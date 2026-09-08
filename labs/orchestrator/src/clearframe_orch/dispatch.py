"""The 1st AD.

Plans the pass, fans it out over the event spine, assigns a crew and a tier per
item, and keeps the pass moving when individual items fail. Every item is an
independent message, which is what lets a 200-item pass survive a closed laptop.
"""

from __future__ import annotations

from clearframe_contracts import (
    Envelope,
    EventType,
    Finding,
    Item,
    ItemStatus,
    ItemType,
    Pass,
    PassMode,
)
from clearframe_ledger.chain import append as ledger_append
from clearframe_runtime import get_bus, get_logger, get_store, log_event

from . import agents_client, state, tiering
from .budget import BudgetExceeded
from .models import ModelClient
from .toolbelt import RunContext

log = get_logger("clearframe.dispatch")

CREW = {
    ItemType.MUSIC_CUE: "music-rights",
    ItemType.LYRIC_QUOTE: "music-rights",
    ItemType.BRAND: "marks-brands",
    ItemType.LOCATION: "marks-brands",
    ItemType.LIKENESS: "likeness",
    ItemType.ARTWORK: "footage-artwork",
    ItemType.FOOTAGE: "footage-artwork",
    ItemType.FONT: "footage-artwork",
}

AGENT_NAME = {
    "music-rights": "music_rights",
    "marks-brands": "marks_brands",
    "likeness": "likeness",
    "footage-artwork": "footage_artwork",
}

RESEARCH_TASK = """Investigate this item and establish what is true about its rights,
with citations.

Item: {title}
Type: {type}
What was seen: {description}
Where: scene {scene}, from {tc_in}
Prominence: {prominence}
Extraction detail: {attrs}

Assigned tier for this run: T{tier} ({tier_note}).
{objection_block}
Work the recon first, then run one structured task against your schema, then
submit the finding. Report what you could not establish rather than filling it in.
"""

OBJECTION_BLOCK = """
A previous finding on this item was challenged and sent back to you.
Grounds: {objection}
Your job on this run is to answer that objection specifically.
"""


def crew_for(item_type: ItemType) -> str:
    return CREW[item_type]


async def start_pass(
    project_id: str,
    cut_id: str,
    *,
    mode: PassMode = PassMode.FULL,
    items: list[Item] | None = None,
) -> Pass:
    """Plan a pass and fan it out. Returns immediately; the spine does the work."""
    store = get_store()
    if items is None:
        if mode is PassMode.DELTA:
            from .delta import delta_items

            plan = await delta_items(cut_id)
            items = plan.to_research
        else:
            items = await store.list_items(cut_id=cut_id)

    record = await state.create_pass(project_id, cut_id, mode, len(items))
    await ledger_append(
        project_id,
        "1st_ad",
        {
            "type": "pass.started",
            "pass_id": record.pass_id,
            "cut_id": cut_id,
            "mode": mode.value,
            "items": len(items),
        },
    )

    bus = get_bus()
    for item in items:
        tier = tiering.initial_tier(item)
        if item.status in (ItemStatus.EXTRACTED, ItemStatus.RESOLVED, ItemStatus.MONITORED):
            await store.set_status(item.item_id, ItemStatus.QUEUED, force=True)
        await bus.publish(
            Envelope(
                type=EventType.RESEARCH_REQUESTED,
                project_id=project_id,
                pass_id=record.pass_id,
                item_id=item.item_id,
                actor="1st_ad",
                payload={
                    "tier": tier,
                    "crew": crew_for(item.type),
                    "rationale": tiering.tier_rationale(item, None),
                },
            )
        )
    log_event(log, "pass fanned out", pass_id=record.pass_id, items=len(items), mode=mode.value)
    return record


