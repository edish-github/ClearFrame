"""The HTTP surface the war room will call, exercised end to end.

No model and no network: this asserts the pathways, the projections, and the
failure states a frontend has to render.
"""

from __future__ import annotations

import pytest
from clearframe_contracts import (
    Cut,
    Item,
    ItemStatus,
    ItemType,
    Project,
    Prominence,
    Timecode,
)
from clearframe_runtime import get_store
from clearframe_runtime.ids import item_id as new_item_id
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def api(workspace):
    from clearframe_orch.main import app

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://orchestrator"
    ) as client:
        yield client


@pytest.mark.asyncio
async def test_readyz_reports_what_is_actually_wired(api):
    response = await api.get("/readyz")
    assert response.status_code == 200
    body = response.json()
    assert body["backend"] == "local"
    assert body["parallel_key_available"] is True  # set by the workspace fixture
    assert set(body) >= {
        "model_available",
        "webhook_url_configured",
        "agent_builder_app",
        "datastores",
    }


@pytest.mark.asyncio
async def test_project_lifecycle_and_budget(api):
    created = (
        await api.post("/projects", json={"title": "The Last Hour", "budget_cap_usd": 25})
    ).json()
    project_id = created["project_id"]
    assert created["budget_cap_usd"] == 25

    listed = (await api.get("/projects")).json()
    assert any(p["project_id"] == project_id for p in listed["projects"])

    detail = (await api.get(f"/projects/{project_id}")).json()
    assert detail["project"]["title"] == "The Last Hour"
    assert detail["budget"]["cap_usd"] == 25

    raised = (await api.put(f"/projects/{project_id}/budget", json={"budget_cap_usd": 60})).json()
    assert raised["cap_usd"] == 60

    meter = (await api.get(f"/projects/{project_id}/budget")).json()
    assert meter["pct"] == 0.0
    assert meter["warn"] is False
    assert "estimate" in meter["pricing_note"] or "invoice" in meter["pricing_note"]

    assert (await api.get("/projects/prj_nope")).status_code == 404


@pytest.mark.asyncio
async def test_upload_rejects_unreadable_material_with_a_usable_message(api, tmp_path):
    project_id = (await api.post("/projects", json={"title": "Odd uploads"})).json()["project_id"]

    junk = tmp_path / "notes.xyz"
    junk.write_text("hello")
    response = await api.post(
        f"/projects/{project_id}/cuts", params={"local_path": str(junk), "run_breakdown": "false"}
    )
    assert response.status_code == 422
    assert "unsupported file type" in response.json()["detail"]

    empty = tmp_path / "empty.txt"
    empty.write_text("")
    response = await api.post(
        f"/projects/{project_id}/cuts", params={"local_path": str(empty), "run_breakdown": "false"}
    )
    assert response.status_code == 422
    assert "empty" in response.json()["detail"]


@pytest.mark.asyncio
async def test_upload_without_breakdown_stores_the_cut(api, tmp_path):
    project_id = (await api.post("/projects", json={"title": "Script only"})).json()["project_id"]
    script = tmp_path / "script.fountain"
    script.write_text("INT. ROOM - DAY\n\nA radio plays.\n")

    body = (
        await api.post(
            f"/projects/{project_id}/cuts",
            params={"local_path": str(script), "run_breakdown": "false"},
        )
    ).json()
    assert body["kind"] == "script"
    assert body["items_extracted"] == 0
    assert body["cut"]["cut_hash"]

    items = (await api.get(f"/cuts/{body['cut']['cut_id']}/items")).json()
    assert items["count"] == 0, "an empty register is a state, not an error"


