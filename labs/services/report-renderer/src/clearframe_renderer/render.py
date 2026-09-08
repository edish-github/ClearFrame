"""Render the E&O clearance pack.

Conservative in form so an underwriter recognises it, radical in one property:
every claim is a link, and every link has a stored snapshot. HTML always; PDF
when WeasyPrint is installed, which is how it runs in Cloud Run.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from clearframe_contracts import NOT_LEGAL_ADVICE, utcnow
from clearframe_runtime import get_blobs, get_logger, log_event, settings
from clearframe_runtime.ids import report_id as new_report_id
from jinja2 import Environment, FileSystemLoader, select_autoescape

from . import views

log = get_logger("clearframe.renderer")

TEMPLATE_DIR = Path(__file__).parent / "templates"


def _env() -> Environment:
    env = Environment(
        loader=FileSystemLoader(TEMPLATE_DIR),
        autoescape=select_autoescape(["html"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.filters["risk_class"] = lambda value: f"risk-{(value or 'unknown').lower()}"
    return env


async def render_html(project_id: str, cut_id: str) -> str:
    data = await views.gather(project_id, cut_id)
    return (
        _env()
        .get_template("report.html.j2")
        .render(
            **data,
            disclaimer=NOT_LEGAL_ADVICE,
            generated=utcnow().isoformat(timespec="seconds"),
        )
    )


def to_pdf(html: str) -> bytes | None:
    try:
        from weasyprint import HTML
    except ImportError:
        log.warning("weasyprint unavailable; rendering HTML only")
        return None
    return HTML(string=html, base_url=str(TEMPLATE_DIR)).write_pdf()


async def render(project_id: str, cut_id: str, *, pdf: bool = True) -> dict[str, Any]:
    """Render, store, and return links. The HTML is always written; the PDF when it can be."""
    html = await render_html(project_id, cut_id)
    blobs = get_blobs()
    bucket = settings().bucket_reports
    stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    report = new_report_id()

    html_path = f"reports/{project_id}/{cut_id}/clearance-{stamp}.html"
    html_uri = blobs.put(bucket, html_path, html.encode(), "text/html")
    result: dict[str, Any] = {
        "report_id": report,
        "html_uri": html_uri,
        "html_url": blobs.signed_url(bucket, html_path),
        "pdf_uri": None,
        "pdf_url": None,
        "generated": stamp,
    }

    if pdf:
        rendered = to_pdf(html)
        if rendered:
            pdf_path = f"reports/{project_id}/{cut_id}/clearance-{stamp}.pdf"
            result["pdf_uri"] = blobs.put(bucket, pdf_path, rendered, "application/pdf")
            result["pdf_url"] = blobs.signed_url(bucket, pdf_path, hours=72)

    from clearframe_ledger.chain import append as ledger_append

    await ledger_append(
        project_id,
        "ledger",
        {
            "type": "report.rendered",
            "report_id": report,
            "cut_id": cut_id,
            "html_uri": result["html_uri"],
            "pdf_uri": result["pdf_uri"],
        },
    )
    log_event(
        log, "report rendered", project_id=project_id, cut_id=cut_id, pdf=bool(result["pdf_uri"])
    )
    return result
