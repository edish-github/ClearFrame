"""Delta re-clearance: a re-cut must not restart the investigation."""

from __future__ import annotations

import pytest
from clearframe_contracts import (
    Citation,
    Cut,
    Finding,
    Item,
    ItemStatus,
    ItemType,
    Project,
    Prominence,
    Timecode,
    utcnow,
)
from clearframe_orch.delta import compute_delta
from clearframe_runtime import get_store
from clearframe_runtime.ids import finding_id, item_id


def _item(
    cut_id: str, title: str, *, scene: str, frame_in: int, description: str = "as seen in the scene"
) -> Item:
    return Item(
        item_id=item_id(),
        cut_id=cut_id,
        project_id="prj_d",
        type=ItemType.BRAND,
        title=title,
        description=description,
        timecode=Timecode(frame_in=frame_in, frame_out=frame_in + 48, scene=scene),
        prominence=Prominence.BACKGROUND,
    ).with_hash()


@pytest.mark.asyncio
async def test_unchanged_items_inherit_and_only_the_difference_is_researched(workspace):
    store = get_store()
    await store.create_project(Project(project_id="prj_d", title="Re-cut picture"))

    cut1 = Cut(cut_id="cut_1", project_id="prj_d", label="cut-01")
    await store.put_cut(cut1)
    kept = [_item("cut_1", f"Brand {i}", scene=str(i), frame_in=i * 100) for i in range(5)]
    dropped = _item("cut_1", "Removed poster", scene="9", frame_in=900)
    for item in [*kept, dropped]:
        await store.put_item(item)
        await store.set_status(item.item_id, ItemStatus.QUEUED)
        await store.set_status(item.item_id, ItemStatus.RESEARCHING)
        await store.set_status(item.item_id, ItemStatus.VERIFIED)
        await store.set_status(item.item_id, ItemStatus.RISK_SCORED)
        await store.set_status(item.item_id, ItemStatus.RESOLVED)
        await store.update_item(item.item_id, risk_state="green")
        await store.put_finding(
            Finding(
                finding_id=finding_id(),
                item_id=item.item_id,
                project_id="prj_d",
                pass_id="pass_1",
                agent="marks_brands",
                claim={"owner_of_record": "Acme"},
                confidence=0.9,
                ts=utcnow(),
                citations=[Citation(citation_id="cit_1", url="https://uspto.gov/x")],
            )
        )

    # the new cut keeps five items untouched, moves one in time, drops one, adds two
    import asyncio

    await asyncio.sleep(0.01)
    cut2 = Cut(cut_id="cut_2", project_id="prj_d", label="cut-02")
    await store.put_cut(cut2)
    moved = _item("cut_2", "Brand 0", scene="1", frame_in=4200)  # same content, new time
    same = [_item("cut_2", f"Brand {i}", scene=str(i), frame_in=i * 100) for i in range(1, 5)]
    added = [
        _item("cut_2", "New mural", scene="12", frame_in=1200),
        _item("cut_2", "New soda can", scene="13", frame_in=1300),
    ]
    for item in [moved, *same, *added]:
        await store.put_item(item)

    plan = await compute_delta("cut_2")

    assert plan.summary() == {"added": 2, "removed": 1, "inherited": 5, "re_researched": 2}

    # a scene that moved is not a new item: it inherited its state and its findings
    inherited = await store.get_item(moved.item_id)
    assert inherited.status is ItemStatus.RESOLVED
    assert inherited.risk_state == "green"
    assert inherited.inherited_from is not None
    assert await store.list_findings(item_id=moved.item_id)

    withdrawn = await store.get_item(dropped.item_id)
    assert withdrawn.status is ItemStatus.WITHDRAWN


@pytest.mark.asyncio
async def test_first_cut_has_no_delta(workspace):
    store = get_store()
    await store.create_project(Project(project_id="prj_d", title="First cut"))
    await store.put_cut(Cut(cut_id="cut_only", project_id="prj_d"))
    for i in range(3):
        await store.put_item(_item("cut_only", f"Brand {i}", scene=str(i), frame_in=i * 10))

    plan = await compute_delta("cut_only")
    assert len(plan.added) == 3
    assert plan.removed == []
