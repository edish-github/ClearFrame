"""Grounding for Risk Counsel.

Agent Builder data stores when they are configured — that is the zero-config
grounding path the brief promotes — and a local corpus reader otherwise, so the
same playbook is testable on a laptop. Both return passages with a reference,
because "cite the handbook section" only means something if the section has an id.
"""

from __future__ import annotations

import os
import re
from functools import cache
from pathlib import Path

from clearframe_runtime import get_logger, settings

log = get_logger("clearframe.grounding")

CORPORA = ("eo-underwriting", "clearance-handbooks")


def corpus_dir() -> Path:
    override = os.environ.get("CLEARFRAME_DATASTORES")
    if override:
        return Path(override)
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "agents" / "datastores"
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError("agents/datastores not found; set CLEARFRAME_DATASTORES")


@cache
def _load_local(corpus: str) -> list[tuple[str, str]]:
    """Return (reference, passage) pairs. Markdown headings become references."""
    directory = corpus_dir() / corpus
    if not directory.is_dir():
        return []
    passages: list[tuple[str, str]] = []
    for path in sorted(directory.glob("**/*.md")):
        text = path.read_text()
        blocks = re.split(r"\n(?=#{1,4}\s)", text)
        for block in blocks:
            block = block.strip()
            if not block:
                continue
            heading = block.splitlines()[0].lstrip("# ").strip()
            passages.append((f"{corpus}/{path.stem}#{heading}", block))
    return passages


def _score(query: str, passage: str) -> int:
    terms = {t for t in re.findall(r"[a-z]{4,}", query.lower())}
    body = passage.lower()
    return sum(body.count(term) for term in terms)


async def search_corpora(query: str, corpus: str = "all", limit: int = 5) -> list[dict]:
    cfg = settings()
    if cfg.datastore_eo_id or cfg.datastore_handbooks_id:
        remote = await _search_datastores(query, corpus, limit)
        if remote:
            return remote

    names = CORPORA if corpus in ("all", "") else (corpus,)
    scored: list[tuple[int, str, str]] = []
    for name in names:
        for reference, passage in _load_local(name):
            score = _score(query, passage)
            if score:
                scored.append((score, reference, passage))
    scored.sort(key=lambda row: row[0], reverse=True)
    return [
        {"reference": reference, "passage": passage[:1500], "score": score}
        for score, reference, passage in scored[:limit]
    ]


async def _search_datastores(query: str, corpus: str, limit: int) -> list[dict]:
    """Vertex AI Search over the Agent Builder data stores."""
    cfg = settings()
    stores = []
    if corpus in ("all", "eo-underwriting") and cfg.datastore_eo_id:
        stores.append(cfg.datastore_eo_id)
    if corpus in ("all", "clearance-handbooks") and cfg.datastore_handbooks_id:
        stores.append(cfg.datastore_handbooks_id)
    if not stores:
        return []

    try:
        from google.cloud import discoveryengine_v1 as discoveryengine
    except ImportError:
        log.warning("discoveryengine client unavailable; falling back to local corpus")
        return []

    client = discoveryengine.SearchServiceAsyncClient()
    passages: list[dict] = []
    for store_id in stores:
        serving_config = (
            f"projects/{cfg.project_id}/locations/global/collections/default_collection/"
            f"dataStores/{store_id}/servingConfigs/default_config"
        )
        response = await client.search(
            discoveryengine.SearchRequest(
                serving_config=serving_config,
                query=query,
                page_size=limit,
                content_search_spec=discoveryengine.SearchRequest.ContentSearchSpec(
                    extractive_content_spec=(
                        discoveryengine.SearchRequest.ContentSearchSpec.ExtractiveContentSpec(
                            max_extractive_answer_count=2
                        )
                    )
                ),
            )
        )
        async for result in response:
            document = result.document
            derived = dict(document.derived_struct_data or {})
            for answer in derived.get("extractive_answers", []):
                passages.append(
                    {
                        "reference": f"{store_id}/{document.id}",
                        "passage": answer.get("content", ""),
                        "score": 1,
                    }
                )
    return passages[:limit]
