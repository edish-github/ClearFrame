import type { ItemType, RiskState, Role } from "@/lib/contracts";

export function timecode(frame: number, fps: number): string {
  const rate = Math.round(fps) || 24;
  const total = Math.max(0, Math.floor(frame));
  const frames = total % rate;
  const seconds = Math.floor(total / rate) % 60;
  const minutes = Math.floor(total / (rate * 60)) % 60;
  const hours = Math.floor(total / (rate * 3600));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

export const seconds = (frame: number, fps: number) => frame / (fps || 24);

export const usd = (value: number, digits = 2) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const riskClass = (risk?: string | null) => `risk-${(risk ?? "unknown").toLowerCase()}`;

export const riskTextClass = (risk?: string | null) =>
  `risk-text-${(risk ?? "unknown").toLowerCase()}`;

/** The vocabulary is Hollywood. Never "jobs", "workers", or "records". */
export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  music_cue: "music cue",
  lyric_quote: "lyric",
  brand: "brand",
  artwork: "artwork",
  likeness: "likeness",
  footage: "footage",
  location: "location",
  font: "font",
};

export const RISK_LABEL: Record<RiskState | "unknown", string> = {
  green: "clear",
  amber: "license or alter",
  red: "blocking",
  unknown: "not yet established",
};

export const ROLE_LABEL: Record<Role, string> = {
  producer: "Producer",
  coordinator: "Coordinator",
  counsel: "Counsel",
  reviewer: "Reviewer",
};

export const ROLE_NOTE: Record<Role, string> = {
  producer: "uploads cuts, starts passes, sets the budget",
  coordinator: "edits the register, annotates, prioritises",
  counsel: "approves red items and outreach, signs the report",
  reviewer: "read-only: the report and its citation trail",
};

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const delta = Math.max(0, Date.now() - then) / 1000;
  if (delta < 45) return "just now";
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

export function shortId(id?: string | null, keep = 8): string {
  if (!id) return "—";
  const body = id.includes("_") ? id.split("_").slice(1).join("_") : id;
  return body.slice(0, keep);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
