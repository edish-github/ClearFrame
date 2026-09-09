import { ArrowUpRight } from "lucide-react";
import type { Evidence, Verification } from "@clearframe/shared";
import { Card, Empty } from "@/components/ui";
import { pad2, stamp } from "@/lib/format";

/**
 * Numbering is used here and nowhere else in the product, because evidence is
 * the one thing that genuinely is an ordered index the report cites back to.
 */
export function EvidenceList({ evidence, working }: { evidence: Evidence[]; working: boolean }) {
  if (!evidence.length) {
    return (
      <Empty title={working ? "Research in progress" : "No sources recorded"}>
        {working
          ? "Sources appear here as they are retrieved."
          : "Nothing was retrieved for this item. Only sources a search actually returned are stored."}
      </Empty>
    );
  }

  return (
    <Card>
      {evidence.map((e, i) => (
        <div className="evidence" key={e.id}>
          <span className="evidence__index">{pad2(i + 1)}</span>
          <div className="grow">
            <div className="row row-wrap" style={{ gap: 10 }}>
              <a className="evidence__link" href={e.url} target="_blank" rel="noreferrer">
                {e.title ?? e.domain} <ArrowUpRight size={13} />
              </a>
              <span className={`stance stance--${e.stance}`}>{e.stance}</span>
            </div>
            <div style={{ fontSize: 14, color: "var(--ink-2)", marginTop: 5, lineHeight: 1.5 }}>{e.note}</div>
            <div className="note mono" style={{ marginTop: 6 }}>
              {e.domain} · retrieved {stamp(e.retrieved_at)}
              {e.publish_date ? ` · published ${e.publish_date}` : ""}
            </div>
          </div>
        </div>
      ))}
    </Card>
  );
}

export function VerificationNote({ verification }: { verification: Verification | null }) {
  if (!verification) return null;
  return (
    <Card style={{ marginTop: 18 }}>
      <h3>Verification</h3>
      {verification.priorReason && (
        <p style={{ fontSize: 14, marginTop: 10, color: "var(--risk-high)" }}>
          Challenged: {verification.priorReason}
        </p>
      )}
      <p style={{ fontSize: 14.5, marginTop: 10, color: "var(--ink-2)", lineHeight: 1.6 }}>
        {verification.sufficient ? "Accepted. " : "Unresolved. "}{verification.reason}
      </p>
    </Card>
  );
}
