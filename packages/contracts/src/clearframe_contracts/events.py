"""Every Pub/Sub envelope in one place."""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field

from .findings import utcnow


class EventType(str, Enum):
    PASS_STARTED = "pass.started"
    ITEM_QUEUED = "item.queued"
    RESEARCH_REQUESTED = "research.requested"
    RESEARCH_COMPLETED = "research.completed"  # carries tier + cost, feeds §9.2
    FINDING_ADDED = "finding.added"
    CHALLENGE_FILED = "challenge.filed"
    VERIFY_PASSED = "verify.passed"
    RISK_SCORED = "risk.scored"
    APPROVAL_REQUIRED = "approval.required"
    DECISION_MADE = "decision.made"
    OUTREACH_QUEUED = "outreach.queued"
    WATCH_ARMED = "watch.armed"
    MONITOR_FIRED = "monitor.fired"
    ITEM_REOPENED = "item.reopened"
    ITEM_ESCALATED = "item.escalated"
    DELTA_COMPUTED = "delta.computed"
    REPORT_RENDERED = "report.rendered"
    PASS_COMPLETED = "pass.completed"
    PASS_PAUSED = "pass.paused"


#: Which Pub/Sub topic each event travels on (§6.2).
TOPIC_FOR_EVENT: dict[EventType, str] = {
    EventType.RESEARCH_REQUESTED: "research",
    EventType.FINDING_ADDED: "findings",
    EventType.RESEARCH_COMPLETED: "findings",
    EventType.CHALLENGE_FILED: "findings",
    EventType.VERIFY_PASSED: "findings",
    EventType.RISK_SCORED: "findings",
    EventType.APPROVAL_REQUIRED: "decisions",
    EventType.DECISION_MADE: "decisions",
    EventType.OUTREACH_QUEUED: "decisions",
    EventType.MONITOR_FIRED: "monitor",
    EventType.ITEM_REOPENED: "monitor",
}


class Envelope(BaseModel):
    event_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    type: EventType
    project_id: str
    pass_id: str
    item_id: str | None = None
    actor: str  # agent role or human principal
    payload: dict = Field(default_factory=dict)
    ts: datetime = Field(default_factory=utcnow)

    def topic(self) -> str:
        return TOPIC_FOR_EVENT.get(self.type, "findings")
