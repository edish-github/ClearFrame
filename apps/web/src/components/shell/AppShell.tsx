import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Banner } from "@/components/ui";
import { useAsync } from "@/hooks/useAsync";
import { api } from "@/api/client";
import { WorkspaceContext } from "@/hooks/useSlate";

/**
 * Loads the slate once for the rail, and hands the same data plus a refresh
 * down to every page so a decision on one screen updates the counts on another.
 */
export function AppShell() {
  const slate = useAsync(() => api.productions(), []);
  const productions = slate.data?.productions ?? [];
  const pending = productions.reduce((n, p) => n + p.review + p.outreach_pending, 0);

  return (
    <div className="shell">
      <Sidebar productions={productions} pendingApprovals={pending} />
      <main className="main">
        <div className="page">
          {slate.error && <div style={{ marginBottom: 22 }}><Banner>{slate.error}</Banner></div>}
          <WorkspaceContext.Provider value={{ productions, refreshSlate: slate.reload }}>
            <Outlet />
          </WorkspaceContext.Provider>
        </div>
      </main>
    </div>
  );
}
