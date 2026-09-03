"""Extraction and the Parallel -> domain boundary."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from clearframe_adapter.normalize import (  # noqa: E402
    citations_from_basis,
    classify_authority,
    derive_confidence,
    to_finding,
)
from clearframe_contracts import Authority, Cut, ItemType, Project, Prominence  # noqa: E402
from clearframe_orch.breakdown import run_breakdown  # noqa: E402
from clearframe_orch.ingest import IngestError, ingest  # noqa: E402
from clearframe_runtime import get_store  # noqa: E402
from fixtures.scripted_model import call, say  # noqa: E402

SCRIPT = """
INT. LOFT APARTMENT - NIGHT

A cover of "BLUE HOUR" plays from a cracked speaker. On the wall hangs a large
mural by a local artist. MAYA drinks from a branded soda can.

MAYA
    They used to play this at the old place.
"""


def test_authority_classifier_ranks_sources():
    assert classify_authority("https://tsdr.uspto.gov/x") is Authority.REGISTRY
    assert classify_authority("https://www.courtlistener.com/docket/1") is Authority.COURT
    assert classify_authority("https://www.sec.gov/filing") is Authority.CORPORATE
    assert classify_authority("https://variety.com/story") is Authority.TRADE
    assert classify_authority("https://en.wikipedia.org/wiki/x") is Authority.REFERENCE
    assert classify_authority("https://someones-blog.example/post") is Authority.OTHER
    assert classify_authority("not a url") is Authority.OTHER


def test_normalizer_builds_findings_from_the_documented_payload_shape():
    raw = {
        "run_id": "trun_1",
        "interaction_id": "trun_1",
        "output": {
            "type": "json",
            "content": {
                "composition_owner": "Northwind",
                "master_owner": "Sixteen Tons",
                "confidence": 0.86,
            },
            "basis": [
                {
                    "field": "composition_owner",
                    "confidence": "high",
                    "reasoning": "registry record names the administrator",
                    "citations": [
                        {
                            "url": "https://uspto.gov/a",
                            "title": "Record",
                            "excerpts": ["administered by Northwind"],
                        }
                    ],
                },
                {
                    "field": "master_owner",
                    "confidence": "medium",
                    "reasoning": "label page",
                    "citations": [{"url": "https://sixteentons.example/releases"}],
                },
            ],
        },
    }
    finding = to_finding(
        raw,
        item_id="itm_1",
        project_id="prj_1",
        pass_id="pass_1",
        agent="music_rights",
        tier=1,
        cost_usd=0.025,
    )

    assert finding.confidence == 0.86
    assert finding.interaction_id == "trun_1"
    assert len(finding.citations) == 2
    assert finding.strongest_authority is Authority.REGISTRY
    assert finding.citations[0].excerpt.startswith("administered by")
    assert finding.claim["_reasoning"]["composition_owner"]
    assert finding.is_admissible()


def test_confidence_falls_back_to_the_basis_bands():
    raw = {
        "output": {
            "content": {"owner_of_record": "Acme"},
            "basis": [
                {"field": "a", "confidence": "high", "citations": []},
                {"field": "b", "confidence": "low", "citations": []},
            ],
        }
    }
    assert derive_confidence(raw) == pytest.approx((0.9 + 0.35) / 2)
    assert citations_from_basis(raw) == []


def test_deduplicates_citations_per_field():
    raw = {
        "output": {
            "content": {},
            "basis": [
                {
                    "field": "owner",
                    "citations": [{"url": "https://x.example"}, {"url": "https://x.example"}],
                },
            ],
        }
    }
    assert len(citations_from_basis(raw)) == 1


@pytest.mark.asyncio
async def test_ingest_rejects_unreadable_uploads_with_a_usable_message(workspace, tmp_path):
    empty = tmp_path / "empty.txt"
    empty.write_text("")
    with pytest.raises(IngestError, match="empty"):
        await ingest(empty)

    odd = tmp_path / "notes.xyz"
    odd.write_text("hello")
    with pytest.raises(IngestError, match="unsupported file type"):
        await ingest(odd)

    with pytest.raises(IngestError, match="does not exist"):
        await ingest(tmp_path / "missing.pdf")


@pytest.mark.asyncio
async def test_breakdown_persists_anchored_hashed_items(workspace, model, tmp_path):
    store = get_store()
    await store.create_project(Project(project_id="prj_bd", title="Loft"))
    cut = Cut(cut_id="cut_bd", project_id="prj_bd", label="cut-01", kind="script")
    await store.put_cut(cut)

    script = tmp_path / "loft.fountain"
    script.write_text(SCRIPT)

    model.script(
        "Breakdown",
        [
            call(
                "record_items",
                items=[
                    {
                        "type": "music_cue",
                        "title": "Blue Hour (cover)",
                        "description": "A cover of Blue Hour plays from a speaker.",
                        "scene": "1",
                        "page": 1,
                        "prominence": "featured",
                        "attrs": {"song_title": "Blue Hour", "is_cover": True},
                    },
                    {
                        "type": "artwork",
                        "title": "Loft mural",
                        "description": "A large mural by a local artist hangs on the wall.",
                        "scene": "1",
                        "page": 1,
                        "prominence": "background",
                    },
                    {
                        "type": "brand",
                        "title": "Soda can",
                        "description": "Maya drinks from a branded soda can.",
                        "scene": "1",
                        "page": 1,
                        "prominence": "background",
                    },
                    {
                        "type": "not_a_real_type",
                        "title": "junk",
                        "description": "junk",
                        "prominence": "background",
                    },
                ],
                notes="One mural may need on-set identification.",
            ),
            say("Three clearable elements extracted."),
        ],
    )

    items = await run_breakdown("prj_bd", cut, script)

    assert len(items) == 3, "an unknown type is dropped, not guessed at"
    kinds = {i.type for i in items}
    assert kinds == {ItemType.MUSIC_CUE, ItemType.ARTWORK, ItemType.BRAND}
    assert all(i.content_hash for i in items)
    assert all(i.timecode.scene == "1" for i in items)

    music = next(i for i in items if i.type is ItemType.MUSIC_CUE)
    assert music.prominence is Prominence.FEATURED
    assert music.attrs["is_cover"] is True

    stored = await store.list_items(cut_id="cut_bd")
    assert len(stored) == 3


def test_content_hash_ignores_timecode_but_not_content():
    from clearframe_contracts import Item, Timecode

    def make(title: str, frame_in: int) -> Item:
        return Item(
            item_id="x",
            cut_id="c",
            project_id="p",
            type=ItemType.BRAND,
            title=title,
            description="d",
            timecode=Timecode(frame_in=frame_in, frame_out=frame_in + 10),
            prominence=Prominence.BACKGROUND,
        ).with_hash()

    assert make("Soda can", 100).content_hash == make("Soda can", 9000).content_hash
    assert make("Soda can", 100).content_hash != make("Beer can", 100).content_hash
