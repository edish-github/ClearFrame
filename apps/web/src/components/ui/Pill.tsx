import type { ReactNode } from "react";
import { STATUS_LABEL, type FindingStatus } from "@clearframe/shared";
import { toneFor, type DotTone } from "@/lib/status";

export function Pill({ tone = "", children }: { tone?: DotTone; children: ReactNode }) {
  return (
    <span className="pill">
      <i className={["dot", tone && `dot--${tone}`].filter(Boolean).join(" ")} />
      {children}
    </span>
  );
}

/** The single rendering of a finding's state, used in every list and header. */
export function StatusPill({ status }: { status: FindingStatus | string }) {
  return <Pill tone={toneFor(status)}>{STATUS_LABEL[status as FindingStatus] ?? status}</Pill>;
}
