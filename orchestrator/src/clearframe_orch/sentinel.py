"""The night watch.

Shipping a report arms a Parallel Monitor on every rights holder attached to a
non-green item. When one fires, the Sentinel wakes the 1st AD, chains a
follow-up run to the monitor event so the reopened investigation inherits its
history, and alerts counsel. It reopens and alerts. It never closes anything.
"""

from __future__ import annotations

from clearframe_contracts import (
    CHANGE_CLASSES_FOR_KIND,
    Envelope,
    EventType,
    Item,
    ItemStatus,
    PassMode,
    RiskState,
    Watch,
    WatchChangeClass,
    utcnow,
)
from clearframe_ledger.chain import append as ledger_append
from clearframe_ledger.graph import holders_for_items
from clearframe_runtime import get_bus, get_logger, get_store, log_event, settings

from . import dispatch, state, tiering

log = get_logger("clearframe.sentinel")

NON_GREEN = {RiskState.AMBER.value, RiskState.RED.value, None, "unknown"}


def webhook_url() -> str:
    cfg = settings()
    base = cfg.url_webhook.rstrip("/")
    if not base:
        raise RuntimeError(
            "URL_WEBHOOK is not set; a monitor with no reachable callback is a "
            "watch that can never fire"
        )
    return f"{base}/webhooks/parallel/monitor"


async def arm_watches(project_id: str, *, only_non_green: bool = True) -> list[Watch]:
    """Called when a report ships. One watch per rights holder, deduplicated."""
    store = get_store()
    items = [
        item
        for item in await store.list_items(project_id=project_id)
        if item.status is not ItemStatus.WITHDRAWN
        and (not only_non_green or (item.risk_state in NON_GREEN))
    ]
    if not items:
        return []

    holders_by_item = await holders_for_items([i.item_id for i in items])
    existing = {
        w.holder_id: w
        for w in await store.list_watches(project_id)
        if w.holder_id and w.status == "active"
    }

    from clearframe_adapter import monitor as monitor_api

    armed: list[Watch] = []
    for item in items:
        for holder in holders_by_item.get(item.item_id, []):
            already = existing.get(holder.holder_id)
            if already:
                if item.item_id not in already.item_ids:
                    await store.update_watch(
                        already.watch_id, item_ids=[*already.item_ids, item.item_id]
                    )
                continue

            classes = [c.value for c in CHANGE_CLASSES_FOR_KIND.get(holder.kind, [])]
            try:
                result = await monitor_api.arm_watch(
                    holder.name,
                    classes,
                    webhook_url(),
                    metadata={"project_id": project_id, "holder_id": holder.holder_id},
                )
            except Exception as exc:  # noqa: BLE001 — an unarmed watch is reported, not hidden
                log_event(log, "arming failed", holder=holder.name, error=repr(exc))
                continue

            monitor_id = result.get("monitor_id")
            if not monitor_id:
                continue
            watch = Watch(
                watch_id=monitor_id,
                project_id=project_id,
                holder_id=holder.holder_id,
                subject=holder.name,
                change_classes=[WatchChangeClass(c) for c in classes],
                item_ids=[item.item_id],
                frequency=settings().monitor_frequency,
            )
            await store.put_watch(watch)
            await store.put_holder(holder.model_copy(update={"watch_id": monitor_id}))
            existing[holder.holder_id] = watch
            armed.append(watch)

            await ledger_append(
                project_id,
                "sentinel",
                {
                    "type": "watch.armed",
                    "watch_id": monitor_id,
                    "subject": holder.name,
                    "change_classes": classes,
                    "item_id": item.item_id,
                },
            )
            await get_bus().publish(
                Envelope(
                    type=EventType.WATCH_ARMED,
                    project_id=project_id,
                    pass_id="sentinel",
                    item_id=item.item_id,
                    actor="sentinel",
                    payload={
                        "watch_id": monitor_id,
                        "subject": holder.name,
                        "change_classes": classes,
                    },
                )
            )

    for item in items:
        if item.status is ItemStatus.RESOLVED:
            await store.set_status(item.item_id, ItemStatus.MONITORED, force=True)

    log_event(log, "watches armed", project_id=project_id, count=len(armed))
    return armed


