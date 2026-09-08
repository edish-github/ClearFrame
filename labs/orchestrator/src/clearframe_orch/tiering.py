"""T0 -> T3 escalation. This function is the 1st AD's judgement, in one place."""

from __future__ import annotations

from clearframe_contracts import Finding, Item, ItemType, Prominence

#: Types where a cheap answer is usually the wrong answer.
HIGH_RISK_TYPES = {ItemType.MUSIC_CUE, ItemType.LIKENESS, ItemType.ARTWORK}

#: Below this, a structured run is not trustworthy enough to score risk on.
CONFIDENCE_FLOOR = 0.70


def initial_tier(item: Item) -> int:
    """T0 recon for everything; straight to T1 for known-hard types and hero uses."""
    if item.type in HIGH_RISK_TYPES or item.prominence is Prominence.HERO:
        return 1
    return 0


def escalate(item: Item, finding: Finding | None, *, challenged: bool = False) -> int | None:
    """The next tier, or None to stop spending.

    Order matters: a challenge always buys a pro run, and a litigation signal
    always buys the dossier, because those are the two cases where being wrong is
    expensive in a way the saved dollar cannot justify.
    """
    if challenged:
        return 2
    if finding is None:
        return max(1, initial_tier(item))
    if finding.claim.get("litigation_signals"):
        return 3
    if finding.claim.get("conflicting_sources"):
        return 2
    if finding.confidence < CONFIDENCE_FLOOR:
        return 2
    if finding.tier == 0:
        return 1
    return None


def tier_rationale(item: Item, finding: Finding | None, *, challenged: bool = False) -> str:
    """Human-readable reason, streamed to the crew feed beside the spend."""
    if challenged:
        return "verifier challenge filed — escalating to a pro run"
    if finding is None:
        return "no structured finding yet — opening at core"
    if finding.claim.get("litigation_signals"):
        return "litigation signal found — ultra dossier on the full chain of title"
    if finding.claim.get("conflicting_sources"):
        return "sources disagree — escalating rather than picking a winner"
    if finding.confidence < CONFIDENCE_FLOOR:
        return f"confidence {finding.confidence:.2f} below {CONFIDENCE_FLOOR} — escalating"
    return "confident and uncontested — stopping here"
