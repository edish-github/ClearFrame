import { useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, RotateCw } from "lucide-react";
import { CATEGORY_LABEL, DECISION_LABEL, isResolved, isWorking } from "@clearframe/shared";
import { Bar, Banner, Button, Card, Risk, StatusPill, Tabs } from "@/components/ui";
import { ChainOfTitle } from "@/components/findings/ChainOfTitle";
import { EvidenceList, VerificationNote } from "@/components/findings/EvidenceList";
import { ActivityTimeline } from "@/components/findings/ActivityTimeline";
import { DecisionPanel } from "@/components/findings/DecisionPanel";
import { OutreachCard } from "@/components/findings/OutreachCard";
import { api } from "@/api/client";
import { useAsync } from "@/hooks/useAsync";
import { useSlate } from "@/hooks/useSlate";
import { percent, sceneLabel, stamp } from "@/lib/format";

type TabKey = "overview" | "evidence" | "activity";

export function FindingDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { refreshSlate } = useSlate();
  const [tab, setTab] = useState<TabKey>("overview");
  const [notice, setNotice] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);

  const state = useAsync(() => api.finding(id!), [id]);

  const after = useCallback(async () => {
    await state.reload();
    await refreshSlate();
  }, [state.reload, refreshSlate]);

  if (state.loading && !state.data) return <div className="note">Loading the finding.</div>;
  if (state.error) return <Banner>{state.error}</Banner>;
  if (!state.data) return null;

  const { finding, evidence, activity, decision, outreach, watch } = state.data;
  const working = isWorking(finding.status);
  const resolved = isResolved(finding.status);

  const recheck = async () => {
    setRechecking(true);
    setNotice(null);
    try { await api.recheck(finding.id); await after(); }
    catch (err) { setNotice(err instanceof Error ? err.message : "The re-check could not be queued."); }
    finally { setRechecking(false); }
  };

  return (
    <>
      <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />}
        onClick={() => navigate(`/productions/${finding.production_id}`)}>
        {finding.production_title}
      </Button>

      <div className="between" style={{ marginTop: 22 }}>
        <div>
          <h1>{finding.item}</h1>
          <div className="table__sub mono" style={{ marginTop: 7 }}>
            {CATEGORY_LABEL[finding.category]} · {sceneLabel(finding.scene)}
            {finding.page ? ` · Page ${finding.page}` : ""}
            {finding.pass_n > 1 ? ` · added in cut ${finding.pass_n}` : ""}
          </div>
        </div>
        <StatusPill status={finding.status} />
      </div>

      {notice && <div style={{ marginTop: 18 }}><Banner>{notice}</Banner></div>}

      <Tabs
        active={tab}
        onChange={(k) => setTab(k as TabKey)}
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "evidence", label: `Evidence ${evidence.length}` },
          { key: "activity", label: "Activity" },
        ]}
      />

      {tab === "overview" && (
        <div style={{ marginTop: 22 }}>
          <div className="split split--narrow">
            <Card>
              <h3>How it appears</h3>
              <p className="muted" style={{ fontSize: 14.5, lineHeight: 1.6, marginTop: 8 }}>{finding.context}</p>
              {finding.summary && (
                <>
                  <h3 style={{ marginTop: 22 }}>Rights position found</h3>
                  <p className="muted" style={{ fontSize: 14.5, lineHeight: 1.6, marginTop: 8 }}>{finding.summary}</p>
                </>
              )}
            </Card>

            <Card>
              <div className="note">Risk</div>
              <div style={{ margin: "8px 0 14px", fontSize: 20, fontWeight: 600, letterSpacing: "-0.03em" }}>
                <Risk level={finding.risk} />
              </div>
              {finding.confidence !== null && (
                <>
                  <Bar percent={finding.confidence * 100} />
                  <div className="note mono" style={{ marginTop: 7 }}>{percent(finding.confidence)} confidence</div>
                </>
              )}
              {finding.verification && (
                <div className="note" style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line-soft)" }}>
                  {finding.verification.sufficient ? "Evidence accepted by verification." : "Evidence still contested."}
                  {finding.verification.escalated ? " Deep research was run after a challenge." : ""}
                </div>
              )}
            </Card>
          </div>

          <div style={{ marginTop: 22 }}>
            <ChainOfTitle chains={finding.chains} category={finding.category} />
          </div>

          {finding.assessment && (
            <div style={{ marginTop: 22 }}>
              <h3>Assessment</h3>
              <p className="prose" style={{ marginTop: 9 }}>{finding.assessment}</p>
              <h3 style={{ marginTop: 22 }}>Recommended next step</h3>
              <p className="prose" style={{ marginTop: 9 }}>{finding.recommendation}</p>
              <p className="note" style={{ marginTop: 14 }}>
                Based on the sources recorded under Evidence. Research output for human review.
              </p>
            </div>
          )}

          {finding.status === "failed" && finding.error && (
            <div style={{ marginTop: 20 }}><Banner>{finding.error}</Banner></div>
          )}

          {finding.status === "held" && (
            <Card style={{ marginTop: 20 }}>
              <div className="note">
                This item was not investigated because the pass reached its research budget.
                Resume the pass from the production to pick it up.
              </div>
            </Card>
          )}

          {finding.status === "withdrawn" && (
            <Card style={{ marginTop: 20 }}>
              <div className="note">
                This element is not in the current cut. Its research stays on record in case it returns.
              </div>
            </Card>
          )}

          {finding.status === "review" && (
            <DecisionPanel
              onRecord={async (action, rationale) => {
                await api.decide(finding.id, action, rationale);
                await after();
              }}
            />
          )}

          {outreach && (
            <OutreachCard
              outreach={outreach}
              onApprove={async () => { await api.approveOutreach(finding.id); await after(); }}
            />
          )}

          {resolved && (
            <Card style={{ marginTop: 22 }}>
              <h3>Decision</h3>
              {decision ? (
                <>
                  <p style={{ fontSize: 14.5, marginTop: 8 }}>
                    {DECISION_LABEL[decision.action]}{decision.rationale ? ` — ${decision.rationale}` : ""}
                  </p>
                  <div className="note mono" style={{ marginTop: 6 }}>
                    {decision.actor_name} ({decision.actor_role}) · {stamp(decision.created_at)}
                  </div>
                </>
              ) : (
                <p className="muted" style={{ fontSize: 14.5, marginTop: 8 }}>
                  Cleared by assessment without human review.
                </p>
              )}

              <div style={{ marginTop: 20, paddingTop: 18, borderTop: "1px solid var(--line-soft)" }}>
                <div className="between">
                  <div>
                    <h3>Monitoring</h3>
                    <p className="note" style={{ marginTop: 6, maxWidth: "48ch" }}>
                      The research is re-run against today's web. If a new source conflicts with what is on record,
                      the finding reopens.
                    </p>
                    {watch?.last_checked_at && (
                      <div className="note mono" style={{ marginTop: 8 }}>
                        Last checked {stamp(watch.last_checked_at)}
                      </div>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" icon={<RotateCw size={13} />} busy={rechecking} onClick={recheck}>
                    Check again
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === "evidence" && (
        <div style={{ marginTop: 22 }}>
          <EvidenceList evidence={evidence} working={working} />
          <VerificationNote verification={finding.verification} />
        </div>
      )}

      {tab === "activity" && (
        <Card style={{ marginTop: 22 }}>
          <ActivityTimeline rows={[...activity].reverse()} live={working} />
        </Card>
      )}
    </>
  );
}
