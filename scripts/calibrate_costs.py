"""Replace the planning estimates in `pricing.py` with measured numbers.

`TIER_COST_USD` starts as an estimate, and the code says so: `CALIBRATED` is
False and the budget meter tells the UI to label the figure. This script closes
that gap from two sources of truth:

* **the ledger** — how many calls this project actually made, per tier, from the
  `cost_events` rows every billable call writes;
* **your invoice** — what those calls actually cost.

    # 1. See what the ledger recorded
    uv run python scripts/calibrate_costs.py --project prj_xxx

    # 2. Feed in the invoice totals for the same window and write the result
    uv run python scripts/calibrate_costs.py --project prj_xxx \
        --invoice-total 12.40 --by-surface search=0.90,task:core=6.10,task:pro=3.20,task:ultra=2.20 \
        --write

Nothing is guessed: a tier with no calls in the window keeps its previous value
and is reported as uncalibrated.
"""

from __future__ import annotations

import argparse
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRICING = ROOT / "services/parallel-adapter/src/clearframe_adapter/pricing.py"

#: Which surfaces roll up into which tier for calibration purposes.
SURFACE_TIER = {
    "search": 0,
    "extract": 0,
    "task:core": 1,
    "task:pro": 2,
    "task:ultra": 3,
    "findall": 2,
}


def parse_by_surface(raw: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for part in filter(None, (p.strip() for p in raw.split(","))):
        name, _, value = part.partition("=")
        out[name.strip()] = float(value)
    return out


def call_counts(project_id: str | None) -> dict[str, int]:
    from clearframe_ledger.sink import COST_EVENTS, get_sink

    criteria = {"project_id": project_id} if project_id else {}
    counts: dict[str, int] = defaultdict(int)
    for row in get_sink().read(COST_EVENTS, **criteria):
        counts[str(row.get("surface", "unknown"))] += 1
    return dict(counts)


def recorded_spend(project_id: str | None) -> dict[str, float]:
    from clearframe_ledger.sink import COST_EVENTS, get_sink

    criteria = {"project_id": project_id} if project_id else {}
    spend: dict[str, float] = defaultdict(float)
    for row in get_sink().read(COST_EVENTS, **criteria):
        spend[str(row.get("surface", "unknown"))] += float(row.get("cost_usd", 0.0))
    return dict(spend)


def measured_tier_costs(
    counts: dict[str, int], invoiced: dict[str, float]
) -> tuple[dict[int, float], list[str]]:
    """Invoice dollars ÷ calls made, rolled up per tier."""
    per_tier_cost: dict[int, list[float]] = defaultdict(list)
    skipped: list[str] = []

    for surface, dollars in invoiced.items():
        tier = SURFACE_TIER.get(surface)
        if tier is None:
            skipped.append(f"{surface}: not a known surface")
            continue
        calls = counts.get(surface, 0)
        if calls == 0:
            skipped.append(f"{surface}: invoiced ${dollars:.2f} but no calls recorded")
            continue
        per_tier_cost[tier].append(dollars / calls)

    return (
        {tier: round(sum(values) / len(values), 6) for tier, values in per_tier_cost.items()},
        skipped,
    )


def write_pricing(measured: dict[int, float]) -> None:
    source = PRICING.read_text()
    current = dict(
        re.findall(
            r"(\d+):\s*([0-9.]+)", re.search(r"TIER_COST_USD.*?\{(.*?)\}", source, re.S).group(1)
        )
    )
    merged = {int(k): float(v) for k, v in current.items()} | measured
    rendered = ", ".join(f"{tier}: {cost}" for tier, cost in sorted(merged.items()))

    source = re.sub(
        r"TIER_COST_USD: dict\[int, float\] = \{.*?\}",
        f"TIER_COST_USD: dict[int, float] = {{{rendered}}}",
        source,
        flags=re.S,
    )
    source = source.replace("CALIBRATED = False", "CALIBRATED = True")
    PRICING.write_text(source)


def main() -> int:
    parser = argparse.ArgumentParser(description="Calibrate tier costs against an invoice")
    parser.add_argument("--project", default=None, help="Limit to one project")
    parser.add_argument(
        "--by-surface",
        default="",
        help="Invoiced dollars per surface, e.g. 'task:core=6.10,search=0.90'",
    )
    parser.add_argument(
        "--invoice-total",
        type=float,
        default=None,
        help="Invoice total for the same window, for a sanity check",
    )
    parser.add_argument(
        "--write", action="store_true", help="Write the measured values into pricing.py"
    )
    args = parser.parse_args()

    counts = call_counts(args.project)
    spend = recorded_spend(args.project)
    if not counts:
        print("No cost events recorded. Run a pass first — every billable call writes one.")
        return 1

    print("Recorded by the ledger")
    for surface in sorted(counts):
        print(
            f"  {surface:14} {counts[surface]:5} calls   estimated ${spend.get(surface, 0.0):8.4f}"
        )
    estimated_total = sum(spend.values())
    print(f"  {'total':14} {sum(counts.values()):5} calls   estimated ${estimated_total:8.4f}")

    invoiced = parse_by_surface(args.by_surface)
    if not invoiced:
        print("\nRe-run with --by-surface once you have the invoice for this window.")
        return 0

    if args.invoice_total is not None:
        drift = sum(invoiced.values()) - args.invoice_total
        if abs(drift) > 0.01:
            print(
                f"\nWARNING: per-surface figures sum to "
                f"${sum(invoiced.values()):.2f}, invoice total is "
                f"${args.invoice_total:.2f} (${drift:+.2f})"
            )

    measured, skipped = measured_tier_costs(counts, invoiced)
    print("\nMeasured cost per call")
    for tier in sorted(measured):
        print(f"  T{tier}  ${measured[tier]:.6f}")
    for note in skipped:
        print(f"  skipped — {note}")

    if not measured:
        print("\nNothing could be measured; pricing.py left alone.")
        return 1

    ratio = (sum(invoiced.values()) / estimated_total) if estimated_total else 0
    print(
        f"\nEstimates were off by {ratio:.2f}x "
        f"(${estimated_total:.2f} estimated vs ${sum(invoiced.values()):.2f} invoiced)"
    )

    if args.write:
        write_pricing(measured)
        print(
            f"\nwrote {PRICING.relative_to(ROOT)} — CALIBRATED is now True, and the "
            "budget meter will stop labelling the figure as an estimate."
        )
    else:
        print("\nRe-run with --write to apply.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
