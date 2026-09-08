"""Citation snapshots — the report's evidence has to survive link rot.

Extract renders the cited page to markdown at fetch time; the markdown lands in
Cloud Storage and the citation carries its URI. Snapshots are of public web
pages, never of production material.
"""

from __future__ import annotations

from clearframe_contracts import Citation
from clearframe_runtime import get_blobs, get_logger, log_event, settings, snapshot_path

from .client import ParallelClient
from .search import extract

log = get_logger("clearframe.adapter.snapshots")


async def snapshot_citations(
    citations: list[Citation],
    project_id: str,
    *,
    client: ParallelClient | None = None,
    max_urls: int = 20,
) -> list[Citation]:
    """Fetch and store a copy of every cited page. Failures degrade visibly:
    the citation keeps its URL and simply has no snapshot."""
    targets = [c for c in citations if c.url and not c.snapshot_uri][:max_urls]
    if not targets:
        return citations

    try:
        payload = await extract(
            [c.url for c in targets],
            objective="Preserve the page content that supports a rights-clearance citation",
            full_content=True,
            client=client,
        )
    except Exception as exc:  # noqa: BLE001 — a missing snapshot is not a failed pass
        log_event(log, "snapshot failed", project_id=project_id, error=repr(exc))
        return citations

    by_url = {r.get("url"): r for r in payload.get("results", []) if r.get("url")}
    blobs = get_blobs()
    bucket = settings().bucket_snapshots

    updated: list[Citation] = []
    for citation in citations:
        result = by_url.get(citation.url)
        if not result or citation.snapshot_uri:
            updated.append(citation)
            continue
        body = result.get("full_content") or "\n\n".join(result.get("excerpts") or [])
        if not body:
            updated.append(citation)
            continue
        document = (
            f"# {result.get('title') or citation.title}\n\n"
            f"Source: {citation.url}\n"
            f"Fetched: {citation.fetched_ts.isoformat()}\n"
            f"Published: {result.get('publish_date') or 'unknown'}\n\n---\n\n{body}"
        )
        uri = blobs.put(
            bucket,
            snapshot_path(project_id, citation.citation_id),
            document.encode(),
            "text/markdown",
        )
        updated.append(citation.model_copy(update={"snapshot_uri": uri}))

    log_event(log, "snapshots stored", project_id=project_id, count=len(targets))
    return updated
