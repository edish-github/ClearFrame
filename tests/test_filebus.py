"""The local spine has to cross process boundaries, or a decision never lands."""

from __future__ import annotations

import asyncio

import pytest
from clearframe_contracts import Envelope, EventType
from clearframe_runtime.filebus import FileBus


@pytest.mark.asyncio
async def test_an_event_published_by_one_process_reaches_another(workspace):
    received: list[Envelope] = []

    # The orchestrator subscribes; the ledger only publishes — the real topology.
    orchestrator = FileBus("orchestrator", root=workspace, poll_interval_s=0.02)
    orchestrator.on(EventType.DECISION_MADE, lambda env: _collect(received, env))
    orchestrator.start()

    ledger = FileBus("ledger", root=workspace, poll_interval_s=0.02)
    await ledger.publish(
        Envelope(
            type=EventType.DECISION_MADE,
            project_id="prj_1",
            pass_id="gate",
            item_id="itm_1",
            actor="counsel@example.test",
            payload={"decision": {"action": "approve_mitigation"}},
        )
    )

    await orchestrator.drain(timeout=5)
    await orchestrator.stop()

    assert len(received) == 1
    assert received[0].item_id == "itm_1"


@pytest.mark.asyncio
async def test_subscriptions_are_durable_across_a_restart(workspace):
    # Announce, then "stop the process" before the event is published.
    first = FileBus("orchestrator", root=workspace, poll_interval_s=0.02)
    first.on(EventType.MONITOR_FIRED, lambda env: asyncio.sleep(0))
    first.start()
    await first.stop()

    webhook = FileBus("webhook", root=workspace, poll_interval_s=0.02)
    await webhook.publish(
        Envelope(
            type=EventType.MONITOR_FIRED,
            project_id="prj_1",
            pass_id="sentinel",
            actor="sentinel",
            payload={"monitor_id": "mon_1"},
        )
    )

    received: list[Envelope] = []
    restarted = FileBus("orchestrator", root=workspace, poll_interval_s=0.02)
    restarted.on(EventType.MONITOR_FIRED, lambda env: _collect(received, env))
    restarted.start()
    await restarted.drain(timeout=5)
    await restarted.stop()

    assert len(received) == 1, "an event published while down must still arrive"


@pytest.mark.asyncio
async def test_a_failing_handler_retries_then_dead_letters(workspace):
    attempts: list[int] = []

    async def always_fails(_env: Envelope) -> None:
        attempts.append(1)
        raise RuntimeError("handler is broken")

    bus = FileBus("orchestrator", root=workspace, poll_interval_s=0.02)
    bus.on(EventType.FINDING_ADDED, always_fails)
    bus.start()
    await bus.publish(
        Envelope(
            type=EventType.FINDING_ADDED, project_id="prj_1", pass_id="p1", actor="crew", payload={}
        )
    )

    for _ in range(60):
        if bus.dead_letters:
            break
        await asyncio.sleep(0.05)
    await bus.stop()

    assert bus.dead_letters, "a permanently failing message must dead-letter"
    assert len(attempts) == 5, "five attempts, then stop retrying"


async def _collect(sink: list[Envelope], envelope: Envelope) -> None:
    sink.append(envelope)
