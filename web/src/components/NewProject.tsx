"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createProject } from "@/lib/api";
import { useAction } from "@/lib/live";

/** Start a production. The budget cap is a hard stop, so it is asked for up front. */
export function NewProject() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [cap, setCap] = useState(25);
  const action = useAction(createProject);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>New production</h2>
      </div>

      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          const created = await action.run(title.trim(), cap);
          if (created) router.push(`/projects/${created.project_id}`);
        }}
      >
        <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 280px" }}>
            <label className="label" htmlFor="title">Title</label>
            <input
              id="title"
              className="field"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="The Last Hour"
              required
            />
          </div>
          <div style={{ width: 160 }}>
            <label className="label" htmlFor="cap">Budget cap (USD)</label>
            <input
              id="cap"
              className="field"
              type="number"
              min={1}
              step={1}
              value={cap}
              onChange={(event) => setCap(Number(event.target.value))}
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={action.pending || !title.trim()}>
            {action.pending ? "Creating…" : "Create"}
          </button>
        </div>

        {action.error && <p className="banner banner-red small">{action.error}</p>}
        <p className="xsmall dim" style={{ margin: 0 }}>
          The 1st AD spends against this cap and stops at it. Raising it later is a
          producer decision, recorded in the ledger.
        </p>
      </form>
    </section>
  );
}
