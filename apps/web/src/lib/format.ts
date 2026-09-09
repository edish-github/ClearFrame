import { formatUsd } from "@clearframe/shared";

export const money = formatUsd;

export const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export const stamp = (iso: string): string =>
  new Date(iso).toLocaleString([], {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });

export const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Scene labels arrive as "42" or "Scene 42" depending on the screenplay. */
export const sceneLabel = (scene: string | null): string =>
  scene ? `Scene ${scene.replace(/^scene\s*/i, "")}` : "Unlocated";

export const percent = (n: number | null): string =>
  n === null ? "—" : `${Math.round(n * 100)}%`;
