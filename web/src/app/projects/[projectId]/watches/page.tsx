import Link from "next/link";
import { WatchesConsole } from "@/components/WatchesConsole";

export const dynamic = "force-dynamic";

export default async function WatchesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <div className="stack">
      <header>
        <span className="kicker">
          <Link href={`/projects/${projectId}`}>← production</Link>
        </span>
        <h1>The night watch</h1>
        <p className="small muted" style={{ margin: 0 }}>
          A clearance report is a photograph of the world on the day it was signed.
          These monitors keep looking.
        </p>
      </header>
      <WatchesConsole projectId={projectId} />
    </div>
  );
}
