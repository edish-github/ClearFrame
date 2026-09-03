"use client";

import { getItem, getProvenance } from "@/lib/api";
import { useLive } from "@/lib/live";
import { ITEM_TYPE_LABEL, hostOf, riskTextClass } from "@/lib/format";
import { ProvenanceGraph } from "@/components/ProvenanceGraph";

/** Everything known about one item: findings, the argument over them, the chains. */
export function ItemDrawer({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const { data, error } = useLive(() => getItem(itemId), 3000, [itemId]);
  const { data: graph } = useLive(() => getProvenance(itemId), 6000, [itemId]);

  return (
    <aside className="drawer" aria-label="Item detail">
      <header className="row-between" style={{ marginBottom: 12 }}>
        <span className="kicker">item</span>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </header>

      {error && <p className="banner banner-red small">{error}</p>}
      {!data && !error && <p className="empty">Loading…</p>}

      {data && (
        <div className="stack">
          <div>
            <h2 style={{ marginBottom: 2 }}>{data.item.title}</h2>
            <p className="small muted" style={{ margin: 0 }}>
              {ITEM_TYPE_LABEL[data.item.type]} ·{" "}
              {data.item.timecode?.scene ? `scene ${data.item.timecode.scene} · ` : ""}
              {data.item.tc_in} · {data.item.prominence}
            </p>
            <p className="small" style={{ marginTop: 6 }}>
              <span className={riskTextClass(data.item.risk_state)}>
                {(data.item.risk_state ?? "not yet established").toUpperCase()}
              </span>{" "}
              <span className="dim">· {data.item.status.replace(/_/g, " ")}</span>
            </p>
            <p className="small muted">{data.item.description}</p>
          </div>

          <section>
            <h3>Chain of title</h3>
            <ProvenanceGraph graph={graph} />
          </section>

          <section>
            <h3>Findings</h3>
            {data.findings.length === 0 && <p className="empty">Nothing established yet.</p>}
            {data.findings.map((finding) => (
              <div key={finding.finding_id} className="panel" style={{ marginBottom: 8 }}>
                <div className="row-between">
                  <span className="mono small">{finding.agent}</span>
                  <span className="xsmall dim">
                    confidence {(finding.confidence ?? 0).toFixed(2)} · T{finding.tier ?? 1}
                    {finding.prev_interaction_id ? " · chained" : ""}
                  </span>
                </div>
                <ul className="cites">
                  {(finding.citations ?? []).map((citation) => (
                    <li key={citation.citation_id}>
                      <span className="tag">{citation.authority}</span>{" "}
                      <a href={citation.url} target="_blank" rel="noreferrer noopener">
                        {citation.title || hostOf(citation.url)}
                      </a>
                      {citation.published_date && (
                        <span className="xsmall dim"> · published {citation.published_date}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          {data.challenges.length > 0 && (
            <section>
              <h3>Verifier challenges</h3>
              {data.challenges.map((challenge) => (
                <div key={challenge.challenge_id} className="feed__challenge">
                  <span className="tag">{challenge.grounds}</span>
                  <p className="small" style={{ margin: "6px 0 0" }}>{challenge.rationale}</p>
                </div>
              ))}
            </section>
          )}

          {data.assessment && (
            <section>
              <h3>Risk counsel</h3>
              <p className="small">{data.assessment.rationale}</p>
              <p className="disclaimer">{data.assessment.disclaimer}</p>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}
