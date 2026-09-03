"""The policies that are supposed to be structural, not instructed."""

from __future__ import annotations

import pytest
from clearframe_contracts import (
    Capability,
    Citation,
    Finding,
    Item,
    ItemStatus,
    ItemType,
    Project,
    Prominence,
    Role,
    Timecode,
    can,
    can_transition,
)
from clearframe_orch import tiering
from clearframe_orch.budget import BudgetExceeded, guard
from clearframe_runtime import TransitionError, get_store


def _item(item_type=ItemType.BRAND, prominence=Prominence.BACKGROUND) -> Item:
    return Item(
        item_id="itm_1",
        cut_id="cut_1",
        project_id="prj_1",
        type=item_type,
        title="t",
        description="d",
        timecode=Timecode(),
        prominence=prominence,
    )


def _finding(**claim) -> Finding:
    confidence = claim.pop("confidence", 0.9)
    tier = claim.pop("tier", 1)
    return Finding(
        finding_id="fnd_1",
        item_id="itm_1",
        project_id="prj_1",
        pass_id="pass_1",
        agent="marks_brands",
        claim=claim,
        confidence=confidence,
        tier=tier,
        citations=[Citation(citation_id="c", url="https://uspto.gov/x")],
    )


def test_citation_required_is_enforced_in_code():
    uncited = Finding(
        finding_id="f",
        item_id="i",
        project_id="p",
        pass_id="pa",
        agent="music_rights",
        claim={"composition_owner": "X"},
        confidence=0.95,
    )
    assert not uncited.is_admissible()
    assert uncited.inadmissible_reason() == "no citations"

    low = _finding(confidence=0.2)
    assert not low.is_admissible()
    assert "below floor" in low.inadmissible_reason()

    assert _finding().is_admissible()


def test_tier_policy_escalates_where_being_wrong_is_expensive():
    item = _item()
    assert tiering.initial_tier(item) == 0
    assert tiering.initial_tier(_item(ItemType.MUSIC_CUE)) == 1
    assert tiering.initial_tier(_item(prominence=Prominence.HERO)) == 1

    assert tiering.escalate(item, _finding(), challenged=True) == 2
    assert tiering.escalate(item, _finding(confidence=0.5)) == 2
    assert tiering.escalate(item, _finding(conflicting_sources=True)) == 2
    assert tiering.escalate(item, _finding(litigation_signals=[{"summary": "s"}])) == 3
    assert tiering.escalate(item, _finding()) is None, "confident and uncontested stops"


def test_state_machine_rejects_illegal_transitions():
    assert can_transition(ItemStatus.QUEUED, ItemStatus.RECON)
    assert not can_transition(ItemStatus.EXTRACTED, ItemStatus.RESOLVED)
    assert not can_transition(ItemStatus.WITHDRAWN, ItemStatus.QUEUED)
    assert can_transition(ItemStatus.RESOLVED, ItemStatus.MONITORED)
    assert can_transition(ItemStatus.MONITORED, ItemStatus.REOPENED)
    assert not can_transition(ItemStatus.MONITORED, ItemStatus.RESOLVED), (
        "the sentinel may not re-close an item"
    )


@pytest.mark.asyncio
async def test_store_refuses_an_illegal_transition(workspace):
    store = get_store()
    await store.create_project(Project(project_id="prj_1", title="t"))
    await store.put_item(_item())
    with pytest.raises(TransitionError):
        await store.set_status("itm_1", ItemStatus.RESOLVED)


@pytest.mark.asyncio
async def test_budget_cap_is_a_hard_stop(workspace):
    store = get_store()
    await store.create_project(Project(project_id="prj_b", title="t", budget_cap_usd=0.10))
    await guard("prj_b", cost_usd=0.025, tier=1)
    await guard("prj_b", cost_usd=0.025, tier=1)

    with pytest.raises(BudgetExceeded):
        await guard("prj_b", cost_usd=0.35, tier=3)

    budget = await store.budget("prj_b")
    assert budget.spent_usd == pytest.approx(0.05)
    assert budget.calls_by_tier == {"T1": 2}, "a refused call is never charged"


@pytest.mark.asyncio
async def test_budget_reservation_is_atomic_under_concurrency(workspace):
    import asyncio

    store = get_store()
    await store.create_project(Project(project_id="prj_c", title="t", budget_cap_usd=1.00))
    results = await asyncio.gather(
        *[guard("prj_c", cost_usd=0.10, tier=1) for _ in range(10)],
        return_exceptions=True,
    )
    assert not [r for r in results if isinstance(r, Exception)]
    budget = await store.budget("prj_c")
    assert budget.spent_usd == pytest.approx(1.00)

    with pytest.raises(BudgetExceeded):
        await guard("prj_c", cost_usd=0.01, tier=1)


def test_role_capabilities_are_least_privilege():
    assert not can(Role.PRODUCER, Capability.APPROVE_RED)
    assert not can(Role.COORDINATOR, Capability.APPROVE_OUTREACH)
    assert can(Role.COUNSEL, Capability.APPROVE_RED)
    assert can(Role.COUNSEL, Capability.SIGN_REPORT)
    assert not can(Role.REVIEWER, Capability.EDIT_ITEM)
    assert can(Role.REVIEWER, Capability.READ)
    assert not can(Role.COUNSEL, Capability.START_PASS)
