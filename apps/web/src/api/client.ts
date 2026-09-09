/**
 * Transport for the ClearFrame API.
 *
 * Types live in @clearframe/shared so the server and the client cannot drift.
 * This file owns nothing but fetch, auth headers, error shape and the stream.
 */
import type {
  ActivityRow, Cut, Decision, DecisionAction, Evidence, Finding, Integrity,
  LedgerEntry, Outreach, Principal, ProductionSummary, ReportRow, Role,
  SpendRow, StreamEvent, Watch,
} from "@clearframe/shared";

/** Thrown for any non-2xx response, carrying the server's own wording. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ProductionDetail {
  production: ProductionSummary;
  findings: Finding[];
  cuts: Cut[];
  spendBy: SpendRow[];
  activity: ActivityRow[];
}

export interface FindingDetail {
  finding: Finding & { production_id: string; production_title: string };
  evidence: Evidence[];
  activity: ActivityRow[];
  decision: Decision | null;
  outreach: Outreach | null;
  watch: Watch | null;
}

export interface ApprovalQueue {
  decisions: (Finding & { production_id: string; production_title: string })[];
  outreach: {
    id: string; item: string; category: string;
    production_id: string; production_title: string;
    addressed_to: string; subject: string; body: string;
    state: string; created_at: string;
  }[];
}

export class ClearFrame {
  private token: string | null = null;

  constructor(private baseUrl: string = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  setToken(token: string | null): void { this.token = token; }
  getToken(): string | null { return this.token; }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, init);
    if (!res.ok) {
      let message = `Request failed (${res.status}).`;
      let code: string | undefined;
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
        code = body?.code;
      } catch { /* non-JSON error body */ }
      throw new ApiError(res.status, message, code);
    }
    if (res.status === 204) return undefined as T;
    const type = res.headers.get("content-type") ?? "";
    return (type.includes("application/json") ? await res.json() : await res.blob()) as T;
  }

  private get<T>(path: string) { return this.request<T>(path, { headers: this.headers(false) }); }
  private post<T>(path: string, body?: unknown) {
    return this.request<T>(path, {
      method: "POST", headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  private patch<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: "PATCH", headers: this.headers(), body: JSON.stringify(body) });
  }
  private upload<T>(path: string, form: FormData) {
    return this.request<T>(path, { method: "POST", headers: this.headers(false), body: form });
  }

  // ------------------------------------------------------------ identity

  async register(input: {
    orgName: string; name: string; email: string; password: string; role?: Role;
  }): Promise<{ token: string; user: Principal }> {
    const out = await this.post<{ token: string; user: Principal }>("/api/auth/register", input);
    this.token = out.token;
    return out;
  }

  async login(email: string, password: string): Promise<{ token: string; user: Principal }> {
    const out = await this.post<{ token: string; user: Principal }>("/api/auth/login", { email, password });
    this.token = out.token;
    return out;
  }

  logout(): void { this.token = null; }

  me() { return this.get<{ user: Principal }>("/api/auth/me"); }

  /** Roles are assigned here and enforced server side. The UI never decides. */
  invite(input: { name: string; email: string; password: string; role: Role }) {
    return this.post<{ user: Principal }>("/api/auth/invite", input);
  }

  // --------------------------------------------------------- productions

  productions() { return this.get<{ productions: ProductionSummary[] }>("/api/productions"); }

  production(id: string) {
    return this.get<ProductionDetail>(`/api/productions/${id}`);
  }

  /** Starts a pass. The breakdown runs on the worker, so this returns at once. */
  createProduction(input: {
    title: string; format: string; budgetUsd: number; file?: File; scriptText?: string;
  }) {
    const form = new FormData();
    form.set("title", input.title);
    form.set("format", input.format);
    form.set("budgetUsd", String(input.budgetUsd));
    if (input.file) form.set("file", input.file);
    else if (input.scriptText) form.set("scriptText", input.scriptText);
    return this.upload<{ production: ProductionSummary; cut: { id: string; n: number } }>("/api/productions", form);
  }

  /** Delta re-clearance. Only new and changed items are researched again. */
  addCut(productionId: string, file: File) {
    const form = new FormData();
    form.set("file", file);
    return this.upload<{ cut: { id: string; n: number; filename: string } }>(
      `/api/productions/${productionId}/cuts`, form
    );
  }

  resume(productionId: string) {
    return this.post<{ queued: number }>(`/api/productions/${productionId}/resume`);
  }

  raiseBudget(productionId: string, budgetUsd: number) {
    return this.post<{ budgetCapMicros: number }>(`/api/productions/${productionId}/budget`, { budgetUsd });
  }

  ledger(productionId: string) {
    return this.get<{ entries: LedgerEntry[] }>(`/api/productions/${productionId}/ledger`);
  }

  integrity(productionId: string) {
    return this.get<Integrity>(`/api/productions/${productionId}/integrity`);
  }

  // ------------------------------------------------------------ findings

  finding(id: string) {
    return this.get<FindingDetail>(`/api/findings/${id}`);
  }

  /** The excerpt captured at retrieval time, so evidence outlives the page. */
  snapshotUrl(evidenceId: string): string {
    return `${this.baseUrl}/api/evidence/${evidenceId}/snapshot`;
  }

  /** Counsel only. Choosing "licensed" also queues the licence inquiry draft. */
  decide(findingId: string, action: DecisionAction, rationale = "") {
    return this.post<{ status: DecisionAction }>(`/api/findings/${findingId}/decision`, { action, rationale });
  }

  approveOutreach(findingId: string) {
    return this.post<{ state: "approved" }>(`/api/findings/${findingId}/outreach/approve`);
  }

  recheck(findingId: string) {
    return this.post<{ queued: boolean }>(`/api/findings/${findingId}/recheck`);
  }

  editFinding(findingId: string, patch: { scene?: string; page?: string | null; context?: string }) {
    return this.patch<{ ok: boolean }>(`/api/findings/${findingId}`, patch);
  }

  // ----------------------------------------------------------- approvals

  approvals() { return this.get<ApprovalQueue>("/api/approvals"); }

  // ------------------------------------------------------------- reports

  reports() { return this.get<{ reports: ReportRow[] }>("/api/reports"); }

  generateReport(productionId: string) {
    return this.post<{ report: { id: string }; totals: Record<string, number>; integrity: Integrity }>(
      `/api/productions/${productionId}/reports`
    );
  }

  /** Counsel only. Pins the ledger head at the moment of signature. */
  signReport(reportId: string) {
    return this.post<{ signed: true; head: string; openFindings: number }>(`/api/reports/${reportId}/sign`);
  }

  async downloadReport(reportId: string): Promise<Blob> {
    return this.request<Blob>(`/api/reports/${reportId}/pdf`, { headers: this.headers(false) });
  }

  // --------------------------------------------------------- live stream

  /**
   * Subscribes to a production's activity. EventSource cannot send an
   * Authorization header, so the token rides as a query parameter on this one
   * endpoint. Returns an unsubscribe function.
   */
  stream(productionId: string, onEvent: (e: StreamEvent) => void, onError?: (e: Event) => void): () => void {
    const url = `${this.baseUrl}/api/productions/${productionId}/stream?token=${encodeURIComponent(this.token ?? "")}`;
    const source = new EventSource(url);
    const forward = (kind: StreamEvent["kind"]) => (ev: MessageEvent<string>) => {
      try { onEvent({ ...(JSON.parse(ev.data) as StreamEvent), kind }); }
      catch { /* ignore malformed frame */ }
    };
    for (const kind of ["ready", "activity", "finding", "production", "outreach"] as const) {
      source.addEventListener(kind, forward(kind));
    }
    if (onError) source.onerror = onError;
    return () => source.close();
  }

  // ------------------------------------------------------------- helpers

}

/** One instance for the app. The base URL uses VITE_API_URL when set, or same-origin when blank. */
export const api = new ClearFrame((import.meta as any).env?.VITE_API_URL ?? "");

