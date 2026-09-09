import type { Cut } from "@clearframe/shared";
import { Banner } from "@/components/ui";

export function DeltaNote({ cuts }: { cuts: Cut[] }) {
  const latest = cuts[cuts.length - 1];
  if (!latest || latest.n < 2) return null;
  const s = latest.stats ?? {};
  return (
    <div style={{ marginTop: 22 }}>
      <Banner tone="calm">
        Cut {latest.n} · {s.added ?? 0} new, {s.changed ?? 0} changed, {s.withdrawn ?? 0} withdrawn.
        {" "}{s.carried ?? 0} items kept their state and sources from the previous cut.
      </Banner>
    </div>
  );
}
