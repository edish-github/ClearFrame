"use client";

import Link from "next/link";
import { useState } from "react";
import type { Role } from "@/lib/contracts";
import { decide, getApprovals, getOutreach } from "@/lib/api";
import { useAction, useLive } from "@/lib/live";
import { ApprovalModal } from "@/components/ApprovalModal";
import { ITEM_TYPE_LABEL, riskTextClass } from "@/lib/format";

/** The gate, and the queue behind it. Nothing here sends anything. */
export function ApprovalsConsole({ projectId, role }: { projectId: string; role: Role }) {
  const [open, setOpen] = useState<string | null>(null);
  const approvals = useLive(() => getApprovals(projectId), 3000, [projectId]);
  const outreach = useLive(() => getOutreach(projectId), 5000, [projectId]);
  const action = useAction(decide);

  const entry = approvals.data?.items?.find((row) => row.item.item_id === open);

  return (
    <div className="stack">
      <header>
        <span className="kicker">
          <Link href={`/projects/${projectId}`}>← production</Link>
        </span>
        <h1>Waiting on counsel</h1>
        <p className="small muted" style={{ margin: 0 }}>
          Red items, and amber items whose mitigation costs money. Nothing red resolves
          without a human, and every decision records its rationale.
        </p>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2>Items</h2>
          <span className="mono xsmall dim">{approvals.data?.counts?.items ?? 0}</span>
        </div>

        {(approvals.data?.items?.length ?? 0) === 0 ? (
          <p className="empty">Nothing is waiting. That is the good state.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Item</th><th>Type</th><th>Risk</th><th>Mitigations</th><th /></tr>
            </thead>
            <tbody>
              {approvals.data?.items?.map(({ item, assessment }) => (
                <tr key={item.item_id}>
                  <td>
                    <strong className="small">{item.title}</strong>
                    <div className="xsmall dim">
                      {item.timecode?.scene ? `scene ${item.timecode.scene}` : "—"}
                    </div>
                  </td>
                  <td className="small">{ITEM_TYPE_LABEL[item.type]}</td>
                  <td className={`small ${riskTextClass(assessment?.risk_state)}`}>
                    {(assessment?.risk_state ?? "unknown").toUpperCase()}
                  </td>
                  <td className="mono small">{assessment?.mitigations?.length ?? 0}</td>
                  <td>
                    <button type="button" className="btn" onClick={() => setOpen(item.item_id)}>
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Outreach queue</h2>
          <span className="mono xsmall dim">{outreach.data?.drafts?.length ?? 0}</span>
        </div>

        {(outreach.data?.drafts?.length ?? 0) === 0 ? (
          <p className="empty">No inquiries drafted.</p>
        ) : (
          <div className="stack-tight">
            {outreach.data?.drafts?.map((draft) => (
              <article key={draft.outreach_id} className="panel" style={{ background: "var(--panel-2)" }}>
                <div className="row-between wrap">
                  <div>
                    <strong className="small">{draft.subject}</strong>
                    <div className="xsmall dim">
                      to {draft.to_name}
                      {draft.to_email ? ` <${draft.to_email}>` : " — contact unconfirmed"}
                      {draft.contact_source_url && (
                        <>
                          {" · "}
                          <a href={draft.contact_source_url} target="_blank" rel="noreferrer noopener">
                            source
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                  <span className="tag">{draft.status.replace(/_/g, " ")}</span>
                </div>

                <pre className="claim">{draft.body}</pre>

                {role === "counsel" && draft.status === "pending_approval" && (
                  <div className="row" style={{ gap: 8, marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={action.pending}
                      onClick={async () => {
                        await action.run(projectId, {
                          action: "approve_outreach",
                          rationale: "Approved for sending by the production office.",
                          item_id: draft.item_id,
                          target_id: draft.outreach_id,
                        });
                        outreach.refresh();
                      }}
                    >
                      Approve for the queue
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={action.pending}
                      onClick={async () => {
                        await action.run(projectId, {
                          action: "reject_outreach",
                          rationale: "Not to be sent.",
                          item_id: draft.item_id,
                          target_id: draft.outreach_id,
                        });
                        outreach.refresh();
                      }}
                    >
                      Reject
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}

        <p className="disclaimer">{outreach.data?.note}</p>
      </section>

      {entry && (
        <ApprovalModal
          projectId={projectId}
          role={role}
          entry={entry}
          onClose={() => setOpen(null)}
          onDecided={() => approvals.refresh()}
        />
      )}
    </div>
  );
}
