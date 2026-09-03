"""The hash chain. Auditability as schema, not as promise.

Sequence numbers are allocated through a transaction on a per-project counter
document rather than by reading the last row back out of BigQuery: streaming
inserts are not immediately readable, so a read-back allocator silently issues
duplicate sequence numbers under concurrency and breaks the chain it exists to
protect.
"""

from __future__ import annotations

import base64
import hashlib
import json

from clearframe_contracts import utcnow
from clearframe_runtime import get_logger, get_store, log_event

from .sink import LEDGER_EVENTS, get_sink

log = get_logger("clearframe.ledger.chain")

COUNTER_COLLECTION = "ledger_counters"


def compute_hash(prev_hash: bytes, event: dict) -> bytes:
    h = hashlib.sha256()
    h.update(prev_hash or b"")
    h.update(json.dumps(event, sort_keys=True, default=str).encode())
    return h.digest()


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


async def _next_slot(project_id: str) -> tuple[int, bytes]:
    """Allocate (seq, prev_hash) atomically for one project."""
    store = get_store()
    doc = await store.get(COUNTER_COLLECTION, project_id)
    if doc is None:
        await store.put(COUNTER_COLLECTION, project_id, {"seq": 0, "head_hash": ""})

    def _apply(current: dict) -> dict:
        current["seq"] = int(current.get("seq", 0)) + 1
        return current

    updated = await store.mutate(COUNTER_COLLECTION, project_id, _apply)
    head = updated.get("head_hash") or ""
    return int(updated["seq"]), base64.b64decode(head) if head else b""


async def _set_head(project_id: str, seq: int, head_hash: bytes) -> None:
    def _apply(current: dict) -> dict:
        current["head_hash"] = _b64(head_hash)
        current["head_seq"] = seq
        return current

    await get_store().mutate(COUNTER_COLLECTION, project_id, _apply)


async def append(project_id: str, actor: str, event: dict) -> dict:
    """Append one event. Returns the written row.

    The row's `event` always carries project_id, so the chain is reconstructible
    from the table alone.
    """
    payload = {**event, "project_id": project_id}
    seq, prev_hash = await _next_slot(project_id)
    event_hash = compute_hash(prev_hash, payload)
    row = {
        "seq": seq,
        "ts": utcnow().isoformat(),
        "actor": actor,
        "event": json.dumps(payload, default=str),
        "prev_hash": _b64(prev_hash),
        "event_hash": _b64(event_hash),
        "project_id": project_id,
    }
    get_sink().insert(LEDGER_EVENTS, [row])
    await _set_head(project_id, seq, event_hash)
    log_event(
        log,
        "ledger append",
        project_id=project_id,
        seq=seq,
        event_type=payload.get("type"),
        actor=actor,
    )
    return row


def read_chain(project_id: str) -> list[dict]:
    rows = get_sink().read(LEDGER_EVENTS, project_id=project_id)
    return sorted(rows, key=lambda r: int(r["seq"]))


def verify_chain(project_id: str) -> dict:
    """Recompute the chain. Runs in CI and once on camera during the demo."""
    rows = read_chain(project_id)
    prev = b""
    for index, row in enumerate(rows, start=1):
        if int(row["seq"]) != index:
            return {
                "valid": False,
                "reason": f"sequence gap at {row['seq']}",
                "checked": index,
                "events": len(rows),
            }
        event = row["event"]
        event = json.loads(event) if isinstance(event, str) else event
        expected = compute_hash(prev, event)
        if base64.b64decode(row["event_hash"]) != expected:
            return {
                "valid": False,
                "reason": f"hash mismatch at seq {row['seq']}",
                "checked": index,
                "events": len(rows),
            }
        prev = expected
    return {
        "valid": True,
        "reason": "",
        "checked": len(rows),
        "events": len(rows),
        "head_hash": _b64(prev) if rows else "",
    }
