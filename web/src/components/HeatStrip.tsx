"use client";

import { useMemo } from "react";
import type { HeatStrip as Strip, HeatStripRegion } from "@/lib/contracts";
import { riskClass, timecode } from "@/lib/format";

type Props = {
  strip: Strip | null;
  playheadPct?: number;
  selectedItemId?: string | null;
  onScrub: (region: HeatStripRegion) => void;
};

/**
 * The signature component: clearance risk rendered under the film's real frames.
 *
 * A red region is not a table row. Clicking it scrubs the picture to the exact
 * frame where the poster hangs, the song swells, or the logo enters shot.
 *
 * Regions arrive from the API already expressed as percentages, with a hairline
 * floor applied so a two-frame item is still clickable — the arithmetic lives
 * server-side so the strip and the report can never disagree.
 */
export function HeatStrip({ strip, playheadPct = 0, selectedItemId, onScrub }: Props) {
  const fps = strip?.fps ?? 24;
  const regions = useMemo(() => strip?.regions ?? [], [strip]);

  const counts = useMemo(() => {
    const tally = { red: 0, amber: 0, green: 0, unknown: 0 } as Record<string, number>;
    for (const region of regions) tally[region.risk] = (tally[region.risk] ?? 0) + 1;
    return tally;
  }, [regions]);

  return (
    <div className="heatstrip-wrap">
      <div
        className="heatstrip"
        role="group"
        aria-label="Clearance status by timecode"
      >
        {regions.map((region) => (
          <button
            key={region.item_id}
            type="button"
            className={`heatstrip__region ${riskClass(region.risk)}${
              selectedItemId === region.item_id ? " is-selected" : ""
            }`}
            style={{ left: `${region.start_pct}%`, width: `${region.width_pct}%` }}
            onClick={() => onScrub(region)}
            aria-label={`${region.title} — ${region.risk} — ${region.tc_in}`}
            title={`${region.title} · ${region.risk} · ${region.tc_in}`}
          />
        ))}
        <div className="heatstrip__playhead" style={{ left: `${playheadPct}%` }} />
      </div>

      <div className="heatstrip__legend">
        <span className="mono xsmall dim">{timecode(0, fps)}</span>
        <span className="row wrap xsmall dim" style={{ gap: 12 }}>
          <LegendKey risk="red" count={counts.red} />
          <LegendKey risk="amber" count={counts.amber} />
          <LegendKey risk="green" count={counts.green} />
          <LegendKey risk="unknown" count={counts.unknown} />
        </span>
        <span className="mono xsmall dim">
          {timecode(strip?.duration_frames ?? 0, fps)}
        </span>
      </div>
    </div>
  );
}

function LegendKey({ risk, count }: { risk: string; count: number }) {
  return (
    <span className="row" style={{ gap: 5 }}>
      <span className={`risk-dot ${riskClass(risk)}`} />
      {count} {risk}
    </span>
  );
}
