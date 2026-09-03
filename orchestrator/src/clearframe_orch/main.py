"""Orchestrator — the pass API and the Pub/Sub push surface.

Two audiences: the event spine, which pushes work in, and the war room, which
reads state out and posts human decisions. The web app never calls an agent and
never writes a finding; it reads projections and posts approvals, which is why
the live demo does not break.
"""

from __future__ import annotations

import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from clearframe_contracts import (
    Cut,
    ItemStatus,
    PassMode,
    Project,
    Role,
    utcnow,
)
from clearframe_runtime import (
    decode_push,
    get_blobs,
    get_bus,
    get_logger,
    get_store,
    log_event,
    settings,
)
from clearframe_runtime.identity import IdentityError, verify_push_caller
from clearframe_runtime.ids import cut_id as new_cut_id
from clearframe_runtime.ids import project_id as new_project_id
from fastapi import Body, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field

from . import agents_client, breakdown, delta, dispatch, handlers, provenance, sentinel, state
from .ingest import IngestError, ingest

log = get_logger("clearframe.orchestrator")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Wire the crew to the spine. In `gcp` mode the same routing serves the
    Pub/Sub push endpoints; locally the in-process workers start here."""
    bus = handlers.register()
    if hasattr(bus, "start"):
        bus.start()
    log_event(log, "orchestrator ready", backend=settings().backend)
    yield
    if hasattr(bus, "stop"):
        await bus.stop()


app = FastAPI(
    title="ClearFrame orchestrator",
    version="0.1.0",
    description="Pass planning, fan-out, the challenge loop, delta re-clearance, "
    "and the read surface the war room subscribes to.",
    lifespan=lifespan,
)


# ------------------------------------------------------------- Pub/Sub push in


async def _push(request: Request, authorization: str | None) -> dict[str, Any]:
    """Handle one pushed event.

    The push endpoints are Cloud Run services with no public invoker, and the
    token is verified on top of that: a subscription is only allowed to wake the
    crew if Pub/Sub minted its token for the account we configured.
    """
    try:
        verify_push_caller(authorization)
    except IdentityError as exc:
        log_event(log, "push refused", error=str(exc))
        raise HTTPException(401, str(exc)) from exc

    try:
        envelope = decode_push(await request.json())
    except (ValueError, KeyError) as exc:
        # A malformed push must not be redelivered forever.
        log_event(log, "push undecodable", error=repr(exc))
        raise HTTPException(400, f"undecodable push body: {exc}") from exc

    await handlers.route(envelope)
    return {"ok": True}


@app.post("/handle/research")
async def push_research(
    request: Request, authorization: str | None = Header(default=None)
) -> dict[str, Any]:
    return await _push(request, authorization)


@app.post("/handle/finding")
async def push_finding(
    request: Request, authorization: str | None = Header(default=None)
) -> dict[str, Any]:
    return await _push(request, authorization)


@app.post("/handle/decision")
async def push_decision(
    request: Request, authorization: str | None = Header(default=None)
) -> dict[str, Any]:
    return await _push(request, authorization)


@app.post("/handle/monitor")
async def push_monitor(
    request: Request, authorization: str | None = Header(default=None)
) -> dict[str, Any]:
    return await _push(request, authorization)


# ------------------------------------------------------------------- projects


class CreateProject(BaseModel):
    title: str
    budget_cap_usd: float = Field(default=0.0, ge=0.0)
    org_id: str = "default"


@app.post("/projects", summary="Create a project")
async def create_project(body: CreateProject) -> dict[str, Any]:
    project = Project(
        project_id=new_project_id(),
        title=body.title,
        org_id=body.org_id,
        budget_cap_usd=body.budget_cap_usd or settings().default_budget_cap_usd,
    )
    await get_store().create_project(project)
    return project.model_dump(mode="json")


@app.get("/projects", summary="List projects")
async def list_projects() -> dict[str, Any]:
    return {"projects": [p.model_dump(mode="json") for p in await get_store().list_projects()]}


@app.get("/projects/{project_id}", summary="Project with its cuts, passes and budget")
async def get_project(project_id: str) -> dict[str, Any]:
    store = get_store()
    project = await store.get_project(project_id)
    if project is None:
        raise HTTPException(404, f"project {project_id} not found")
    return {
        "project": project.model_dump(mode="json"),
        "cuts": [c.model_dump(mode="json") for c in await store.list_cuts(project_id)],
        "passes": [p.model_dump(mode="json") for p in await store.list_passes(project_id)],
        "budget": (await store.budget(project_id)).model_dump(mode="json"),
    }


class BudgetUpdate(BaseModel):
    budget_cap_usd: float = Field(gt=0)


@app.put("/projects/{project_id}/budget", summary="Raise the cap (producer only)")
async def set_budget(project_id: str, body: BudgetUpdate) -> dict[str, Any]:
    budget = await get_store().raise_budget(project_id, body.budget_cap_usd)
    return budget.model_dump(mode="json")


@app.get("/projects/{project_id}/budget", summary="Live spend for the budget meter")
async def get_budget(project_id: str) -> dict[str, Any]:
    from clearframe_adapter import pricing

    budget = await get_store().budget(project_id)
    return {
        **budget.model_dump(mode="json"),
        "pct": budget.pct,
        "warn": budget.warn,
        "pricing_note": pricing.cost_note(),
    }


class RoleBinding(BaseModel):
    subject: str
    role: Role


@app.put("/projects/{project_id}/roles", summary="Bind a principal to a project role")
async def bind_project_role(project_id: str, body: RoleBinding) -> dict[str, Any]:
    from clearframe_ledger.auth import bind_role

    await bind_role(project_id, body.subject, body.role)
    return {"ok": True, "subject": body.subject, "role": body.role.value}


# ----------------------------------------------------------------------- cuts


@app.post("/projects/{project_id}/cuts", summary="Upload a script or a cut and break it down")
async def upload_cut(
    project_id: str,
    file: UploadFile | None = File(default=None),
    label: str = Query(default="cut-01"),
    local_path: str | None = Query(
        default=None, description="Server-side path, for seeding and CI"
    ),
    run_breakdown: bool = Query(default=True),
) -> dict[str, Any]:
    store = get_store()
    if await store.get_project(project_id) is None:
        raise HTTPException(404, f"project {project_id} not found")

    if file is not None:
        suffix = Path(file.filename or "upload").suffix
        tmp = Path(tempfile.mkdtemp(prefix="cf-upload-")) / f"source{suffix}"
        tmp.write_bytes(await file.read())
        source = tmp
        original = file.filename or tmp.name
    elif local_path:
        source = Path(local_path)
        original = source.name
    else:
        raise HTTPException(400, "provide a file upload or local_path")

    try:
        material = await ingest(source)
    except IngestError as exc:
        # A judge's odd upload ends cleanly with a reason, never a stack trace.
        raise HTTPException(422, str(exc)) from exc

    import hashlib

    payload = source.read_bytes()
    stored_uri = get_blobs().put(
        settings().bucket_cuts, f"{project_id}/{original}", payload, "application/octet-stream"
    )

    cut = Cut(
        cut_id=new_cut_id(),
        project_id=project_id,
        label=label,
        gcs_uri=stored_uri,
        kind=material.kind,
        cut_hash=hashlib.sha256(payload).hexdigest()[:32],
        duration_frames=material.duration_frames,
        fps=material.fps or 24.0,
    )
    await store.put_cut(cut)

    items: list[Any] = []
    if run_breakdown:
        if not agents_client.model_available():
            raise HTTPException(
                503,
                "no reasoning backend configured: set VERTEX_PROJECT and install the "
                "gemini extra, or upload with run_breakdown=false and post items directly",
            )
        items = await breakdown.run_breakdown(project_id, cut, source, ingested=material)

    return {
        "cut": cut.model_dump(mode="json"),
        "items_extracted": len(items),
        "kind": material.kind,
        "pages": material.pages,
        "keyframes": len(material.media),
    }


@app.get("/cuts/{cut_id}/items", summary="The item register for a cut")
async def cut_items(cut_id: str) -> dict[str, Any]:
    items = await get_store().list_items(cut_id=cut_id)
    return {"count": len(items), "items": [state.item_public(i) for i in items]}


@app.get("/cuts/{cut_id}/heatstrip", summary="Timecode-aligned risk regions")
async def cut_heatstrip(cut_id: str) -> dict[str, Any]:
    cut = await get_store().get_cut(cut_id)
    if cut is None:
        raise HTTPException(404, f"cut {cut_id} not found")
    return {
        "cut_id": cut_id,
        "duration_frames": cut.duration_frames,
        "fps": cut.fps,
        "regions": await state.heat_strip(cut_id),
    }


@app.get("/cuts/{cut_id}/delta", summary="What a delta pass would re-clear")
async def preview_delta(cut_id: str) -> dict[str, Any]:
    plan = await delta.compute_delta(cut_id)
    return {
        **plan.summary(),
        "added": [i.item_id for i in plan.added],
        "removed": [i.item_id for i in plan.removed],
        "re_researched": [i.item_id for i in plan.to_research],
    }


# ---------------------------------------------------------------------- passes


class StartPass(BaseModel):
    cut_id: str
    mode: PassMode = PassMode.FULL


@app.post("/projects/{project_id}/passes", summary="Start a pass")
async def start_pass(project_id: str, body: StartPass) -> dict[str, Any]:
    store = get_store()
    if await store.get_cut(body.cut_id) is None:
        raise HTTPException(404, f"cut {body.cut_id} not found")
    if not agents_client.model_available():
        raise HTTPException(503, "no reasoning backend configured")
    record = await dispatch.start_pass(project_id, body.cut_id, mode=body.mode)
    return record.model_dump(mode="json")


@app.get("/passes/{pass_id}", summary="Live pass state")
async def get_pass(pass_id: str) -> dict[str, Any]:
    record = await state.refresh_pass(pass_id)
    return record.model_dump(mode="json")


@app.get("/passes/{pass_id}/feed", summary="The crew feed")
async def pass_feed(pass_id: str, limit: int = 200) -> dict[str, Any]:
    return {"feed": await get_store().list_feed(pass_id, limit=limit)}


@app.post("/passes/{pass_id}/pause", summary="Kill switch — drains, never drops")
async def pause_pass(
    pass_id: str, reason: str = Body(default="paused by producer", embed=True)
) -> dict[str, Any]:
    record = await state.pause_pass(pass_id, reason)
    bus = get_bus()
    if hasattr(bus, "drain"):
        await bus.drain(timeout=30)
    return record.model_dump(mode="json")


@app.post("/passes/{pass_id}/complete", summary="Close the pass and recount")
async def complete_pass(pass_id: str) -> dict[str, Any]:
    return (await state.complete_pass(pass_id)).model_dump(mode="json")


# ----------------------------------------------------------------------- items


@app.get("/items/{item_id}", summary="An item with everything known about it")
async def get_item(item_id: str) -> dict[str, Any]:
    store = get_store()
    item = await store.get_item(item_id)
    if item is None:
        raise HTTPException(404, f"item {item_id} not found")
    findings = await store.list_findings(item_id=item_id, live_only=True)
    assessment = await store.latest_assessment(item_id)
    return {
        "item": state.item_public(item),
        "findings": [f.model_dump(mode="json") for f in findings],
        "challenges": [
            c.model_dump(mode="json") for c in await store.list_challenges(item_id=item_id)
        ],
        "assessment": assessment.model_dump(mode="json") if assessment else None,
    }


@app.get("/items/{item_id}/provenance", summary="The chain-of-title graph")
async def item_provenance(item_id: str) -> dict[str, Any]:
    try:
        return await provenance.build(item_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.get("/projects/{project_id}/riskboard", summary="Red / amber / green columns")
async def riskboard(project_id: str, cut_id: str | None = None) -> dict[str, Any]:
    store = get_store()
    items = await (
        store.list_items(cut_id=cut_id) if cut_id else store.list_items(project_id=project_id)
    )
    columns: dict[str, list[dict]] = {"red": [], "amber": [], "green": [], "unknown": []}
    for item in items:
        if item.status is ItemStatus.WITHDRAWN:
            continue
        key = item.risk_state or "unknown"
        columns.setdefault(key, []).append(state.item_public(item))
    return {"columns": columns, "counts": {k: len(v) for k, v in columns.items()}}


@app.get("/projects/{project_id}/approvals", summary="What is waiting on counsel")
async def approvals(project_id: str) -> dict[str, Any]:
    store = get_store()
    pending = []
    for item in await store.list_items(project_id=project_id):
        if item.status is not ItemStatus.PENDING_APPROVAL:
            continue
        assessment = await store.latest_assessment(item.item_id)
        pending.append(
            {
                "item": state.item_public(item),
                "assessment": assessment.model_dump(mode="json") if assessment else None,
                "findings": [
                    f.model_dump(mode="json")
                    for f in await store.list_findings(item_id=item.item_id, live_only=True)
                ],
            }
        )
    outreach_pending = [
        d.model_dump(mode="json")
        for d in await store.list_outreach(project_id)
        if d.status.value == "pending_approval"
    ]
    return {
        "items": pending,
        "outreach": outreach_pending,
        "counts": {"items": len(pending), "outreach": len(outreach_pending)},
    }


@app.get("/projects/{project_id}/outreach", summary="The outreach queue")
async def outreach_queue(project_id: str) -> dict[str, Any]:
    drafts = await get_store().list_outreach(project_id)
    return {
        "drafts": [d.model_dump(mode="json") for d in drafts],
        "note": "ClearFrame has no send capability; the queue is the feature",
    }


# --------------------------------------------------------------------- watches


@app.get("/projects/{project_id}/watches", summary="Armed monitors and reopen history")
async def list_watches(project_id: str) -> dict[str, Any]:
    watches = await get_store().list_watches(project_id)
    return {"watches": [w.model_dump(mode="json") for w in watches]}


@app.post("/projects/{project_id}/watches/arm", summary="Arm watches (report ship)")
async def arm_watches(
    project_id: str, only_non_green: bool = Query(default=True)
) -> dict[str, Any]:
    armed = await sentinel.arm_watches(project_id, only_non_green=only_non_green)
    return {"armed": [w.model_dump(mode="json") for w in armed], "count": len(armed)}


# --------------------------------------------------------------------- reports


class RenderReport(BaseModel):
    cut_id: str
    pdf: bool = True
    arm_watches: bool = True


@app.post("/projects/{project_id}/reports", summary="Ship the E&O pack and arm the watch")
async def render_report(project_id: str, body: RenderReport) -> dict[str, Any]:
    from clearframe_renderer import render as renderer

    result = await renderer.render(project_id, body.cut_id, pdf=body.pdf)
    armed = []
    if body.arm_watches:
        armed = await sentinel.arm_watches(project_id)
    return {**result, "watches_armed": len(armed)}


@app.get("/projects/{project_id}/ledger/verify", summary="Recompute the hash chain")
async def verify_ledger(project_id: str) -> dict[str, Any]:
    from clearframe_ledger.chain import verify_chain

    return verify_chain(project_id)


# ---------------------------------------------------------------------- health


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {"ok": True, "ts": utcnow().isoformat()}


@app.get("/readyz", summary="What is actually wired up right now")
async def readyz() -> dict[str, Any]:
    cfg = settings()
    parallel_ready = True
    parallel_detail = ""
    try:
        from clearframe_runtime import parallel_api_key

        parallel_ready = bool(parallel_api_key())
    except Exception as exc:  # noqa: BLE001 — readiness reports, never raises
        parallel_ready, parallel_detail = False, repr(exc)

    return {
        "backend": cfg.backend,
        "model_available": agents_client.model_available(),
        "parallel_key_available": parallel_ready,
        "parallel_detail": parallel_detail,
        "webhook_url_configured": bool(cfg.url_webhook),
        "agent_builder_app": bool(cfg.agent_app_id),
        "datastores": bool(cfg.datastore_eo_id or cfg.datastore_handbooks_id),
    }
