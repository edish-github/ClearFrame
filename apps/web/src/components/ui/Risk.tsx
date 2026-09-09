import type { Risk as RiskLevel } from "@clearframe/shared";

/** A filled square rather than an emoji, so it prints and reads at any size. */
export function Risk({ level }: { level: RiskLevel | null }) {
  return (
    <span className="risk">
      <i className={["risk__mark", level && `risk__mark--${level}`].filter(Boolean).join(" ")} />
      {level ? level.charAt(0) + level.slice(1).toLowerCase() : "Pending"}
    </span>
  );
}
