"""Report renderer — a Cloud Run service and a Cloud Run job in one image."""

from __future__ import annotations

from typing import Any

from clearframe_runtime import get_logger
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from . import render as renderer
from . import views

log = get_logger("clearframe.renderer.api")

app = FastAPI(title="ClearFrame report renderer", version="0.1.0")


class RenderRequest(BaseModel):
    project_id: str
    cut_id: str
    pdf: bool = True


@app.post("/render", summary="Render and store the E&O pack")
async def do_render(request: RenderRequest) -> dict[str, Any]:
    try:
        return await renderer.render(request.project_id, request.cut_id, pdf=request.pdf)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.get(
    "/preview/{project_id}/{cut_id}",
    response_class=HTMLResponse,
    summary="Render without storing — the war room's report preview",
)
async def preview(project_id: str, cut_id: str) -> HTMLResponse:
    return HTMLResponse(await renderer.render_html(project_id, cut_id))


@app.get("/data/{project_id}/{cut_id}", summary="The report as JSON, section by section")
async def data(project_id: str, cut_id: str) -> dict[str, Any]:
    return await views.gather(project_id, cut_id)


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    from .render import to_pdf

    return {"ok": True, "pdf_available": to_pdf("<html><body>probe</body></html>") is not None}
