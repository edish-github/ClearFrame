"""Writing findings, citations, decisions, assessments and cost to the permanent past."""

from __future__ import annotations

from clearframe_contracts import (
    Decision,
    Envelope,
    EventType,
    Finding,
    RiskAssessment,
    utcnow,
)
from clearframe_runtime import get_bus, get_store

from . import graph
from .chain import append
from .sink import ASSESSMENTS, CITATIONS, COST_EVENTS, DECISIONS, FINDINGS, get_sink


def finding_row(finding: Finding) -> dict:
    return {
        "finding_id": finding.finding_id,
        "item_id": finding.item_id,
        "project_id": finding.project_id,
        "pass_id": finding.pass_id,
        "agent": finding.agent,
        "claim": finding.claim,
        "confidence": finding.confidence,
        "interaction_id": finding.interaction_id,
        "prev_interaction_id": finding.prev_interaction_id,
        "superseded_by": finding.superseded_by,
        "tier": finding.tier,
        "cost_usd": finding.cost_usd,
        "ts": finding.ts.isoformat(),
    }


def citation_rows(finding: Finding) -> list[dict]:
    return [
        {
            "citation_id": c.citation_id,
            "finding_id": finding.finding_id,
            "project_id": finding.project_id,
            "url": c.url,
            "title": c.title,
            "excerpt": c.excerpt,
            "snapshot_uri": c.snapshot_uri,
            "fetched_ts": c.fetched_ts.isoformat(),
            "published_date": c.published_date,
            "authority": c.authority.value,
            "field": c.field,
        }
        for c in finding.citations
    ]


async def record_finding(finding: Finding) -> Finding:
    """The single write path for a finding.

    Rejects inadmissible findings at the boundary: the citation-required policy is
    a property of the store, not an instruction in a prompt.
    """
    reason = finding.inadmissible_reason()
    if reason:
        raise ValueError(f"finding {finding.finding_id} is inadmissible: {reason}")

    sink = get_sink()
    sink.insert(FINDINGS, [finding_row(finding)])
    sink.insert(CITATIONS, citation_rows(finding))
    await get_store().put_finding(finding)

    await graph.holders_from_claim(finding.claim, sorted({c.url for c in finding.citations}))
    await append(
        finding.project_id,
        finding.agent,
        {
            "type": "finding.added",
            "finding_id": finding.finding_id,
            "item_id": finding.item_id,
            "pass_id": finding.pass_id,
            "confidence": finding.confidence,
            "citations": len(finding.citations),
            "interaction_id": finding.interaction_id,
            "prev_interaction_id": finding.prev_interaction_id,
            "tier": finding.tier,
        },
    )
    # One write path, one event: the challenge loop starts here whether the finding
    # came from an in-process crew or an HTTP submission.
    await get_bus().publish(
        Envelope(
            type=EventType.FINDING_ADDED,
            project_id=finding.project_id,
            pass_id=finding.pass_id,
            item_id=finding.item_id,
            actor=finding.agent,
            payload={"finding": finding.model_dump(mode="json")},
        )
    )
    return finding


async def record_decision(decision: Decision) -> Decision:
    """Only a human principal reaches this path; the API enforces the role."""
    get_sink().insert(
        DECISIONS,
        [
            {
                "decision_id": decision.decision_id,
                "project_id": decision.project_id,
                "item_id": decision.item_id,
                "actor": decision.actor,
                "iam_role": decision.iam_role.value,
                "action": decision.action.value,
                "rationale": decision.rationale,
                "target_id": decision.target_id,
                "ts": decision.ts.isoformat(),
            }
        ],
    )
    await append(
        decision.project_id,
        decision.actor,
        {
            "type": "decision.made",
            "decision_id": decision.decision_id,
            "item_id": decision.item_id,
            "action": decision.action.value,
            "iam_role": decision.iam_role.value,
            "rationale": decision.rationale,
            "target_id": decision.target_id,
        },
    )
    return decision


async def record_assessment(assessment: RiskAssessment) -> RiskAssessment:
    get_sink().insert(
        ASSESSMENTS,
        [
            {
                "assessment_id": assessment.assessment_id,
                "item_id": assessment.item_id,
                "project_id": assessment.project_id,
                "pass_id": assessment.pass_id,
                "risk_state": assessment.risk_state.value,
                "rationale": assessment.rationale,
                "grounding_refs": assessment.grounding_refs,
                "mitigations": [m.model_dump(mode="json") for m in assessment.mitigations],
                "requires_approval": assessment.requires_approval,
                "agent": assessment.agent,
                "ts": assessment.ts.isoformat(),
            }
        ],
    )
    await get_store().put_assessment(assessment)
    await append(
        assessment.project_id,
        assessment.agent,
        {
            "type": "risk.scored",
            "assessment_id": assessment.assessment_id,
            "item_id": assessment.item_id,
            "risk_state": assessment.risk_state.value,
            "requires_approval": assessment.requires_approval,
            "mitigations": len(assessment.mitigations),
        },
    )
    return assessment


async def record_cost(
    project_id: str,
    pass_id: str,
    item_id: str | None,
    tier: int,
    cost_usd: float,
    surface: str,
) -> None:
    """Every tool call's tier and cost, so §9.2's weekly query has something to read."""
    get_sink().insert(
        COST_EVENTS,
        [
            {
                "project_id": project_id,
                "pass_id": pass_id,
                "item_id": item_id,
                "tier": tier,
                "cost_usd": cost_usd,
                "surface": surface,
                "ts": utcnow().isoformat(),
            }
        ],
    )
    await append(
        project_id,
        "1st_ad",
        {
            "type": "research.completed",
            "item_id": item_id,
            "pass_id": pass_id,
            "tier": tier,
            "cost_usd": cost_usd,
            "surface": surface,
        },
    )
