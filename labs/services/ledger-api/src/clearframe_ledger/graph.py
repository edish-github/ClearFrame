"""The rights-holder graph — the asset that compounds across productions."""

from __future__ import annotations

from clearframe_contracts import Contact, HolderKind, RightsHolder, utcnow
from clearframe_runtime import get_store
from clearframe_runtime.ids import holder_id as new_holder_id

from .sink import RIGHTS_HOLDERS, get_sink

#: Claim fields that name a controlling entity, and the kind each implies.
HOLDER_FIELDS: list[tuple[str, HolderKind]] = [
    ("composition_owner", HolderKind.PUBLISHER),
    ("publisher_of_record", HolderKind.PUBLISHER),
    ("master_owner", HolderKind.LABEL),
    ("owner_of_record", HolderKind.TRADEMARK_OWNER),
    ("rights_representative", HolderKind.ESTATE),
    ("current_rights_holder", HolderKind.ARCHIVE),
    ("archive_or_agency", HolderKind.ARCHIVE),
    ("creator", HolderKind.ARTIST),
]

#: Values that mean "we did not find one" — never create a holder for these.
NULL_NAMES = {
    "",
    "unknown",
    "n/a",
    "na",
    "none",
    "not found",
    "undetermined",
    "not established",
    "unclear",
}


def is_real_name(name: str | None) -> bool:
    return bool(name) and name.strip().lower() not in NULL_NAMES


async def upsert_holder(
    name: str,
    kind: HolderKind,
    *,
    source_urls: list[str] | None = None,
    contacts: list[Contact] | None = None,
    parent_id: str | None = None,
    aliases: list[str] | None = None,
) -> RightsHolder:
    """One node per entity, merged by name. Re-verification refreshes the timestamp."""
    store = get_store()
    existing = await store.find_holder_by_name(name)
    if existing:
        merged_urls = sorted({*existing.source_urls, *(source_urls or [])})
        merged_aliases = sorted({*existing.aliases, *(aliases or [])})
        known = {(c.email, c.name) for c in existing.contacts}
        merged_contacts = existing.contacts + [
            c for c in (contacts or []) if (c.email, c.name) not in known
        ]
        holder = existing.model_copy(
            update={
                "kind": existing.kind if existing.kind is not HolderKind.UNKNOWN else kind,
                "source_urls": merged_urls,
                "aliases": merged_aliases,
                "contacts": merged_contacts,
                "parent_id": parent_id or existing.parent_id,
                "last_verified": utcnow(),
            }
        )
    else:
        holder = RightsHolder(
            holder_id=new_holder_id(),
            name=name.strip(),
            kind=kind,
            source_urls=sorted(set(source_urls or [])),
            contacts=contacts or [],
            parent_id=parent_id,
            aliases=aliases or [],
        )

    await store.put_holder(holder)
    get_sink().insert(RIGHTS_HOLDERS, [holder.model_dump(mode="json")])
    return holder


async def holders_from_claim(claim: dict, source_urls: list[str]) -> list[RightsHolder]:
    """Every entity a finding names becomes a graph node with its sources attached."""
    seen: set[str] = set()
    holders: list[RightsHolder] = []
    for field, kind in HOLDER_FIELDS:
        name = claim.get(field)
        if not isinstance(name, str) or not is_real_name(name):
            continue
        key = name.strip().lower()
        if key in seen:
            continue
        seen.add(key)
        holders.append(await upsert_holder(name, kind, source_urls=source_urls))
    return holders


async def link_parent(child_id: str, parent_id: str) -> None:
    """Corporate parentage discovered by FindAll — the graph's only edge type today."""
    await get_store().put_holder(
        (await get_store().get_holder(child_id)).model_copy(update={"parent_id": parent_id})
    )


async def holders_for_items(item_ids: list[str]) -> dict[str, list[RightsHolder]]:
    """Which holders each item's live findings name — drives watch arming."""
    store = get_store()
    out: dict[str, list[RightsHolder]] = {}
    for item_id in item_ids:
        names: set[str] = set()
        for finding in await store.list_findings(item_id=item_id, live_only=True):
            for field, _kind in HOLDER_FIELDS:
                value = finding.claim.get(field)
                if isinstance(value, str) and is_real_name(value):
                    names.add(value.strip())
        resolved = [await store.find_holder_by_name(n) for n in sorted(names)]
        out[item_id] = [h for h in resolved if h]
    return out
