"""Golden-item regression.

Two kinds of check, and the difference matters:

* **extraction** — ground truth is a fact about the script, so it is checkable.
  Measures recall of planted items, which is the metric that actually predicts
  whether a pass is worth anything.
* **research** — ground truth about who owns what lives on the live web and moves.
  Asserting a specific owner would bake today's answer into a test and make the
  suite lie the moment a catalog changes hands. So these check the *properties* a
  good finding must have: every claim cited, both chains named for music, a stated
  basis for a public-domain claim, confidence reported, and gaps reported as gaps.

    uv run python agents/evals/run_evals.py                # everything
    uv run python agents/evals/run_evals.py --kind extraction
    uv run python agents/evals/run_evals.py --baseline eval-baseline.json

Research checks make live Parallel calls and cost money; they are skipped unless
`--kind research` or `--kind all` is given explicitly.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GOLDEN = Path(__file__).parent / "golden_items.jsonl"


def load_golden(kind: str | None = None) -> list[dict]:
    rows = [json.loads(line) for line in GOLDEN.read_text().splitlines() if line.strip()]
    return [r for r in rows if kind in (None, "all") or r["kind"] == kind]


def _matches(item, expected: dict) -> bool:
    haystack = f"{item.title} {item.description} {json.dumps(item.attrs)}".lower()
    return item.type.value == expected["expect_type"] and any(
        term in haystack for term in expected["match"]
    )


async def run_extraction(rows: list[dict]) -> dict:
    """Recall of planted items, per source script."""
    from clearframe_contracts import Cut, Project
    from clearframe_orch.breakdown import run_breakdown
    from clearframe_runtime import get_store
    from clearframe_runtime.ids import cut_id, project_id

    store = get_store()
    by_source: dict[str, list[dict]] = {}
    for row in rows:
        by_source.setdefault(row["source"], []).append(row)

    results = []
    for source, expected in by_source.items():
        project = Project(project_id=project_id(), title=f"eval:{Path(source).parent.name}")
        await store.create_project(project)
        cut = Cut(cut_id=cut_id(), project_id=project.project_id, label="eval")
        await store.put_cut(cut)

        items = await run_breakdown(project.project_id, cut, ROOT / source)
        for row in expected:
            hit = any(_matches(item, row) for item in items)
            results.append(
                {
                    "id": row["id"],
                    "kind": "extraction",
                    "pass": hit,
                    "note": row["note"],
                    "extracted": len(items),
                }
            )
            print(f"  {'✓' if hit else '✗'} {row['id']}  {row['note']}")
    return {"results": results}


def _check(name: str, ok: bool, detail: str = "") -> dict:
    return {"check": name, "pass": ok, "detail": detail}


async def run_research(rows: list[dict]) -> dict:
    """Property checks on live findings. Costs real money; run deliberately."""
    from clearframe_contracts import Cut, Item, ItemType, Project, Prominence, Timecode
    from clearframe_orch import agents_client, dispatch
    from clearframe_orch.toolbelt import RunContext
    from clearframe_runtime import get_store
    from clearframe_runtime.ids import cut_id, item_id, project_id

    store = get_store()
    project = Project(project_id=project_id(), title="eval:research", budget_cap_usd=10.0)
    await store.create_project(project)
    cut = Cut(cut_id=cut_id(), project_id=project.project_id, label="eval")
    await store.put_cut(cut)

    results = []
    for row in rows:
        item_type = ItemType(row["item_type"])
        item = Item(
            item_id=item_id(),
            cut_id=cut.cut_id,
            project_id=project.project_id,
            type=item_type,
            title=row["title"],
            description=row["description"],
            timecode=Timecode(scene="eval"),
            prominence=Prominence.FEATURED,
            attrs=row.get("attrs", {}),
        ).with_hash()
        await store.put_item(item)

        crew = dispatch.crew_for(item_type)
        ctx = RunContext(
            project_id=project.project_id,
            pass_id="eval",
            agent=dispatch.AGENT_NAME[crew],
            item_id=item.item_id,
            tier=1,
        )
        task = dispatch.RESEARCH_TASK.format(
            title=item.title,
            type=item.type.value,
            description=item.description,
            scene="eval",
            tc_in=item.timecode.tc_in,
            prominence=item.prominence.value,
            attrs=item.attrs,
            tier=1,
            tier_note="eval run",
            objection_block="",
        )
        await agents_client.invoke(crew, ctx, task)

        findings = await store.list_findings(item_id=item.item_id, live_only=True)
        claim = findings[-1].claim if findings else {}
        checks = []
        for assertion in row["assert"]:
            if assertion == "cited":
                checks.append(
                    _check("cited", bool(findings and all(f.citations for f in findings)))
                )
            elif assertion == "both_chains":
                checks.append(
                    _check(
                        "both_chains",
                        bool(claim.get("composition_owner")) and bool(claim.get("master_owner")),
                        "a music finding that names only one chain is incomplete",
                    )
                )
            elif assertion == "owner_named":
                checks.append(_check("owner_named", bool(claim.get("owner_of_record"))))
            elif assertion == "status_reported":
                checks.append(
                    _check(
                        "status_reported",
                        bool(claim.get("registration_status") or claim.get("copyright_status")),
                    )
                )
            elif assertion == "confidence_reported":
                checks.append(
                    _check("confidence_reported", bool(findings) and findings[-1].confidence > 0)
                )
            elif assertion == "basis_if_public_domain":
                is_pd = str(claim.get("copyright_status", "")).lower() == "public_domain"
                checks.append(
                    _check(
                        "basis_if_public_domain",
                        not is_pd or bool(claim.get("public_domain_basis")),
                        "a public-domain claim must state its basis",
                    )
                )
            elif assertion == "reports_unresolved":
                checks.append(
                    _check(
                        "reports_unresolved",
                        bool(claim.get("unresolved_questions")) or not findings,
                        "an unestablished chain must be reported as unresolved",
                    )
                )

        passed = all(c["pass"] for c in checks)
        results.append(
            {
                "id": row["id"],
                "kind": "research",
                "pass": passed,
                "checks": checks,
                "note": row["note"],
            }
        )
        print(f"  {'✓' if passed else '✗'} {row['id']}  {row['note']}")
        for check in checks:
            if not check["pass"]:
                print(f"      failed: {check['check']} {check['detail']}")
    return {"results": results}


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=["extraction", "research", "all"], default="extraction")
    parser.add_argument(
        "--baseline", type=Path, help="Compare against a previous run and fail on regression"
    )
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    from clearframe_orch import agents_client

    if not agents_client.model_available():
        print(
            "no reasoning backend configured — set VERTEX_PROJECT and install the gemini extra",
            file=sys.stderr,
        )
        return 2

    results: list[dict] = []
    if args.kind in ("extraction", "all"):
        print("▸ extraction")
        results += (await run_extraction(load_golden("extraction")))["results"]
    if args.kind in ("research", "all"):
        print("▸ research (live Parallel calls)")
        results += (await run_research(load_golden("research")))["results"]

    passed = sum(1 for r in results if r["pass"])
    score = passed / len(results) if results else 0.0
    print(f"\nscore {passed}/{len(results)} = {score:.0%}")

    payload = {"score": score, "passed": passed, "total": len(results), "results": results}
    if args.out:
        args.out.write_text(json.dumps(payload, indent=2))
        print(f"wrote {args.out}")

    if args.baseline and args.baseline.exists():
        previous = json.loads(args.baseline.read_text())
        if score < previous["score"] - 0.001:
            print(f"REGRESSION: {previous['score']:.0%} → {score:.0%}", file=sys.stderr)
            return 1
        print(f"no regression against baseline ({previous['score']:.0%})")

    return 0 if score >= 0.9 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
