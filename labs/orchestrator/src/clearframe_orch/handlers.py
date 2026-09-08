"""Wiring the crew to the event spine.

One registration function, used identically by the local runner and by the Cloud
Run push subscriptions — so a laptop rehearsal exercises the same routing the
deployed system uses.
"""

from __future__ import annotations

from clearframe_contracts import Envelope, EventType
from clearframe_runtime import EventBus, get_bus, get_logger, get_store, log_event

from . import challenge, dispatch, outreach, riskcounsel, sentinel

log = get_logger("clearframe.handlers")

ROUTES = {
    EventType.RESEARCH_REQUESTED: dispatch.handle_research,
    EventType.FINDING_ADDED: challenge.on_finding,
    EventType.VERIFY_PASSED: riskcounsel.on_verified,
    EventType.APPROVAL_REQUIRED: outreach.on_approval_required,
    EventType.DECISION_MADE: riskcounsel.on_decision,
    EventType.MONITOR_FIRED: sentinel.on_monitor_fired,
}


#: Events the war room shows even though no agent acts on them.
FEED_ONLY = [
    EventType.PASS_STARTED,
    EventType.RISK_SCORED,
    EventType.CHALLENGE_FILED,
    EventType.OUTREACH_QUEUED,
    EventType.WATCH_ARMED,
    EventType.ITEM_REOPENED,
    EventType.ITEM_ESCALATED,
    EventType.DELTA_COMPUTED,
    EventType.PASS_COMPLETED,
    EventType.PASS_PAUSED,
    EventType.REPORT_RENDERED,
    EventType.APPROVAL_REQUIRED,
    EventType.DECISION_MADE,
    EventType.MONITOR_FIRED,
]

FEED_COLOUR = {
    "verifier": "teal",
    "risk_counsel": "rose",
    "sentinel": "teal",
    "1st_ad": "amber",
    "outreach": "sky",
}


async def project_to_feed(env: Envelope) -> None:
    """Every event the UI needs, in one place, so no handler has to remember."""
    await get_store().push_feed(
        env.pass_id,
        {
            "event_id": env.event_id,
            "kind": env.type.value,
            "agent": env.actor,
            "colour": FEED_COLOUR.get(env.actor, "slate"),
            "item_id": env.item_id,
            "message": _headline(env),
            "detail": env.payload,
            "ts": env.ts.isoformat(),
        },
    )


def _headline(env: Envelope) -> str:
    payload = env.payload
    match env.type:
        case EventType.PASS_STARTED:
            return f"pass started — {payload.get('items', 0)} items ({payload.get('mode')})"
        case EventType.CHALLENGE_FILED:
            challenge = payload.get("challenge", {})
            return f"challenge filed — {challenge.get('grounds')}: {challenge.get('rationale', '')[:160]}"
        case EventType.RISK_SCORED:
            return f"risk scored {str(payload.get('assessment', {}).get('risk_state', '')).upper()}"
        case EventType.APPROVAL_REQUIRED:
            if payload.get("reason") == "budget_cap_reached":
                return (
                    f"budget cap reached — ${payload.get('spent_usd', 0):.2f} of "
                    f"${payload.get('cap_usd', 0):.2f}; producer approval needed"
                )
            return f"counsel approval required — {payload.get('risk_state', '')}"
        case EventType.DECISION_MADE:
            decision = payload.get("decision", {})
            return f"{decision.get('iam_role')} {decision.get('action')} — {decision.get('rationale', '')[:140]}"
        case EventType.WATCH_ARMED:
            return f"watch armed on {payload.get('subject')}"
        case EventType.MONITOR_FIRED:
            return f"monitor fired — {payload.get('summary', '')[:160]}"
        case EventType.ITEM_REOPENED:
            return f"item reopened — {payload.get('summary', '')[:160]}"
        case EventType.ITEM_ESCALATED:
            return f"escalated to a human — {payload.get('reason', '')}"
        case EventType.OUTREACH_QUEUED:
            return "licence inquiry queued for counsel approval"
        case EventType.PASS_COMPLETED:
            return (
                f"pass complete — {payload.get('cleared_items', 0)} cleared, "
                f"{payload.get('open_items', 0)} open"
            )
        case EventType.PASS_PAUSED:
            return f"pass paused — {payload.get('reason', '')}"
        case _:
            return env.type.value


def register(bus: EventBus | None = None) -> EventBus:
    bus = bus or get_bus()
    for event_type, handler in ROUTES.items():
        if handler not in bus.handlers_for(event_type):
            bus.on(event_type, handler)
    for event_type in {*ROUTES, *FEED_ONLY}:
        if project_to_feed not in bus.handlers_for(event_type):
            bus.on(event_type, project_to_feed)
    return bus


async def route(envelope: Envelope) -> None:
    """Deliver one envelope to its handler — the Pub/Sub push path."""
    handler = ROUTES.get(envelope.type)
    if handler is None:
        log_event(log, "unrouted event", event_type=envelope.type.value)
        return
    await handler(envelope)
