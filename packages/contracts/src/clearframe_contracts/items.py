"""Items — one clearable element extracted from a cut or a script."""

from __future__ import annotations

import hashlib
import json
from enum import Enum

from pydantic import BaseModel, Field


class ItemType(str, Enum):
    MUSIC_CUE = "music_cue"  # a song use — two chains, always
    LYRIC_QUOTE = "lyric_quote"
    BRAND = "brand"  # visible trademark, logo, packaging
    ARTWORK = "artwork"  # painting, mural, poster, photograph
    LIKENESS = "likeness"  # real person depicted or named
    FOOTAGE = "footage"  # archival / stock
    LOCATION = "location"
    FONT = "font"


class Prominence(str, Enum):
    BACKGROUND = "background"
    FEATURED = "featured"
    HERO = "hero"


class ItemStatus(str, Enum):
    """The state machine of FIG. 07. Transitions are enforced by `can_transition`."""

    EXTRACTED = "extracted"
    QUEUED = "queued"
    RECON = "recon"
    RESEARCHING = "researching"
    CONTESTED = "contested"
    VERIFIED = "verified"
    RISK_SCORED = "risk_scored"
    PENDING_APPROVAL = "pending_approval"
    RESOLVED = "resolved"
    MONITORED = "monitored"
    REOPENED = "reopened"
    WITHDRAWN = "withdrawn"
    ESCALATED = "escalated"  # MAX_CHALLENGES hit — a human must look
    FAILED = "failed"  # research could not complete; reported, never hidden


#: Legal transitions. Anything not listed here is a bug, not a state.
TRANSITIONS: dict[ItemStatus, set[ItemStatus]] = {
    ItemStatus.EXTRACTED: {ItemStatus.QUEUED, ItemStatus.WITHDRAWN},
    ItemStatus.QUEUED: {
        ItemStatus.RECON,
        ItemStatus.RESEARCHING,
        ItemStatus.WITHDRAWN,
        ItemStatus.FAILED,
    },
    ItemStatus.RECON: {ItemStatus.RESEARCHING, ItemStatus.FAILED, ItemStatus.WITHDRAWN},
    ItemStatus.RESEARCHING: {
        ItemStatus.CONTESTED,
        ItemStatus.VERIFIED,
        ItemStatus.RESEARCHING,
        ItemStatus.ESCALATED,
        ItemStatus.FAILED,
        ItemStatus.WITHDRAWN,
    },
    ItemStatus.CONTESTED: {ItemStatus.RESEARCHING, ItemStatus.ESCALATED, ItemStatus.FAILED},
    ItemStatus.VERIFIED: {ItemStatus.RISK_SCORED, ItemStatus.CONTESTED, ItemStatus.FAILED},
    ItemStatus.RISK_SCORED: {ItemStatus.PENDING_APPROVAL, ItemStatus.RESOLVED},
    ItemStatus.PENDING_APPROVAL: {
        ItemStatus.RESOLVED,
        ItemStatus.RESEARCHING,
        ItemStatus.ESCALATED,
    },
    ItemStatus.RESOLVED: {ItemStatus.MONITORED, ItemStatus.REOPENED},
    ItemStatus.MONITORED: {ItemStatus.REOPENED},
    ItemStatus.REOPENED: {ItemStatus.RESEARCHING, ItemStatus.RECON},
    ItemStatus.ESCALATED: {ItemStatus.RESEARCHING, ItemStatus.RESOLVED, ItemStatus.RISK_SCORED},
    ItemStatus.FAILED: {ItemStatus.QUEUED, ItemStatus.RESEARCHING, ItemStatus.WITHDRAWN},
    ItemStatus.WITHDRAWN: set(),
}


def can_transition(src: ItemStatus, dst: ItemStatus) -> bool:
    return dst in TRANSITIONS.get(src, set())


class Timecode(BaseModel):
    frame_in: int = 0
    frame_out: int = 0
    fps: float = 24.0
    scene: str | None = None
    page: int | None = None  # script passes have pages, not frames

    def _tc(self, frame: int) -> str:
        fps = int(self.fps) or 24
        s, f = divmod(max(frame, 0), fps)
        m, s = divmod(s, 60)
        h, m = divmod(m, 60)
        return f"{h:02d}:{m:02d}:{s:02d}:{f:02d}"

    @property
    def tc_in(self) -> str:
        return self._tc(self.frame_in)

    @property
    def tc_out(self) -> str:
        return self._tc(self.frame_out)

    @property
    def seconds_in(self) -> float:
        return self.frame_in / (self.fps or 24.0)


class Item(BaseModel):
    item_id: str
    cut_id: str
    project_id: str
    type: ItemType
    title: str  # "Blue Hour (cover) — montage"
    description: str  # what the Breakdown agent saw
    timecode: Timecode = Timecode()
    prominence: Prominence = Prominence.BACKGROUND
    content_hash: str = ""
    status: ItemStatus = ItemStatus.EXTRACTED
    risk_state: str | None = None
    challenge_count: int = 0
    tier_reached: int = 0
    attrs: dict = Field(default_factory=dict)  # type-specific extraction detail
    inherited_from: str | None = None  # delta pass provenance

    def compute_hash(self) -> str:
        """Stable across cuts. Drives delta re-clearance.

        Deliberately excludes timecode: a scene that moves is not a new item.
        """
        payload = json.dumps(
            {
                "t": self.type.value,
                "ti": self.title.strip().lower(),
                "d": self.description.strip().lower(),
                "p": self.prominence.value,
            },
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode()).hexdigest()[:16]

    def with_hash(self) -> Item:
        return self.model_copy(update={"content_hash": self.compute_hash()})
