"use client";

import type {
  ApprovalQueue,
  BudgetMeter,
  ChainVerification,
  DeltaPreview,
  FeedEntry,
  Finding,
  HeatStrip,
  Item,
  Pass,
  ProvenanceGraph,
  Readiness,
  RiskAssessment,
  RiskBoard,
  Role,
  Challenge,
  OutreachDraft,
  Watch,
} from "@/lib/contracts";

/** Everything the browser calls goes through this app's own proxy. */
const CF = "/api/cf";
const LEDGER = "/api/ledger";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail =
      typeof payload.detail === "string" ? payload.detail : `request failed (${response.status})`;
    throw new ApiError(detail, response.status);
  }
  return payload as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// ------------------------------------------------------------------ reading

export const getReadiness = () => request<Readiness>(`${CF}/readyz`);

export const getProject = (projectId: string) =>
  request<{
    project: { project_id: string; title: string; budget_cap_usd: number; spent_usd: number };
    cuts: Array<{ cut_id: string; label: string; kind: string; duration_frames: number; fps: number }>;
    passes: Pass[];
    budget: BudgetMeter;
  }>(`${CF}/projects/${projectId}`);

export const getBudget = (projectId: string) =>
  request<BudgetMeter>(`${CF}/projects/${projectId}/budget`);

export const getHeatStrip = (cutId: string) => request<HeatStrip>(`${CF}/cuts/${cutId}/heatstrip`);

export const getCutItems = (cutId: string) =>
  request<{ count: number; items: Item[] }>(`${CF}/cuts/${cutId}/items`);

export const getPass = (passId: string) => request<Pass>(`${CF}/passes/${passId}`);

export const getFeed = (passId: string, limit = 200) =>
  request<{ feed: FeedEntry[] }>(`${CF}/passes/${passId}/feed?limit=${limit}`);

export const getRiskBoard = (projectId: string, cutId?: string) =>
  request<RiskBoard>(`${CF}/projects/${projectId}/riskboard${cutId ? `?cut_id=${cutId}` : ""}`);

export const getItem = (itemId: string) =>
  request<{
    item: Item & { tc_in: string; tc_out: string };
    findings: Finding[];
    challenges: Challenge[];
    assessment: RiskAssessment | null;
  }>(`${CF}/items/${itemId}`);

export const getProvenance = (itemId: string) =>
  request<ProvenanceGraph>(`${CF}/items/${itemId}/provenance`);

export const getApprovals = (projectId: string) =>
  request<ApprovalQueue>(`${CF}/projects/${projectId}/approvals`);

export const getOutreach = (projectId: string) =>
  request<{ drafts: OutreachDraft[]; note: string }>(`${CF}/projects/${projectId}/outreach`);

export const getWatches = (projectId: string) =>
  request<{ watches: Watch[] }>(`${CF}/projects/${projectId}/watches`);

export const verifyChain = (projectId: string) =>
  request<ChainVerification>(`${CF}/projects/${projectId}/ledger/verify`);

export const previewDelta = (cutId: string) =>
  request<DeltaPreview & { inherited: number }>(`${CF}/cuts/${cutId}/delta`);

// ------------------------------------------------------------------ writing

export const createProject = (title: string, budgetCapUsd: number) =>
  request<{ project_id: string }>(`${CF}/projects`, json({ title, budget_cap_usd: budgetCapUsd }));

export const startPass = (projectId: string, cutId: string, mode: "full" | "delta") =>
  request<Pass>(`${CF}/projects/${projectId}/passes`, json({ cut_id: cutId, mode }));

export const pausePass = (passId: string, reason: string) =>
  request<Pass>(`${CF}/passes/${passId}/pause`, json({ reason }));

export const raiseBudget = (projectId: string, capUsd: number) =>
  request<BudgetMeter>(`${CF}/projects/${projectId}/budget`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ budget_cap_usd: capUsd }),
  });

export const uploadCut = async (projectId: string, file: File, label: string, breakdown: boolean) => {
  const form = new FormData();
  form.append("file", file);
  const query = `label=${encodeURIComponent(label)}&run_breakdown=${breakdown}`;
  return request<{ cut: { cut_id: string }; items_extracted: number; kind: string; keyframes: number }>(
    `${CF}/projects/${projectId}/cuts?${query}`,
    { method: "POST", body: form },
  );
};

export const shipReport = (projectId: string, cutId: string, armWatches: boolean) =>
  request<{ html_url: string; pdf_url: string | null; watches_armed: number }>(
    `${CF}/projects/${projectId}/reports`,
    json({ cut_id: cutId, pdf: true, arm_watches: armWatches }),
  );

export const armWatches = (projectId: string) =>
  request<{ count: number }>(`${CF}/projects/${projectId}/watches/arm`, json({}));

export type DecisionAction =
  | "approve_mitigation"
  | "reject_mitigation"
  | "approve_outreach"
  | "reject_outreach"
  | "request_reinvestigation"
  | "sign_report"
  | "raise_budget"
  | "flag_for_watch";

export const decide = (
  projectId: string,
  body: { action: DecisionAction; rationale: string; item_id?: string; target_id?: string },
) => request<{ decision_id: string }>(`${LEDGER}/projects/${projectId}/decisions`, json(body));

export const bindRole = (projectId: string, subject: string, role: Role) =>
  request<{ ok: boolean }>(`${CF}/projects/${projectId}/roles`, json({ subject, role }));

export const setRole = (role: Role) => request<{ ok: boolean }>(`/api/session`, json({ role }));
