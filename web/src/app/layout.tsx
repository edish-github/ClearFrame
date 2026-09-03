import type { Metadata } from "next";
import Link from "next/link";
import { actingRole, demoIdentityEnabled } from "@/lib/upstream";
import { RoleSwitcher } from "@/components/RoleSwitcher";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "ClearFrame — the clearance war room",
  description:
    "Autonomous clearance and chain-of-title investigation. Every frame cleared, every right traced.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const role = await actingRole();

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="rail">
            <Link href="/" className="wordmark">
              ClearFrame
              <span>every frame cleared</span>
            </Link>

            <RoleSwitcher current={role} enabled={demoIdentityEnabled} />

            <div className="nav">
              <Link href="/">Slate</Link>
            </div>

            <div style={{ marginTop: "auto" }} className="stack-tight">
              <p className="xsmall dim" style={{ margin: 0 }}>
                Research and drafting for review by production counsel. Not legal advice.
              </p>
            </div>
          </nav>

          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
