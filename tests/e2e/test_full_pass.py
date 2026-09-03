"""One pass, end to end, through every pathway the product claims.

Extract -> dispatch -> research -> verify (challenge, then re-research) ->
risk-score -> human gate -> resolve -> report -> arm watches -> monitor webhook
-> reopen. Research payloads come from the transport double; every decision,
transition, hash, and route below is the real implementation.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from clearframe_contracts import (  # noqa: E402
    Cut,
    ItemStatus,
    ItemType,
    PassMode,
    Project,
    Prominence,
    RiskState,
    Role,
    Timecode,
)
from clearframe_contracts.items import Item  # noqa: E402
from clearframe_runtime import get_bus, get_store  # noqa: E402
from clearframe_runtime.ids import item_id as new_item_id  # noqa: E402
from fixtures.scripted_model import call, call_dynamic, last_tool_response, say  # noqa: E402

PROJECT_ID = "prj_e2e"
CUT_ID = "cut_e2e_01"

STALE_CITE = "https://reference.example.org/wiki/blue_hour"
FRESH_CITE = "https://www.example-registry.gov/composition/blue-hour"
SUIT_CITE = "https://www.courtlistener.example/docket/estate-v-northwind"


def _music_claim(*, publisher: str, litigation: bool, confidence: float) -> dict:
    claim = {
        "composition_owner": publisher,
        "publisher_of_record": publisher,
        "songwriters": ["A. Writer"],
        "master_owner": "Sixteen Tons Records",
        "is_cover": True,
        "catalog_transfers": [
            {
                "from": "Original Songs Ltd",
                "to": publisher,
                "year": 2023,
                "chain": "composition",
                "source_url": FRESH_CITE,
            }
        ],
        "litigation_signals": (
            [
                {
                    "summary": "Estate contests control of the composition catalog",
                    "status": "pending",
                    "parties": [publisher, "Writer Estate"],
                    "source_url": SUIT_CITE,
                }
            ]
            if litigation
            else []
        ),
        "conflicting_sources": False,
        "confidence": confidence,
    }
    return claim


async def _seed(store) -> Item:
    await store.create_project(
        Project(project_id=PROJECT_ID, title="Test picture", budget_cap_usd=25.0)
    )
    await store.put_cut(
        Cut(
            cut_id=CUT_ID,
            project_id=PROJECT_ID,
            label="cut-01",
            kind="cut",
            duration_frames=5760,
            fps=24.0,
        )
    )
    item = Item(
        item_id=new_item_id(),
        cut_id=CUT_ID,
        project_id=PROJECT_ID,
        type=ItemType.MUSIC_CUE,
        title="Blue Hour (cover) — montage",
        description="A cover recording plays under the scene 42 montage.",
        timecode=Timecode(frame_in=2880, frame_out=3600, fps=24.0, scene="42"),
        prominence=Prominence.FEATURED,
        attrs={"song_title": "Blue Hour", "is_cover": True},
    ).with_hash()
    await store.put_item(item)
    return item


def _script_crew(model, stub, item_id: str) -> None:
    """Music crew: recon, structured run, submit. Twice — the second answers a challenge."""
    submit = call_dynamic(
        "submit_finding",
        lambda h: {
            "draft_finding_id": last_tool_response(h)["draft_finding_id"],
            "note": "Both chains named; composition traced through a 2023 sale.",
        },
    )
    model.script(
        "Music rights",
        [
            call(
                "parallel_search",
                objective="Establish control of Blue Hour",
                search_queries=["blue hour composition publisher", "blue hour master owner"],
            ),
            call(
                "parallel_task",
                objective="Establish current control of composition and master for Blue Hour",
                schema_name="music_rights",
            ),
            submit,
            say("Composition traced to Northwind; master with Sixteen Tons."),
            # second run, after the challenge
            call(
                "parallel_task",
                objective="Re-establish control of the Blue Hour composition post-2023 sale",
                schema_name="music_rights",
            ),
            submit,
            say("Re-run answers the staleness objection with a registry source."),
        ],
    )


def _script_verifier(model) -> None:
    """Challenges the first finding on staleness, passes the second."""
    model.script(
        "Continuity",
        [
            call_dynamic(
                "file_challenge",
                lambda h: {
                    "finding_id": _finding_id_from(h),
                    "grounds": "stale",
                    "rationale": (
                        "The controlling claim rests on a reference site last "
                        "updated in 2019; the 2023 catalog sale post-dates it."
                    ),
                    "citation_urls": [FRESH_CITE],
                },
            ),
            say("Challenge filed."),
            call_dynamic(
                "verify_pass",
                lambda h: {
                    "finding_id": _finding_id_from(h),
                    "rationale": "Registry record post-dates the sale and names the same party.",
                },
            ),
            say("Verified."),
        ],
    )


def _finding_id_from(history) -> str:
    """The verifier is handed the finding id in its task text — parse it the way a
    model would have to."""
    import re

    for message in history:
        if message.role == "user":
            match = re.search(r"Finding id: (\S+)", message.text)
            if match:
                return match.group(1)
    raise AssertionError("the verifier task must name the finding under examination")


@pytest.mark.asyncio
async def test_pass_runs_end_to_end(workspace, parallel, model, monkeypatch):
    monkeypatch.setenv("URL_WEBHOOK", "https://webhook.example.test")
    from clearframe_runtime import reset_settings_cache

    reset_settings_cache()

    store = get_store()
    item = await _seed(store)

    # Two structured runs: the first cites a stale reference, the second a registry
    # record — and only the second surfaces the estate suit.
    parallel.queue_task_result(
        _music_claim(publisher="Original Songs Ltd", litigation=False, confidence=0.82),
        [parallel.basis("composition_owner", STALE_CITE, confidence="medium")],
    )
    parallel.queue_task_result(
        _music_claim(publisher="Northwind Publishing Group", litigation=True, confidence=0.91),
        [
            parallel.basis("composition_owner", FRESH_CITE),
            parallel.basis("litigation_signals", SUIT_CITE),
        ],
    )

    _script_crew(model, parallel, item.item_id)
    _script_verifier(model)
    model.script(
        "Studio counsel",
        [
            call("search_clearance_guidance", query="litigation estate composition chain"),
            call_dynamic(
                "submit_assessment",
                lambda h: {
                    "risk_state": "amber",  # the runtime must force this to red
                    "rationale": "Composition sits with a publisher whose catalog is contested.",
                    "grounding_refs": [
                        p["reference"] for p in last_tool_response(h).get("passages", [])[:2]
                    ],
                    "mitigations": [
                        {
                            "kind": "license",
                            "summary": "Licence from the current administrator",
                            "cost_delta_usd": 12000,
                            "production_impact": "no cut change",
                            "recommended": True,
                        },
                        {
                            "kind": "replace",
                            "summary": "Replace with a library cue",
                            "cost_delta_usd": 1500,
                            "production_impact": "re-cut of 30 seconds",
                        },
                    ],
                },
            ),
            say("Scored."),
        ],
    )
    model.script(
        "Outreach",
        [
            call(
                "findall_rights_holders",
                objective="Find licensing entities controlling the Blue Hour catalog",
                match_conditions=[
                    {
                        "name": "controls_catalog",
                        "description": "Administers the composition catalog",
                    }
                ],
            ),
            call(
                "draft_outreach",
                holder_name="Northwind Publishing Group",
                subject="Sync licence inquiry — Blue Hour",
                body="We are seeking a synchronisation licence for a cover recording.",
            ),
            say("Drafted."),
        ],
    )

    # --- run the pass -----------------------------------------------------
    from clearframe_orch import dispatch, handlers

    bus = get_bus()
    handlers.register(bus)

    await dispatch.start_pass(PROJECT_ID, CUT_ID, mode=PassMode.FULL)
    bus.start()
    await bus.drain(timeout=30)

    assert not bus.dead_letters, bus.dead_letters

    # --- the challenge actually happened ---------------------------------
    challenges = await store.list_challenges(item_id=item.item_id)
    assert len(challenges) == 1
    assert challenges[0].grounds.value == "stale"
    assert challenges[0].citations, "a challenge must cite its ground"

    # --- the re-run was chained to the challenged run ---------------------
    bodies = [b for b in parallel.task_payloads]
    assert len(bodies) == 2
    assert bodies[1]["previous_interaction_id"] == "trun_00000001", bodies[1]
    assert "challenged" in bodies[1]["input"] or "objection" in bodies[1]["input"].lower()
    assert bodies[1]["processor"] == "pro", "a challenge buys a pro run"

    # --- litigation forced RED regardless of what the model proposed ------
    assessment = await store.latest_assessment(item.item_id)
    assert assessment is not None
    assert assessment.risk_state is RiskState.RED
    assert assessment.requires_approval is True
    assert assessment.grounding_refs, "risk counsel must cite the handbooks"
    assert "Not legal advice" in assessment.disclaimer

    refreshed = await store.get_item(item.item_id)
    assert refreshed.status is ItemStatus.PENDING_APPROVAL
    assert refreshed.risk_state == RiskState.RED.value

    # --- outreach drafted, queued, never sent ----------------------------
    drafts = await store.list_outreach(PROJECT_ID)
    assert drafts and drafts[0].status.value == "pending_approval"

    # --- provenance graph resolves both chains ---------------------------
    from clearframe_orch import provenance

    graph = await provenance.build(item.item_id)
    assert graph["resolved"] == {"composition": True, "master": True}
    assert any(n["kind"] == "litigation" for n in graph["nodes"])
    assert any(e["kind"] == "transferred" for e in graph["edges"])

    # --- the gate: producer may not approve, counsel may -----------------
    from clearframe_ledger.auth import bind_role
    from clearframe_ledger.main import app as ledger_app
    from httpx import ASGITransport, AsyncClient

    await bind_role(PROJECT_ID, "producer@example.test", Role.PRODUCER)
    await bind_role(PROJECT_ID, "counsel@example.test", Role.COUNSEL)

    async with AsyncClient(
        transport=ASGITransport(app=ledger_app), base_url="http://ledger"
    ) as client:
        denied = await client.post(
            f"/projects/{PROJECT_ID}/decisions",
            json={
                "action": "approve_mitigation",
                "rationale": "looks fine",
                "item_id": item.item_id,
            },
            headers={"x-clearframe-subject": "producer@example.test"},
        )
        assert denied.status_code == 403, denied.text

        approved = await client.post(
            f"/projects/{PROJECT_ID}/decisions",
            json={
                "action": "approve_mitigation",
                "rationale": "Licence from the current administrator; budget approved.",
                "item_id": item.item_id,
                "target_id": assessment.mitigations[0].mitigation_id,
            },
            headers={"x-clearframe-subject": "counsel@example.test"},
        )
        assert approved.status_code == 200, approved.text

    await bus.drain(timeout=30)
    resolved = await store.get_item(item.item_id)
    assert resolved.status is ItemStatus.RESOLVED

    # --- ship the report, which arms the watch ---------------------------
    from clearframe_orch import sentinel
    from clearframe_renderer import render as renderer

    report = await renderer.render(PROJECT_ID, CUT_ID, pdf=False)
    assert report["html_uri"]
    html = Path(report["html_uri"].removeprefix("file://")).read_text()
    assert "Blue Hour" in html
    assert SUIT_CITE in html, "the report must carry the citation for the suit"
    assert "verified" in html

    armed = await sentinel.arm_watches(PROJECT_ID)
    assert armed, "a red item's rights holders must be watched"
    watch = armed[0]
    assert watch.item_ids == [item.item_id]

    monitored = await store.get_item(item.item_id)
    assert monitored.status is ItemStatus.MONITORED

    # --- three weeks later: a monitor fires ------------------------------
    # Script the reopened investigation before the callback lands: once the
    # webhook returns, the spine is already re-researching.
    parallel.queue_task_result(
        _music_claim(publisher="Northwind Publishing Group", litigation=True, confidence=0.88),
        [parallel.basis("litigation_signals", SUIT_CITE)],
    )
    model.script(
        "Music rights",
        [
            call(
                "parallel_task",
                objective="Re-verify in light of the new filing",
                schema_name="music_rights",
            ),
            call_dynamic(
                "submit_finding",
                lambda h: {"draft_finding_id": last_tool_response(h)["draft_finding_id"]},
            ),
            say("Reopened investigation complete."),
        ],
    )
    model.script(
        "Continuity",
        [
            call_dynamic(
                "verify_pass",
                lambda h: {"finding_id": _finding_id_from(h), "rationale": "Filing confirmed."},
            ),
            say("Verified."),
        ],
    )
    model.script(
        "Studio counsel",
        [
            call("search_clearance_guidance", query="litigation red"),
            call_dynamic(
                "submit_assessment",
                lambda h: {
                    "risk_state": "red",
                    "rationale": "The dispute is now docketed against the catalog itself.",
                    "grounding_refs": ["eo-underwriting/underwriting-notes#Risk banding"],
                    "mitigations": [
                        {
                            "kind": "replace",
                            "summary": "Replace the cue",
                            "cost_delta_usd": 1500,
                            "recommended": True,
                        }
                    ],
                },
            ),
            say("Rescored."),
        ],
    )
    model.script("Outreach", [say("No new outreach while the item is contested.")])

    from clearframe_webhook.main import app as webhook_app

    payload = json.dumps(
        {
            "type": "monitor.event.detected",
            "monitor_id": watch.watch_id,
            "event_id": "mev_00000001",
            "output": {
                "content": {
                    "change_class": "litigation",
                    "material": True,
                    "summary": "New filing in the estate dispute names the catalog directly.",
                    "source_url": SUIT_CITE,
                }
            },
        }
    ).encode()

    secret = "whsec_dGVzdHNlY3JldHRlc3RzZWNyZXQ="
    ts = str(int(time.time()))
    from clearframe_webhook.verify import signing_key

    digest = hmac.new(
        signing_key(secret), f"msg_1.{ts}.".encode() + payload, hashlib.sha256
    ).digest()

    async with AsyncClient(
        transport=ASGITransport(app=webhook_app), base_url="http://webhook"
    ) as client:
        unsigned = await client.post("/webhooks/parallel/monitor", content=payload)
        assert unsigned.status_code == 401, "unsigned callbacks must be dropped"

        signed = await client.post(
            "/webhooks/parallel/monitor",
            content=payload,
            headers={
                "webhook-id": "msg_1",
                "webhook-timestamp": ts,
                "webhook-signature": "v1," + base64.b64encode(digest).decode(),
            },
        )
        assert signed.status_code == 200, signed.text

    await bus.drain(timeout=30)

    reopened = await store.get_item(item.item_id)
    # Reopened, re-researched, re-verified, re-scored — and back in front of a human.
    # The sentinel never re-closes an item itself.
    assert reopened.status is ItemStatus.PENDING_APPROVAL, reopened.status
    assert reopened.risk_state == RiskState.RED.value

    reopen_passes = [p for p in await store.list_passes(PROJECT_ID) if p.mode is PassMode.REOPEN]
    assert len(reopen_passes) == 1, "a reopen is a pass the war room can watch"

    feed = await store.list_feed(reopen_passes[0].pass_id)
    assert any(entry["kind"] == "item.reopened" for entry in feed)

    # the follow-up run chained to the monitor event, not to a research run
    assert parallel.task_payloads[-1]["previous_interaction_id"] == "mev_00000001"

    watch_after = await store.get_watch(watch.watch_id)
    assert watch_after.reopen_count == 1
    assert watch_after.last_checked_ts is not None

    # --- the ledger still verifies --------------------------------------
    from clearframe_ledger.chain import verify_chain

    chain = verify_chain(PROJECT_ID)
    assert chain["valid"] is True, chain
    assert chain["events"] > 10

    # --- the budget meter counted every billable call --------------------
    budget = await store.budget(PROJECT_ID)
    assert budget.spent_usd > 0
    assert set(budget.calls_by_tier) & {"T0", "T1", "T2"}
