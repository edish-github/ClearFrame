import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { RotateCw, Search, Square, Upload } from "lucide-react";
import {
  isResolved, isWorking, progressPercent, type Finding, type FindingStatus,
} from "@clearframe/shared";
import { Bar, Banner, Button, Card, Chips, Empty, Stats, StatusPill, TextInput } from "@/components/ui";
import { ActivityTimeline } from "@/components/findings/ActivityTimeline";
import { FindingsTable } from "@/components/findings/FindingsTable";
import { DeltaNote } from "@/components/production/DeltaNote";
import { NewCutPanel } from "@/components/production/NewCutPanel";
import { SpendBreakdown } from "@/components/production/SpendBreakdown";
import { api } from "@/api/client";
import { useAsync } from "@/hooks/useAsync";
import { useProductionStream } from "@/hooks/useProductionStream";
import { useSlate } from "@/hooks/useSlate";
import { money, stamp } from "@/lib/format";
import { productionTone } from "@/lib/status";

type Filter = "all" | "review" | "open" | "resolved";

const HELD: FindingStatus[] = ["held", "queued", "failed"];

export function Workspace() {
  const { id } = useParams<{ id: string }>();
  const { refreshSlate } = useSlate();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [cutOpen, setCutOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const state = useAsync(() => api.production(id!), [id]);

  // A stream frame means something moved; the screen re-reads rather than
  // patching local state, so what is shown is always what was persisted.
  const onChange = useCallback(() => {
    void state.reload();
    void refreshSlate();
  }, [state.reload, refreshSlate]);

  const running = state.data?.production.status === "running" || state.data?.production.status === "breakdown";
  useProductionStream(id, onChange, true);

  const tally = useMemo(() => {
    const findings = state.data?.findings ?? [];
    const live = findings.filter((f) => f.status !== "withdrawn");
    return {
      total: live.length,
      resolved: live.filter((f) => isResolved(f.status)).length,
      review: live.filter((f) => f.status === "review").length,
      open: live.filter((f) => isWorking(f.status) || f.status === "held" || f.status === "failed").length,
      withdrawn: findings.length - live.length,
    };
  }, [state.data]);

  const rows = useMemo(() => {
    const findings = state.data?.findings ?? [];
    const inBucket = (f: Finding) => {
      if (filter === "all") return f.status !== "withdrawn";
      if (filter === "review") return f.status === "review";
      if (filter === "open") return isWorking(f.status) || f.status === "held" || f.status === "failed";
      return isResolved(f.status) || f.status === "withdrawn";
    };
    const q = query.trim().toLowerCase();
    return findings.filter(
      (f) => inBucket(f) && (!q || `${f.item} ${f.category} ${f.scene ?? ""}`.toLowerCase().includes(q))
    );
  }, [state.data, filter, query]);

  if (state.loading && !state.data) return <div className="note">Loading the production.</div>;
  if (state.error) return <Banner>{state.error}</Banner>;
  if (!state.data) return null;

  const { production, findings, cuts, spendBy, activity } = state.data;
  const heldCount = findings.filter((f) => HELD.includes(f.status)).length;

  const act = async (fn: () => Promise<unknown>, message: string) => {
    try { await fn(); setNotice(null); await state.reload(); await refreshSlate(); }
    catch (err) { setNotice(err instanceof Error ? err.message : message); }
  };

  return (
    <>
      <div className="between">
        <div>
          <h1>{production.title}</h1>
          <div className="table__sub mono" style={{ marginTop: 7 }}>
            {production.format} · {production.script ?? "no script"} · started {stamp(production.created_at)}
          </div>
        </div>
        <div className="row">
          {!running && heldCount > 0 && (
            <Button variant="ghost" size="sm" icon={<RotateCw size={12} />}
              onClick={() => act(() => api.resume(production.id), "The pass could not be resumed.")}>
              Resume {heldCount}
            </Button>
          )}
          {!running && findings.length > 0 && (
            <Button variant="ghost" size="sm" icon={<Upload size={12} />} onClick={() => setCutOpen((o) => !o)}>
              New cut
            </Button>
          )}
          {running && (
            <span className="row note" style={{ gap: 6 }}><Square size={11} /> pass running</span>
          )}
          <StatusPill status={productionTone(production.status)} />
        </div>
      </div>

      {production.error && <div style={{ marginTop: 22 }}><Banner>{production.error}</Banner></div>}
      {notice && <div style={{ marginTop: 22 }}><Banner>{notice}</Banner></div>}

      {cutOpen && (
        <NewCutPanel
          onCancel={() => setCutOpen(false)}
          onSubmit={async (file) => {
            await api.addCut(production.id, file);
            setCutOpen(false);
            await state.reload();
            await refreshSlate();
          }}
        />
      )}

      <DeltaNote cuts={cuts} />

      <div style={{ marginTop: 26 }}><Stats tally={tally} /></div>

      <div style={{ marginTop: 18 }}>
        <Bar percent={progressPercent({ total: tally.total, resolved: tally.resolved, review: tally.review })} />
        <div className="row" style={{ justifyContent: "space-between", marginTop: 9 }}>
          <span className="note">
            {production.status === "breakdown"
              ? "Reading the screenplay"
              : running ? "Investigation running" : "Investigation complete"}
            {tally.withdrawn > 0 ? ` · ${tally.withdrawn} withdrawn from the cut` : ""}
          </span>
          <span className="note mono">
            {money(production.spent_micros)} of {money(production.budget_cap_micros)} spent
          </span>
        </div>
      </div>

      <div className="split" style={{ marginTop: 30 }}>
        <div>
          <div className="row row-wrap" style={{ justifyContent: "space-between", marginBottom: 14, gap: 10 }}>
            <Chips
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All", count: tally.total },
                { value: "review", label: "Needs review", count: tally.review },
                { value: "open", label: "In progress", count: tally.open },
                { value: "resolved", label: "Resolved", count: tally.resolved + tally.withdrawn },
              ]}
            />
            <div className="row" style={{ gap: 7 }}>
              <Search size={14} color="var(--ink-3)" />
              <TextInput className="input input--inline" value={query}
                onChange={(e) => setQuery(e.target.value)} placeholder="Search findings" />
            </div>
          </div>

          {findings.length === 0 ? (
            <Empty title={production.status === "breakdown" ? "Reading the screenplay" : "Nothing found yet"}>
              {production.status === "breakdown"
                ? "Items appear here as soon as the breakdown finishes."
                : "The breakdown returned no clearance items for this script."}
            </Empty>
          ) : (
            <FindingsTable findings={rows} emptyNote="No findings match that filter." />
          )}
        </div>

        <div>
          <Card>
            <h3>Activity</h3>
            <p className="note" style={{ margin: "5px 0 16px" }}>Every step the pass has actually taken.</p>
            <ActivityTimeline rows={activity} live={running} showItem />
          </Card>
          <SpendBreakdown rows={spendBy} />
        </div>
      </div>
    </>
  );
}
