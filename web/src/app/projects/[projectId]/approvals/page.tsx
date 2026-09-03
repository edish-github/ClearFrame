import { ApprovalsConsole } from "@/components/ApprovalsConsole";
import { actingRole } from "@/lib/upstream";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ApprovalsConsole projectId={projectId} role={await actingRole()} />;
}
