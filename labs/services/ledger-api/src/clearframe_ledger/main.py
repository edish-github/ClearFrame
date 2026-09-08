"""Ledger API — the only write path into the permanent past."""

from __future__ import annotations

from typing import Any

from clearframe_contracts import (
    Capability,
    Decision,
    DecisionAction,
    Envelope,
    EventType,
    Finding,
    Principal,
    RightsHolder,
    RiskAssessment,
    Role,
    utcnow,
)
from clearframe_runtime import get_bus, get_logger, get_store, log_event
from clearframe_runtime.ids import decision_id as new_decision_id
from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import graph, records
from .auth import bind_role, current_principal
from .chain import append, read_chain, verify_chain

log = get_logger("clearframe.ledger")

app = FastAPI(
    title="ClearFrame ledger API",
    version="0.1.0",
    description="Append-only, hash-chained. No update path exists, by design.",
)


@app.post("/findings", summary="submit_finding — the crews' only write path")
async def submit_finding(finding: Finding) -> dict[str, Any]:
    try:
        # record_finding publishes finding.added itself, so both entry points behave
        # identically.
        stored = await records.record_finding(finding)
    except ValueError as exc:
        # Inadmissible findings are rejected loudly so the orchestrator can re-run.
        raise HTTPException(422, str(exc)) from exc
    return {"finding_id": stored.finding_id, "citations": len(stored.citations)}


@app.post("/assessments", summary="Record a risk assessment")
async def submit_assessment(assessment: RiskAssessment) -> dict[str, Any]:
    stored = await records.record_assessment(assessment)
    return {"assessment_id": stored.assessment_id, "risk_state": stored.risk_state.value}


class LedgerEvent(BaseModel):
    project_id: str
    actor: str
    event: dict


@app.post("/events", summary="Append one event to the chain")
async def append_event(body: LedgerEvent) -> dict[str, Any]:
    row = await append(body.project_id, body.actor, body.event)
    return {"seq": row["seq"], "event_hash": row["event_hash"]}


@app.get("/events/{project_id}", summary="Read the chain in order")
async def list_events(project_id: str, limit: int = 500) -> dict[str, Any]:
    rows = read_chain(project_id)
    return {"count": len(rows), "events": rows[-limit:]}


@app.get("/verify/{project_id}", summary="Recompute the hash chain")
async def verify(project_id: str) -> dict[str, Any]:
    return verify_chain(project_id)


class DecisionRequest(BaseModel):
    action: DecisionAction
    rationale: str = Field(min_length=1)
    item_id: str | None = None
    target_id: str | None = None


#: Which capability each decision demands. Checked server-side, always.
DECISION_CAPABILITY = {
    DecisionAction.APPROVE_MITIGATION: Capability.APPROVE_RED,
    DecisionAction.REJECT_MITIGATION: Capability.APPROVE_RED,
    DecisionAction.APPROVE_OUTREACH: Capability.APPROVE_OUTREACH,
    DecisionAction.REJECT_OUTREACH: Capability.APPROVE_OUTREACH,
    DecisionAction.REQUEST_REINVESTIGATION: Capability.EDIT_ITEM,
    DecisionAction.SIGN_REPORT: Capability.SIGN_REPORT,
    DecisionAction.RAISE_BUDGET: Capability.SET_BUDGET,
    DecisionAction.FLAG_FOR_WATCH: Capability.EDIT_ITEM,
}


@app.post("/projects/{project_id}/decisions", summary="Record a human decision")
async def make_decision(
    project_id: str,
    body: DecisionRequest,
    principal: Principal = Depends(current_principal),
) -> dict[str, Any]:
    capability = DECISION_CAPABILITY[body.action]
    if not principal.may(capability):
        raise HTTPException(403, f"role {principal.role.value} may not {body.action.value}")

    decision = Decision(
        decision_id=new_decision_id(),
        project_id=project_id,
        item_id=body.item_id,
        actor=principal.subject,
        iam_role=principal.role,
        action=body.action,
        rationale=body.rationale,
        target_id=body.target_id,
        ts=utcnow(),
    )
    await records.record_decision(decision)
    await get_bus().publish(
        Envelope(
            type=EventType.DECISION_MADE,
            project_id=project_id,
            pass_id="gate",
            item_id=body.item_id,
            actor=principal.subject,
            payload={"decision": decision.model_dump(mode="json")},
        )
    )
    log_event(
        log,
        "decision recorded",
        project_id=project_id,
        action=body.action.value,
        actor=principal.subject,
    )
    return {"decision_id": decision.decision_id}


class RoleBinding(BaseModel):
    subject: str
    role: Role


@app.put("/projects/{project_id}/roles", summary="Bind a principal to a project role")
async def put_role(project_id: str, body: RoleBinding) -> dict[str, Any]:
    """Mirrors the Cloud IAM binding into the state plane so the API can enforce it
    on every request without a directory round-trip."""
    await bind_role(project_id, body.subject, body.role)
    await append(
        project_id,
        "system",
        {
            "type": "role.bound",
            "subject": body.subject,
            "role": body.role.value,
        },
    )
    return {"ok": True}


@app.get("/projects/{project_id}/holders", summary="The rights-holder graph")
async def list_holders(project_id: str) -> dict[str, Any]:
    holders = await get_store().list_holders()
    return {"holders": [h.model_dump(mode="json") for h in holders]}


@app.post("/holders", summary="Upsert a rights holder (FindAll enrichment lands here)")
async def upsert_holder(holder: RightsHolder) -> dict[str, Any]:
    stored = await graph.upsert_holder(
        holder.name,
        holder.kind,
        source_urls=holder.source_urls,
        contacts=holder.contacts,
        parent_id=holder.parent_id,
        aliases=holder.aliases,
    )
    return {"holder_id": stored.holder_id}


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {"ok": True}
