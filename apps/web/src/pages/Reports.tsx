import { useCallback, useState } from "react";
import { Download, FileText, Shield } from "lucide-react";
import { progressPercent, type Integrity } from "@clearframe/shared";
import { Banner, Button, Card, Empty, Pill } from "@/components/ui";
import { api } from "@/api/client";
import { useAsync } from "@/hooks/useAsync";
import { useAuth } from "@/hooks/useAuth";
import { useSlate } from "@/hooks/useSlate";
import { stamp } from "@/lib/format";

export function Reports() {
  const { productions, refreshSlate } = useSlate();
  const { can } = useAuth();
  const state = useAsync(() => api.reports(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [integrity, setIntegrity] = useState<Record<string, Integrity>>({});

  const after = useCallback(async () => {
    await state.reload();
    await refreshSlate();
  }, [state.reload, refreshSlate]);

  const ready = productions.filter((p) => p.total > 0);
  const reports = state.data?.reports ?? [];

  const run = async (key: string, fn: () => Promise<unknown>, fallback: string) => {
    setBusy(key);
    setNotice(null);
    try { await fn(); await after(); }
    catch (err) { setNotice(err instanceof Error ? err.message : fallback); }
    finally { setBusy(null); }
  };

  const download = async (reportId: string, title: string) => {
    const blob = await api.downloadReport(reportId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-clearance.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <h1>Reports</h1>
      <p className="lede">A clearance record built from what the pass actually found, verified, traced and decided.</p>

      {notice && <div style={{ marginTop: 22 }}><Banner>{notice}</Banner></div>}

      <div style={{ marginTop: 30 }} className="stack">
        {!ready.length && (
          <Empty title="No completed passes">Run a clearance pass and its report becomes available here.</Empty>
        )}

        {ready.map((p) => {
          const latest = reports.find((r) => r.production_id === p.id);
          const check = integrity[p.id];
          return (
            <Card key={p.id}>
              <div className="between">
                <div>
                  <div className="row" style={{ gap: 10 }}>
                    <h2>{p.title}</h2>
                    {latest?.signed_at && <Pill tone="green"><Shield size={11} /> Signed</Pill>}
                  </div>
                  <div className="row row-wrap mono muted" style={{ marginTop: 10, gap: 20, fontSize: 12.5 }}>
                    <span>{p.total} findings</span>
                    <span>{p.resolved} resolved</span>
                    <span>{p.review} open</span>
                    <span>{progressPercent(p)}% complete</span>
                    {p.cuts > 1 && <span>{p.cuts} cuts</span>}
                  </div>
                  {p.review > 0 && (
                    <div className="note" style={{ marginTop: 10 }}>
                      {p.review} finding{p.review === 1 ? "" : "s"} still awaiting a decision.
                      The report will list {p.review === 1 ? "it" : "them"} as unresolved.
                    </div>
                  )}
                  {latest && (
                    <div className="note mono" style={{ marginTop: 10 }}>
                      Generated {stamp(latest.generated_at)} · ledger {latest.ledger_length} entries
                      {latest.signed_at ? ` · signed by ${latest.signed_name} on ${stamp(latest.signed_at)}` : ""}
                    </div>
                  )}
                  {check && (
                    <div className="note" style={{ marginTop: 6, color: check.ok ? "var(--risk-low)" : "var(--risk-high)" }}>
                      {check.ok
                        ? `Ledger intact across all ${check.length} entries.`
                        : `Ledger breaks at entry ${check.brokenAt}. This history has been altered.`}
                    </div>
                  )}
                </div>

                <div className="row" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <Button
                    variant="ghost" size="sm"
                    busy={busy === `check-${p.id}`}
                    icon={<Shield size={13} />}
                    onClick={() => run(`check-${p.id}`, async () => {
                      const result = await api.integrity(p.id);
                      setIntegrity((prev) => ({ ...prev, [p.id]: result }));
                    }, "The ledger could not be verified.")}
                  >
                    Verify chain
                  </Button>

                  {latest?.has_pdf && (
                    <Button variant="ghost" size="sm" icon={<Download size={13} />}
                      onClick={() => download(latest.id, p.title)}>
                      Download
                    </Button>
                  )}

                  {latest && !latest.signed_at && (
                    <Button size="sm" variant="ghost" icon={<Shield size={13} />}
                      disabled={!can("counsel")}
                      busy={busy === `sign-${p.id}`}
                      onClick={() => run(`sign-${p.id}`, () => api.signReport(latest.id), "The report could not be signed.")}>
                      Sign off
                    </Button>
                  )}

                  <Button
                    icon={<FileText size={14} />}
                    busy={busy === `gen-${p.id}`}
                    onClick={() => run(`gen-${p.id}`, () => api.generateReport(p.id), "The report could not be generated.")}
                  >
                    {latest ? "Rebuild" : "Build report"}
                  </Button>
                </div>
              </div>

              {latest && !latest.signed_at && !can("counsel") && (
                <div className="note" style={{ marginTop: 12 }}>Sign-off is counsel's to give.</div>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}
