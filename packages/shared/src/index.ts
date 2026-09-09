/**
 * Vocabulary shared by the API and the web client.
 *
 * These are the words the product speaks. Keeping them in one place is why a
 * status can never mean one thing in the database and another on screen.
 */

export const ROLES = ["producer", "coordinator", "counsel", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export const CATEGORIES = ["MUSIC", "BRAND", "ARTWORK", "FOOTAGE", "LIKENESS", "OTHER"] as const;
export type Category = (typeof CATEGORIES)[number];

export const RISKS = ["LOW", "MEDIUM", "HIGH"] as const;
export type Risk = (typeof RISKS)[number];

export const FINDING_STATUSES = [
  "queued", "researching", "verifying", "tracing", "assessing",
  "review", "cleared", "approved", "licensed", "replaced", "rejected",
  "withdrawn", "held", "failed",
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const DECISION_ACTIONS = ["approved", "licensed", "replaced", "rejected"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export type ChainStatus = "clear" | "contested" | "unresolved";
export type Stance = "supports" | "conflicts" | "context";

/** Statuses where the pipeline still owns the finding. */
export const WORKING_STATUSES: readonly FindingStatus[] =
  ["queued", "researching", "verifying", "tracing", "assessing"];

/** Statuses where the finding has an outcome on record. */
export const RESOLVED_STATUSES: readonly FindingStatus[] =
  ["cleared", "approved", "licensed", "replaced", "rejected"];

export const isWorking = (s: FindingStatus): boolean => WORKING_STATUSES.includes(s);
export const isResolved = (s: FindingStatus): boolean => RESOLVED_STATUSES.includes(s);

export const CATEGORY_LABEL: Record<Category, string> = {
  MUSIC: "Music", BRAND: "Brand", ARTWORK: "Artwork",
  FOOTAGE: "Footage", LIKENESS: "Likeness", OTHER: "Other",
};

export const STATUS_LABEL: Record<FindingStatus, string> = {
  queued: "Queued", researching: "Researching", verifying: "Verifying",
  tracing: "Tracing title", assessing: "Assessing", review: "Needs review",
  cleared: "Cleared", approved: "Approved", licensed: "Licensing",
  replaced: "Replaced", rejected: "Removed", withdrawn: "Withdrawn from cut",
  held: "Held at cap", failed: "Failed",
};

export const DECISION_LABEL: Record<DecisionAction, string> = {
  approved: "Clear for use", licensed: "Pursue licence",
  replaced: "Replace element", rejected: "Remove from cut",
};

/** Money crosses the wire as integer micro-dollars. Never as a float. */
export const MICROS_PER_USD = 1_000_000;
export const toUsd = (micros: number): number => micros / MICROS_PER_USD;
export const formatUsd = (micros: number): string => `$${toUsd(micros).toFixed(2)}`;

export interface Principal { id: string; orgId: string; email: string; name: string; role: Role; }

export interface Chain { right: string; holder: string | null; status: ChainStatus; note: string; }

export interface ProductionSummary {
  id: string; title: string; format: string; status: string; error: string | null;
  budget_cap_micros: number; spent_micros: number;
  created_at: string; updated_at: string;
  cuts: number; script: string | null;
  total: number; resolved: number; review: number; withdrawn: number; open: number;
  outreach_pending: number; signed: boolean | null;
}

export interface Finding {
  id: string; item: string; category: Category;
  scene: string | null; page: string | null; context: string;
  status: FindingStatus; risk: Risk | null; confidence: number | null;
  summary: string | null; assessment: string | null; recommendation: string | null;
  verification: Verification | null;
  chains: Chain[]; pass_n: number; tier: string | null; error: string | null;
  evidence_count: number; conflicts: number; outreach_state: OutreachState | null;
}

export interface Verification {
  sufficient: boolean; reason: string; escalated: boolean; priorReason: string | null;
}

export interface Evidence {
  id: string; url: string; title: string | null; domain: string;
  stance: Stance; note: string; publish_date: string | null;
  retrieved_at: string; round: number; has_snapshot: boolean;
}

export interface ActivityRow {
  id: number; finding_id: string | null; stage: string; text: string;
  created_at: string; item?: string | null;
}

export type OutreachState = "drafting" | "draft" | "approved" | "failed";

export interface Outreach {
  addressed_to: string; subject: string; body: string; state: OutreachState;
  approved_name: string | null; approved_at: string | null; error: string | null;
}

export interface Decision {
  action: DecisionAction; rationale: string;
  actor_name: string; actor_role: Role; created_at: string;
}

export interface Cut {
  id: string; n: number; filename: string;
  stats: { extracted?: number; added?: number; changed?: number; withdrawn?: number; carried?: number };
  created_at: string;
}

export interface SpendRow { stage: string; cost_micros: number; calls: number; }

export interface LedgerEntry {
  seq: number; ts: string; actor: string;
  event: Record<string, unknown>; prev_hash: string; hash: string;
}

export interface Integrity { ok: boolean; length: number; head: string; brokenAt?: number; }

export interface Watch { state: string; last_checked_at: string | null; next_check_at: string; }

export interface ReportRow {
  id: string; production_id: string; title: string; generated_at: string;
  ledger_head: string; ledger_length: number;
  signed_name: string | null; signed_role: Role | null; signed_at: string | null;
  has_pdf: boolean;
}

export type StreamEventKind = "ready" | "activity" | "finding" | "production" | "outreach";

export interface StreamEvent {
  productionId: string; kind: StreamEventKind;
  data: Record<string, unknown>; at: string;
}

/** Share of a production's register that has reached an outcome or a human. */
export function progressPercent(p: Pick<ProductionSummary, "total" | "resolved" | "review">): number {
  return p.total ? Math.round(((p.resolved + p.review) / p.total) * 100) : 0;
}
