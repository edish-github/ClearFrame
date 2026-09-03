"""Populate a local project so the war room can be developed without spending money.

**This is a development fixture, not demo content.** It writes a project into the
local state directory using the same test doubles the suite uses, so a designer
can iterate on the UI at 3am without a Parallel invoice. It must never be used to
produce anything a judge or a viewer sees: the demo runs a real pass, and
`docs/DEMO-SCRIPT.md` says so.

Every row it writes is marked `fixture: true`, and the war room shows a banner
whenever it finds one.

    uv run python scripts/dev_fixture.py --root .local
    make dev            # then open http://localhost:3000
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))

FIXTURE_MARK = {"fixture": True}


async def build(root: Path) -> str:
    from clearframe_adapter.client import ParallelClient, set_client
    from clearframe_contracts import Cut, PassMode, Project, Role
    from clearframe_ledger.auth import bind_role
    from clearframe_ledger.sink import LocalLedgerSink, set_sink
    from clearframe_orch import breakdown, dispatch, handlers, sentinel
    from clearframe_orch.models import set_model
    from clearframe_runtime import (
        InProcessBus,
        LocalBlobStore,
        LocalStateStore,
        get_store,
        set_blobs,
        set_bus,
        set_store,
    )
    from clearframe_runtime.ids import cut_id, project_id
    from fixtures.parallel_stub import ParallelStub
    from fixtures.scripted_model import ScriptedModelClient

    set_store(LocalStateStore(root))
    set_blobs(LocalBlobStore(root))
    set_sink(LocalLedgerSink(root))
    bus = InProcessBus()
    set_bus(bus)

    stub = ParallelStub()
    set_client(ParallelClient(api_key="fixture", transport=stub.transport(), max_attempts=1))
    model = ScriptedModelClient()
    set_model(model)

    store = get_store()
    project = Project(project_id=project_id(), title="The Last Hour (fixture)", budget_cap_usd=25.0)
    await store.create_project(project)
    for subject, role in [
        ("producer@clearframe.dev", Role.PRODUCER),
        ("coord@clearframe.dev", Role.COORDINATOR),
        ("counsel@clearframe.dev", Role.COUNSEL),
        ("reviewer@clearframe.dev", Role.REVIEWER),
    ]:
        await bind_role(project.project_id, subject, role)

    cut = Cut(
        cut_id=cut_id(),
        project_id=project.project_id,
        label="cut-01",
        kind="cut",
        duration_frames=5760,
        fps=24.0,
    )
    await store.put_cut(cut)

    # --- breakdown ---------------------------------------------------------
    from fixtures.scripted_model import call, say

    model.script(
        "Breakdown",
        [
            call("record_items", items=_extracted(), notes="fixture register"),
            say("Register extracted."),
        ],
    )
    script = ROOT / "demo/film/cut-01/script.fountain"
    items = await breakdown.run_breakdown(project.project_id, cut, script)
    print(f"  {len(items)} items")

    # --- research ----------------------------------------------------------
    # Pinned per item: a fan-out runs concurrently, so a FIFO queue would hand the
    # music claim to whichever crew happened to ask first.
    for index, item in enumerate(items):
        content, basis = _claim_for(item.type.value, index)
        stub.queue_task_result_for(item.item_id, content, basis)
        stub.queue_task_result_for(item.item_id, content, basis)  # for a re-run

    _script_crews(model, items)
    _script_verifier(model)
    _script_counsel(model, items)
    _script_outreach(model)

    handlers.register(bus)
    bus.start()
    record = await dispatch.start_pass(project.project_id, cut.cut_id, mode=PassMode.FULL)
    await bus.drain(timeout=120)
    await sentinel.arm_watches(project.project_id)
    await bus.stop()

    print(f"  pass {record.pass_id}")
    return project.project_id


def _script_crews(model, items) -> None:
    """Recon, one structured run, submit — decided from the conversation, so many
    items can be in flight at once without stealing each other's turns."""
    from fixtures.scripted_model import ModelTurn, ToolCall, response_of, tools_called

    schema_for_title = {
        item.title: {
            "music_cue": "music_rights",
            "lyric_quote": "music_rights",
            "brand": "trademark",
            "location": "trademark",
            "likeness": "likeness",
        }.get(item.type.value, "footage")
        for item in items
    }

    def responder(history):
        called = tools_called(history)
        text = " ".join(m.text for m in history if m.role == "user")
        schema = next(
            (schema for title, schema in schema_for_title.items() if title in text),
            "footage",
        )

        if "parallel_search" not in called:
            return ModelTurn(
                tool_calls=[
                    ToolCall(
                        name="parallel_search",
                        args={
                            "objective": "Establish who controls this element today",
                            "search_queries": ["rights holder", "catalog administration"],
                        },
                    )
                ]
            )
        if "parallel_task" not in called:
            return ModelTurn(
                tool_calls=[
                    ToolCall(
                        name="parallel_task",
                        args={
                            "objective": "Establish current control, naming every party and hop",
                            "schema_name": schema,
                        },
                    )
                ]
            )
        if "submit_finding" not in called:
            draft = (response_of(history, "parallel_task") or {}).get("draft_finding_id")
            if not draft:
                return ModelTurn(text="no admissible draft; stopping rather than guessing")
            return ModelTurn(
                tool_calls=[
                    ToolCall(
                        name="submit_finding",
                        args={
                            "draft_finding_id": draft,
                            "note": "Both chains named where the type has two; gaps reported as gaps.",
                        },
                    )
                ]
            )
        return ModelTurn(text="Investigation complete.")

    for crew in ["Music rights", "Marks & brands", "Likeness", "Footage & artwork"]:
        model.reactive(crew, responder)


