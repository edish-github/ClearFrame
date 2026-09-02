"""Monitor — the Sentinel's senses.

A shipped report arms one monitor per rights holder attached to a non-green
item, watching the change classes that would move its risk state.
"""

from __future__ import annotations

from typing import Any

from clearframe_runtime import get_logger, log_event, settings

from .client import MONITOR, MONITOR_EVENTS, MONITORS, ParallelClient, get_client

log = get_logger("clearframe.adapter.monitor")

DEFAULT_EVENT_TYPES = ["monitor.event.detected", "monitor.execution.failed"]

#: Emitted alongside every detected change so the reopen path can act on structure,
#: not prose.
MONITOR_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "change_class": {
            "type": "string",
            "description": (
                "catalog_transfer | litigation | bankruptcy | rename_restructure | "
                "probate | representation_change | trademark_status | opposition | "
                "provenance_correction | takedown | other"
            ),
        },
        "summary": {"type": "string", "description": "What changed, in one or two sentences"},
        "material": {
            "type": "boolean",
            "description": "True only if this plausibly alters who controls the rights",
        },
        "effective_date": {"type": "string"},
        "parties": {"type": "array", "items": {"type": "string"}},
        "source_url": {"type": "string"},
    },
    "required": ["change_class", "summary", "material"],
}


def build_objective(subject: str, change_classes: list[str]) -> str:
    return (
        f"Track material changes affecting rights control for {subject}. "
        f"Report only substantive developments in these classes: "
        f"{', '.join(change_classes)}. "
        "Ignore routine press, marketing, and product news. For every reported change, "
        "give the change class, a one-sentence summary, the effective date if stated, "
        "and the source URL."
    )


async def arm_watch(
    subject: str,
    change_classes: list[str],
    webhook_url: str,
    *,
    frequency: str | None = None,
    processor: str = "base",
    metadata: dict[str, str] | None = None,
    include_backfill: bool = False,
    client: ParallelClient | None = None,
) -> dict:
    """POST /v1/monitors — returns the monitor envelope; monitor_id becomes watch_id."""
    body: dict[str, Any] = {
        "type": "event_stream",
        "frequency": frequency or settings().monitor_frequency,
        "processor": processor,
        "settings": {
            "query": build_objective(subject, change_classes),
            "output_schema": MONITOR_OUTPUT_SCHEMA,
            "include_backfill": include_backfill,
        },
        "webhook": {"url": webhook_url, "event_types": DEFAULT_EVENT_TYPES},
    }
    if metadata:
        body["metadata"] = {k[:16]: str(v)[:512] for k, v in metadata.items()}

    monitor = await (client or get_client()).post(MONITORS, body)
    log_event(log, "watch armed", monitor_id=monitor.get("monitor_id"), subject=subject)
    return monitor


async def disarm_watch(monitor_id: str, *, client: ParallelClient | None = None) -> dict:
    return await (client or get_client()).request("DELETE", MONITOR.format(monitor_id=monitor_id))


async def get_monitor(monitor_id: str, *, client: ParallelClient | None = None) -> dict:
    return await (client or get_client()).get(MONITOR.format(monitor_id=monitor_id))


async def list_events(
    monitor_id: str,
    *,
    limit: int = 20,
    cursor: str | None = None,
    include_completions: bool = False,
    client: ParallelClient | None = None,
) -> dict:
    """GET /v1/monitors/{id}/events — the poll path, and the demo's safety net if a
    webhook is delayed. Events are still real; only the transport differs."""
    params: dict[str, Any] = {
        "limit": limit,
        "include_completions": str(include_completions).lower(),
    }
    if cursor:
        params["cursor"] = cursor
    return await (client or get_client()).get(
        MONITOR_EVENTS.format(monitor_id=monitor_id), params=params
    )
