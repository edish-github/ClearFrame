"use client";

import type { Watch } from "@/lib/contracts";
import { relativeTime } from "@/lib/format";

/** Armed monitors: what is being watched, when it last looked, what it reopened. */
export function WatchPanel({ watches }: { watches: Watch[] }) {
  if (watches.length === 0) {
    return (
      <p className="empty">
        No watches armed. Watches arm when the report ships — a cleared item becomes
        an armed monitor, not a closed row.
      </p>
    );
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Subject</th>
          <th>Watching for</th>
          <th>Every</th>
          <th>Last checked</th>
          <th>Reopens</th>
        </tr>
      </thead>
      <tbody>
        {watches.map((watch) => (
          <tr key={watch.watch_id}>
            <td>
              <strong className="small">{watch.subject}</strong>
              <div className="xsmall dim mono">{watch.watch_id}</div>
            </td>
            <td className="small muted">
              {(watch.change_classes ?? []).map((c) => c.replace(/_/g, " ")).join(", ")}
            </td>
            <td className="mono xsmall">{watch.frequency}</td>
            <td className="xsmall dim">
              {watch.last_checked_ts ? relativeTime(watch.last_checked_ts) : "not yet"}
            </td>
            <td className="mono xsmall">{watch.reopen_count ?? 0}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
