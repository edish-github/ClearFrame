// Generated from packages/contracts/src/clearframe_contracts by
// scripts/export_ts_contracts.py. Do not edit by hand: change the Python
// contracts and regenerate, so the services and the war room cannot drift.

// ---------------------------------------------------------------- enums

export type Authority = "registry" | "court" | "corporate" | "trade" | "reference" | "other";
export type Capability = "upload_cut" | "start_pass" | "set_budget" | "edit_item" | "approve_red" | "approve_outreach" | "sign_report" | "read";
export type ChallengeGround = "stale" | "authority" | "independence" | "inconsistent" | "conflict_unresolved";
export type DecisionAction = "approve_mitigation" | "reject_mitigation" | "approve_outreach" | "reject_outreach" | "request_reinvestigation" | "sign_report" | "raise_budget" | "flag_for_watch";
export type EventType = "pass.started" | "item.queued" | "research.requested" | "research.completed" | "finding.added" | "challenge.filed" | "verify.passed" | "risk.scored" | "approval.required" | "decision.made" | "outreach.queued" | "watch.armed" | "monitor.fired" | "item.reopened" | "item.escalated" | "delta.computed" | "report.rendered" | "pass.completed" | "pass.paused";
export type HolderKind = "publisher" | "label" | "estate" | "trademark_owner" | "archive" | "artist" | "individual" | "unknown";
export type ItemStatus = "extracted" | "queued" | "recon" | "researching" | "contested" | "verified" | "risk_scored" | "pending_approval" | "resolved" | "monitored" | "reopened" | "withdrawn" | "escalated" | "failed";
export type ItemType = "music_cue" | "lyric_quote" | "brand" | "artwork" | "likeness" | "footage" | "location" | "font";
export type MitigationKind = "license" | "replace" | "alter" | "remove" | "fair_use_memo" | "no_action";
export type OutreachStatus = "drafted" | "pending_approval" | "approved_queued" | "rejected";
export type PassMode = "full" | "delta" | "reopen";
export type PassStatus = "planned" | "running" | "paused" | "completed" | "failed";
export type Prominence = "background" | "featured" | "hero";
export type RiskState = "green" | "amber" | "red" | "unknown";
export type Role = "producer" | "coordinator" | "counsel" | "reviewer";
export type VerdictAction = "verify_pass" | "file_challenge";
export type WatchChangeClass = "catalog_transfer" | "litigation" | "bankruptcy" | "rename_restructure" | "probate" | "representation_change" | "trademark_status" | "opposition" | "provenance_correction" | "takedown" | "counsel_flag";

// --------------------------------------------------------------- models

export interface BudgetState {
  cap_usd: number;
  spent_usd: number;
  by_tier: Record<string, number>;
  calls_by_tier: Record<string, number>;
}

export interface Challenge {
  challenge_id: string;
  finding_id: string;
  item_id: string;
  project_id: string;
  grounds: ChallengeGround;
  rationale: string;
  citations: Citation[];
  agent: string;
  ts: string;
}

export interface Citation {
  citation_id: string;
  url: string;
  title: string;
  excerpt: string;
  fetched_ts: string;
  published_date?: string | null;
  snapshot_uri?: string | null;
  authority: Authority;
  field?: string | null;
}

export interface Contact {
  name: string;
  role: string;
  email?: string | null;
  phone?: string | null;
  url?: string | null;
  source_url?: string | null;
}

export interface Cut {
  cut_id: string;
  project_id: string;
  label: string;
  gcs_uri: string;
  kind: string;
  cut_hash: string;
  duration_frames: number;
  fps: number;
  created_ts: string;
}

export interface Decision {
  decision_id: string;
  project_id: string;
  item_id?: string | null;
  actor: string;
  iam_role: Role;
  action: DecisionAction;
  rationale: string;
  target_id?: string | null;
  ts: string;
}

export interface Envelope {
  event_id: string;
  type: EventType;
  project_id: string;
  pass_id: string;
  item_id?: string | null;
  actor: string;
  payload: unknown;
  ts: string;
}

export interface Finding {
  finding_id: string;
  item_id: string;
  project_id: string;
  pass_id: string;
  agent: string;
  claim: unknown;
  confidence: number;
  citations: Citation[];
  interaction_id?: string | null;
  prev_interaction_id?: string | null;
  superseded_by?: string | null;
  tier: number;
  cost_usd: number;
  ts: string;
}

export interface Item {
  item_id: string;
  cut_id: string;
  project_id: string;
  type: ItemType;
  title: string;
  description: string;
  timecode: Timecode;
  prominence: Prominence;
  content_hash: string;
  status: ItemStatus;
  risk_state?: string | null;
  challenge_count: number;
  tier_reached: number;
  attrs: unknown;
  inherited_from?: string | null;
}

