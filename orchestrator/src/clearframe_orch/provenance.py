"""The chain-of-title graph, per item.

One song is two properties with separate chains; a mural is one chain with a
living author at the end of it. This turns whatever the specialists established
into nodes and edges the war room can draw, and every edge carries the source
that justifies it — an edge without a citation is not drawn.
"""

from __future__ import annotations

from typing import Any

from clearframe_contracts import Finding, Item, ItemType
from clearframe_runtime import get_store

COMPOSITION = "composition"
MASTER = "master"
SINGLE = "rights"


def _node(node_id: str, label: str, kind: str, **extra: Any) -> dict:
    return {"id": node_id, "label": label, "kind": kind, **extra}


def _chains_for(item_type: ItemType) -> list[str]:
    if item_type in (ItemType.MUSIC_CUE, ItemType.LYRIC_QUOTE):
        return [COMPOSITION, MASTER]
    return [SINGLE]


CHAIN_FIELDS = {
    COMPOSITION: ("composition_owner", "publisher_of_record"),
    MASTER: ("master_owner",),
    SINGLE: (
        "owner_of_record",
        "current_rights_holder",
        "rights_representative",
        "archive_or_agency",
        "creator",
    ),
}


async def build(item_id: str) -> dict[str, Any]:
    """Nodes, edges, and the open questions that keep a chain from resolving."""
    store = get_store()
    item = await store.get_item(item_id)
    if item is None:
        raise KeyError(f"item {item_id} not found")
    findings = await store.list_findings(item_id=item_id, live_only=True)

    nodes: list[dict] = [
        _node(
            item.item_id,
            item.title,
            "item",
            item_type=item.type.value,
            scene=item.timecode.scene,
            tc_in=item.timecode.tc_in,
        )
    ]
    edges: list[dict] = []
    open_questions: list[str] = []
    seen_nodes: set[str] = {item.item_id}

    def add_node(node: dict) -> str:
        if node["id"] not in seen_nodes:
            nodes.append(node)
            seen_nodes.add(node["id"])
        return node["id"]

    for chain in _chains_for(item.type):
        chain_id = f"{item.item_id}:{chain}"
        add_node(_node(chain_id, chain, "chain"))
        edges.append({"from": item.item_id, "to": chain_id, "kind": "has_chain", "sources": []})

        for finding in findings:
            for field in CHAIN_FIELDS[chain]:
                name = finding.claim.get(field)
                if not isinstance(name, str) or not name.strip():
                    continue
                holder_id = f"holder:{name.strip().lower()}"
                add_node(
                    _node(
                        holder_id,
                        name.strip(),
                        "holder",
                        role=field,
                        agent=finding.agent,
                        confidence=finding.confidence,
                    )
                )
                edges.append(
                    {
                        "from": chain_id,
                        "to": holder_id,
                        "kind": "controlled_by",
                        "field": field,
                        "confidence": finding.confidence,
                        "sources": [c.url for c in finding.citations if c.field in (field, None)][
                            :4
                        ],
                    }
                )

    for finding in findings:
        for transfer in finding.claim.get("catalog_transfers") or []:
            if not isinstance(transfer, dict):
                continue
            source = transfer.get("from")
            target = transfer.get("to")
            if not (source and target):
                continue
            from_id = add_node(_node(f"holder:{str(source).lower()}", str(source), "holder"))
            to_id = add_node(_node(f"holder:{str(target).lower()}", str(target), "holder"))
            edges.append(
                {
                    "from": from_id,
                    "to": to_id,
                    "kind": "transferred",
                    "year": transfer.get("year"),
                    "chain": transfer.get("chain"),
                    "sources": [transfer.get("source_url")] if transfer.get("source_url") else [],
                }
            )

        for signal in finding.claim.get("litigation_signals") or []:
            if not isinstance(signal, dict):
                continue
            node_id = f"litigation:{abs(hash(signal.get('summary', ''))) % 10**10}"
            add_node(
                _node(
                    node_id,
                    signal.get("summary", "dispute")[:120],
                    "litigation",
                    status=signal.get("status"),
                    source=signal.get("source_url"),
                )
            )
            for party in signal.get("parties") or []:
                party_id = f"holder:{str(party).lower()}"
                if party_id in seen_nodes:
                    edges.append(
                        {
                            "from": party_id,
                            "to": node_id,
                            "kind": "party_to",
                            "sources": [signal.get("source_url")],
                        }
                    )
            if not (signal.get("parties") or []):
                edges.append(
                    {
                        "from": f"{item.item_id}:{_chains_for(item.type)[0]}",
                        "to": node_id,
                        "kind": "encumbers",
                        "sources": [signal.get("source_url")],
                    }
                )

        open_questions.extend(
            q for q in finding.claim.get("unresolved_questions") or [] if isinstance(q, str)
        )
        if finding.claim.get("conflicting_sources"):
            open_questions.append(
                finding.claim.get("conflict_note")
                or "Sources disagree about control; both positions are reported."
            )

    return {
        "item_id": item.item_id,
        "title": item.title,
        "type": item.type.value,
        "risk_state": item.risk_state or "unknown",
        "chains": _chains_for(item.type),
        "nodes": nodes,
        "edges": edges,
        "open_questions": sorted(set(open_questions)),
        "resolved": _is_resolved(item, findings),
    }


def _is_resolved(item: Item, findings: list[Finding]) -> dict[str, bool]:
    """Which chains actually landed on a named controller. For music, both must."""
    resolved: dict[str, bool] = {}
    for chain in _chains_for(item.type):
        resolved[chain] = any(
            isinstance(finding.claim.get(field), str)
            and finding.claim[field].strip().lower()
            not in {"", "unknown", "n/a", "not found", "undetermined"}
            for finding in findings
            for field in CHAIN_FIELDS[chain]
        )
    return resolved
