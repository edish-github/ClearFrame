"""Parallel adapter — the HTTP surface playbooks and the orchestrator call.

Registered in Agent Builder from `agents/tools/parallel-adapter.json`, which is
generated from this app's OpenAPI document. The service holds the API key and
does no reasoning whatsoever.
"""

from __future__ import annotations

from typing import Any

from clearframe_contracts import Citation, Finding
from clearframe_contracts.schema_registry import load_schema
from clearframe_runtime import get_logger, log_event
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import deep_research, findall, monitor, normalize, pricing, search, snapshots
from .client import ParallelError, get_client
from .task import run_task

log = get_logger("clearframe.adapter")

app = FastAPI(
    title="ClearFrame Parallel adapter",
    version="0.1.0",
    description=(
        "One seam for every Parallel API call: Task, Deep Research, FindAll, Monitor. "
        "Search and Extract also reach agents through Parallel's managed MCP server."
    ),
)


class TaskRequest(BaseModel):
    objective: str
    schema_name: str | None = Field(
        default=None, description="music_rights | trademark | likeness | footage"
    )
    output_schema: dict | None = None
    tier: int = 1
    item_id: str
    project_id: str
    pass_id: str
    agent: str
    prev_interaction_id: str | None = None
    snapshot: bool = True


class FindingResponse(BaseModel):
    finding: Finding
    cost_usd: float
    processor: str
    run_id: str | None = None
    interaction_id: str | None = None


def _resolve_schema(request: TaskRequest) -> dict:
    if request.output_schema:
        return request.output_schema
    if request.schema_name:
        try:
            return load_schema(request.schema_name)
        except KeyError as exc:
            raise HTTPException(400, str(exc)) from exc
    raise HTTPException(400, "either schema_name or output_schema is required")


@app.post(
    "/task/run",
    response_model=FindingResponse,
    summary="Run one structured research task and return a normalized finding",
)
async def task_run(request: TaskRequest) -> FindingResponse:
    """T1-T3. The processor comes from the tier; the caller never picks it directly."""
    output_schema = _resolve_schema(request)
    try:
        processor = pricing.processor_for_tier(request.tier)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    try:
        if request.tier >= 3:
            raw = await deep_research.run_dossier(
                request.objective,
                output_schema,
                prev_interaction_id=request.prev_interaction_id,
                metadata={"item_id": request.item_id, "pass_id": request.pass_id},
            )
        else:
            raw = await run_task(
                request.objective,
                output_schema,
                processor=processor,
                prev_interaction_id=request.prev_interaction_id,
                metadata={"item_id": request.item_id, "pass_id": request.pass_id},
            )
    except ParallelError as exc:
        log_event(log, "task failed", item_id=request.item_id, error=str(exc))
        raise HTTPException(502, f"parallel task failed: {exc}") from exc

    cost = pricing.cost_for_tier(request.tier)
    finding = normalize.to_finding(
        raw,
        item_id=request.item_id,
        project_id=request.project_id,
        pass_id=request.pass_id,
        agent=request.agent,
        tier=request.tier,
        cost_usd=cost,
        prev_interaction_id=request.prev_interaction_id,
    )
    if request.snapshot and finding.citations:
        finding = finding.model_copy(
            update={
                "citations": await snapshots.snapshot_citations(
                    finding.citations, request.project_id
                )
            }
        )
    return FindingResponse(
        finding=finding,
        cost_usd=cost,
        processor=processor,
        run_id=raw.get("run_id"),
        interaction_id=raw.get("interaction_id"),
    )


class SearchRequest(BaseModel):
    objective: str
    search_queries: list[str]
    max_results: int = 8
    as_citations: bool = False


class SearchResponse(BaseModel):
    search_id: str | None = None
    results: list[dict] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)
    cost_usd: float = pricing.SEARCH_COST_USD


@app.post("/search", response_model=SearchResponse, summary="T0 recon — cited excerpts")
async def do_search(request: SearchRequest) -> SearchResponse:
    try:
        payload = await search.search(
            request.objective, request.search_queries, max_results=request.max_results
        )
    except ParallelError as exc:
        raise HTTPException(502, f"parallel search failed: {exc}") from exc
    results = payload.get("results", [])
    return SearchResponse(
        search_id=payload.get("search_id"),
        results=results,
        citations=normalize.citations_from_search(results) if request.as_citations else [],
    )


class ExtractRequest(BaseModel):
    urls: list[str]
    objective: str | None = None
    full_content: bool = False


@app.post("/extract", summary="Fetch cited pages as clean markdown")
async def do_extract(request: ExtractRequest) -> dict[str, Any]:
    try:
        return await search.extract(
            request.urls, objective=request.objective, full_content=request.full_content
        )
    except ParallelError as exc:
        raise HTTPException(502, f"parallel extract failed: {exc}") from exc


class FindAllRequest(BaseModel):
    objective: str
    match_conditions: list[dict]
    entity_type: str = "companies"
    generator: str = "core"
    match_limit: int = 10


@app.post("/findall", summary="Discover controlling entities and licensing contacts")
async def do_findall(request: FindAllRequest) -> dict[str, Any]:
    try:
        result = await findall.find_rights_holders(
            request.objective,
            request.match_conditions,
            generator=request.generator,
            match_limit=request.match_limit,
        )
    except ParallelError as exc:
        raise HTTPException(502, f"parallel findall failed: {exc}") from exc
    return {
        "findall_id": result.get("findall_id"),
        "matches": findall.extract_matches(result),
        "cost_usd": pricing.FINDALL_COST_USD,
    }


class ArmWatchRequest(BaseModel):
    subject: str
    change_classes: list[str]
    webhook_url: str
    frequency: str | None = None
    metadata: dict[str, str] = Field(default_factory=dict)


@app.post("/monitor/arm", summary="Arm a Parallel Monitor on a rights holder")
async def arm(request: ArmWatchRequest) -> dict[str, Any]:
    try:
        result = await monitor.arm_watch(
            request.subject,
            request.change_classes,
            request.webhook_url,
            frequency=request.frequency,
            metadata=request.metadata,
        )
    except ParallelError as exc:
        raise HTTPException(502, f"parallel monitor failed: {exc}") from exc
    return {
        "monitor_id": result.get("monitor_id"),
        "status": result.get("status"),
        "frequency": result.get("frequency"),
        "cost_usd": pricing.MONITOR_ARM_COST_USD,
    }


@app.delete("/monitor/{monitor_id}", summary="Disarm a watch")
async def disarm(monitor_id: str) -> dict[str, Any]:
    try:
        return await monitor.disarm_watch(monitor_id)
    except ParallelError as exc:
        raise HTTPException(502, f"parallel monitor disarm failed: {exc}") from exc


@app.get("/monitor/{monitor_id}/events", summary="Poll a watch's events")
async def monitor_events(monitor_id: str, limit: int = 20) -> dict[str, Any]:
    try:
        return await monitor.list_events(monitor_id, limit=limit)
    except ParallelError as exc:
        raise HTTPException(502, f"parallel monitor events failed: {exc}") from exc


@app.get("/healthz", summary="Liveness, and whether the API key is readable")
async def healthz() -> dict[str, Any]:
    key_ok = True
    detail = ""
    try:
        get_client()
    except Exception as exc:  # noqa: BLE001 — health must report, not raise
        key_ok, detail = False, repr(exc)
    return {
        "ok": True,
        "parallel_key_available": key_ok,
        "detail": detail,
        "pricing_calibrated": pricing.CALIBRATED,
    }
