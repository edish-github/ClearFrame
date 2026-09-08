"""Live pass state and the feed the war room reads.

Thin on purpose: the store owns persistence, this owns the pass-level arithmetic
that more than one caller needs.
"""

from __future__ import annotations

from clearframe_contracts import (
    BudgetState,
    Envelope,
    EventType,
    Item,
    ItemStatus,
    Pass,
    PassMode,
    PassStatus,
    RiskState,
)
from clearframe_runtime import get_bus, get_logger, get_store
from clearframe_runtime.ids import pass_id as new_pass_id

log = get_logger("clearframe.state")

OPEN_STATES = {
    ItemStatus.QUEUED,
    ItemStatus.RECON,
    ItemStatus.RESEARCHING,
    ItemStatus.CONTESTED,
    ItemStatus.VERIFIED,
    ItemStatus.RISK_SCORED,
    ItemStatus.PENDING_APPROVAL,
    ItemStatus.REOPENED,
    ItemStatus.ESCALATED,
}
CLOSED_STATES = {ItemStatus.RESOLVED, ItemStatus.MONITORED, ItemStatus.WITHDRAWN}


async def create_pass(project_id: str, cut_id: str, mode: PassMode, total: int) -> Pass:
    store = get_store()
    project = await store.get_project(project_id)
    cap = project.budget_cap_usd if project else 0.0
    spent = project.spent_usd if project else 0.0
    record = Pass(
        pass_id=new_pass_id(),
        project_id=project_id,
        cut_id=cut_id,
        mode=mode,
        status=PassStatus.RUNNING,
        total_items=total,
        open_items=total,
        budget=BudgetState(cap_usd=cap, spent_usd=spent),
    )
    await store.create_pass(record)
    await get_bus().publish(
        Envelope(
            type=EventType.PASS_STARTED,
            project_id=project_id,
            pass_id=record.pass_id,
            actor="1st_ad",
            payload={"mode": mode.value, "items": total, "cut_id": cut_id},
        )
    )
    return record


async def refresh_pass(pass_id: str) -> Pass | None:
    """Recount from the items themselves — counters that drift are worse than none.

    Returns None for work that is not part of a pass; a counter refresh must never
    be the reason an event handler fails and gets retried.
    """
    store = get_store()
    record = await store.get_pass(pass_id)
    if record is None:
        return None

    items = await store.list_items(cut_id=record.cut_id)
    open_items = sum(1 for i in items if i.status in OPEN_STATES)
    cleared = sum(
        1 for i in items if i.status in CLOSED_STATES or i.risk_state == RiskState.GREEN.value
    )
    challenges = len(await store.list_challenges(project_id=record.project_id))
    budget = await store.budget(record.project_id)
    updated = await store.update_pass(
        pass_id,
        open_items=open_items,
        cleared_items=cleared,
        completed_items=len(items) - open_items,
        challenges=challenges,
        budget=budget.model_dump(mode="json"),
    )

    # A pass with nothing left in flight is finished. Closing it here rather than
    # waiting for a caller means the war room shows "complete" the moment it is
    # true, which is also when the report becomes worth rendering.
    if updated.status is PassStatus.RUNNING and open_items == 0 and updated.total_items > 0:
        return await _close(updated)
    return updated


async def _close(record: Pass) -> Pass:
    from clearframe_contracts import utcnow

    store = get_store()
    closed = await store.update_pass(
        record.pass_id,
        status=PassStatus.COMPLETED.value,
        completed_ts=utcnow().isoformat(),
    )
    await get_bus().publish(
        Envelope(
            type=EventType.PASS_COMPLETED,
            project_id=record.project_id,
            pass_id=record.pass_id,
            actor="1st_ad",
            payload={
                "open_items": closed.open_items,
                "cleared_items": closed.cleared_items,
                "challenges": closed.challenges,
            },
        )
    )
    return closed


async def complete_pass(pass_id: str) -> Pass:
    """Close a pass by hand. `refresh_pass` closes one automatically once nothing
    is open; this exists for the case where a producer calls it early."""
    record = await refresh_pass(pass_id)
    if record is None:
        raise KeyError(f"pass {pass_id} not found")
    if record.status is PassStatus.COMPLETED:
        return record
    return await _close(record)


async def pause_pass(pass_id: str, reason: str) -> Pass:
    """The kill switch. State is durable, so resume is exact."""
    store = get_store()
    record = await store.get_pass(pass_id)
    if record is None:
        raise KeyError(f"pass {pass_id} not found")
    updated = await store.update_pass(pass_id, status=PassStatus.PAUSED.value)
    await get_bus().publish(
        Envelope(
            type=EventType.PASS_PAUSED,
            project_id=record.project_id,
            pass_id=pass_id,
            actor="1st_ad",
            payload={"reason": reason},
        )
    )
    return updated


async def heat_strip(cut_id: str) -> list[dict]:
    """Timecode-aligned risk regions — the shape the heat strip renders."""
    store = get_store()
    cut = await store.get_cut(cut_id)
    duration = max(1, cut.duration_frames if cut else 1)
    regions = []
    for item in await store.list_items(cut_id=cut_id):
        start = item.timecode.frame_in / duration * 100
        width = max(0.4, (item.timecode.frame_out - item.timecode.frame_in) / duration * 100)
        regions.append(
            {
                "item_id": item.item_id,
                "title": item.title,
                "type": item.type.value,
                "start_pct": round(min(100.0, max(0.0, start)), 4),
                "width_pct": round(width, 4),
                "risk": item.risk_state or "unknown",
                "status": item.status.value,
                "scene": item.timecode.scene,
                "tc_in": item.timecode.tc_in,
                "frame_in": item.timecode.frame_in,
            }
        )
    return sorted(regions, key=lambda r: r["start_pct"])


def item_public(item: Item) -> dict:
    return {
        **item.model_dump(mode="json"),
        "tc_in": item.timecode.tc_in,
        "tc_out": item.timecode.tc_out,
    }