def _script_verifier(model) -> None:
    """Challenges the first finding it sees on staleness, then passes the rest —
    roughly the one-in-ten rate the playbook is tuned for."""
    from fixtures.scripted_model import ModelTurn, ToolCall, task_text

    state = {"challenged": False}

    def responder(history):
        import re

        from fixtures.scripted_model import tools_called

        text = task_text(history)
        match = re.search(r"Finding id: (\S+)", text)
        finding_id = match.group(1) if match else ""
        if not finding_id:
            return ModelTurn(text="no finding named; passing")

        # Exactly one verdict per finding — the toolbelt enforces it, and a
        # responder that forgets would look like a challenge silently becoming a pass.
        if {"verify_pass", "file_challenge"} & set(tools_called(history)):
            return ModelTurn(text="Verdict returned.")

        if not state["challenged"]:
            state["challenged"] = True
            return ModelTurn(
                tool_calls=[
                    ToolCall(
                        name="file_challenge",
                        args={
                            "finding_id": finding_id,
                            "grounds": "stale",
                            "rationale": (
                                "The controlling claim rests on a reference page last revised in "
                                "2019, and the catalog sale it describes post-dates it. A current "
                                "administrator cannot be established from a source that old."
                            ),
                            "citation_urls": [
                                "https://www.example-registry.gov/composition/blue-hour"
                            ],
                        },
                    )
                ]
            )

        return ModelTurn(
            tool_calls=[
                ToolCall(
                    name="verify_pass",
                    args={
                        "finding_id": finding_id,
                        "rationale": "Registry record is current and outranks the alternatives.",
                    },
                )
            ]
        )

    model.reactive("Continuity", responder)


def _script_counsel(model, items) -> None:
    from fixtures.scripted_model import ModelTurn, ToolCall, task_text, tools_called

    music_title = next((i.title for i in items if i.type.value == "music_cue"), "")
    brand_titles = {i.title for i in items if i.type.value == "brand"}

    def responder(history):
        if "search_clearance_guidance" not in tools_called(history):
            return ModelTurn(
                tool_calls=[
                    ToolCall(
                        name="search_clearance_guidance",
                        args={
                            "query": "risk banding litigation prominence",
                        },
                    )
                ]
            )
        if "submit_assessment" not in tools_called(history):
            key = _scoring_key(task_text(history), music_title, brand_titles)
            return ModelTurn(tool_calls=[ToolCall(name="submit_assessment", args=_assessment(key))])
        return ModelTurn(text="Scored. Research and drafting for review by counsel.")

    model.reactive("Studio counsel", responder)


def _script_outreach(model) -> None:
    from fixtures.scripted_model import ModelTurn, ToolCall, tools_called

    def responder(history):
        called = tools_called(history)
        if "findall_rights_holders" not in called:
            return ModelTurn(
                tool_calls=[
                    ToolCall(
                        name="findall_rights_holders",
                        args={
                            "objective": "Find the entity administering this catalog and its sync desk",
                            "match_conditions": [
                                {
                                    "name": "controls_catalog",
                                    "description": "Administers the composition catalog in question",
                                },
                            ],
                        },
                    )
                ]
            )
        if "draft_outreach" not in called:
            return ModelTurn(
                tool_calls=[
                    ToolCall(
                        name="draft_outreach",
                        args={
                            "holder_name": "Northwind Publishing Group",
                            "subject": "Sync licence inquiry — cover recording, THE LAST HOUR",
                            "body": (
                                "We are clearing a cover recording used under a montage in THE LAST "
                                "HOUR (feature, 2026, in post).\n\n"
                                "We seek a synchronisation licence for the underlying composition: "
                                "worldwide, all media, five years, festival and theatrical release "
                                "included. The use runs approximately 30 seconds.\n\n"
                                "Could you confirm whether your desk administers this work, and if "
                                "so quote for the use above? If this is the wrong desk we would be "
                                "grateful for a pointer to the right one."
                            ),
                        },
                    )
                ]
            )
        return ModelTurn(text="Drafted and queued for counsel approval.")

    model.reactive("Outreach", responder)


