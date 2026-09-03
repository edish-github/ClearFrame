"use client";

import { armWatches, getWatches } from "@/lib/api";
import { useAction, useLive } from "@/lib/live";
import { WatchPanel } from "@/components/WatchPanel";

export function WatchesConsole({ projectId }: { projectId: string }) {
  const watches = useLive(() => getWatches(projectId), 8000, [projectId]);
  const arm = useAction(armWatches);

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head">
          <h2>Armed monitors</h2>
          <button
            type="button"
            className="btn"
            disabled={arm.pending}
            onClick={async () => {
              await arm.run(projectId);
              watches.refresh();
            }}
          >
            {arm.pending ? "Arming…" : "Arm watches now"}
          </button>
        </div>

        {watches.error && <p className="banner banner-red small">{watches.error}</p>}
        <WatchPanel watches={watches.data?.watches ?? []} />

        <p className="disclaimer">
          When a watch fires, the Sentinel reopens the affected items and alerts counsel.
          It never marks an item resolved — reopening and alerting is the whole of its
          authority.
        </p>
      </section>
    </div>
  );
}
