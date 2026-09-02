"""Personas, capabilities, and the decisions they may take (Reel 05)."""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field

from .findings import utcnow


class Role(str, Enum):
    PRODUCER = "producer"
    COORDINATOR = "coordinator"
    COUNSEL = "counsel"
    REVIEWER = "reviewer"


class Capability(str, Enum):
    UPLOAD_CUT = "upload_cut"
    START_PASS = "start_pass"
    SET_BUDGET = "set_budget"
    EDIT_ITEM = "edit_item"
    APPROVE_RED = "approve_red"
    APPROVE_OUTREACH = "approve_outreach"
    SIGN_REPORT = "sign_report"
    READ = "read"


#: Server-side authority map. The web app mirrors it for affordances; the API enforces it.
CAPABILITIES: dict[Role, set[Capability]] = {
    Role.PRODUCER: {
        Capability.UPLOAD_CUT,
        Capability.START_PASS,
        Capability.SET_BUDGET,
        Capability.READ,
    },
    Role.COORDINATOR: {Capability.EDIT_ITEM, Capability.READ},
    Role.COUNSEL: {
        Capability.APPROVE_RED,
        Capability.APPROVE_OUTREACH,
        Capability.SIGN_REPORT,
        Capability.EDIT_ITEM,
        Capability.READ,
    },
    Role.REVIEWER: {Capability.READ},
}


def can(role: Role, capability: Capability) -> bool:
    return capability in CAPABILITIES.get(role, set())


class Principal(BaseModel):
    """Resolved from the IAP/OIDC token by the API — never from the request body."""

    subject: str  # email or service identity
    role: Role
    project_ids: list[str] = Field(default_factory=list)

    def may(self, capability: Capability) -> bool:
        return can(self.role, capability)


class DecisionAction(str, Enum):
    APPROVE_MITIGATION = "approve_mitigation"
    REJECT_MITIGATION = "reject_mitigation"
    APPROVE_OUTREACH = "approve_outreach"
    REJECT_OUTREACH = "reject_outreach"
    REQUEST_REINVESTIGATION = "request_reinvestigation"
    SIGN_REPORT = "sign_report"
    RAISE_BUDGET = "raise_budget"
    FLAG_FOR_WATCH = "flag_for_watch"


class Decision(BaseModel):
    decision_id: str
    project_id: str
    item_id: str | None = None
    actor: str  # human principal — never an agent
    iam_role: Role
    action: DecisionAction
    rationale: str
    target_id: str | None = None  # mitigation_id / outreach_id / report_id
    ts: datetime = Field(default_factory=utcnow)
