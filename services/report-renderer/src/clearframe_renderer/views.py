"""The report's data layer: eight views over the ledger and the state plane.

The report is a view, not a document that is edited. Every section here is a
query; nothing is composed by hand and nothing is stored twice.
"""

from __future__ import annotations

from typing import Any

from clearframe_contracts import ItemStatus, OutreachStatus, RiskState, utcnow
from clearframe_ledger.chain import read_chain, verify_chain
from clearframe_ledger.sink import DECISIONS, get_sink
from clearframe_runtime import get_store

GREEN = RiskState.GREEN.value


async def production_summary(project_id: str, cut_id: str) -> dict[str, Any]:
    store = get_store()
    project = await store.get_project(project_id)
    cut = await store.get_cut(cut_id)
    passes = await store.list_passes(project_id)
    chain = verify_chain(project_id)
    signatories = sorted(
        {row["actor"] for row in get_sink().read(DECISIONS, project_id=project_id)}
    )
    return {
        "title": project.title if project else project_id,
        "project_id": project_id,
        "cut_id": cut_id,
        "cut_label": cut.label if cut else "",
        "cut_hash": cut.cut_hash if cut else "",
        "cut_uri": cut.gcs_uri if cut else "",
        "generated": utcnow().isoformat(timespec="seconds"),
        "chain_verified": chain["valid"],
        "chain_events": chain["events"],
        "chain_head": chain.get("head_hash", ""),
        "budget_spent_usd": round(project.spent_usd, 2) if project else 0.0,
        "budget_cap_usd": project.budget_cap_usd if project else 0.0,
        "passes": [
            {
                "pass_id": p.pass_id,
                "mode": p.mode.value,
                "status": p.status.value,
                "items": p.total_items,
                "challenges": p.challenges,
                "started": p.started_ts.isoformat(timespec="seconds"),
            }
            for p in passes
        ],
        "signatories": signatories,
    }


async def item_register(project_id: str, cut_id: str) -> list[dict]:
    """The heat strip as a table."""
    items = await get_store().list_items(cut_id=cut_id)
    rows = []
    for item in sorted(items, key=lambda i: (i.timecode.frame_in, i.title)):
        rows.append(
            {
                "item_id": item.item_id,
                "type": item.type.value,
                "title": item.title,
                "scene": item.timecode.scene or "",
                "tc_in": item.timecode.tc_in,
                "tc_out": item.timecode.tc_out,
                "prominence": item.prominence.value,
                "risk_state": item.risk_state or "unknown",
                "status": item.status.value,
                "content_hash": item.content_hash,
            }
        )
    return rows


async def findings_detail(project_id: str, cut_id: str) -> list[dict]:
    """Per non-green item: the traced chains, cited findings, Verifier history."""
    store = get_store()
    out = []
    for item in await store.list_items(cut_id=cut_id):
        if item.risk_state == GREEN and item.status is not ItemStatus.ESCALATED:
            continue
        findings = await store.list_findings(item_id=item.item_id, live_only=True)
        challenges = await store.list_challenges(item_id=item.item_id)
        out.append(
            {
                "item_id": item.item_id,
                "title": item.title,
                "type": item.type.value,
                "scene": item.timecode.scene or "",
                "tc_in": item.timecode.tc_in,
                "risk_state": item.risk_state or "unknown",
                "status": item.status.value,
                "findings": [
                    {
                        "finding_id": f.finding_id,
                        "agent": f.agent,
                        "confidence": round(f.confidence, 2),
                        "claim": {k: v for k, v in f.claim.items() if not k.startswith("_")},
                        "reasoning": f.claim.get("_reasoning", {}),
                        "note": f.claim.get("_note", ""),
                        "tier": f.tier,
                        "interaction_id": f.interaction_id,
                        "prev_interaction_id": f.prev_interaction_id,
                        "citations": [c.model_dump(mode="json") for c in f.citations],
                    }
                    for f in findings
                ],
                "challenges": [
                    {
                        "grounds": c.grounds.value,
                        "rationale": c.rationale,
                        "citations": [x.url for x in c.citations],
                        "ts": c.ts.isoformat(timespec="seconds"),
                    }
                    for c in challenges
                ],
            }
        )
    return out


