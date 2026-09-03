import Link from "next/link";
import { fetchJson } from "@/lib/upstream";
import { ReportConsole } from "@/components/ReportConsole";

export const dynamic = "force-dynamic";

export default async function ReportPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const project = await fetchJson<{
    cuts: Array<{ cut_id: string; label: string }>;
  }>("orchestrator", `/projects/${projectId}`);

  return (
    <div className="stack">
      <header>
        <span className="kicker">
          <Link href={`/projects/${projectId}`}>← production</Link>
        </span>
        <h1>E&amp;O clearance report</h1>
        <p className="small muted" style={{ margin: 0 }}>
          Rendered from the ledger. Every claim is a link, and every link has a stored
          snapshot.
        </p>
      </header>
      <ReportConsole projectId={projectId} cuts={project?.cuts ?? []} />
    </div>
  );
}
