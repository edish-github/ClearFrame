"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  armWatches,
  getBudget,
  previewDelta,
  shipReport,
  startPass,
  uploadCut,
  verifyChain,
} from "@/lib/api";
import { useAction, useLive } from "@/lib/live";
import { BudgetMeter } from "@/components/BudgetMeter";
import { relativeTime, usd } from "@/lib/format";

type Cut = { cut_id: string; label: string; kind: string; duration_frames: number; fps: number };
type Pass = {
  pass_id: string;
  mode: string;
  status: string;
  total_items: number;
  open_items: number;
  cleared_items: number;
  challenges: number;
  started_ts: string;
};

type Props = {
  projectId: string;
  initial: {
    project: { title: string; budget_cap_usd: number };
    cuts: Cut[];
    passes: Pass[];
  };
};

/** The production's front door: upload a cut, start a pass, ship the report. */
export function ProjectConsole({ projectId, initial }: Props) {
  const router = useRouter();
  const [cuts, setCuts] = useState<Cut[]>(initial.cuts);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const budget = useLive(() => getBudget(projectId), 4000, [projectId]);
  const chain = useLive(() => verifyChain(projectId), 15000, [projectId]);

  const upload = useAction(uploadCut);
  const start = useAction(startPass);
  const ship = useAction(shipReport);
  const arm = useAction(armWatches);
  const delta = useAction(previewDelta);

  const latestCut = cuts[cuts.length - 1];
  const [label, setLabel] = useState(`cut-${String(cuts.length + 1).padStart(2, "0")}`);

  return (
    <div className="stack">
      <header className="row-between wrap">
        <div>
          <span className="kicker">production</span>
          <h1 style={{ marginBottom: 2 }}>{initial.project.title}</h1>
          <p className="small dim mono" style={{ margin: 0 }}>{projectId}</p>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <Link className="btn" href={`/projects/${projectId}/approvals`}>Approvals</Link>
          <Link className="btn" href={`/projects/${projectId}/watches`}>Watches</Link>
          <Link className="btn" href={`/projects/${projectId}/report`}>Report</Link>
        </div>
      </header>

      {notice && <p className="banner banner-ok small">{notice}</p>}

      <div className="grid grid-2">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Cuts</h2>
              <span className="mono xsmall dim">{cuts.length}</span>
            </div>

            {cuts.length === 0 ? (
              <p className="empty">Nothing uploaded yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>Label</th><th>Kind</th><th>Duration</th><th /></tr>
                </thead>
                <tbody>
                  {cuts.map((cut) => (
                    <tr key={cut.cut_id}>
                      <td>
                        {cut.label}
                        <div className="xsmall dim mono">{cut.cut_id}</div>
                      </td>
                      <td className="small">{cut.kind}</td>
                      <td className="mono small dim">
                        {cut.duration_frames ? `${Math.round(cut.duration_frames / (cut.fps || 24))}s` : "—"}
                      </td>
                      <td className="row" style={{ gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={start.pending}
                          onClick={async () => {
                            const record = await start.run(projectId, cut.cut_id, "full");
                            if (record) router.push(`/projects/${projectId}/pass/${record.pass_id}`);
                          }}
                        >
                          Investigate
                        </button>
                        {cuts.length > 1 && (
                          <button
                            type="button"
                            className="btn"
                            disabled={start.pending}
                            onClick={async () => {
                              const plan = await delta.run(cut.cut_id);
                              if (plan) {
                                setNotice(
                                  `Delta against the previous cut: ${plan.re_researched.length} to re-clear, ` +
                                    `${plan.inherited} inherited, ${plan.removed.length} withdrawn.`,
                                );
                              }
                              const record = await start.run(projectId, cut.cut_id, "delta");
                              if (record) router.push(`/projects/${projectId}/pass/${record.pass_id}`);
                            }}
                          >
                            Delta pass
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {(start.error || delta.error) && (
              <p className="banner banner-red small">{start.error ?? delta.error}</p>
            )}

            <form
              className="upload stack"
              style={{ marginTop: 16 }}
              onSubmit={async (event) => {
                event.preventDefault();
                const file = fileRef.current?.files?.[0];
                if (!file) return;
                const created = await upload.run(projectId, file, label, true);
                if (created) {
                  setCuts((current) => [...current, { ...created.cut, label, kind: created.kind, duration_frames: 0, fps: 24 } as Cut]);
                  setNotice(
                    `${created.items_extracted} clearable elements extracted from ${file.name}.`,
                  );
                  router.refresh();
                }
              }}
            >
              <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
                <div style={{ flex: "1 1 260px" }}>
                  <label className="label" htmlFor="file">Upload a script or a cut</label>
                  <input id="file" ref={fileRef} className="field" type="file"
                         accept=".pdf,.txt,.md,.fountain,.fdx,.mp4,.mov,.mkv,.m4v,.webm" required />
                </div>
                <div style={{ width: 130 }}>
                  <label className="label" htmlFor="label">Label</label>
                  <input id="label" className="field" value={label}
                         onChange={(event) => setLabel(event.target.value)} />
                </div>
                <button className="btn btn-primary" type="submit" disabled={upload.pending}>
                  {upload.pending ? "Breaking down…" : "Upload & break down"}
                </button>
              </div>
              {upload.error && <p className="banner banner-red small">{upload.error}</p>}
              <p className="xsmall dim" style={{ margin: 0 }}>
                Scripts anchor to scene and page; picture anchors to frames. Breakdown
                extracts what is there and says nothing about who owns it.
              </p>
            </form>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Passes</h2></div>
            {initial.passes.length === 0 ? (
              <p className="empty">No passes yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>Pass</th><th>Mode</th><th>Status</th><th>Cleared</th><th>Open</th><th>Challenges</th><th>Started</th></tr>
                </thead>
                <tbody>
                  {initial.passes.map((pass) => (
                    <tr key={pass.pass_id} className="clickable"
                        onClick={() => router.push(`/projects/${projectId}/pass/${pass.pass_id}`)}>
                      <td className="mono xsmall">{pass.pass_id.slice(5, 15)}</td>
                      <td className="small">{pass.mode}</td>
                      <td className="small">{pass.status}</td>
                      <td className="mono small">{pass.cleared_items}</td>
                      <td className="mono small">{pass.open_items}</td>
                      <td className="mono small">{pass.challenges}</td>
                      <td className="xsmall dim">{relativeTime(pass.started_ts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <div className="stack">
          <BudgetMeter meter={budget.data} />

          <section className="panel">
            <div className="panel-head"><h2>Ship the report</h2></div>
            <p className="small muted">
              Renders the E&amp;O pack from the ledger and arms a watch on every rights
              holder attached to a non-green item.
            </p>
            <div className="row wrap" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!latestCut || ship.pending}
                onClick={async () => {
                  if (!latestCut) return;
                  const result = await ship.run(projectId, latestCut.cut_id, true);
                  if (result) setNotice(`Report rendered; ${result.watches_armed} watches armed.`);
                }}
              >
                {ship.pending ? "Rendering…" : "Render & arm watches"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={arm.pending}
                onClick={async () => {
                  const result = await arm.run(projectId);
                  if (result) setNotice(`${result.count} watches armed.`);
                }}
              >
                Arm watches only
              </button>
            </div>
            {(ship.error || arm.error) && (
              <p className="banner banner-red small" style={{ marginTop: 8 }}>
                {ship.error ?? arm.error}
              </p>
            )}
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Ledger</h2></div>
            {chain.data ? (
              <div className="stack-tight">
                <p className="small" style={{ margin: 0 }}>
                  {chain.data.valid ? (
                    <span className="risk-text-green">chain verified</span>
                  ) : (
                    <span className="risk-text-red">chain FAILED: {chain.data.reason}</span>
                  )}{" "}
                  <span className="dim">· {chain.data.events} events</span>
                </p>
                {chain.data.head_hash && (
                  <p className="xsmall dim mono truncate" style={{ margin: 0 }}>
                    head {chain.data.head_hash.slice(0, 32)}
                  </p>
                )}
                <p className="xsmall dim" style={{ margin: 0 }}>
                  Append-only and hash-chained. Recomputed on every read of this panel;
                  tampering would show here and on the report&apos;s cover.
                </p>
              </div>
            ) : (
              <p className="empty">verifying…</p>
            )}
          </section>

          {budget.data && (
            <p className="xsmall dim">
              Spent {usd(budget.data.spent_usd ?? 0, 4)} of {usd(budget.data.cap_usd)} across{" "}
              {Object.values(budget.data.calls_by_tier ?? {}).reduce((a, b) => a + b, 0)} tool calls.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
