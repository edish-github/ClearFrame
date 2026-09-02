"""Findings and citations — the citation-required policy, enforced in code."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import Enum

from pydantic import BaseModel, Field


def utcnow() -> datetime:
    return datetime.now(UTC)


class Authority(str, Enum):
    REGISTRY = "registry"  # uspto.gov, copyright.gov, PRO databases
    COURT = "court"  # courtlistener, pacer, justia
    CORPORATE = "corporate"  # sec.gov, company filings, the holder's own site
    TRADE = "trade"  # variety, billboard, hollywoodreporter
    REFERENCE = "reference"  # wikipedia, discogs, musicbrainz
    OTHER = "other"


#: Ordering used by the Verifier's authority test — higher wins.
AUTHORITY_WEIGHT: dict[Authority, int] = {
    Authority.REGISTRY: 5,
    Authority.COURT: 5,
    Authority.CORPORATE: 4,
    Authority.TRADE: 3,
    Authority.REFERENCE: 2,
    Authority.OTHER: 1,
}


#: Minimum confidence a finding needs to enter verification at all.
MIN_CONFIDENCE = 0.35


class Citation(BaseModel):
    citation_id: str
    url: str
    title: str = ""
    excerpt: str = ""  # <= 200 chars, for the UI card
    fetched_ts: datetime = Field(default_factory=utcnow)
    published_date: str | None = None  # as reported by the source, when present
    snapshot_uri: str | None = None  # GCS — survives link rot
    authority: Authority = Authority.OTHER
    field: str | None = None  # which output field this citation supports

    @property
    def weight(self) -> int:
        return AUTHORITY_WEIGHT[self.authority]


class Finding(BaseModel):
    finding_id: str
    item_id: str
    project_id: str
    pass_id: str
    agent: str  # "music_rights" | "verifier" | ...
    claim: dict  # conforms to the specialist's Task schema
    confidence: float = Field(ge=0.0, le=1.0, default=0.5)
    citations: list[Citation] = Field(default_factory=list)
    interaction_id: str | None = None  # Parallel run id
    prev_interaction_id: str | None = None  # <- provenance chain
    superseded_by: str | None = None
    tier: int = 1
    cost_usd: float = 0.0
    ts: datetime = Field(default_factory=utcnow)

    def is_admissible(self) -> bool:
        """Citation-required policy, enforced in code, not in a prompt."""
        return len(self.citations) > 0 and self.confidence >= MIN_CONFIDENCE

    def inadmissible_reason(self) -> str | None:
        if not self.citations:
            return "no citations"
        if self.confidence < MIN_CONFIDENCE:
            return f"confidence {self.confidence:.2f} below floor {MIN_CONFIDENCE}"
        return None

    @property
    def strongest_authority(self) -> Authority:
        if not self.citations:
            return Authority.OTHER
        return max(self.citations, key=lambda c: c.weight).authority


class ChallengeGround(str, Enum):
    STALE = "stale"
    AUTHORITY = "authority"
    INDEPENDENCE = "independence"
    INCONSISTENT = "inconsistent"
    CONFLICT_UNRESOLVED = "conflict_unresolved"


class Challenge(BaseModel):
    challenge_id: str
    finding_id: str
    item_id: str
    project_id: str
    grounds: ChallengeGround
    rationale: str
    citations: list[Citation] = Field(default_factory=list)
    agent: str = "verifier"
    ts: datetime = Field(default_factory=utcnow)

    def is_valid(self) -> bool:
        """A challenge without cited grounds is invalid — no vetoes by vibe."""
        return bool(self.rationale.strip()) and len(self.citations) > 0


class VerdictAction(str, Enum):
    PASS = "verify_pass"
    CHALLENGE = "file_challenge"


class Verdict(BaseModel):
    action: VerdictAction
    finding_id: str
    grounds: ChallengeGround | None = None
    rationale: str = ""
    citations: list[Citation] = Field(default_factory=list)
