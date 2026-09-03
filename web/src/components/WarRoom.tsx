"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { HeatStripRegion } from "@/lib/contracts";
import { getBudget, getFeed, getHeatStrip, getPass, getRiskBoard, pausePass } from "@/lib/api";
import { useAction, useLive } from "@/lib/live";
import { BudgetMeter } from "@/components/BudgetMeter";
import { CrewFeed } from "@/components/CrewFeed";
import { CutPlayer } from "@/components/CutPlayer";
import { HeatStrip } from "@/components/HeatStrip";
import { ItemDrawer } from "@/components/ItemDrawer";
import { RiskBoard } from "@/components/RiskBoard";

/**
 * The war room.
 *
 * The film is the protagonist: the cut plays as the hero surface with the
 * clearance heat strip under its real frames. Clicking a red region scrubs the
 * picture to the offending frame and opens what the crew found there. Findings
 * annotate the movie, not a document.
 */
export function WarRoom({ projectId, passId }: { projectId: string; passId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [scrubTo, setScrubTo] = useState<HeatStripRegion | null>(null);
  const [playhead, setPlayhead] = useState(0);

  const pass = useLive(() => getPass(passId), 2000, [passId]);
  const cutId = pass.data?.cut_id;

  const strip = useLive(
    () => (cutId ? getHeatStrip(cutId) : Promise.resolve(null)),
    2500,
    [cutId],
  );
  const feed = useLive(() => getFeed(passId), 1500, [passId]);
  const board = useLive(
    () => getRiskBoard(projectId, cutId),
    3000,
    [projectId, cutId],
  );
  const budget = useLive(() => getBudget(projectId), 3000, [projectId]);
  const pause = useAction(pausePass);

  const scrub = useCallback((region: HeatStripRegion) => {
    setScrubTo(region);
    setSelected(region.item_id);
  }, []);

  const running = pass.data?.status === "running";

  return (
    <div className="stack">
      <header className="row-between wrap">
        <div>
          <span className="kicker">
            <Link href={`/projects/${projectId}`}>← production</Link>
          </span>
          <h1 style={{ marginBottom: 2 }}>
            Pass {pass.data?.mode ?? ""}{" "}
            <span className="dim mono" style={{ fontSize: "var(--fs-sm)" }}>
              {pass.data?.status ?? "…"}
            </span>
          </h1>
          <p className="small dim" style={{ margin: 0 }}>
            {pass.data
              ? `${pass.data.open_items} open · ${pass.data.cleared_items} cleared · ${pass.data.challenges} challenges filed`
              : "loading…"}
          </p>
        </div>

        <div className="row wrap" style={{ gap: 8 }}>
          <Link className="btn" href={`/projects/${projectId}/approvals`}>Approvals</Link>
          <button
            type="button"
            className="btn"
            disabled={!running || pause.pending}
            onClick={() => pause.run(passId, "paused from the war room")}
          >
            {pause.pending ? "Draining…" : "Pause pass"}
          </button>
        </div>
      </header>

      {pass.data?.status === "paused" && (
        <p className="banner small">
          Paused. The spine drained rather than dropping work, so state is durable and
          resuming is exact.
        </p>
      )}

      <div className="grid grid-2">
        <div className="stack">
          <CutPlayer
            src={null}
            fps={strip.data?.fps ?? 24}
            durationFrames={strip.data?.duration_frames ?? 0}
            scrubTo={scrubTo}
            onProgress={setPlayhead}
          />

          <HeatStrip
            strip={strip.data}
            playheadPct={playhead}
            selectedItemId={selected}
            onScrub={scrub}
          />

          <section className="panel">
            <div className="panel-head">
              <h2>Risk board</h2>
              <span className="xsmall dim">green collapsed</span>
            </div>
            <RiskBoard board={board.data} selectedItemId={selected} onSelect={setSelected} />
          </section>
        </div>

        <div className="stack">
          <BudgetMeter meter={budget.data} />

          <section className="panel">
            <div className="panel-head">
              <h2>Crew feed</h2>
              <span className="xsmall dim">
                {feed.data?.feed?.length ?? 0} events · challenges thread under their finding
              </span>
            </div>
            {feed.error && <p className="banner banner-red small">{feed.error}</p>}
            <CrewFeed feed={feed.data?.feed ?? []} onSelectItem={setSelected} />
          </section>
        </div>
      </div>

      {selected && <ItemDrawer itemId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
