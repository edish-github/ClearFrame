"""FindAll — entity discovery that builds the rights-holder graph.

Outreach uses it to answer "who actually controls this catalog, and how is their
licensing desk reached" with match conditions rather than a guess.
"""

from __future__ import annotations

import asyncio
from typing import Any

from clearframe_runtime import get_logger, log_event

from .client import FINDALL_RESULT, FINDALL_RUNS, ParallelClient, get_client

log = get_logger("clearframe.adapter.findall")

TERMINAL = {"completed", "failed", "cancelled"}


async def create_findall(
    objective: str,
    match_conditions: list[dict],
    *,
    entity_type: str = "companies",
    generator: str = "core",
    match_limit: int = 10,
    exclude_list: list[str] | None = None,
    metadata: dict[str, str] | None = None,
    client: ParallelClient | None = None,
) -> dict:
    """POST /v1beta/findall/runs. Conditions are explicit, so matches are checkable."""
    body: dict[str, Any] = {
        "objective": objective,
        "entity_type": entity_type,
        "match_conditions": [
            {"name": c["name"][:64], "description": c["description"]} for c in match_conditions
        ],
        "generator": generator,
        "match_limit": max(5, min(match_limit, 1000)),
    }
    if exclude_list:
        body["exclude_list"] = exclude_list[:10000]
    if metadata:
        body["metadata"] = {k[:16]: str(v)[:512] for k, v in metadata.items()}

    run = await (client or get_client()).post(FINDALL_RUNS, body)
    log_event(
        log, "findall created", findall_id=run.get("findall_id"), conditions=len(match_conditions)
    )
    return run


async def get_findall_result(findall_id: str, *, client: ParallelClient | None = None) -> dict:
    return await (client or get_client()).get(FINDALL_RESULT.format(findall_id=findall_id))


def _status_of(payload: dict) -> str:
    status = payload.get("status")
    if isinstance(status, dict):
        return str(status.get("status", "unknown"))
    return str(status or "unknown")


async def find_rights_holders(
    objective: str,
    match_conditions: list[dict],
    *,
    generator: str = "core",
    match_limit: int = 10,
    poll_interval_s: float = 10.0,
    max_wait_s: float = 600.0,
    client: ParallelClient | None = None,
) -> dict:
    """Create a FindAll run and poll its result snapshot until the run settles."""
    client = client or get_client()
    run = await create_findall(
        objective,
        match_conditions,
        generator=generator,
        match_limit=match_limit,
        client=client,
    )
    findall_id = run.get("findall_id")
    if not findall_id:
        raise ValueError(f"findall run carried no findall_id: {run}")

    waited = 0.0
    result: dict = {}
    while waited < max_wait_s:
        result = await get_findall_result(findall_id, client=client)
        if _status_of(result) in TERMINAL:
            break
        await asyncio.sleep(poll_interval_s)
        waited += poll_interval_s
    result.setdefault("findall_id", findall_id)
    return result


def extract_matches(result: dict) -> list[dict]:
    """Normalize the result snapshot to a flat list of matches.

    The beta surface has moved field names before; accept the shapes it has used
    rather than crashing a pass over a rename.
    """
    for key in ("matches", "results", "entities", "candidates"):
        value = result.get(key)
        if isinstance(value, list):
            return value
    data = result.get("data")
    if isinstance(data, dict):
        for key in ("matches", "results", "entities"):
            if isinstance(data.get(key), list):
                return data[key]
    return []
