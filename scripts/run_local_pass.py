"""Run one real pass, end to end, from the command line.

This is the fastest way to prove the system works on a laptop before any of it is
deployed: local state, in-process event spine, and live calls to Gemini and
Parallel. Nothing here is simulated — if the research is wrong, that is the
research, and it is visible.

    uv run python scripts/run_local_pass.py --file demo/film/cut-01/script.fountain

Requires in .env: PARALLEL_API_KEY, VERTEX_PROJECT (with application-default
credentials), and URL_WEBHOOK if you intend to arm watches.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

# A single-process run needs no cross-process spine, and the in-memory one is
# faster. Set CLEARFRAME_BUS=file to rehearse the multi-service topology instead.
os.environ.setdefault("CLEARFRAME_BUS", "inproc")

from clearframe_contracts import Cut, PassMode, Project, Role  # noqa: E402
from clearframe_runtime import get_store, settings
from clearframe_runtime.ids import cut_id as new_cut_id
from clearframe_runtime.ids import project_id as new_project_id


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a ClearFrame pass locally")
    parser.add_argument("--file", required=True, help="Script or cut to break down")
    parser.add_argument("--title", default="Demo picture")
    parser.add_argument(
        "--budget",
        type=float,
        default=None,
        help="Budget cap in USD (default: DEFAULT_BUDGET_CAP_USD)",
    )
    parser.add_argument(
        "--project", default=None, help="Existing project id — use with --cut for a delta pass"
    )
    parser.add_argument("--label", default="cut-01")
    parser.add_argument("--mode", choices=[m.value for m in PassMode], default=PassMode.FULL.value)
    parser.add_argument("--report", action="store_true", help="Render the E&O pack at the end")
    parser.add_argument(
        "--arm-watches",
        action="store_true",
        help="Arm Parallel monitors after the report (needs URL_WEBHOOK)",
    )
    parser.add_argument("--timeout", type=float, default=3600.0)
    return parser.parse_args()


async def main() -> int:
    args = parse_args()
    source = Path(args.file)
    if not source.exists():
        print(f"no such file: {source}", file=sys.stderr)
        return 2

    cfg = settings()
    from clearframe_orch import agents_client, breakdown, dispatch, handlers, state

    if not agents_client.model_available():
        print(
            "No reasoning backend. Set VERTEX_PROJECT in .env, run "
            "`gcloud auth application-default login`, and install the gemini extra "
            "(`uv sync --extra gemini`).",
            file=sys.stderr,
        )
        return 2

    store = get_store()
    if args.project:
        project = await store.get_project(args.project)
        if project is None:
            print(f"no such project: {args.project}", file=sys.stderr)
            return 2
    else:
        project = Project(
            project_id=new_project_id(),
            title=args.title,
            budget_cap_usd=args.budget or cfg.default_budget_cap_usd,
        )
        await store.create_project(project)

    from clearframe_ledger.auth import bind_role

    await bind_role(project.project_id, "local@clearframe.dev", Role.COUNSEL)

    cut = Cut(cut_id=new_cut_id(), project_id=project.project_id, label=args.label)
    await store.put_cut(cut)

    print(f"project  {project.project_id}  ({project.title})")
    print(f"cut      {cut.cut_id}  ({args.label})")
    print(f"budget   ${project.budget_cap_usd:.2f} cap\n")

    print("▸ breakdown")
    items = await breakdown.run_breakdown(project.project_id, cut, source)
    if not items:
        print("no clearable elements were extracted — nothing to investigate")
        return 1
    by_type: dict[str, int] = {}
    for item in items:
        by_type[item.type.value] = by_type.get(item.type.value, 0) + 1
    print(f"  {len(items)} items: " + ", ".join(f"{k} {v}" for k, v in sorted(by_type.items())))

    bus = handlers.register()
    if hasattr(bus, "start"):
        bus.start()

    print("\n▸ pass")
    record = await dispatch.start_pass(project.project_id, cut.cut_id, mode=PassMode(args.mode))
    print(f"  pass {record.pass_id} fanned out")

    if hasattr(bus, "drain"):
        await bus.drain(timeout=args.timeout)

    final = await state.refresh_pass(record.pass_id) or record
    budget = await store.budget(project.project_id)
    print("\n▸ result")
    print(
        f"  cleared {final.cleared_items} · open {final.open_items} · challenges {final.challenges}"
    )
    print(f"  spend   ${budget.spent_usd:.4f} of ${budget.cap_usd:.2f} ({budget.calls_by_tier})")

    from clearframe_ledger.chain import verify_chain

    chain = verify_chain(project.project_id)
    print(
        f"  ledger  {chain['events']} events, chain "
        f"{'verified' if chain['valid'] else 'FAILED: ' + chain['reason']}"
    )

    if getattr(bus, "dead_letters", None):
        print(f"  dead letters: {len(bus.dead_letters)}")
        for envelope, error in bus.dead_letters[:5]:
            print(f"    {envelope.type.value} {envelope.item_id}: {error}")

    for item in await store.list_items(cut_id=cut.cut_id):
        findings = await store.list_findings(item_id=item.item_id, live_only=True)
        citations = sum(len(f.citations) for f in findings)
        print(f"\n  [{(item.risk_state or 'unknown').upper():7}] {item.title}")
        print(
            f"    status {item.status.value} · {len(findings)} finding(s) · {citations} citation(s)"
        )
        for finding in findings:
            claim = {k: v for k, v in finding.claim.items() if not k.startswith("_")}
            print(f"    {finding.agent}: {json.dumps(claim, default=str)[:220]}")
            for citation in finding.citations[:3]:
                print(f"      [{citation.authority.value}] {citation.url}")

    if args.report:
        from clearframe_renderer import render as renderer

        result = await renderer.render(project.project_id, cut.cut_id, pdf=True)
        print(f"\n▸ report\n  {result['html_uri']}")
        if result["pdf_uri"]:
            print(f"  {result['pdf_uri']}")

    if args.arm_watches:
        from clearframe_orch import sentinel

        armed = await sentinel.arm_watches(project.project_id)
        print(f"\n▸ watches\n  {len(armed)} armed")
        for watch in armed:
            print(
                f"  {watch.watch_id}  {watch.subject}  "
                f"[{', '.join(c.value for c in watch.change_classes)}]"
            )

    print(f"\nproject id: {project.project_id}   cut id: {cut.cut_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
