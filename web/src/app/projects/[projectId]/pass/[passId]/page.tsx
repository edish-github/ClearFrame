import { WarRoom } from "@/components/WarRoom";

export const dynamic = "force-dynamic";

export default async function PassPage({
  params,
}: {
  params: Promise<{ projectId: string; passId: string }>;
}) {
  const { projectId, passId } = await params;
  return <WarRoom projectId={projectId} passId={passId} />;
}
