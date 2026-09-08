"""Outreach — the production office.

Finds the right counterparty and drafts the inquiry. There is no send path in
this system; the queue behind the counsel gate is the feature.
"""

from __future__ import annotations

from clearframe_contracts import Envelope, EventType, OutreachDraft, RiskState
from clearframe_runtime import get_bus, get_logger, get_store, log_event

from . import agents_client
from .models import ModelClient
from .toolbelt import RunContext

log = get_logger("clearframe.outreach")

DRAFT_TASK = """Prepare licence outreach for this item.

Item: {title} ({type}) — {description}
Scene {scene}, {tc_in}. Prominence: {prominence}.
Risk state: {risk_state}
Production: {production}

What research established:
{findings}

Rights holders already in the graph for this item:
{holders}

1. If the controlling entity or its licensing contact is unclear, run
   findall_rights_holders with explicit match conditions.
2. Draft one inquiry per controlling entity with draft_outreach. Say precisely
   what is used, where it appears, the intended territory and term, and ask for a
   quote. Never assert that rights have been cleared or that a deal exists.
3. Use a contact detail only if a source you can name carries it.
"""


def _findings_block(findings) -> str:
    import json

    lines = []
    for finding in findings:
        claim = {k: v for k, v in finding.claim.items() if not k.startswith("_")}
        lines.append(f"- {finding.agent}: {json.dumps(claim, default=str)[:800]}")
    return "\n".join(lines)


async def on_approval_required(env: Envelope, *, model_client: ModelClient | None = None) -> None:
    """Amber and red items get a drafted inquiry waiting when counsel opens the gate."""
    risk = env.payload.get("risk_state")
    if risk not in (RiskState.AMBER.value, RiskState.RED.value):
        return
    await draft_for_item(env.project_id, env.pass_id, env.item_id or "", model_client=model_client)


async def draft_for_item(
    project_id: str, pass_id: str, item_id: str, *, model_client: ModelClient | None = None
) -> list[OutreachDraft]:
    store = get_store()
    item = await store.get_item(item_id)
    if item is None:
        return []
    project = await store.get_project(project_id)
    findings = await store.list_findings(item_id=item_id, live_only=True)

    from clearframe_ledger.graph import holders_for_items

    holders = (await holders_for_items([item_id])).get(item_id, [])
    ctx = RunContext(
        project_id=project_id, pass_id=pass_id, agent="outreach", item_id=item_id, tier=2
    )

    task = DRAFT_TASK.format(
        title=item.title,
        type=item.type.value,
        description=item.description,
        scene=item.timecode.scene or "unspecified",
        tc_in=item.timecode.tc_in,
        prominence=item.prominence.value,
        risk_state=item.risk_state or "unknown",
        production=project.title if project else project_id,
        findings=_findings_block(findings) or "(none)",
        holders="\n".join(
            f"- {h.name} ({h.kind.value}) contacts: "
            f"{[c.email or c.url for c in h.contacts] or 'none on file'}"
            for h in holders
        )
        or "(none yet)",
    )

    try:
        await agents_client.invoke("outreach", ctx, task, model_client=model_client)
    except Exception as exc:  # noqa: BLE001 — outreach is never on the critical path
        log_event(log, "outreach drafting failed", item_id=item_id, error=repr(exc))
        return []

    for draft in ctx.outreach:
        await get_bus().publish(
            Envelope(
                type=EventType.OUTREACH_QUEUED,
                project_id=project_id,
                pass_id=pass_id,
                item_id=item_id,
                actor="outreach",
                payload={
                    "outreach_id": draft.outreach_id,
                    "status": draft.status.value,
                    "awaiting": "counsel approval",
                },
            )
        )
    log_event(log, "outreach drafted", item_id=item_id, drafts=len(ctx.outreach))
    return ctx.outreach
