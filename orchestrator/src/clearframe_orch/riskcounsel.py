"""Risk Counsel and the human gate.

Scoring is grounded on the handbooks; the gate is a property of the state
machine, not a UI affordance. Nothing red resolves without a human, and the
system is proud of that.
"""

from __future__ import annotations

from clearframe_contracts import (
    Decision,
    DecisionAction,
    Envelope,
    EventType,
    Finding,
    ItemStatus,
    RiskState,
)
from clearframe_ledger.chain import append as ledger_append
from clearframe_runtime import get_bus, get_logger, get_store, log_event

from . import agents_client, state
from .models import ModelClient
from .toolbelt import RunContext

log = get_logger("clearframe.risk")

SCORE_TASK = """Score the clearance exposure for this item.

Item: {title} ({type}) — {description}
Scene {scene}, from {tc_in}. Prominence: {prominence}.

Verified findings:
{findings}

Ground every judgement in a retrieved passage — call search_clearance_guidance
before you score, and name the passages you relied on in grounding_refs. Then
call submit_assessment once.
"""


def _findings_block(findings: list[Finding]) -> str:
    import json

    if not findings:
        return "(none — say so and score UNKNOWN rather than guessing)"
    blocks = []
    for f in findings:
        claim = {k: v for k, v in f.claim.items() if not k.startswith("_")}
        sources = ", ".join(f"{c.authority.value}:{c.url}" for c in f.citations[:6])
        blocks.append(
            f"- {f.agent} (confidence {f.confidence:.2f})\n"
            f"  {json.dumps(claim, default=str)[:1800]}\n  sources: {sources}"
        )
    return "\n".join(blocks)


async def on_verified(env: Envelope, *, model_client: ModelClient | None = None) -> None:
    """Handler for verify.passed — score, then gate if the score demands it."""
    store = get_store()
    item = await store.get_item(env.item_id or "")
    if item is None:
        return

    findings = await store.list_findings(item_id=item.item_id, live_only=True)
    ctx = RunContext(
        project_id=env.project_id,
        pass_id=env.pass_id,
        agent="risk_counsel",
        item_id=item.item_id,
        tier=0,
    )
    task = SCORE_TASK.format(
        title=item.title,
        type=item.type.value,
        description=item.description,
        scene=item.timecode.scene or "unspecified",
        tc_in=item.timecode.tc_in,
        prominence=item.prominence.value,
        findings=_findings_block(findings),
    )

    try:
        await agents_client.invoke("risk-counsel", ctx, task, model_client=model_client)
    except Exception as exc:  # noqa: BLE001
        log_event(log, "risk scoring failed", item_id=item.item_id, error=repr(exc))
        await store.set_status(item.item_id, ItemStatus.ESCALATED, force=True)
        return

    if not ctx.assessments:
        await store.set_status(item.item_id, ItemStatus.ESCALATED, force=True)
        await get_bus().publish(
            Envelope(
                type=EventType.ITEM_ESCALATED,
                project_id=env.project_id,
                pass_id=env.pass_id,
                item_id=item.item_id,
                actor="risk_counsel",
                payload={"reason": "no assessment produced"},
            )
        )
        return

    assessment = ctx.assessments[-1]
    await store.update_item(item.item_id, risk_state=assessment.risk_state.value)
    await store.set_status(item.item_id, ItemStatus.RISK_SCORED, force=True)
    await get_bus().publish(
        Envelope(
            type=EventType.RISK_SCORED,
            project_id=env.project_id,
            pass_id=env.pass_id,
            item_id=item.item_id,
            actor="risk_counsel",
            payload={"assessment": assessment.model_dump(mode="json")},
        )
    )

    if assessment.requires_approval:
        await store.set_status(item.item_id, ItemStatus.PENDING_APPROVAL, force=True)
        await get_bus().publish(
            Envelope(
                type=EventType.APPROVAL_REQUIRED,
                project_id=env.project_id,
                pass_id=env.pass_id,
                item_id=item.item_id,
                actor="risk_counsel",
                payload={
                    "assessment_id": assessment.assessment_id,
                    "risk_state": assessment.risk_state.value,
                    "mitigations": [m.model_dump(mode="json") for m in assessment.mitigations],
                },
            )
        )
    else:
        await store.set_status(item.item_id, ItemStatus.RESOLVED, force=True)
        await ledger_append(
            env.project_id,
            "risk_counsel",
            {
                "type": "item.resolved",
                "item_id": item.item_id,
                "risk_state": assessment.risk_state.value,
                "resolution": "cleared"
                if assessment.risk_state is RiskState.GREEN
                else "no gate required",
            },
        )
    await state.refresh_pass(env.pass_id)


async def on_decision(env: Envelope) -> None:
    """Handler for decision.made — the only path out of pending approval."""
    store = get_store()
    decision = Decision(**env.payload["decision"])
    if not decision.item_id:
        return
    item = await store.get_item(decision.item_id)
    if item is None:
        return

    if decision.action is DecisionAction.APPROVE_MITIGATION:
        await store.set_status(item.item_id, ItemStatus.RESOLVED, force=True)
        await ledger_append(
            decision.project_id,
            decision.actor,
            {
                "type": "item.resolved",
                "item_id": item.item_id,
                "resolution": "mitigation approved",
                "mitigation_id": decision.target_id,
                "decided_by": decision.actor,
                "iam_role": decision.iam_role.value,
            },
        )
    elif decision.action is DecisionAction.REJECT_MITIGATION:
        await store.set_status(item.item_id, ItemStatus.ESCALATED, force=True)
    elif decision.action is DecisionAction.REQUEST_REINVESTIGATION:
        from . import dispatch

        await store.set_status(item.item_id, ItemStatus.RESEARCHING, force=True)
        await dispatch.request_research(
            decision.project_id,
            env.pass_id,
            item,
            tier=2,
            objection=f"counsel requested re-investigation: {decision.rationale}",
            rationale="counsel requested re-investigation",
        )
    elif decision.action is DecisionAction.APPROVE_OUTREACH and decision.target_id:
        from clearframe_contracts import OutreachStatus

        await store.update_outreach(
            decision.target_id,
            status=OutreachStatus.APPROVED_QUEUED.value,
            approved_by=decision.actor,
        )
        await get_bus().publish(
            Envelope(
                type=EventType.OUTREACH_QUEUED,
                project_id=decision.project_id,
                pass_id=env.pass_id,
                item_id=item.item_id,
                actor=decision.actor,
                payload={"outreach_id": decision.target_id},
            )
        )
    elif decision.action is DecisionAction.REJECT_OUTREACH and decision.target_id:
        from clearframe_contracts import OutreachStatus

        await store.update_outreach(
            decision.target_id, status=OutreachStatus.REJECTED.value, approved_by=decision.actor
        )

    log_event(
        log,
        "decision applied",
        item_id=item.item_id,
        action=decision.action.value,
        actor=decision.actor,
    )
