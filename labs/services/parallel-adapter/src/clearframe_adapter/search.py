"""Search + Extract — T0 recon on every item, cheaply.

These two also reach the crews through Parallel's managed MCP server registered
as an Agent Builder tool; this module is the same surface for code paths that
run outside a playbook (the Verifier's independent re-search, snapshotting).
"""

from __future__ import annotations

from typing import Any

from .client import EXTRACT, SEARCH, ParallelClient, get_client


async def search(
    objective: str,
    search_queries: list[str],
    *,
    max_results: int = 8,
    max_chars_total: int | None = 6000,
    source_policy: dict | None = None,
    client: ParallelClient | None = None,
) -> dict:
    """POST /v1/search — returns {search_id, results:[{url,title,publish_date,excerpts}]}."""
    body: dict[str, Any] = {
        "objective": objective,
        "search_queries": [q[:120] for q in search_queries][:8],
        "max_results": max_results,
    }
    if max_chars_total:
        body["max_chars_total"] = max_chars_total
    if source_policy:
        body["source_policy"] = source_policy
    return await (client or get_client()).post(SEARCH, body)


async def extract(
    urls: list[str],
    *,
    objective: str | None = None,
    search_queries: list[str] | None = None,
    full_content: bool = False,
    max_chars_total: int | None = 12000,
    client: ParallelClient | None = None,
) -> dict:
    """POST /v1/extract — clean markdown for up to 20 URLs, JS pages and PDFs included."""
    body: dict[str, Any] = {"urls": urls[:20]}
    if objective:
        body["objective"] = objective
    if search_queries:
        body["search_queries"] = search_queries[:8]
    if max_chars_total:
        body["max_chars_total"] = max_chars_total
    if full_content:
        body["advanced_settings"] = {"full_content": True}
    return await (client or get_client()).post(EXTRACT, body)