def _scoring_key(text: str, music_title: str, brand_titles: set[str]) -> int:
    """Which fixture assessment this invocation should produce, read from the task
    text Risk Counsel was actually given — so the fixture is stable no matter what
    order the crews finish in."""
    if music_title and music_title in text:
        return 0
    if any(title in text for title in brand_titles):
        return 1
    return 2


def _assessment(index: int) -> dict:
    if index == 0:
        return {
            "risk_state": "amber",  # the runtime forces this to red on the litigation signal
            "rationale": (
                "The composition sits with a publisher whose catalog is the "
                "subject of an estate dispute. The master licenses cleanly; the "
                "composition does not."
            ),
            "grounding_refs": [
                "eo-underwriting/underwriting-notes#Risk banding used in this system"
            ],
            "mitigations": [
                {
                    "kind": "license",
                    "summary": "Licence from the current administrator once control is settled",
                    "cost_delta_usd": 12000,
                    "production_impact": "no cut change",
                    "recommended": True,
                },
                {
                    "kind": "replace",
                    "summary": "Replace with a library cue of similar tempo",
                    "cost_delta_usd": 1500,
                    "production_impact": "re-cut of roughly 30 seconds",
                },
                {
                    "kind": "remove",
                    "summary": "Play the scene without music",
                    "cost_delta_usd": 0,
                    "production_impact": "changes the scene's register",
                },
            ],
        }
    if index % 3 == 1:
        return {
            "risk_state": "amber",
            "rationale": "Visible mark from an owner with a documented enforcement history.",
            "grounding_refs": ["clearance-handbooks/practice-notes#Trademarks in picture"],
            "mitigations": [
                {
                    "kind": "alter",
                    "summary": "Blur or reposition so the mark is not legible",
                    "cost_delta_usd": 400,
                    "production_impact": "VFX pass on two shots",
                    "recommended": True,
                },
                {
                    "kind": "license",
                    "summary": "Seek written consent from the owner",
                    "cost_delta_usd": 0,
                    "production_impact": "schedule risk",
                },
            ],
        }
    return {
        "risk_state": "green",
        "rationale": "Incidental, unemphasised, and the chain of title is established.",
        "grounding_refs": [
            'clearance-handbooks/practice-notes#Prominence and the limits of "background"'
        ],
        "mitigations": [],
    }


def _extracted() -> list[dict]:
    return [
        {
            "type": "music_cue",
            "title": "Blue Hour (cover) — montage",
            "description": "A modern cover of the 1891 song plays from a cracked speaker.",
            "scene": "1",
            "frame_in": 2880,
            "frame_out": 3600,
            "prominence": "featured",
            "attrs": {"song_title": "Blue Hour", "is_cover": True},
        },
        {
            "type": "artwork",
            "title": "Whale mural, signed",
            "description": "A hand-painted mural runs the length of the shop wall.",
            "scene": "1",
            "frame_in": 240,
            "frame_out": 900,
            "prominence": "background",
        },
        {
            "type": "brand",
            "title": "Soda can, logo to camera",
            "description": "A character drinks from a branded can, logo facing camera.",
            "scene": "1",
            "frame_in": 1100,
            "frame_out": 1300,
            "prominence": "featured",
        },
        {
            "type": "artwork",
            "title": "The Great Wave (framed print)",
            "description": "A sun-bleached framed print hangs above a desk.",
            "scene": "2",
            "frame_in": 1900,
            "frame_out": 2100,
            "prominence": "background",
        },
        {
            "type": "footage",
            "title": "Archival newsreel — 1936 harbour strike",
            "description": "Black-and-white newsreel with burned-in timecode.",
            "scene": "2",
            "frame_in": 2200,
            "frame_out": 2600,
            "prominence": "featured",
        },
        {
            "type": "brand",
            "title": "Container ship livery",
            "description": "A container ship in full livery crosses frame.",
            "scene": "3",
            "frame_in": 3800,
            "frame_out": 4100,
            "prominence": "featured",
        },
        {
            "type": "artwork",
            "title": "Self-portrait postcard",
            "description": "A postcard curls on the fridge door.",
            "scene": "4",
            "frame_in": 4400,
            "frame_out": 4500,
            "prominence": "background",
        },
        {
            "type": "lyric_quote",
            "title": "Novel opening, read aloud",
            "description": "A character reads the opening line from a paperback.",
            "scene": "4",
            "frame_in": 4700,
            "frame_out": 4900,
            "prominence": "featured",
        },
        {
            "type": "likeness",
            "title": "Prime Minister, referenced on the radio",
            "description": "A news bulletin quotes a statement.",
            "scene": "4",
            "frame_in": 4300,
            "frame_out": 4380,
            "prominence": "background",
        },
        {
            "type": "artwork",
            "title": "1977 concert poster",
            "description": "A poster for a long-gone venue, band logo visible.",
            "scene": "5",
            "frame_in": 5200,
            "frame_out": 5500,
            "prominence": "featured",
        },
    ]


