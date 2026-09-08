"""The per-project cost guard. The cap is a hard stop, not a warning."""

from __future__ import annotations

from clearframe_contracts import Envelope, EventType
from clearframe_runtime import get_bus, get_logger, get_store, log_event

log = get_logger("clearframe.budget")


class BudgetExceeded(RuntimeError):
    """Raised before the spend happens, never after."""

    def __init__(self, project_id: str, spent: float, cost: float, cap: float) -> None:
        super().__init__(
            f"{project_id}: ${spent:.2f} + ${cost:.2f} would exceed the ${cap:.2f} cap"
        )
        self.project_id, self.spent, self.cost, self.cap = project_id, spent, cost, cap


async def guard(project_id: str, *, cost_usd: float, tier: int) -> None:
    """Called before every billable call.

    Reserves the spend atomically, so two concurrent crews cannot both squeeze the
    last cent through. On refusal an approval event goes to the producer — the
    pass pauses rather than dying.
    """
    store = get_store()
    budget = await store.budget(project_id)
    if budget.cap_usd > 0 and budget.spent_usd + cost_usd > budget.cap_usd:
        await get_bus().publish(
            Envelope(
                type=EventType.APPROVAL_REQUIRED,
                project_id=project_id,
                pass_id="budget",
                actor="1st_ad",
                payload={
                    "reason": "budget_cap_reached",
                    "spent_usd": budget.spent_usd,
                    "cap_usd": budget.cap_usd,
                    "blocked_tier": tier,
                    "blocked_cost_usd": cost_usd,
                },
            )
        )
        log_event(
            log,
            "budget refusal",
            project_id=project_id,
            spent=budget.spent_usd,
            cap=budget.cap_usd,
            tier=tier,
        )
        raise BudgetExceeded(project_id, budget.spent_usd, cost_usd, budget.cap_usd)

    updated = await store.increment_spend(project_id, tier, cost_usd)
    if updated.warn:
        log_event(
            log,
            "budget 80 percent",
            project_id=project_id,
            spent=updated.spent_usd,
            cap=updated.cap_usd,
        )


async def may_escalate(project_id: str, cost_usd: float) -> bool:
    """Non-throwing check used by the dispatcher to skip an escalation it cannot fund."""
    budget = await store_budget(project_id)
    return budget.cap_usd <= 0 or budget.spent_usd + cost_usd <= budget.cap_usd


async def store_budget(project_id: str):
    return await get_store().budget(project_id)
