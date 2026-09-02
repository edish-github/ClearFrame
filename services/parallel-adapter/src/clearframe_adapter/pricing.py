"""Tier -> processor -> price. Calibrate against a real invoice in week one.

These are planning numbers, and the code says so: `CALIBRATED` flips to True
once `scripts/calibrate_costs.py` has written measured values, and the budget
meter labels the figure accordingly rather than pretending to precision.
"""

from __future__ import annotations

#: T0 recon (Search/Extract), T1 core, T2 pro, T3 ultra.
TIER_PROCESSOR: dict[int, str | None] = {0: None, 1: "core", 2: "pro", 3: "ultra"}

#: USD per call, by tier. Planning estimates until calibrated.
TIER_COST_USD: dict[int, float] = {0: 0.004, 1: 0.025, 2: 0.10, 3: 0.35}

#: Per-call price of the recon surfaces used at T0.
SEARCH_COST_USD = 0.003
EXTRACT_COST_USD = 0.001
FINDALL_COST_USD = 0.15
MONITOR_ARM_COST_USD = 0.02

CALIBRATED = False


def processor_for_tier(tier: int) -> str:
    processor = TIER_PROCESSOR.get(tier)
    if processor is None:
        raise ValueError(f"tier {tier} is recon-only; it has no Task processor")
    return processor


def cost_for_tier(tier: int) -> float:
    return TIER_COST_USD.get(tier, 0.0)


def cost_note() -> str:
    return (
        "measured against invoiced usage"
        if CALIBRATED
        else "planning estimate — not yet calibrated against an invoice"
    )