def _claim_for(item_type: str, index: int) -> tuple[dict, list[dict]]:
    from fixtures.parallel_stub import ParallelStub

    registry = "https://www.example-registry.gov/record/1"
    suit = "https://www.courtlistener.example/docket/estate-v-northwind"

    if item_type in ("music_cue", "lyric_quote"):
        claim = {
            "composition_owner": "Northwind Publishing Group",
            "publisher_of_record": "Northwind Publishing Group",
            "songwriters": ["Charles K. Harris"],
            "master_owner": "Sixteen Tons Records",
            "is_cover": True,
            "catalog_transfers": [
                {
                    "from": "Original Songs Ltd",
                    "to": "Northwind Publishing Group",
                    "year": 2023,
                    "chain": "composition",
                    "source_url": registry,
                }
            ],
            "litigation_signals": (
                [
                    {
                        "summary": "Estate contests control of the composition catalog",
                        "status": "pending",
                        "parties": ["Northwind Publishing Group", "Writer Estate"],
                        "source_url": suit,
                    }
                ]
                if index == 0
                else []
            ),
            "conflicting_sources": False,
            "confidence": 0.88,
        }
        basis = [
            ParallelStub.basis(
                "composition_owner", registry, excerpt="administered by Northwind Publishing Group"
            ),
            ParallelStub.basis("master_owner", "https://sixteentons.example/releases"),
        ]
        if index == 0:
            basis.append(ParallelStub.basis("litigation_signals", suit))
        return claim, basis

    if item_type in ("brand", "location"):
        return (
            {
                "mark": "Fixture mark",
                "owner_of_record": "Fixture Holdings Inc",
                "registration_status": "live",
                "registration_numbers": ["1234567"],
                "jurisdictions": ["US"],
                "enforcement_temperament": "active",
                "depiction_objections": False,
                "litigation_signals": [],
                "conflicting_sources": False,
                "confidence": 0.84,
            },
            [ParallelStub.basis("owner_of_record", "https://tsdr.uspto.gov/record/1234567")],
        )

    if item_type == "likeness":
        return (
            {
                "person_name": "Unnamed public official",
                "living": "unknown",
                "public_figure": True,
                "defamation_adjacent": False,
                "unresolved_questions": ["No identifiable individual is depicted."],
                "conflicting_sources": False,
                "confidence": 0.55,
            },
            [ParallelStub.basis("person_name", "https://en.wikipedia.org/wiki/Head_of_government")],
        )

    return (
        {
            "work_title": "Fixture work",
            "creator": "A. Maker",
            "creator_living": "unknown",
            "current_rights_holder": "Fixture Archive",
            "archive_or_agency": "Fixture Archive",
            "copyright_status": "in_copyright",
            "license_lineage": [],
            "orphan_work_signals": [],
            "provenance_disputes": [],
            "litigation_signals": [],
            "unresolved_questions": [
                "Reproduction rights in this specific print are unestablished."
            ],
            "conflicting_sources": False,
            "confidence": 0.72,
        },
        [ParallelStub.basis("current_rights_holder", "https://www.loc.gov/item/fixture")],
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".local", help="Local state directory")
    args = parser.parse_args()

    root = Path(args.root)
    print(f"Building a UI development fixture in {root}/ — not demo content.")
    project = asyncio.run(build(root))
    print(f"\nfixture project {project}")
    print("Start the API and the war room:\n  make dev\n  cd web && pnpm dev")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
