"""Monitor webhook receiver — small, paranoid, and the entry point for Act IV.

The only publicly invokable service besides the web app. Unverified callbacks
are logged and dropped; nothing reaches the event spine unsigned.
"""

from __future__ import annotations

from typing import Any

from clearframe_contracts import Envelope, EventType, utcnow
from clearframe_runtime import (
    get_bus,
    get_logger,
    get_store,
    log_event,
    parallel_webhook_secret,
)
from fastapi import FastAPI, Header, HTTPException, Request

from .guard import RateLimiter, ReplayCache
from .verify import verify

log = get_logger("clearframe.webhook")

app = FastAPI(title="ClearFrame webhook receiver", version="0.1.0")

#: Process-local, which is the right scope: each Cloud Run instance sheds its own
#: load, and a duplicate that slips past one instance is caught by the Sentinel's
#: own idempotence — a reopened item cannot be reopened twice into a worse state.
_replays = ReplayCache()
_rate = RateLimiter()

MATERIAL_EVENT_TYPES = {"monitor.event.detected", "event_stream", "snapshot"}


def _change_from(payload: dict) -> dict:
    """Pull the structured change out of whichever envelope shape arrived."""
    for key in ("output", "changed_output", "data", "event"):
        block = payload.get(key)
        if isinstance(block, dict):
            content = block.get("content", block)
            if isinstance(content, dict) and ("change_class" in content or "summary" in content):
                return content
    content = payload.get("content")
    return content if isinstance(content, dict) else {}


def _first(payload: dict, *keys: str) -> Any:
    for key in keys:
        if payload.get(key):
            return payload[key]
        data = payload.get("data")
        if isinstance(data, dict) and data.get(key):
            return data[key]
    return None


@app.post("/webhooks/parallel/monitor", summary="Parallel Monitor callback")
async def monitor_event(
    request: Request,
    webhook_id: str | None = Header(default=None, alias="webhook-id"),
    webhook_timestamp: str | None = Header(default=None, alias="webhook-timestamp"),
    webhook_signature: str | None = Header(default=None, alias="webhook-signature"),
) -> dict[str, Any]:
    if not _rate.allow():
        log_event(log, "webhook rate limited", in_window=_rate.in_window)
        raise HTTPException(429, "too many callbacks; retry shortly")

    raw = await request.body()

    try:
        secret = parallel_webhook_secret()
    except Exception as exc:  # noqa: BLE001
        log_event(log, "webhook secret unavailable", error=repr(exc))
        raise HTTPException(500, "webhook secret unavailable") from exc

    if not verify(
        secret,
        raw,
        webhook_id=webhook_id,
        timestamp=webhook_timestamp,
        signature_header=webhook_signature,
    ):
        log_event(log, "unverified monitor callback dropped", webhook_id=webhook_id)
        raise HTTPException(401, "signature verification failed")

    if webhook_id and _replays.seen(webhook_id):
        # A redelivery of an event already on the spine. Acknowledge it so Parallel
        # stops retrying, and do not reprocess it.
        log_event(log, "duplicate callback acknowledged", webhook_id=webhook_id)
        return {"ok": True, "duplicate": True}

    import json

    try:
        payload = json.loads(raw or b"{}")
    except json.JSONDecodeError as exc:
        log_event(log, "unparseable callback", error=str(exc))
        raise HTTPException(400, "body is not JSON") from exc
    event_type = str(_first(payload, "type", "event_type") or "monitor.event.detected")
    monitor_id = str(_first(payload, "monitor_id") or "")
    if not monitor_id:
        log_event(log, "monitor callback without monitor_id", event_type=event_type)
        return {"ok": True, "ignored": "no monitor_id"}

    watch = await get_store().get_watch(monitor_id)
    if watch is None:
        log_event(log, "monitor callback for unknown watch", monitor_id=monitor_id)
        return {"ok": True, "ignored": "unknown monitor"}

    if event_type.split(".")[-1] not in {"detected"} and event_type not in MATERIAL_EVENT_TYPES:
        await get_store().update_watch(monitor_id, last_checked_ts=utcnow().isoformat())
        return {"ok": True, "ignored": event_type}

    change = _change_from(payload)
    await get_bus().publish(
        Envelope(
            type=EventType.MONITOR_FIRED,
            project_id=watch.project_id,
            pass_id="sentinel",
            actor="sentinel",
            payload={
                "monitor_id": monitor_id,
                "event_id": _first(payload, "event_id", "id"),  # becomes prev_interaction_id
                "event_type": event_type,
                "change": change,
                "summary": change.get("summary", ""),
            },
        )
    )
    log_event(
        log,
        "monitor event accepted",
        monitor_id=monitor_id,
        change_class=change.get("change_class"),
    )
    return {"ok": True}


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    secret_ok = True
    try:
        parallel_webhook_secret()
    except Exception:  # noqa: BLE001 — health reports, never raises
        secret_ok = False
    return {
        "ok": True,
        "signing_secret_available": secret_ok,
        "recent_callbacks": _rate.in_window,
        "replay_cache": len(_replays),
    }