@pytest.mark.asyncio
async def test_projections_the_war_room_reads(api, workspace):
    store = get_store()
    await store.create_project(Project(project_id="prj_ui", title="UI"))
    await store.put_cut(Cut(cut_id="cut_ui", project_id="prj_ui", duration_frames=2400, fps=24.0))

    reds = []
    for index, (kind, risk, frame) in enumerate(
        [
            (ItemType.MUSIC_CUE, "red", 1200),
            (ItemType.BRAND, "amber", 600),
            (ItemType.ARTWORK, "green", 30),
            (ItemType.FOOTAGE, None, 2000),
        ]
    ):
        item = Item(
            item_id=new_item_id(),
            cut_id="cut_ui",
            project_id="prj_ui",
            type=kind,
            title=f"item {index}",
            description="d",
            timecode=Timecode(frame_in=frame, frame_out=frame + 24, scene=str(index)),
            prominence=Prominence.FEATURED,
            risk_state=risk,
        ).with_hash()
        await store.put_item(item)
        if risk == "red":
            reds.append(item)

    strip = (await api.get("/cuts/cut_ui/heatstrip")).json()
    assert strip["duration_frames"] == 2400
    assert len(strip["regions"]) == 4
    assert strip["regions"] == sorted(strip["regions"], key=lambda r: r["start_pct"])
    assert all(r["width_pct"] >= 0.4 for r in strip["regions"]), "hairline floor"
    assert all(0 <= r["start_pct"] <= 100 for r in strip["regions"])
    assert {r["risk"] for r in strip["regions"]} == {"red", "amber", "green", "unknown"}

    board = (await api.get("/projects/prj_ui/riskboard", params={"cut_id": "cut_ui"})).json()
    assert board["counts"]["red"] == 1
    assert board["counts"]["unknown"] == 1

    detail = (await api.get(f"/items/{reds[0].item_id}")).json()
    assert detail["item"]["tc_in"] == "00:00:50:00"
    assert detail["findings"] == []
    assert detail["assessment"] is None

    graph = (await api.get(f"/items/{reds[0].item_id}/provenance")).json()
    assert graph["chains"] == ["composition", "master"], "a music item has two chains"
    assert graph["resolved"] == {"composition": False, "master": False}

    assert (await api.get("/items/itm_nope/provenance")).status_code == 404


@pytest.mark.asyncio
async def test_approvals_and_outreach_queues(api, workspace):
    store = get_store()
    await store.create_project(Project(project_id="prj_gate", title="Gate"))
    await store.put_cut(Cut(cut_id="cut_gate", project_id="prj_gate"))
    item = Item(
        item_id=new_item_id(),
        cut_id="cut_gate",
        project_id="prj_gate",
        type=ItemType.ARTWORK,
        title="Mural",
        description="d",
        timecode=Timecode(),
        prominence=Prominence.BACKGROUND,
        risk_state="red",
    ).with_hash()
    await store.put_item(item)
    await store.set_status(item.item_id, ItemStatus.PENDING_APPROVAL, force=True)

    approvals = (await api.get("/projects/prj_gate/approvals")).json()
    assert approvals["counts"]["items"] == 1
    assert approvals["items"][0]["item"]["item_id"] == item.item_id

    outreach = (await api.get("/projects/prj_gate/outreach")).json()
    assert outreach["drafts"] == []
    assert "no send capability" in outreach["note"]


@pytest.mark.asyncio
async def test_pass_control_and_ledger_verification(api, workspace):
    from clearframe_ledger.chain import append

    store = get_store()
    await store.create_project(Project(project_id="prj_pass", title="Pass"))
    await store.put_cut(Cut(cut_id="cut_pass", project_id="prj_pass"))
    await append("prj_pass", "1st_ad", {"type": "pass.started"})

    verification = (await api.get("/projects/prj_pass/ledger/verify")).json()
    assert verification["valid"] is True
    assert verification["events"] == 1

    from clearframe_contracts import PassMode
    from clearframe_orch import handlers, state
    from clearframe_runtime import get_bus

    bus = handlers.register()  # the app does this on startup
    bus.start()
    record = await state.create_pass("prj_pass", "cut_pass", PassMode.FULL, 0)
    await get_bus().drain(timeout=10)
    paused = (
        await api.post(
            f"/passes/{record.pass_id}/pause", json={"reason": "producer stopped the pass"}
        )
    ).json()
    assert paused["status"] == "paused"

    feed = (await api.get(f"/passes/{record.pass_id}/feed")).json()
    assert any(entry["kind"] == "pass.started" for entry in feed["feed"])
