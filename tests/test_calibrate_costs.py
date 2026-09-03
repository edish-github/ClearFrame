"""Calibration must measure, never guess."""

from __future__ import annotations

import pytest
from clearframe_ledger.records import record_cost
from clearframe_runtime import get_store

from scripts.calibrate_costs import call_counts, measured_tier_costs, parse_by_surface


def test_parse_by_surface():
    assert parse_by_surface("task:core=6.10, search=0.90") == {"task:core": 6.10, "search": 0.90}
    assert parse_by_surface("") == {}


@pytest.mark.asyncio
async def test_counts_come_from_the_ledger(workspace):
    from clearframe_contracts import Project

    await get_store().create_project(Project(project_id="prj_cal", title="Calibrate"))
    for _ in range(20):
        await record_cost("prj_cal", "pass_1", "itm_1", 0, 0.004, "search")
    for _ in range(8):
        await record_cost("prj_cal", "pass_1", "itm_1", 1, 0.025, "task:core")

    counts = call_counts("prj_cal")
    assert counts == {"search": 20, "task:core": 8}

    measured, skipped = measured_tier_costs(counts, {"search": 1.00, "task:core": 4.00})
    assert measured[0] == pytest.approx(0.05)  # $1.00 / 20 calls
    assert measured[1] == pytest.approx(0.50)  # $4.00 / 8 calls
    assert skipped == []


def test_a_surface_with_no_calls_is_reported_not_invented():
    measured, skipped = measured_tier_costs({"search": 5}, {"task:ultra": 3.00})
    assert measured == {}, "no calls means no measurement, not a made-up rate"
    assert "task:ultra" in skipped[0]