async def risk_mitigations(project_id: str, cut_id: str) -> list[dict]:
    store = get_store()
    decisions = get_sink().read(DECISIONS, project_id=project_id)
    by_item: dict[str, list[dict]] = {}
    for row in decisions:
        by_item.setdefault(row.get("item_id") or "", []).append(row)

    out = []
    for item in await store.list_items(cut_id=cut_id):
        assessment = await store.latest_assessment(item.item_id)
        if assessment is None or assessment.risk_state is RiskState.GREEN:
            continue
        out.append(
            {
                "item_id": item.item_id,
                "title": item.title,
                "risk_state": assessment.risk_state.value,
                "rationale": assessment.rationale,
                "grounding_refs": assessment.grounding_refs,
                "disclaimer": assessment.disclaimer,
                "mitigations": [m.model_dump(mode="json") for m in assessment.mitigations],
                "decisions": [
                    {
                        "actor": d["actor"],
                        "role": d["iam_role"],
                        "action": d["action"],
                        "rationale": d["rationale"],
                        "ts": d["ts"],
                    }
                    for d in by_item.get(item.item_id, [])
                ],
            }
        )
    return out


async def outreach_log(project_id: str, cut_id: str) -> list[dict]:
    drafts = await get_store().list_outreach(project_id)
    return [
        {
            "outreach_id": d.outreach_id,
            "item_id": d.item_id,
            "to": d.to_name,
            "email": d.to_email,
            "contact_source": d.contact_source_url,
            "subject": d.subject,
            "status": d.status.value,
            "approved_by": d.approved_by,
            "queued": d.status is OutreachStatus.APPROVED_QUEUED,
            "ts": d.ts.isoformat(timespec="seconds"),
        }
        for d in sorted(drafts, key=lambda d: d.ts)
    ]


async def watch_schedule(project_id: str, cut_id: str) -> list[dict]:
    watches = await get_store().list_watches(project_id)
    return [
        {
            "watch_id": w.watch_id,
            "subject": w.subject,
            "status": w.status,
            "frequency": w.frequency,
            "change_classes": [c.value for c in w.change_classes],
            "item_ids": w.item_ids,
            "armed": w.armed_ts.isoformat(timespec="seconds"),
            "last_checked": w.last_checked_ts.isoformat(timespec="seconds")
            if w.last_checked_ts
            else None,
            "reopens": w.reopen_count,
        }
        for w in watches
    ]


async def delta_annex(project_id: str, cut_id: str) -> dict[str, Any]:
    """What changed since the prior report, and what was re-verified."""
    import json

    events = [
        json.loads(row["event"]) if isinstance(row["event"], str) else row["event"]
        for row in read_chain(project_id)
    ]
    deltas = [e for e in events if e.get("type") == "delta.computed" and e.get("cut_id") == cut_id]
    reopens = [e for e in events if e.get("type") == "item.reopened"]
    return {
        "has_delta": bool(deltas),
        "deltas": deltas,
        "reopens": reopens,
    }


async def citation_appendix(project_id: str, cut_id: str) -> list[dict]:
    """Every source, once, with its fetch time, authority, and stored snapshot."""
    store = get_store()
    seen: dict[str, dict] = {}
    for item in await store.list_items(cut_id=cut_id):
        for finding in await store.list_findings(item_id=item.item_id):
            for citation in finding.citations:
                row = seen.setdefault(
                    citation.url,
                    {
                        "url": citation.url,
                        "title": citation.title,
                        "authority": citation.authority.value,
                        "fetched_ts": citation.fetched_ts.isoformat(timespec="seconds"),
                        "published_date": citation.published_date,
                        "snapshot_uri": citation.snapshot_uri,
                        "used_by": [],
                    },
                )
                if item.title not in row["used_by"]:
                    row["used_by"].append(item.title)
    return sorted(seen.values(), key=lambda r: (r["authority"], r["url"]))


SECTIONS = [
    ("1", "Production summary", "production_summary", production_summary),
    ("2", "Item register", "item_register", item_register),
    ("3", "Findings & chain of title", "findings_detail", findings_detail),
    ("4", "Risk assessment & mitigations", "risk_mitigations", risk_mitigations),
    ("5", "Outreach log", "outreach_log", outreach_log),
    ("6", "Watch schedule", "watch_schedule", watch_schedule),
    ("7", "Delta annex", "delta_annex", delta_annex),
    ("A", "Citation appendix", "citation_appendix", citation_appendix),
]


async def gather(project_id: str, cut_id: str) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for _number, _title, key, fn in SECTIONS:
        data[key] = await fn(project_id, cut_id)
    data["sections"] = [{"number": n, "title": t, "key": k} for n, t, k, _ in SECTIONS]
    return data
