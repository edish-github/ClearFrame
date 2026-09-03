"use client";

import { useState } from "react";
import type { Finding, Item, Mitigation, RiskAssessment, Role } from "@/lib/contracts";
import { decide, type DecisionAction } from "@/lib/api";
import { useAction } from "@/lib/live";
import { hostOf, riskTextClass, usd } from "@/lib/format";

type Props = {
  projectId: string;
  role: Role;
  entry: { item: Item; assessment: RiskAssessment | null; findings: Finding[] };
  onClose: () => void;
  onDecided: () => void;
};

/**
 * The counsel gate.
 *
 * Side by side: the item, what research established, the citations behind it, and
 * the mitigations with their cost deltas. Every decision writes a rationale to
 * the ledger, which is what makes the report's decision log worth reading.
 *
 * A producer never sees the approve controls — they are absent, not disabled.
 */
export function ApprovalModal({ projectId, role, entry, onClose, onDecided }: Props) {
  const { item, assessment, findings } = entry;
  const [choice, setChoice] = useState<Mitigation | null>(
    assessment?.mitigations?.find((m) => m.recommended) ?? assessment?.mitigations?.[0] ?? null,
  );
  const [rationale, setRationale] = useState("");
  const action = useAction(decide);
  const mayApprove = role === "counsel";

  const submit = async (kind: DecisionAction) => {
    const result = await action.run(projectId, {
      action: kind,
      rationale: rationale.trim(),
      item_id: item.item_id,
      target_id: kind === "approve_mitigation" ? choice?.mitigation_id : undefined,
    });
    if (result) {
      onDecided();
      onClose();
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Approve ${item.title}`}>
      <div className="modal__panel">
        <header className="row-between" style={{ marginBottom: 12 }}>
          <div>
            <span className="kicker">counsel gate</span>
            <h2 style={{ margin: "4px 0 0" }}>{item.title}</h2>
            <p className="small muted" style={{ margin: 0 }}>
              {item.timecode?.scene ? `scene ${item.timecode.scene} · ` : ""}
              {item.type.replace(/_/g, " ")} ·{" "}
              <span className={riskTextClass(assessment?.risk_state)}>
                {(assessment?.risk_state ?? "unknown").toUpperCase()}
              </span>
            </p>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="modal__body">
          <section className="stack">
            <div>
              <h3>What research established</h3>
              {findings.length === 0 && <p className="empty">No live findings.</p>}
              {findings.map((finding) => (
                <div key={finding.finding_id} className="panel" style={{ marginBottom: 8 }}>
                  <div className="row-between">
                    <span className="mono small">{finding.agent}</span>
                    <span className="xsmall dim">
                      confidence {(finding.confidence ?? 0).toFixed(2)} · T{finding.tier ?? 1}
                    </span>
                  </div>
                  <pre className="claim">{claimText(finding)}</pre>
                  <ul className="cites">
                    {(finding.citations ?? []).slice(0, 6).map((citation) => (
                      <li key={citation.citation_id}>
                        <span className="tag">{citation.authority}</span>{" "}
                        <a href={citation.url} target="_blank" rel="noreferrer noopener">
                          {citation.title || hostOf(citation.url)}
                        </a>{" "}
                        {citation.snapshot_uri && <span className="xsmall dim">· snapshot stored</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            {assessment && (
              <div>
                <h3>Risk counsel</h3>
                <p className="small">{assessment.rationale}</p>
                {assessment.grounding_refs?.length ? (
                  <p className="xsmall dim">Grounded in: {assessment.grounding_refs.join("; ")}</p>
                ) : null}
                <p className="disclaimer">{assessment.disclaimer}</p>
              </div>
            )}
          </section>

          <section className="stack">
            <div>
              <h3>Mitigations</h3>
              {(assessment?.mitigations ?? []).length === 0 && (
                <p className="empty">None proposed.</p>
              )}
              <div className="stack-tight">
                {(assessment?.mitigations ?? []).map((mitigation) => (
                  <label
                    key={mitigation.mitigation_id}
                    className={`option${choice?.mitigation_id === mitigation.mitigation_id ? " is-selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name="mitigation"
                      checked={choice?.mitigation_id === mitigation.mitigation_id}
                      onChange={() => setChoice(mitigation)}
                    />
                    <span className="stack-tight" style={{ gap: 2 }}>
                      <span className="row" style={{ gap: 6 }}>
                        <strong className="small">{mitigation.kind.replace(/_/g, " ")}</strong>
                        {mitigation.recommended && <span className="tag">recommended</span>}
                        <span className="mono xsmall dim">
                          {mitigation.cost_delta_usd ? usd(mitigation.cost_delta_usd, 0) : "no cost"}
                        </span>
                      </span>
                      <span className="small muted">{mitigation.summary}</span>
                      {mitigation.production_impact && (
                        <span className="xsmall dim">{mitigation.production_impact}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="label" htmlFor="rationale">
                Rationale — recorded in the ledger and printed in the report
              </label>
              <textarea
                id="rationale"
                className="field"
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
                placeholder="Why this decision, in the words you would want an underwriter to read."
              />
            </div>

            {action.error && <p className="banner banner-red small">{action.error}</p>}

            {mayApprove ? (
              <div className="row wrap" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={action.pending || !rationale.trim() || !choice}
                  onClick={() => submit("approve_mitigation")}
                >
                  Approve mitigation
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={action.pending || !rationale.trim()}
                  onClick={() => submit("request_reinvestigation")}
                >
                  Send back for re-investigation
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={action.pending || !rationale.trim()}
                  onClick={() => submit("reject_mitigation")}
                >
                  Reject
                </button>
              </div>
            ) : (
              <p className="banner small">
                Approval is counsel&apos;s. You are acting as <strong>{role}</strong>, so the
                approval controls are not shown — and the API would refuse them regardless.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function claimText(finding: Finding): string {
  const claim = { ...(finding.claim as Record<string, unknown>) };
  for (const key of Object.keys(claim)) if (key.startsWith("_")) delete claim[key];
  return JSON.stringify(claim, null, 2).slice(0, 2200);
}