async def handle_research(env: Envelope, *, model_client: ModelClient | None = None) -> None:
    """One item, one crew, one run. Called by the Pub/Sub push subscription."""
    store = get_store()
    item = await store.get_item(env.item_id or "")
    if item is None:
        log_event(log, "research for unknown item", item_id=env.item_id)
        return

    crew = env.payload.get("crew") or crew_for(item.type)
    tier = int(env.payload.get("tier", tiering.initial_tier(item)))
    objection = env.payload.get("objection")
    prev_interaction_id = env.payload.get("prev_interaction_id")

    await store.set_status(item.item_id, ItemStatus.RESEARCHING, force=True)
    ctx = RunContext(
        project_id=env.project_id,
        pass_id=env.pass_id,
        agent=AGENT_NAME[crew],
        item_id=item.item_id,
        tier=max(1, tier),
        prev_interaction_id=prev_interaction_id,
        objection=objection,
    )

    task = RESEARCH_TASK.format(
        title=item.title,
        type=item.type.value,
        description=item.description,
        scene=item.timecode.scene or "unspecified",
        tc_in=item.timecode.tc_in,
        prominence=item.prominence.value,
        attrs=item.attrs or {},
        tier=ctx.tier,
        tier_note=env.payload.get("rationale", "standard structured run"),
        objection_block=OBJECTION_BLOCK.format(objection=objection) if objection else "",
    )

    try:
        run = await agents_client.invoke(crew, ctx, task, model_client=model_client)
    except BudgetExceeded as exc:
        await store.set_status(item.item_id, ItemStatus.FAILED, force=True)
        await state.pause_pass(env.pass_id, str(exc))
        return
    except Exception as exc:  # noqa: BLE001 — one item must not end the pass
        log_event(log, "research failed", item_id=item.item_id, error=repr(exc))
        await store.set_status(item.item_id, ItemStatus.FAILED, force=True)
        await agents_client.push_feed(
            ctx, "agent.error", f"research failed: {exc}", item_id=item.item_id
        )
        await state.refresh_pass(env.pass_id)
        return

    await store.update_item(item.item_id, tier_reached=max(item.tier_reached, ctx.tier))
    if not ctx.findings:
        # No admissible finding. Escalate once, then stop and say so — a pass that
        # ends with an honest gap beats one that invents a fact.
        next_tier = tiering.escalate(item, None, challenged=False)
        if next_tier and next_tier > ctx.tier and item.tier_reached < next_tier:
            await get_bus().publish(
                Envelope(
                    type=EventType.RESEARCH_REQUESTED,
                    project_id=env.project_id,
                    pass_id=env.pass_id,
                    item_id=item.item_id,
                    actor="1st_ad",
                    payload={
                        "tier": next_tier,
                        "crew": crew,
                        "rationale": "no admissible finding at the previous tier",
                    },
                )
            )
        else:
            await store.set_status(item.item_id, ItemStatus.ESCALATED, force=True)
            await get_bus().publish(
                Envelope(
                    type=EventType.ITEM_ESCALATED,
                    project_id=env.project_id,
                    pass_id=env.pass_id,
                    item_id=item.item_id,
                    actor="1st_ad",
                    payload={"reason": "no admissible finding", "text": run.final_text[:500]},
                )
            )
    await state.refresh_pass(env.pass_id)


async def request_research(
    project_id: str,
    pass_id: str,
    item: Item,
    tier: int,
    *,
    objection: str | None = None,
    prev_interaction_id: str | None = None,
    rationale: str = "",
) -> None:
    await get_bus().publish(
        Envelope(
            type=EventType.RESEARCH_REQUESTED,
            project_id=project_id,
            pass_id=pass_id,
            item_id=item.item_id,
            actor="1st_ad",
            payload={
                "tier": tier,
                "crew": crew_for(item.type),
                "objection": objection,
                "prev_interaction_id": prev_interaction_id,
                "rationale": rationale,
            },
        )
    )


def latest_finding(findings: list[Finding]) -> Finding | None:
    live = [f for f in findings if not f.superseded_by]
    return live[-1] if live else None
