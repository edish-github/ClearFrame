import type { Category, Chain } from "@clearframe/shared";
import { Card } from "@/components/ui";

/**
 * The signature panel of the product. A song is two properties with separate
 * owners, and licensing one clears nothing, so both chains are shown together
 * and neither is allowed to imply the other is settled.
 */
export function ChainOfTitle({ chains, category }: { chains: Chain[]; category: Category }) {
  if (!chains.length) return null;
  return (
    <Card>
      <div className="between">
        <h3>Chain of title</h3>
        {category === "MUSIC" && chains.length > 1 && (
          <span className="note">Both chains must resolve before the cue can be used.</span>
        )}
      </div>
      <div style={{ marginTop: 14 }}>
        {chains.map((c, i) => (
          <div className="chain" key={`${c.right}-${i}`}>
            <i className={`chain__mark chain__mark--${c.status}`} />
            <div className="grow">
              <div className="between">
                <span className="chain__right">{c.right}</span>
                <span className="chain__right">{c.status}</span>
              </div>
              <div className="chain__holder">{c.holder ?? "No owner established"}</div>
              {c.note && <div className="chain__note">{c.note}</div>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Compact form for the approvals queue, where space is tighter. */
export function ChainSummary({ chains }: { chains: Chain[] }) {
  if (!chains.length) return null;
  return (
    <div style={{ marginTop: 16 }}>
      {chains.map((c, i) => (
        <div className="chain" key={`${c.right}-${i}`}>
          <i className={`chain__mark chain__mark--${c.status}`} />
          <div className="grow">
            <div className="chain__right">{c.right} · {c.status}</div>
            <div className="chain__holder" style={{ fontSize: 14 }}>{c.holder ?? "No owner established"}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
