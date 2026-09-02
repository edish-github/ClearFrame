"""ClearFrame shared contracts.

Every service, agent, and the web app import these shapes. A schema change is a
change here first, then everywhere else in the same commit.
"""

from .events import TOPIC_FOR_EVENT, Envelope, EventType
from .findings import (
    AUTHORITY_WEIGHT,
    MIN_CONFIDENCE,
    Authority,
    Challenge,
    ChallengeGround,
    Citation,
    Finding,
    Verdict,
    VerdictAction,
    utcnow,
)
from .items import TRANSITIONS, Item, ItemStatus, ItemType, Prominence, Timecode, can_transition
from .passes import BudgetState, Cut, Pass, PassMode, PassStatus, Project
from .rights import (
    CHANGE_CLASSES_FOR_KIND,
    Contact,
    HolderKind,
    OutreachDraft,
    OutreachStatus,
    RightsHolder,
    Watch,
    WatchChangeClass,
)
from .risk import (
    NOT_LEGAL_ADVICE,
    Mitigation,
    MitigationKind,
    RiskAssessment,
    RiskState,
)
from .roles import (
    CAPABILITIES,
    Capability,
    Decision,
    DecisionAction,
    Principal,
    Role,
    can,
)
from .schema_registry import SCHEMA_FOR_TYPE, load_schema, schema_for, schema_name_for

__all__ = [
    "AUTHORITY_WEIGHT",
    "Authority",
    "BudgetState",
    "CAPABILITIES",
    "CHANGE_CLASSES_FOR_KIND",
    "Capability",
    "Challenge",
    "ChallengeGround",
    "Citation",
    "Contact",
    "Cut",
    "Decision",
    "DecisionAction",
    "Envelope",
    "EventType",
    "Finding",
    "HolderKind",
    "Item",
    "ItemStatus",
    "ItemType",
    "MIN_CONFIDENCE",
    "Mitigation",
    "MitigationKind",
    "NOT_LEGAL_ADVICE",
    "OutreachDraft",
    "OutreachStatus",
    "Pass",
    "PassMode",
    "PassStatus",
    "Principal",
    "Project",
    "Prominence",
    "RightsHolder",
    "RiskAssessment",
    "RiskState",
    "Role",
    "SCHEMA_FOR_TYPE",
    "TOPIC_FOR_EVENT",
    "TRANSITIONS",
    "Timecode",
    "Verdict",
    "VerdictAction",
    "Watch",
    "WatchChangeClass",
    "can",
    "can_transition",
    "load_schema",
    "schema_for",
    "schema_name_for",
    "utcnow",
]
