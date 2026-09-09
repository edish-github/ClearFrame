import type { SpendRow } from "@clearframe/shared";
import { Card } from "@/components/ui";
import { money } from "@/lib/format";

/**
 * Measured, not estimated. Each row is the sum of real cost events, which is
 * what lets a pass show pennies on the boring items and dollars only where the
 * verifier forced an escalation.
 */
export function SpendBreakdown({ rows }: { rows: SpendRow[] }) {
  if (!rows.length) return null;
  const peak = Math.max(...rows.map((r) => r.cost_micros), 1);
  return (
    <Card style={{ marginTop: 16 }}>
      <h3>Where the budget went</h3>
      <div style={{ marginTop: 12 }}>
        {rows.map((r) => (
          <div className="spend" key={r.stage}>
            <span className="spend__stage">{r.stage}</span>
            <span className="spend__track">
              <i className="spend__fill" style={{ width: `${Math.round((r.cost_micros / peak) * 100)}%` }} />
            </span>
            <span className="spend__value">{money(r.cost_micros)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
