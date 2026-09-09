import { isResolved, isWorking, type FindingStatus } from "@clearframe/shared";

export type DotTone = "" | "live" | "green" | "amber" | "red";

/** One place that decides what colour a status is, so the rail and the table agree. */
export function toneFor(status: FindingStatus | string): DotTone {
  const s = status as FindingStatus;
  if (isWorking(s)) return "live";
  if (s === "review") return "amber";
  if (isResolved(s)) return "green";
  if (s === "failed" || s === "held") return "red";
  return "";
}

/** Production status collapses onto the same vocabulary the findings use. */
export function productionTone(status: string): FindingStatus {
  if (status === "running" || status === "breakdown") return "researching";
  if (status === "review") return "review";
  if (status === "failed") return "failed";
  return "cleared";
}
