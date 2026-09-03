"""Prove the Parallel integration against the live API, one call per surface.

Run this in week one and again before the shoot. It costs a few cents and tells
you which of the five surfaces are actually reachable with your key — which is
the failure the demo cannot survive discovering on camera.

    uv run python scripts/smoke_parallel.py
"""

from __future__ import annotations

import asyncio
import sys

from clearframe_runtime import settings


async def main() -> int:
    from clearframe_adapter import findall, monitor, search
    from clearframe_adapter.client import ParallelError, get_client
    from clearframe_adapter.task import run_task
    from clearframe_contracts.schema_registry import load_schema

    cfg = settings()
    try:
        get_client()
    except Exception as exc:  # noqa: BLE001
        print(f"no API key available: {exc}", file=sys.stderr)
        return 2

    ok = True

    print("▸ search")
    try:
        result = await search.search(
            "Establish who administers a well-known music publishing catalog today",
            ["music publishing catalog acquisition 2024"],
            max_results=3,
        )
        print(
            f"  {len(result.get('results', []))} results, "
            f"first: {(result.get('results') or [{}])[0].get('url')}"
        )
    except ParallelError as exc:
        ok = False
        print(f"  FAILED: {exc}")

    print("▸ extract")
    try:
        result = await search.extract(
            ["https://www.copyright.gov/help/faq/"], objective="copyright registration basics"
        )
        print(f"  {len(result.get('results', []))} page(s) extracted")
    except ParallelError as exc:
        ok = False
        print(f"  FAILED: {exc}")

    print("▸ task (core) + interaction chaining")
    try:
        first = await run_task(
            "Who currently administers the publishing catalog of a major music "
            "publisher? Name the entity and cite a source.",
            load_schema("music_rights"),
            processor="core",
        )
        interaction = first.get("interaction_id") or first.get("run_id")
        basis = (first.get("output") or {}).get("basis") or []
        print(f"  run {first.get('run_id')} · {len(basis)} basis entries")

        chained = await run_task(
            "Confirm the answer above against a second, independent source.",
            load_schema("music_rights"),
            processor="core",
            prev_interaction_id=interaction,
        )
        print(
            f"  chained run {chained.get('run_id')} accepted previous_interaction_id={interaction}"
        )
    except ParallelError as exc:
        ok = False
        print(f"  FAILED: {exc}")

    print("▸ findall (beta)")
    try:
        result = await findall.create_findall(
            "Find music publishing companies that administer catalogs of 1970s songwriters",
            [
                {
                    "name": "administers_catalog",
                    "description": "Administers a music publishing catalog",
                }
            ],
            match_limit=5,
        )
        print(f"  findall_id {result.get('findall_id')}")
    except ParallelError as exc:
        ok = False
        print(f"  FAILED: {exc}")

    print("▸ monitor")
    if not cfg.url_webhook:
        print("  skipped: URL_WEBHOOK is not set, so a monitor could never call back")
    else:
        try:
            armed = await monitor.arm_watch(
                "Smoke test subject",
                ["litigation"],
                f"{cfg.url_webhook.rstrip('/')}/webhooks/parallel/monitor",
                metadata={"smoke": "true"},
            )
            monitor_id = armed.get("monitor_id")
            print(f"  armed {monitor_id}; disarming")
            if monitor_id:
                await monitor.disarm_watch(monitor_id)
        except ParallelError as exc:
            ok = False
            print(f"  FAILED: {exc}")

    print("\n" + ("all reachable surfaces responded" if ok else "one or more surfaces failed"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
