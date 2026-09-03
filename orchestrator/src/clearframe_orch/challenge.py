"""The loop that makes agents argue.

A finding lands, the Verifier attacks it, and either it survives to risk scoring
or it goes back to research with the objection attached and the original run's
interaction id, so the re-run answers the challenge instead of starting over.
"""

from __future__ import annotations

from clearframe_contracts import (
    Envelope,
    EventType,
    Finding,
    ItemStatus,
)
from clearframe_ledger.chain import append as ledger_append
from clearframe_runtime import get_bus, get_logger, get_store, log_event, settings

from . import agents_client, dispatch, state, tiering
from .budget import may_escalate
from .models import ModelClient
from .toolbelt import RunContext

log = get_logger("clearframe.challenge")

VERIFY_TASK = """Cross-examine this finding before it reaches risk scoring.

Finding id: {finding_id}   (pass this id to verify_pass or file_challenge)
Item: {title} ({type}) — {description}
Researcher: {agent}
Confidence: {confidence:.2f}
Claim:
{claim}

Citations:
{citations}

Prior challenges on this item: {prior_challenges}

Run the four tests — staleness, authority, independence, internal consistency.
Re-search the question yourself with different phrasing than the researcher used.
Then call exactly one of verify_pass or file_challenge.
"""


def _format_citations(finding: Finding) -> str:
    if not finding.citations:
        return "(none — this finding should not have reached you)"
    return "\n".join(
        f"- [{c.authority.value}] {c.url} — published {c.published_date or 'undated'}"
        f" — fetched {c.fetched_ts.date()}" + (f" — “{c.excerpt[:120]}”" if c.excerpt else "")
        for c in finding.citations[:15]
    )


async def on_finding(env: Envelope, *, model_client: ModelClient | None = None) -> None:
    """Handler for finding.added."""
    store = get_store()
    finding = Finding(**env.payload["finding"])
    item = await store.get_item(finding.item_id)
    if item is None:
        return

    if not finding.is_admissible():
        # Should be impossible — the ledger rejects these — but if it happens the
        # item goes back for research rather than forward on a bad claim.
        await dispatch.request_research(
            env.project_id,
            env.pass_id,
            item,
            max(1, finding.tier),
            rationale=f"inadmissible finding: {finding.inadmissible_reason()}",
        )
        return

    await store.set_status(finding.item_id, ItemStatus.CONTESTED, force=True)
    ctx = RunContext(
        project_id=env.project_id,
        pass_id=env.pass_id,
        agent="verifier",
        item_id=finding.item_id,
        tier=0,
    )
    prior = await store.list_challenges(item_id=finding.item_id)
    task = VERIFY_TASK.format(
        finding_id=finding.finding_id,
        title=item.title,
        type=item.type.value,
        description=item.description,
        agent=finding.agent,
        confidence=finding.confidence,
        claim=_claim_text(finding),
        citations=_format_citations(finding),
        prior_challenges=(
            "; ".join(f"{c.grounds.value}: {c.rationale[:120]}" for c in prior) or "none"
        ),
    )

    try:
        await agents_client.invoke("verifier", ctx, task, model_client=model_client)
    except Exception as exc:  # noqa: BLE001 — a broken adversary must not block the pass
        log_event(log, "verifier failed", item_id=finding.item_id, error=repr(exc))
        await _pass_through(env, finding, reason=f"verifier unavailable: {exc}")
        return

    # The first verdict is the verdict; the toolbelt refuses any second one.
    verdict = ctx.verdicts[0] if ctx.verdicts else None
    if verdict is None or verdict["action"] == "verify_pass":
        await _pass_through(
            env, finding, reason=(verdict or {}).get("rationale", "no objection filed")
        )
        return

    await _handle_challenge(env, finding, ctx)


def _claim_text(finding: Finding) -> str:
    import json

    claim = {k: v for k, v in finding.claim.items() if not k.startswith("_")}
    return json.dumps(claim, indent=2, default=str)[:4000]


async def _pass_through(env: Envelope, finding: Finding, *, reason: str) -> None:
    store = get_store()
    await store.set_status(finding.item_id, ItemStatus.VERIFIED, force=True)
    await ledger_append(
        env.project_id,
        "verifier",
        {
            "type": "verify.passed",
            "finding_id": finding.finding_id,
            "item_id": finding.item_id,
            "rationale": reason[:1000],
        },
    )
    await get_bus().publish(
        Envelope(
            type=EventType.VERIFY_PASSED,
            project_id=env.project_id,
            pass_id=env.pass_id,
            item_id=finding.item_id,
            actor="verifier",
            payload={"finding": finding.model_dump(mode="json"), "rationale": reason},
        )
    )


async def _handle_challenge(env: Envelope, finding: Finding, ctx: RunContext) -> None:
    store = get_store()
    challenge = ctx.challenges[-1]
    await store.put_challenge(challenge)
    count = await store.increment_challenges(finding.item_id)

    await ledger_append(
        env.project_id,
        "verifier",
        {
            "type": "challenge.filed",
            "finding_id": finding.finding_id,
            "item_id": finding.item_id,
            "grounds": challenge.grounds.value,
            "rationale": challenge.rationale,
            "citations": [c.url for c in challenge.citations],
            "challenge_number": count,
        },
    )
    await get_bus().publish(
        Envelope(
            type=EventType.CHALLENGE_FILED,
            project_id=env.project_id,
            pass_id=env.pass_id,
            item_id=finding.item_id,
            actor="verifier",
            payload={
                "challenge": challenge.model_dump(mode="json"),
                "finding_id": finding.finding_id,
            },
        )
    )

    if count > settings().max_challenges:
        # Honest failure mode: the machines could not agree, so a human looks.
        await store.set_status(finding.item_id, ItemStatus.ESCALATED, force=True)
        await get_bus().publish(
            Envelope(
                type=EventType.ITEM_ESCALATED,
                project_id=env.project_id,
                pass_id=env.pass_id,
                item_id=finding.item_id,
                actor="verifier",
                payload={
                    "reason": "challenge limit reached",
                    "grounds": challenge.grounds.value,
                    "rationale": challenge.rationale,
                    "challenges": count,
                },
            )
        )
        await ledger_append(
            env.project_id,
            "1st_ad",
            {
                "type": "item.escalated",
                "item_id": finding.item_id,
                "reason": "challenge limit reached",
                "challenges": count,
            },
        )
        return

    item = await store.get_item(finding.item_id)
    tier = tiering.escalate(item, finding, challenged=True) or 2
    from clearframe_adapter import pricing

    if not await may_escalate(env.project_id, pricing.cost_for_tier(tier)):
        # Pause rather than raise: raising here would retry the event five times and
        # then dead-letter it, losing a challenge that is perfectly valid and simply
        # unaffordable right now. The item resumes when the producer raises the cap.
        await state.pause_pass(env.pass_id, "budget cap reached before re-research")
        await store.set_status(finding.item_id, ItemStatus.ESCALATED, force=True)
        log_event(log, "challenge unfunded", item_id=finding.item_id, tier=tier)
        return

    await store.supersede_finding(finding.finding_id, challenge.challenge_id)
    await dispatch.request_research(
        env.project_id,
        env.pass_id,
        item,
        tier,
        objection=f"{challenge.grounds.value}: {challenge.rationale}",
        prev_interaction_id=finding.interaction_id,  # <- provenance chain
        rationale=tiering.tier_rationale(item, finding, challenged=True),
    )
    log_event(
        log,
        "challenge routed",
        item_id=finding.item_id,
        tier=tier,
        grounds=challenge.grounds.value,
        challenge_number=count,
    )
