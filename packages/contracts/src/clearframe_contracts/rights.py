"""Rights holders, watches, and outreach drafts."""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field

from .findings import utcnow


class HolderKind(str, Enum):
    PUBLISHER = "publisher"
    LABEL = "label"
    ESTATE = "estate"
    TRADEMARK_OWNER = "trademark_owner"
    ARCHIVE = "archive"
    ARTIST = "artist"
    INDIVIDUAL = "individual"
    UNKNOWN = "unknown"


class Contact(BaseModel):
    name: str = ""
    role: str = ""
    email: str | None = None
    phone: str | None = None
    url: str | None = None
    source_url: str | None = None  # discovered where — never invented


class RightsHolder(BaseModel):
    holder_id: str
    name: str
    kind: HolderKind = HolderKind.UNKNOWN
    parent_id: str | None = None
    aliases: list[str] = Field(default_factory=list)
    contacts: list[Contact] = Field(default_factory=list)
    watch_id: str | None = None
    source_urls: list[str] = Field(default_factory=list)
    first_seen: datetime = Field(default_factory=utcnow)
    last_verified: datetime = Field(default_factory=utcnow)


class WatchChangeClass(str, Enum):
    CATALOG_TRANSFER = "catalog_transfer"
    LITIGATION = "litigation"
    BANKRUPTCY = "bankruptcy"
    RENAME_RESTRUCTURE = "rename_restructure"
    PROBATE = "probate"
    REPRESENTATION_CHANGE = "representation_change"
    TRADEMARK_STATUS = "trademark_status"
    OPPOSITION = "opposition"
    PROVENANCE_CORRECTION = "provenance_correction"
    TAKEDOWN = "takedown"
    COUNSEL_FLAG = "counsel_flag"


#: Reel 11's "what gets watched" table, as data the Sentinel can act on.
CHANGE_CLASSES_FOR_KIND: dict[HolderKind, list[WatchChangeClass]] = {
    HolderKind.PUBLISHER: [
        WatchChangeClass.CATALOG_TRANSFER,
        WatchChangeClass.LITIGATION,
        WatchChangeClass.BANKRUPTCY,
        WatchChangeClass.RENAME_RESTRUCTURE,
    ],
    HolderKind.LABEL: [
        WatchChangeClass.CATALOG_TRANSFER,
        WatchChangeClass.LITIGATION,
        WatchChangeClass.RENAME_RESTRUCTURE,
    ],
    HolderKind.ESTATE: [
        WatchChangeClass.PROBATE,
        WatchChangeClass.REPRESENTATION_CHANGE,
        WatchChangeClass.LITIGATION,
    ],
    HolderKind.TRADEMARK_OWNER: [
        WatchChangeClass.TRADEMARK_STATUS,
        WatchChangeClass.OPPOSITION,
        WatchChangeClass.LITIGATION,
    ],
    HolderKind.ARCHIVE: [
        WatchChangeClass.PROVENANCE_CORRECTION,
        WatchChangeClass.TAKEDOWN,
        WatchChangeClass.LITIGATION,
    ],
    HolderKind.ARTIST: [WatchChangeClass.LITIGATION, WatchChangeClass.REPRESENTATION_CHANGE],
    HolderKind.INDIVIDUAL: [WatchChangeClass.LITIGATION, WatchChangeClass.REPRESENTATION_CHANGE],
    HolderKind.UNKNOWN: [WatchChangeClass.LITIGATION, WatchChangeClass.CATALOG_TRANSFER],
}


class Watch(BaseModel):
    watch_id: str  # Parallel monitor_id
    project_id: str
    holder_id: str | None = None
    subject: str
    change_classes: list[WatchChangeClass] = Field(default_factory=list)
    item_ids: list[str] = Field(default_factory=list)
    frequency: str = "1d"
    status: str = "active"
    armed_ts: datetime = Field(default_factory=utcnow)
    last_checked_ts: datetime | None = None
    reopen_count: int = 0


class OutreachStatus(str, Enum):
    DRAFTED = "drafted"
    PENDING_APPROVAL = "pending_approval"
    APPROVED_QUEUED = "approved_queued"  # the queue IS the feature — nothing sends
    REJECTED = "rejected"


class OutreachDraft(BaseModel):
    outreach_id: str
    project_id: str
    item_id: str
    holder_id: str | None = None
    to_name: str = ""
    to_email: str | None = None
    contact_source_url: str | None = None
    subject: str = ""
    body: str = ""
    status: OutreachStatus = OutreachStatus.DRAFTED
    approved_by: str | None = None
    ts: datetime = Field(default_factory=utcnow)