export interface Mitigation {
  mitigation_id: string;
  kind: MitigationKind;
  summary: string;
  cost_delta_usd: number;
  production_impact: string;
  recommended: boolean;
}

export interface OutreachDraft {
  outreach_id: string;
  project_id: string;
  item_id: string;
  holder_id?: string | null;
  to_name: string;
  to_email?: string | null;
  contact_source_url?: string | null;
  subject: string;
  body: string;
  status: OutreachStatus;
  approved_by?: string | null;
  ts: string;
}

export interface Pass {
  pass_id: string;
  project_id: string;
  cut_id: string;
  mode: PassMode;
  status: PassStatus;
  total_items: number;
  completed_items: number;
  open_items: number;
  cleared_items: number;
  challenges: number;
  budget: BudgetState;
  delta: unknown;
  started_ts: string;
  completed_ts?: string | null;
}

export interface Principal {
  subject: string;
  role: Role;
  project_ids: string[];
}

export interface Project {
  project_id: string;
  title: string;
  org_id: string;
  budget_cap_usd: number;
  spent_usd: number;
  created_ts: string;
}

export interface RightsHolder {
  holder_id: string;
  name: string;
  kind: HolderKind;
  parent_id?: string | null;
  aliases: string[];
  contacts: Contact[];
  watch_id?: string | null;
  source_urls: string[];
  first_seen: string;
  last_verified: string;
}

export interface RiskAssessment {
  assessment_id: string;
  item_id: string;
  project_id: string;
  pass_id: string;
  risk_state: RiskState;
  rationale: string;
  grounding_refs: string[];
  citations: Citation[];
  mitigations: Mitigation[];
  requires_approval: boolean;
  disclaimer: string;
  agent: string;
  ts: string;
}

export interface Timecode {
  frame_in: number;
  frame_out: number;
  fps: number;
  scene?: string | null;
  page?: number | null;
}

export interface Verdict {
  action: VerdictAction;
  finding_id: string;
  grounds?: ChallengeGround | null;
  rationale: string;
  citations: Citation[];
}

export interface Watch {
  watch_id: string;
  project_id: string;
  holder_id?: string | null;
  subject: string;
  change_classes: WatchChangeClass[];
  item_ids: string[];
  frequency: string;
  status: string;
  armed_ts: string;
  last_checked_ts?: string | null;
  reopen_count: number;
}

// ------------------------------------------------------ API projections

export interface HeatStripRegion {
  item_id: string;
  title: string;
  type: ItemType;
  start_pct: number;
  width_pct: number;
  risk: RiskState | "unknown";
  status: ItemStatus;
  scene?: string | null;
  tc_in: string;
  frame_in: number;
}

export interface HeatStrip {
  cut_id: string;
  duration_frames: number;
  fps: number;
  regions: HeatStripRegion[];
}

export interface FeedEntry {
  event_id?: string;
  kind: string;
  agent: string;
  colour: string;
  item_id?: string | null;
  message: string;
  detail: Record<string, unknown>;
  ts: string;
  pass_id: string;
}

export interface ProvenanceNode {
  id: string;
  label: string;
  kind: "item" | "chain" | "holder" | "litigation";
  [key: string]: unknown;
}

export interface ProvenanceEdge {
  from: string;
  to: string;
  kind: "has_chain" | "controlled_by" | "transferred" | "party_to" | "encumbers";
  sources: string[];
  [key: string]: unknown;
}

export interface ProvenanceGraph {
  item_id: string;
  title: string;
  type: ItemType;
  risk_state: RiskState | "unknown";
  chains: string[];
  nodes: ProvenanceNode[];
  edges: ProvenanceEdge[];
  open_questions: string[];
  resolved: Record<string, boolean>;
}

export interface BudgetMeter extends BudgetState {
  pct: number;
  warn: boolean;
  pricing_note: string;
}

export interface RiskBoard {
  columns: Record<"red" | "amber" | "green" | "unknown", Item[]>;
  counts: Record<string, number>;
}

export interface ApprovalQueue {
  items: Array<{
    item: Item;
    assessment: RiskAssessment | null;
    findings: Finding[];
  }>;
  outreach: OutreachDraft[];
  counts: { items: number; outreach: number };
}

export interface ChainVerification {
  valid: boolean;
  reason: string;
  events: number;
  checked: number;
  head_hash?: string;
}

export interface DeltaPreview {
  added: string[];
  removed: string[];
  inherited: number;
  re_researched: string[];
}

export interface Readiness {
  backend: "local" | "gcp";
  model_available: boolean;
  parallel_key_available: boolean;
  parallel_detail: string;
  webhook_url_configured: boolean;
  agent_builder_app: boolean;
  datastores: boolean;
}
