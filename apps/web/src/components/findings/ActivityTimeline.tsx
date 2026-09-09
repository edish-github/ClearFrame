import type { ActivityRow } from "@clearframe/shared";
import { clock } from "@/lib/format";

/** Real events with real timestamps. Nothing here is a spinner in disguise. */
export function ActivityTimeline({ rows, live, showItem }: {
  rows: ActivityRow[]; live?: boolean; showItem?: boolean;
}) {
  if (!rows.length) return <div className="note">Nothing has happened yet.</div>;
  return (
    <div className="timeline">
      {rows.map((e, i) => (
        <div className={["timeline__row", i === 0 && live && "is-current"].filter(Boolean).join(" ")} key={e.id}>
          <div className="row" style={{ gap: 8, fontSize: 12.5 }}>
            <span className="mono" style={{ color: "var(--ink-3)" }}>{clock(e.created_at)}</span>
            <span style={{ fontWeight: 500 }}>{e.stage}</span>
          </div>
          <div className="note" style={{ marginTop: 2 }}>
            {showItem && e.item ? `${e.item} — ` : ""}{e.text}
          </div>
        </div>
      ))}
    </div>
  );
}
