"""FindAll matches -> rights-holder graph nodes with contacts attached."""

from __future__ import annotations

from typing import Any

from clearframe_contracts import Contact, HolderKind, RightsHolder
from clearframe_ledger import graph
from clearframe_runtime import get_logger, log_event

log = get_logger("clearframe.enrichment")

KIND_HINTS: list[tuple[HolderKind, tuple[str, ...]]] = [
    (HolderKind.PUBLISHER, ("publishing", "publisher", "songs", "music group")),
    (HolderKind.LABEL, ("records", "recordings", "label")),
    (HolderKind.ESTATE, ("estate", "trust", "heirs")),
    (HolderKind.ARCHIVE, ("archive", "collection", "library", "museum", "stock")),
    (HolderKind.TRADEMARK_OWNER, ("brands", "holdings", "ip", "trademark")),
]


def infer_kind(name: str, description: str = "") -> HolderKind:
    blob = f"{name} {description}".lower()
    for kind, hints in KIND_HINTS:
        if any(hint in blob for hint in hints):
            return kind
    return HolderKind.UNKNOWN


def _first_str(source: dict, *keys: str) -> str:
    for key in keys:
        value = source.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def contacts_from_match(match: dict) -> list[Contact]:
    """Read whatever enrichment shape came back without inventing anything.

    Only fields the payload actually carries become contacts; a missing email is
    a missing email, never a guessed one.
    """
    blocks: list[dict] = []
    for key in ("enrichments", "enrichment", "attributes", "fields", "data"):
        value = match.get(key)
        if isinstance(value, dict):
            blocks.append(value)
        elif isinstance(value, list):
            blocks.extend(b for b in value if isinstance(b, dict))
    blocks.append(match)

    contacts: list[Contact] = []
    for block in blocks:
        email = _first_str(block, "email", "contact_email", "licensing_email")
        name = _first_str(block, "contact_name", "name", "licensing_contact")
        phone = _first_str(block, "phone", "telephone", "contact_phone")
        url = _first_str(block, "contact_url", "website", "url", "homepage")
        source = _first_str(block, "source_url", "citation_url", "url")
        if not any((email, phone, name and url)):
            continue
        contacts.append(
            Contact(
                name=name,
                role=_first_str(block, "role", "title") or "licensing",
                email=email or None,
                phone=phone or None,
                url=url or None,
                source_url=source or None,
            )
        )
    return contacts


async def ingest_findall_matches(matches: list[dict[str, Any]]) -> list[RightsHolder]:
    holders: list[RightsHolder] = []
    for match in matches:
        name = _first_str(match, "name", "entity_name", "company_name", "title")
        if not name:
            continue
        description = _first_str(match, "description", "summary", "reasoning")
        source_urls = [
            u
            for u in (
                _first_str(match, "url", "website", "homepage"),
                _first_str(match, "source_url"),
            )
            if u
        ]
        holder = await graph.upsert_holder(
            name,
            infer_kind(name, description),
            source_urls=source_urls,
            contacts=contacts_from_match(match),
        )
        holders.append(holder)
    log_event(log, "findall ingested", matches=len(matches), holders=len(holders))
    return holders
