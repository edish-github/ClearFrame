import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { CATEGORY_LABEL } from "@clearframe/shared";
import { Banner, Card, Empty, Risk, Tabs } from "@/components/ui";
import { ChainSummary } from "@/components/findings/ChainOfTitle";
import { DecisionPanel } from "@/components/findings/DecisionPanel";
import { OutreachCard } from "@/components/findings/OutreachCard";
import { api } from "@/api/client";
import { useAsync } from "@/hooks/useAsync";
import { useSlate } from "@/hooks/useSlate";
import { percent, sceneLabel } from "@/lib/format";

type TabKey = "decisions" | "outreach";

export function Approvals() {
  const { refreshSlate } = useSlate();
  const [tab, setTab] = useState<TabKey>("decisions");
  const state = useAsync(() => api.approvals(), []);

  const after = useCallback(async () => {
    await state.reload();
    await refreshSlate();
  }, [state.reload, refreshSlate]);

  if (state.loading && !state.data) return <div className="note">Loading the queue.</div>;
  if (state.error) return <Banner>{state.error}</Banner>;

  const decisions = state.data?.decisions ?? [];
  const outreach = state.data?.outreach ?? [];

  return (
    <>
      <h1>Approvals</h1>
      <p className="lede">
        What research cannot settle on its own: findings that need a decision, and inquiries that need
        clearing before they leave the building.
      </p>

      <Tabs
        active={tab}
        onChange={(k) => setTab(k as TabKey)}
        tabs={[
          { key: "decisions", label: `Decisions${decisions.length ? ` ${decisions.length}` : ""}` },
          { key: "outreach", label: `Outreach${outreach.length ? ` ${outreach.length}` : ""}` },
        ]}
      />

      <div style={{ marginTop: 26 }}>
        {tab === "decisions" ? (
          decisions.length === 0 ? (
            <Empty title="Nothing waiting">
              When an assessment calls for human review, the finding lands here with its evidence and
              chain of title attached.
            </Empty>
          ) : (
            <div className="stack" style={{ gap: 18 }}>
              {decisions.map((f) => (
                <Card key={f.id}>
                  <div className="between">
                    <div>
                      <div className="note mono">{f.production_title}</div>
                      <Link to={`/findings/${f.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                        <h2 style={{ marginTop: 5 }}>{f.item}</h2>
                      </Link>
                      <div className="table__sub mono" style={{ marginTop: 4 }}>
                        {CATEGORY_LABEL[f.category]} · {sceneLabel(f.scene)}
                      </div>
                    </div>
                    <Risk level={f.risk} />
                  </div>

                  <div className="row row-wrap mono muted" style={{ marginTop: 16, gap: 22, fontSize: 12.5 }}>
                    <span>{percent(f.confidence)} confidence</span>
                    <span>{f.evidence_count} sources</span>
                    <span>{f.conflicts} conflicting</span>
                    {f.chains.length > 0 && (
                      <span>{f.chains.filter((c) => c.status !== "clear").length} of {f.chains.length} chains open</span>
                    )}
                  </div>

                  <ChainSummary chains={f.chains} />

                  {f.assessment && <p className="prose" style={{ marginTop: 18, fontSize: 14.5 }}>{f.assessment}</p>}
                  {f.recommendation && (
                    <p className="prose" style={{ marginTop: 10, fontSize: 14.5, fontWeight: 500 }}>{f.recommendation}</p>
                  )}

                  <DecisionPanel
                    onRecord={async (action, rationale) => {
                      await api.decide(f.id, action, rationale);
                      await after();
                    }}
                  />
                </Card>
              ))}
            </div>
          )
        ) : outreach.length === 0 ? (
          <Empty title="No inquiries waiting">
            Choosing to pursue a licence on a finding drafts the inquiry to the traced rights holder.
            It waits here for counsel.
          </Empty>
        ) : (
          <div className="stack" style={{ gap: 18 }}>
            {outreach.map((o) => (
              <Card key={o.id}>
                <div className="note mono">{o.production_title}</div>
                <Link to={`/findings/${o.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                  <h2 style={{ marginTop: 5 }}>{o.item}</h2>
                </Link>
                <OutreachCard
                  bare
                  outreach={{
                    addressed_to: o.addressed_to, subject: o.subject, body: o.body,
                    state: "draft", approved_name: null, approved_at: null, error: null,
                  }}
                  onApprove={async () => { await api.approveOutreach(o.id); await after(); }}
                />
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
