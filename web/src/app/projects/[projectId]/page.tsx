import Link from "next/link";
import { fetchJson } from "@/lib/upstream";
import { ProjectConsole } from "@/components/ProjectConsole";

export const dynamic = "force-dynamic";

type ProjectPayload = {
  project: { project_id: string; title: string; budget_cap_usd: number; spent_usd: number };
  cuts: Array<{ cut_id: string; label: string; kind: string; duration_frames: number; fps: number }>;
  passes: Array<{
    pass_id: string;
    mode: string;
    status: string;
    total_items: number;
    open_items: number;
    cleared_items: number;
    challenges: number;
    started_ts: string;
  }>;
  budget: { cap_usd: number; spent_usd: number; by_tier: Record<string, number> };
};

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const data = await fetchJson<ProjectPayload>("orchestrator", `/projects/${projectId}`);

  if (!data) {
    return (
      <div className="stack">
        <p className="banner banner-red small">
          Project not found, or the orchestrator is unreachable.
        </p>
        <Link href="/">← back to the slate</Link>
      </div>
    );
  }

  return <ProjectConsole projectId={projectId} initial={data} />;
}
