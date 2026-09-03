import Link from "next/link";
import { fetchJson } from "@/lib/upstream";
import { NewProject } from "@/components/NewProject";
import type { Readiness } from "@/lib/contracts";

type ProjectRow = {
  project_id: string;
  title: string;
  budget_cap_usd: number;
  spent_usd: number;
};

export const dynamic = "force-dynamic";

/** The slate: every production this instance is clearing. */
export default async function SlatePage() {
  const projects = await fetchJson<{ projects: ProjectRow[] }>("orchestrator", "/projects");
  const readiness = await fetchJson<Readiness>("orchestrator", "/readyz");

  return (
    <div className="stack">
      <header>
        <span className="kicker">the slate</span>
        <h1>Productions in clearance</h1>
      </header>

      {readiness && <ReadinessBanner readiness={readiness} />}

      {!projects && (
        <p className="banner banner-red small">
          The orchestrator is unreachable. Start it with <code>make dev</code>, or set{" "}
          <code>URL_ORCHESTRATOR</code> for this app.
        </p>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Projects</h2>
          <span className="mono xsmall dim">{projects?.projects?.length ?? 0}</span>
        </div>

        {projects?.projects?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Production</th>
                <th>Spend</th>
                <th>Cap</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {projects.projects.map((project) => (
                <tr key={project.project_id}>
                  <td>
                    <Link href={`/projects/${project.project_id}`}>{project.title}</Link>
                    <div className="xsmall dim mono">{project.project_id}</div>
                  </td>
                  <td className="mono small">${project.spent_usd.toFixed(4)}</td>
                  <td className="mono small dim">${project.budget_cap_usd.toFixed(2)}</td>
                  <td>
                    <Link className="small" href={`/projects/${project.project_id}`}>
                      open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty">No productions yet. Start one below.</p>
        )}
      </section>

      <NewProject />
    </div>
  );
}

function ReadinessBanner({ readiness }: { readiness: Readiness }) {
  const missing: string[] = [];
  if (!readiness.model_available) missing.push("Gemini (set VERTEX_PROJECT and install the gemini extra)");
  if (!readiness.parallel_key_available) missing.push("the Parallel API key");
  if (!readiness.webhook_url_configured) missing.push("URL_WEBHOOK — watches cannot be armed without it");

  if (missing.length === 0) {
    return (
      <p className="banner banner-ok small">
        Ready — reasoning on Gemini, research through Parallel, watches can arm.{" "}
        <span className="dim">backend: {readiness.backend}</span>
      </p>
    );
  }

  return (
    <div className="banner small">
      <strong>Not fully wired yet.</strong> Missing: {missing.join("; ")}.
      <div className="xsmall dim" style={{ marginTop: 4 }}>
        Everything else works; a pass will refuse rather than pretend.
      </div>
    </div>
  );
}
