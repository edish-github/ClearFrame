"""Risk states, mitigations, and the approval gate."""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field

from .findings import Citation, utcnow


class RiskState(str, Enum):
    GREEN = "green"  # clear / de minimis
    AMBER = "amber"  # license or alter
    RED = "red"  # blocking exposure
    UNKNOWN = "unknown"


class MitigationKind(str, Enum):
    LICENSE = "license"
    REPLACE = "replace"
    ALTER = "alter"
    REMOVE = "remove"
    FAIR_USE_MEMO = "fair_use_memo"
    NO_ACTION = "no_action"


class Mitigation(BaseModel):
    mitigation_id: str
    kind: MitigationKind
    summary: str
    cost_delta_usd: float = 0.0
    production_impact: str = ""
    recommended: bool = False


#: Every Risk Counsel output carries this. It is a product feature, not a disclaimer.
NOT_LEGAL_ADVICE = "Research and drafting for review by production counsel. Not legal advice."


class RiskAssessment(BaseModel):
    assessment_id: str
    item_id: str
    project_id: str
    pass_id: str
    risk_state: RiskState
    rationale: str
    grounding_refs: list[str] = Field(default_factory=list)  # data-store passages cited
    citations: list[Citation] = Field(default_factory=list)
    mitigations: list[Mitigation] = Field(default_factory=list)
    requires_approval: bool = False
    disclaimer: str = NOT_LEGAL_ADVICE
    agent: str = "risk_counsel"
    ts: datetime = Field(default_factory=utcnow)

    def gate_required(self) -> bool:
        """Red items always gate. Amber gates when a mitigation costs money."""
        if self.risk_state is RiskState.RED:
            return True
        if self.risk_state is RiskState.AMBER:
            return any(m.cost_delta_usd > 0 for m in self.mitigations)
        return False
