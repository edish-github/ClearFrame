"""Breakdown — the script supervisor.

Reads the upload, emits items with anchors and a content hash. Extraction only:
this agent never says who owns anything, which is why its output schema has no
field in which to say it.
"""

from __future__ import annotations

from pathlib import Path

from clearframe_contracts import Cut, Item, ItemStatus, ItemType, Prominence, Timecode
from clearframe_ledger.chain import append as ledger_append
from clearframe_runtime import get_logger, get_store, log_event
from clearframe_runtime.ids import item_id as new_item_id

from . import agents_client
from .ingest import IngestedCut, ingest
from .models import ModelClient
from .toolbelt import RunContext, extracted_items

log = get_logger("clearframe.breakdown")

TASK_TEMPLATE = """Break down this {kind} for clearance.

Production: {title}
Cut: {label} ({cut_id})

Find every third-party element that would need clearing before distribution.
Work through the material systematically rather than sampling it: music cues and
lyric quotes, visible brands and packaging, artwork and posters and murals, real
people depicted or named, archival or stock footage, recognisable locations, and
distinctive typefaces.

Anchor each item: scene and page for a script, frame numbers for picture (the
keyframe labels give you t= and frame= for each image).

Call record_items exactly once with everything you found. If you find nothing,
call it with an empty list and say why in notes.

{source}
"""


def _prominence(value: str | None) -> Prominence:
    try:
        return Prominence(value or "background")
    except ValueError:
        return Prominence.BACKGROUND


def _item_type(value: str) -> ItemType | None:
    try:
        return ItemType(value)
    except ValueError:
        return None


def to_items(raw_items: list[dict], cut: Cut) -> list[Item]:
    """Extraction output -> Item rows, hashed and anchored."""
    items: list[Item] = []
    for raw in raw_items:
        item_type = _item_type(str(raw.get("type", "")))
        if item_type is None or not raw.get("title"):
            continue
        frame_in = int(raw.get("frame_in") or 0)
        frame_out = int(raw.get("frame_out") or frame_in)
        if frame_out < frame_in:
            frame_in, frame_out = frame_out, frame_in
        item = Item(
            item_id=new_item_id(),
            cut_id=cut.cut_id,
            project_id=cut.project_id,
            type=item_type,
            title=str(raw.get("title"))[:200],
            description=str(raw.get("description", ""))[:2000],
            timecode=Timecode(
                frame_in=frame_in,
                frame_out=frame_out,
                fps=cut.fps or 24.0,
                scene=raw.get("scene"),
                page=raw.get("page"),
            ),
            prominence=_prominence(raw.get("prominence")),
            attrs=raw.get("attrs") or {},
            status=ItemStatus.EXTRACTED,
        )
        items.append(item.with_hash())
    return items


async def run_breakdown(
    project_id: str,
    cut: Cut,
    source_path: str | Path,
    *,
    model_client: ModelClient | None = None,
    ingested: IngestedCut | None = None,
) -> list[Item]:
    """Run the Breakdown playbook over one upload and persist the item register."""
    material = ingested or await ingest(source_path)
    store = get_store()
    project = await store.get_project(project_id)

    if material.duration_frames and not cut.duration_frames:
        cut = cut.model_copy(
            update={
                "duration_frames": material.duration_frames,
                "fps": material.fps,
                "kind": material.kind,
            }
        )
        await store.put_cut(cut)

    ctx = RunContext(
        project_id=project_id, pass_id=f"breakdown:{cut.cut_id}", agent="breakdown", tier=0
    )
    task = TASK_TEMPLATE.format(
        kind=material.kind,
        title=project.title if project else project_id,
        label=cut.label,
        cut_id=cut.cut_id,
        source=("SCRIPT TEXT FOLLOWS\n\n" + material.text[:400_000])
        if material.kind == "script"
        else material.text,
    )

    run = await agents_client.invoke(
        "breakdown",
        ctx,
        task,
        model_client=model_client,
        media=material.media,
    )
    items = to_items(extracted_items(ctx), cut)

    for item in items:
        await store.put_item(item)
    await ledger_append(
        project_id,
        "breakdown",
        {
            "type": "breakdown.completed",
            "cut_id": cut.cut_id,
            "items": len(items),
            "kind": material.kind,
            "notes": " ".join(ctx.notes)[:500],
        },
    )
    log_event(
        log,
        "breakdown complete",
        cut_id=cut.cut_id,
        items=len(items),
        tool_calls=[c["name"] for c in run.tool_calls],
    )
    return items
