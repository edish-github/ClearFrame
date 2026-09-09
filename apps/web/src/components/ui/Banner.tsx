import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

/** Errors state what happened. They do not apologise and they are never vague. */
export function Banner({ tone = "error", children }: { tone?: "error" | "calm"; children: ReactNode }) {
  return (
    <div className={["banner", tone === "calm" && "banner--calm"].filter(Boolean).join(" ")} role={tone === "error" ? "alert" : undefined}>
      {tone === "error" && <AlertTriangle size={16} />}
      <span>{children}</span>
    </div>
  );
}