async def on_monitor_fired(env: Envelope) -> None:
    """Handler for monitor.fired — the beat that proves clearance is continuous."""
    store = get_store()
    monitor_id = env.payload.get("monitor_id", "")
    watch = await store.get_watch(monitor_id)
    if watch is None:
        log_event(log, "monitor event for unknown watch", monitor_id=monitor_id)
        return

    change = env.payload.get("change", {}) or {}
    if change.get("material") is False:
        # The monitor itself judged the change immaterial; record it and stop.
        await store.update_watch(watch.watch_id, last_checked_ts=utcnow().isoformat())
        await ledger_append(
            watch.project_id,
            "sentinel",
            {
                "type": "watch.checked",
                "watch_id": watch.watch_id,
                "material": False,
                "summary": change.get("summary", "")[:500],
            },
        )
        return

    await store.update_watch(
        watch.watch_id, last_checked_ts=utcnow().isoformat(), reopen_count=watch.reopen_count + 1
    )

    summary = change.get("summary") or env.payload.get("summary") or "a change was detected"
    event_id = env.payload.get("event_id")

    items = []
    for item_id in watch.item_ids:
        item = await store.get_item(item_id)
        if item is not None and item.status is not ItemStatus.WITHDRAWN:
            items.append(item)
    if not items:
        return

    # A reopen is a pass in its own right: it has items, a budget, and a feed the
    # war room can watch weeks after everyone went home.
    reopen_pass = await state.create_pass(
        watch.project_id, items[0].cut_id, PassMode.REOPEN, len(items)
    )

    for item in items:
        await _reopen(item, watch, summary, change, event_id, reopen_pass.pass_id)

    log_event(
        log,
        "monitor reopened items",
        watch_id=watch.watch_id,
        items=len(watch.item_ids),
        change_class=change.get("change_class"),
    )


async def _reopen(
    item: Item,
    watch: Watch,
    summary: str,
    change: dict,
    event_id: str | None,
    pass_id: str = "sentinel",
) -> None:
    store = get_store()
    await store.set_status(item.item_id, ItemStatus.REOPENED, force=True)
    await store.update_item(item.item_id, risk_state=RiskState.UNKNOWN.value)

    await ledger_append(
        watch.project_id,
        "sentinel",
        {
            "type": "item.reopened",
            "item_id": item.item_id,
            "watch_id": watch.watch_id,
            "change_class": change.get("change_class"),
            "summary": summary[:1000],
            "source_url": change.get("source_url"),
            "monitor_event_id": event_id,
        },
    )

    tier = 3 if change.get("change_class") == "litigation" else 2
    findings = await store.list_findings(item_id=item.item_id, live_only=True)
    prev_interaction = findings[-1].interaction_id if findings else None

    await get_bus().publish(
        Envelope(
            type=EventType.ITEM_REOPENED,
            project_id=watch.project_id,
            pass_id=pass_id,
            item_id=item.item_id,
            actor="sentinel",
            payload={
                "watch_id": watch.watch_id,
                "summary": summary,
                "change": change,
                "monitor_event_id": event_id,
                "alert": "counsel",
                "risk_state_was": item.risk_state,
            },
        )
    )

    # The follow-up inherits the monitor event's context, so the reopened
    # investigation carries its entire history rather than starting over.
    await dispatch.request_research(
        watch.project_id,
        pass_id,
        item,
        tier,
        objection=f"A monitored change may affect this item: {summary}",
        prev_interaction_id=event_id or prev_interaction,
        rationale=tiering.tier_rationale(item, None) + " — reopened by the night watch",
    )


async def alert_counsel(
    project_id: str, item_id: str, message: str, detail: dict | None = None
) -> None:
    """Counsel alerts are ledger events plus a feed line — never an outbound message."""
    await ledger_append(
        project_id,
        "sentinel",
        {
            "type": "counsel.alert",
            "item_id": item_id,
            "message": message[:1000],
            **(detail or {}),
        },
    )
    await get_store().push_feed(
        "sentinel",
        {
            "kind": "counsel.alert",
            "agent": "sentinel",
            "colour": "teal",
            "item_id": item_id,
            "message": message,
            "detail": detail or {},
        },
    )
