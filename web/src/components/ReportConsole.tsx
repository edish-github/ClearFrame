"use client";

import { useState } from "react";
import { shipReport, verifyChain } from "@/lib/api";
import { useAction, useLive } from "@/lib/live";

type Cut = { cut_id: string; label: string };

export function ReportConsole({ projectId, cuts }: { projectId: string; cuts: Cut[] }) {
  const [cutId, setCutId] = useState(cuts[cuts.length - 1]?.cut_id ?? "");
  const [result, setResult] = useState<{ html_url: string; pdf_url: string | null } | null>(null);
  const ship = useAction(shipReport);
  const chain = useLive(() => verifyChain(projectId), 20000, [projectId]);

  const preview = cutId ? `/api/cf/../renderer/preview/${projectId}/${cutId}` : null;

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head"><h2>Render</h2></div>

        {cuts.length === 0 ? (
          <p className="empty">Upload a cut first.</p>
        ) : (
          <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
            <div style={{ minWidth: 220 }}>
              <label className="label" htmlFor="cut">Cut</label>
              <select id="cut" className="field" value={cutId} onChange={(e) => setCutId(e.target.value)}>
                {cuts.map((cut) => (
                  <option key={cut.cut_id} value={cut.cut_id}>{cut.label}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!cutId || ship.pending}
              onClick={async () => {
                const rendered = await ship.run(projectId, cutId, true);
                if (rendered) setResult(rendered);
              }}
            >
              {ship.pending ? "Rendering…" : "Render & ship"}
            </button>
          </div>
        )}

        {ship.error && <p className="banner banner-red small" style={{ marginTop: 12 }}>{ship.error}</p>}

        {result && (
          <div className="banner banner-ok small" style={{ marginTop: 12 }}>
            Rendered.{" "}
            <a href={result.html_url} target="_blank" rel="noreferrer noopener">open the HTML pack</a>
            {result.pdf_url && (
              <>
                {" · "}
                <a href={result.pdf_url} target="_blank" rel="noreferrer noopener">PDF</a>
              </>
            )}
          </div>
        )}

        <p className="disclaimer">
          Shipping the report arms a monitor on every rights holder attached to a
          non-green item. The report&apos;s cover prints whether the ledger&apos;s hash chain
          verifies — today it{" "}
          {chain.data ? (chain.data.valid ? "does" : `does NOT: ${chain.data.reason}`) : "…"}.
        </p>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Sections</h2></div>
        <ol className="small muted" style={{ margin: 0, paddingLeft: 20 }}>
          <li>Production summary — cut identifier and hash, pass history, sign-off principals</li>
          <li>Item register — every item with type, timecode, risk state and resolution</li>
          <li>Findings &amp; chain of title — per non-green item, with the Verifier&apos;s history</li>
          <li>Risk assessment &amp; mitigations — scoring rationale, cost deltas, counsel decisions</li>
          <li>Outreach log — inquiries drafted, approved and queued</li>
          <li>Watch schedule — armed monitors, triggers, and the reopen protocol</li>
          <li>Delta annex — what changed since the prior report and what was re-verified</li>
          <li>Citation appendix — every source, fetch time, authority note and snapshot</li>
        </ol>
        {preview && (
          <p className="xsmall dim" style={{ marginTop: 12 }}>
            A live preview is served by the renderer at{" "}
            <code>/preview/{projectId}/{cutId}</code>.
          </p>
        )}
      </section>
    </div>
  );
}
