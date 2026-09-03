"""A pass that runs out of money must pause cleanly, not die."""

from __future__ import annotations

import pytest
from clearframe_contracts import (
    Cut,
    EventType,
    Item,
    ItemStatus,
    ItemType,
    PassMode,
    Project,
    Prominence,
    Timecode,
)
from clearframe_orch import handlers, state
from clearframe_orch.budget import BudgetExceeded, guard
from clearframe_runtime import get_store
from clearframe_runtime.ids import item_id as new_item_id


@pytest.mark.asyncio
async def test_refusal_asks_the_producer_and_leaves_the_pass_resumable(workspace):
    store = get_store()
    await store.create_project(
        Project(project_id="prj_cap", title="Tight budget", budget_cap_usd=0.02)
    )
    await store.put_cut(Cut(cut_id="cut_cap", project_id="prj_cap"))
    item = Item(
        item_id=new_item_id(),
        cut_id="cut_cap",
        project_id="prj_cap",
        type=ItemType.BRAND,
        title="Soda can",
        description="d",
        timecode=Timecode(),
        prominence=Prominence.BACKGROUND,
    ).with_hash()
    await store.put_item(item)

    bus = handlers.register()
    bus.start()

    record = await state.create_pass("prj_cap", "cut_cap", PassMode.FULL, 1)

    with pytest.raises(BudgetExceeded):
        await guard("prj_cap", cost_usd=0.35, tier=3)

    await bus.drain(timeout=10)

    feed = await store.list_feed("budget")
    refusals = [e for e in feed if e["kind"] == EventType.APPROVAL_REQUIRED.value]
    assert refusals, "a refusal must reach the producer, not just the log"
    assert refusals[0]["detail"]["reason"] == "budget_cap_reached"
    assert "budget cap reached" in refusals[0]["message"]

    paused = await state.pause_pass(record.pass_id, "budget cap reached")
    assert paused.status.value == "paused"

    # Raising the cap makes the same call affordable, and the state survived intact.
    await store.raise_budget("prj_cap", 5.00)
    await guard("prj_cap", cost_usd=0.35, tier=3)
    budget = await store.budget("prj_cap")
    assert budget.spent_usd == pytest.approx(0.35)

    unchanged = await store.get_item(item.item_id)
    assert unchanged.status is ItemStatus.EXTRACTED, "durable state, exact resume"
