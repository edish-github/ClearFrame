import { NavLink, useLocation } from "react-router-dom";
import { ChevronDown, Shield } from "lucide-react";
import { useState } from "react";
import type { ProductionSummary } from "@clearframe/shared";
import { StatusPill } from "@/components/ui";
import { productionTone } from "@/lib/status";
import { useAuth } from "@/hooks/useAuth";

/**
 * The rail is identical on every screen. Agents are infrastructure, so there is
 * no "agent management" here: the navigation is the work, not the machinery.
 */
export function Sidebar({ productions, pendingApprovals }: {
  productions: ProductionSummary[]; pendingApprovals: number;
}) {
  const { user, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  const active =
    productions.find((p) => p.status === "running" || p.status === "breakdown") ?? productions[0] ?? null;

  const links = [
    { to: "/productions", label: "Productions", count: productions.length },
    { to: "/approvals", label: "Approvals", count: pendingApprovals },
    { to: "/reports", label: "Reports", count: productions.filter((p) => p.total > 0).length },
  ];

  return (
    <aside className="rail">
      <div className="rail__brand">
        <b>ClearFrame</b>
        <span>Every frame cleared.</span>
      </div>

      <nav className="rail__group">
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            className={({ isActive }) =>
              ["nav", (isActive || (l.to === "/productions" && location.pathname.startsWith("/findings"))) && "is-active"]
                .filter(Boolean).join(" ")
            }
          >
            {l.label}
            {l.count > 0 && <span className="nav__count">{l.count}</span>}
          </NavLink>
        ))}
      </nav>

      <div className="rail__group" style={{ paddingTop: 16 }}>
        {active ? (
          <NavLink to={`/productions/${active.id}`} className="card card--pad" style={{ display: "block", textDecoration: "none" }}>
            <div style={{ fontSize: 13.5, fontWeight: 500, lineHeight: 1.3 }}>{active.title}</div>
            <div style={{ marginTop: 8 }}><StatusPill status={productionTone(active.status)} /></div>
            {active.cuts > 1 && <div className="note mono" style={{ marginTop: 8 }}>Cut {active.cuts}</div>}
          </NavLink>
        ) : (
          <div className="card card--pad"><div className="note">No production open.</div></div>
        )}
      </div>

      <div className="rail__foot">
        <button
          className="nav"
          style={{ padding: "6px 0" }}
          onClick={() => setMenuOpen((o) => !o)}
          aria-expanded={menuOpen}
        >
          <span style={{ color: "var(--ink)" }}>{user?.name}</span>
          <ChevronDown size={13} style={{ marginLeft: "auto" }} />
        </button>
        {menuOpen && (
          <div className="card" style={{ padding: 10, marginTop: 6 }}>
            <div className="note" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Shield size={11} /> Signed in as {user?.role}
            </div>
            <div className="note" style={{ marginTop: 6 }}>
              Only counsel can resolve findings, release outreach or sign a report.
            </div>
            <button className="nav" style={{ marginTop: 8 }} onClick={signOut}>Sign out</button>
          </div>
        )}
      </div>
    </aside>
  );
}
