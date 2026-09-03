"use client";

import type { BudgetMeter as Meter } from "@/lib/contracts";
import { usd } from "@/lib/format";

/**
 * The 1st AD's budget, ticking per tool call.
 *
 * It also reports whether its own numbers are calibrated, because a cost figure
 * that looks precise and is not is worse than one that admits it.
 */
export function BudgetMeter({ meter, compact = false }: { meter: Meter | null; compact?: boolean }) {
  if (!meter) return <div className="empty">budget unavailable</div>;

  const pct = Math.min(100, (meter.pct ?? 0) * 100);
  const state = pct >= 100 ? "at-cap" : meter.warn ? "warn" : "ok";
  const tiers = Object.entries(meter.by_tier ?? {}).sort();

  return (
    <div className={`meter meter--${state}`}>
      <div className="row-between">
        <span className="kicker">1st AD · budget</span>
        <span className="mono small">
          {usd(meter.spent_usd ?? 0, 4)} <span className="dim">/ {usd(meter.cap_usd)}</span>
        </span>
      </div>

      <div className="meter__track" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className="meter__fill" style={{ width: `${pct}%` }} />
      </div>

      {!compact && (
        <>
          <div className="meter__tiers">
            {tiers.length === 0 && <span className="dim xsmall">no spend yet</span>}
            {tiers.map(([tier, amount]) => (
              <span key={tier} className="xsmall dim mono">
                {tier} {usd(amount, 4)}
                <span className="dim"> ×{meter.calls_by_tier?.[tier] ?? 0}</span>
              </span>
            ))}
          </div>
          <p className="xsmall dim" style={{ margin: 0 }}>
            {meter.pricing_note}
          </p>
        </>
      )}

      {state === "at-cap" && (
        <p className="xsmall" style={{ color: "var(--red)", margin: 0 }}>
          Cap reached. The pass pauses rather than overspending; a producer can raise it.
        </p>
      )}
    </div>
  );
}
