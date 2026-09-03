"""Delta re-clearance.

Pictures get re-cut weekly. Clearance that restarts from zero each time is
clearance nobody runs twice, so an item that did not change keeps its state, its
findings, its citations, and its armed watch.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from clearframe_contracts import Cut, Item, ItemStatus
from clearframe_ledger.chain import append as ledger_append
from clearframe_runtime import get_logger, get_store, log_event

log = get_logger("clearframe.delta")

#: States worth inheriting. An item that was still mid-flight is simply re-run.
SETTLED = {
    ItemStatus.RESOLVED,
    ItemStatus.MONITORED,
    ItemStatus.VERIFIED,
    ItemStatus.RISK_SCORED,
    ItemStatus.PENDING_APPROVAL,
}


@dataclass
class DeltaPlan:
    added: list[Item] = field(default_factory=list)
    removed: list[Item] = field(default_factory=list)
    inherited: list[Item] = field(default_factory=list)
    unsettled: list[Item] = field(default_factory=list)

    @property
    def to_research(self) -> list[Item]:
        """New items, plus anything that had not settled on the previous cut."""
        return self.added + self.unsettled

    def summary(self) -> dict:
        return {
            "added": len(self.added),
            "removed": len(self.removed),
            "inherited": len(self.inherited),
            "re_researched": len(self.to_research),
        }


async def previous_cut(cut: Cut) -> Cut | None:
    cuts = await get_store().list_cuts(cut.project_id)
    earlier = [c for c in cuts if c.created_ts < cut.created_ts and c.cut_id != cut.cut_id]
    return earlier[-1] if earlier else None


async def inherit_state(previous: Item, current: Item) -> Item:
    """Carry everything the earlier investigation established onto the new row."""
    store = get_store()
    updated = await store.update_item(
        current.item_id,
        status=previous.status.value,
        risk_state=previous.risk_state,
        challenge_count=previous.challenge_count,
        tier_reached=previous.tier_reached,
        inherited_from=previous.item_id,
    )
    for finding in await store.list_findings(item_id=previous.item_id, live_only=True):
        await store.put_finding(finding.model_copy(update={"item_id": current.item_id}))
    for watch in await store.list_watches(previous.project_id):
        if previous.item_id in watch.item_ids and current.item_id not in watch.item_ids:
            await store.update_watch(watch.watch_id, item_ids=[*watch.item_ids, current.item_id])
    return updated


async def compute_delta(new_cut_id: str) -> DeltaPlan:
    """Diff by content hash. Timecode is deliberately excluded from the hash, so a
    scene that merely moved is not a new item."""
    store = get_store()
    cut = await store.get_cut(new_cut_id)
    if cut is None:
        raise KeyError(f"cut {new_cut_id} not found")

    prior = await previous_cut(cut)
    new_items = await store.list_items(cut_id=new_cut_id)
    if prior is None:
        return DeltaPlan(added=new_items)

    prev_items = await store.list_items(cut_id=prior.cut_id)
    prev_by_hash = {i.content_hash: i for i in prev_items}
    new_by_hash = {i.content_hash: i for i in new_items}

    plan = DeltaPlan()
    for content_hash, item in new_by_hash.items():
        previous = prev_by_hash.get(content_hash)
        if previous is None:
            plan.added.append(item)
            continue
        inherited = await inherit_state(previous, item)
        if previous.status in SETTLED:
            plan.inherited.append(inherited)
        else:
            plan.unsettled.append(inherited)

    for content_hash, item in prev_by_hash.items():
        if content_hash not in new_by_hash:
            await store.set_status(item.item_id, ItemStatus.WITHDRAWN, force=True)
            plan.removed.append(item)

    await ledger_append(
        cut.project_id,
        "ledger",
        {
            "type": "delta.computed",
            "cut_id": new_cut_id,
            "previous_cut_id": prior.cut_id,
            **plan.summary(),
        },
    )
    log_event(log, "delta computed", cut_id=new_cut_id, **plan.summary())
    return plan


async def delta_items(new_cut_id: str) -> DeltaPlan:
    return await compute_delta(new_cut_id)
