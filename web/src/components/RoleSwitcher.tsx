"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Role } from "@/lib/contracts";
import { setRole } from "@/lib/api";
import { ROLE_LABEL, ROLE_NOTE } from "@/lib/format";

const ROLES: Role[] = ["producer", "coordinator", "counsel", "reviewer"];

/**
 * Who you are acting as.
 *
 * Present only in demo mode, so a judge can walk the counsel gate without four
 * accounts. It changes which subject the server proxies as — it grants nothing:
 * authority still comes from that subject's role binding, checked in the ledger.
 */
export function RoleSwitcher({ current, enabled }: { current: Role; enabled: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  if (!enabled) {
    return (
      <div className="stack-tight">
        <span className="kicker">signed in as</span>
        <span className="small">{ROLE_LABEL[current]}</span>
      </div>
    );
  }

  return (
    <div className="stack-tight">
      <span className="kicker">acting as</span>
      <select
        className="field"
        value={current}
        disabled={pending}
        onChange={async (event) => {
          setPending(true);
          await setRole(event.target.value as Role);
          setPending(false);
          router.refresh();
        }}
      >
        {ROLES.map((role) => (
          <option key={role} value={role}>
            {ROLE_LABEL[role]}
          </option>
        ))}
      </select>
      <span className="xsmall dim">{ROLE_NOTE[current]}</span>
    </div>
  );
}
