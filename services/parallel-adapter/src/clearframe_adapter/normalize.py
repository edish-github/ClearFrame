"""The boundary where Parallel output becomes ClearFrame domain objects.

Everything above this line is web research; everything below is a database row
with a citation attached to it.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from clearframe_contracts import Authority, Citation, Finding, utcnow
from clearframe_runtime.ids import citation_id, finding_id

#: Host fragments that identify a source class. Ordered: first match wins.
AUTHORITY_HOSTS: list[tuple[Authority, tuple[str, ...]]] = [
    (
        Authority.REGISTRY,
        (
            "uspto.gov",
            "copyright.gov",
            "tmsearch",
            "euipo.europa.eu",
            "wipo.int",
            "ascap.com",
            "bmi.com",
            "sesac.com",
            "prs",
            "gema.de",
            "socan.com",
            "icelibrary",
            "ipchain",
            "loc.gov",
        ),
    ),
    (
        Authority.COURT,
        (
            "courtlistener.com",
            "pacer.gov",
            "justia.com",
            "casetext.com",
            "law.justia",
            "uscourts.gov",
            "unicourt.com",
            "docketbird.com",
            "trellis.law",
        ),
    ),
    (
        Authority.CORPORATE,
        (
            "sec.gov",
            "companieshouse.gov.uk",
            "opencorporates.com",
            "investor.",
            "prnewswire.com",
            "businesswire.com",
        ),
    ),
    (
        Authority.TRADE,
        (
            "variety.com",
            "billboard.com",
            "hollywoodreporter.com",
            "musicbusinessworldwide.com",
            "deadline.com",
            "completemusicupdate.com",
            "musicweek.com",
            "ipwatchdog.com",
            "worldipreview.com",
            "artnews.com",
            "theartnewspaper.com",
        ),
    ),
    (
        Authority.REFERENCE,
        (
            "wikipedia.org",
            "discogs.com",
            "musicbrainz.org",
            "imdb.com",
            "allmusic.com",
            "secondhandsongs.com",
            "whosampled.com",
        ),
    ),
]

#: Parallel reports per-field confidence as a band; the ledger stores a number.
CONFIDENCE_BAND = {"high": 0.9, "medium": 0.65, "low": 0.35}


def classify_authority(url: str) -> Authority:
    """Feeds the Verifier's authority test: a blog is weaker than a registry."""
    host = urlparse(url).netloc.lower()
    if not host:
        return Authority.OTHER
    for authority, fragments in AUTHORITY_HOSTS:
        if any(fragment in host for fragment in fragments):
            return authority
    if host.endswith(".gov"):
        return Authority.REGISTRY
    return Authority.OTHER


def _basis_entries(raw: dict) -> list[dict]:
    output = raw.get("output") or {}
    basis = output.get("basis")
    return basis if isinstance(basis, list) else []


def citations_from_basis(raw: dict) -> list[Citation]:
    """Flatten output.basis into Citation rows, deduplicated by (url, field)."""
    seen: set[tuple[str, str | None]] = set()
    citations: list[Citation] = []
    for entry in _basis_entries(raw):
        field = entry.get("field")
        for cite in entry.get("citations") or []:
            url = (cite.get("url") or "").strip()
            if not url:
                continue
            key = (url, field)
            if key in seen:
                continue
            seen.add(key)
            excerpts = cite.get("excerpts") or []
            excerpt = " ".join(e.strip() for e in excerpts if e)[:200]
            citations.append(
                Citation(
                    citation_id=citation_id(),
                    url=url,
                    title=cite.get("title") or "",
                    excerpt=excerpt,
                    fetched_ts=utcnow(),
                    published_date=cite.get("publish_date") or cite.get("published_date"),
                    authority=classify_authority(url),
                    field=field,
                )
            )
    return citations


def derive_confidence(raw: dict) -> float:
    """Prefer the schema's own confidence field; fall back to the basis bands.

    A structured run that declares its own confidence is more informative than an
    average of per-field bands, but an average is better than a made-up default.
    """
    content = (raw.get("output") or {}).get("content")
    if isinstance(content, dict):
        value = content.get("confidence")
        if isinstance(value, (int, float)):
            return max(0.0, min(1.0, float(value)))
        if isinstance(value, str) and value.lower() in CONFIDENCE_BAND:
            return CONFIDENCE_BAND[value.lower()]

    bands = [
        CONFIDENCE_BAND[str(entry.get("confidence", "")).lower()]
        for entry in _basis_entries(raw)
        if str(entry.get("confidence", "")).lower() in CONFIDENCE_BAND
    ]
    if bands:
        return round(sum(bands) / len(bands), 3)
    return 0.5


def reasoning_notes(raw: dict) -> dict[str, str]:
    """Per-field reasoning, kept so the UI can show why a claim was made."""
    return {
        str(entry.get("field", f"field_{i}")): str(entry.get("reasoning", ""))
        for i, entry in enumerate(_basis_entries(raw))
        if entry.get("reasoning")
    }


def to_finding(
    raw: dict,
    *,
    item_id: str,
    project_id: str,
    pass_id: str,
    agent: str,
    tier: int = 1,
    cost_usd: float = 0.0,
    prev_interaction_id: str | None = None,
) -> Finding:
    """Parallel run payload -> a Finding with its citations attached."""
    output = raw.get("output") or {}
    content: Any = output.get("content")
    claim = content if isinstance(content, dict) else {"text": content}
    claim = dict(claim)
    notes = reasoning_notes(raw)
    if notes:
        claim.setdefault("_reasoning", notes)

    return Finding(
        finding_id=finding_id(),
        item_id=item_id,
        project_id=project_id,
        pass_id=pass_id,
        agent=agent,
        claim=claim,
        confidence=derive_confidence(raw),
        citations=citations_from_basis(raw),
        interaction_id=raw.get("interaction_id") or raw.get("run_id"),
        prev_interaction_id=prev_interaction_id,
        tier=tier,
        cost_usd=cost_usd,
        ts=utcnow(),
    )


def citations_from_search(results: list[dict], *, field: str | None = None) -> list[Citation]:
    """T0 recon results as citations — used by the Verifier's independent re-search."""
    citations: list[Citation] = []
    for result in results:
        url = (result.get("url") or "").strip()
        if not url:
            continue
        excerpts = result.get("excerpts") or []
        citations.append(
            Citation(
                citation_id=citation_id(),
                url=url,
                title=result.get("title") or "",
                excerpt=" ".join(e.strip() for e in excerpts if e)[:200],
                fetched_ts=utcnow(),
                published_date=result.get("publish_date"),
                authority=classify_authority(url),
                field=field,
            )
        )
    return citations


def has_litigation(claim: dict) -> bool:
    """The one hard rule Risk Counsel may not soften."""
    signals = claim.get("litigation_signals")
    return isinstance(signals, list) and len(signals) > 0
