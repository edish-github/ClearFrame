"""The hash chain must detect tampering — that is its entire job."""

from __future__ import annotations

import json

import pytest
from clearframe_contracts import Project
from clearframe_ledger.chain import append, verify_chain
from clearframe_ledger.sink import LEDGER_EVENTS, get_sink
from clearframe_runtime import get_store


@pytest.mark.asyncio
async def test_chain_verifies_and_detects_tampering(workspace):
    store = get_store()
    await store.create_project(Project(project_id="prj_1", title="Test picture"))

    for i in range(5):
        await append("prj_1", "1st_ad", {"type": "pass.started", "n": i})

    result = verify_chain("prj_1")
    assert result["valid"] is True
    assert result["events"] == 5

    # tamper with history the way an attacker would: rewrite one event body
    sink = get_sink()
    path = sink.root / f"{LEDGER_EVENTS}.jsonl"
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    doctored = json.loads(rows[2]["event"])
    doctored["n"] = 999
    rows[2]["event"] = json.dumps(doctored)
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    after = verify_chain("prj_1")
    assert after["valid"] is False
    assert "seq 3" in after["reason"]


@pytest.mark.asyncio
async def test_sequence_is_dense_under_concurrency(workspace):
    import asyncio

    store = get_store()
    await store.create_project(Project(project_id="prj_2", title="Concurrent"))

    await asyncio.gather(
        *[append("prj_2", "crew", {"type": "finding.added", "i": i}) for i in range(25)]
    )

    result = verify_chain("prj_2")
    assert result["valid"] is True, result["reason"]
    assert result["events"] == 25
