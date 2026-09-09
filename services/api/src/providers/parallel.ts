import { Parallel, APIError } from "parallel-web";
import { env } from "../core/env.js";
import { ProviderError } from "./gemini.js";

/**
 * Parallel is the retrieval layer via the official `parallel-web` TypeScript SDK.
 * Every URL that ever reaches the database comes back from one of these calls,
 * enforcing real citations without model hallucination.
 *
 * Surfaces used:
 *   parallel.search              recon on every item          (tier 0/1)
 *   parallel.taskRun.create/result deep research              (tier 2/3)
 *   parallel.monitor.create      ambient monitoring
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getParallelClient(): Parallel {
  return new Parallel({
    apiKey: env.parallel.apiKey,
    baseURL: env.parallel.baseUrl,
  });
}

// ------------------------------------------------------------------ search

export interface SearchResult {
  url: string;
  title: string | null;
  publishDate: string | null;
  excerpts: string[];
}

export interface SearchOutcome {
  searchId: string;
  sessionId: string;
  results: SearchResult[];
  costMicros: number;
  units: number;
}

export interface SearchInput {
  objective: string;
  queries: string[];
  mode?: "turbo" | "fast" | "basic" | "advanced";
  maxResults?: number;
  maxCharsPerResult?: number;
  sessionId?: string;
}

export async function search(input: SearchInput): Promise<SearchOutcome> {
  const client = getParallelClient();
  const body: Record<string, unknown> = {
    objective: input.objective.slice(0, 5000),
    search_queries: input.queries.slice(0, 5),
    mode: input.mode ?? "advanced",
    client_model: "gemini",
  };
  if (input.sessionId) body.session_id = input.sessionId;
  body.advanced_settings = {
    max_results: input.maxResults ?? 8,
    excerpt_settings: { max_chars_per_result: input.maxCharsPerResult ?? 1800 },
  };

  let lastError: ProviderError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(700 * 2 ** attempt + Math.random() * 300);

    try {
      const res = (await client.search(body as any)) as {
        search_id?: string;
        session_id?: string;
        results?: { url: string; title?: string | null; publish_date?: string | null; excerpts?: string[] }[];
        usage?: { name?: string; count?: number }[];
      };

      const searchId = res.search_id ?? "";
      const sessionId = res.session_id ?? "";
      const results = (res.results ?? []).map((r) => ({
        url: r.url,
        title: r.title ?? null,
        publishDate: r.publish_date ?? null,
        excerpts: r.excerpts ?? [],
      }));
      const units = (res.usage ?? []).reduce((n, u) => n + (u.count ?? 0), 0) || 1;

      return {
        searchId,
        sessionId,
        results,
        units,
        costMicros: Math.round(env.parallel.searchUsd * units * 1_000_000),
      };
    } catch (err) {
      const status = err instanceof APIError ? err.status : (err as any)?.status;
      const retryable = status === 429 || (status && status >= 500) || (err as Error).message.includes("failed");
      lastError = new ProviderError(`Parallel search failed: ${(err as Error).message}`, status, retryable);
      if (!retryable) throw lastError;
    }
  }

  throw lastError ?? new ProviderError("Parallel search call failed");
}

// ------------------------------------------------------------------- tasks

export type Processor = "lite" | "base" | "core" | "pro" | "ultra";

export interface TaskOutcome<T> {
  runId: string;
  interactionId?: string;
  output: T | null;
  basis: unknown;
  citations: { url: string; title: string | null; excerpts: string[] }[];
  costMicros: number;
}

/**
 * Deep research escalation via parallel.taskRun.
 * Returns structured output plus the citation basis.
 */
export async function runTask<T>(args: {
  input: string;
  outputSchema: Record<string, unknown>;
  processor?: Processor;
  previousRunId?: string | null;
  previousInteractionId?: string | null;
  metadata?: Record<string, string>;
  timeoutMs?: number;
}): Promise<TaskOutcome<T>> {
  const processor: Processor = args.processor ?? "core";
  const client = getParallelClient();
  const previousInteractionId = args.previousInteractionId ?? args.previousRunId ?? undefined;

  const created = (await client.taskRun.create({
    input: args.input,
    processor,
    task_spec: { output_schema: { type: "json", json_schema: args.outputSchema } },
    previous_interaction_id: previousInteractionId || undefined,
    metadata: args.metadata ?? undefined,
  } as any)) as { run_id?: string; id?: string; interaction_id?: string };

  const runId = created.run_id ?? (created as any).id;
  if (!runId) throw new ProviderError("Parallel did not return a run ID for task");

  const deadline = Date.now() + (args.timeoutMs ?? 600_000);
  let result: any = null;
  while (Date.now() < deadline) {
    try {
      const r = (await client.taskRun.result(runId)) as any;
      if (r && (r.output || r.status === "completed" || r.status === "failed")) {
        result = r;
        break;
      }
    } catch (err: any) {
      const status = err instanceof APIError ? err.status : err?.status;
      if (status === 404 || status === 425) {
        // Task is still running, poll again after delay
      } else {
        throw new ProviderError(`Parallel task poll failed: ${err.message}`, status);
      }
    }
    await sleep(4000);
  }
  if (!result) throw new ProviderError(`Parallel task ${runId} did not finish in time`, undefined, true);

  const content = result.output?.content ?? result.output ?? null;
  const basis = result.output?.basis ?? null;

  const citations: { url: string; title: string | null; excerpts: string[] }[] = [];
  const seen = new Set<string>();
  for (const field of Array.isArray(basis) ? basis : []) {
    for (const c of field?.citations ?? []) {
      if (!c?.url || seen.has(c.url)) continue;
      seen.add(c.url);
      citations.push({
        url: c.url,
        title: c.title ?? null,
        excerpts: c.excerpts ?? (c.excerpt ? [c.excerpt] : []),
      });
    }
  }

  const unitUsd =
    processor === "pro" || processor === "ultra" ? env.parallel.taskProUsd : env.parallel.taskCoreUsd;

  const interactionId = created.interaction_id ?? result?.interaction_id ?? runId;

  return {
    runId,
    interactionId,
    output: (typeof content === "string" ? safeParse<T>(content) : (content as T)) ?? null,
    basis,
    citations,
    costMicros: Math.round(unitUsd * 1_000_000),
  };
}

function safeParse<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

// ----------------------------------------------------------------- monitor

export async function createMonitor(args: {
  objective: string;
  queries: string[];
  webhookUrl: string;
  metadata: Record<string, string>;
}): Promise<{ monitorId: string } | null> {
  if (!env.parallel.monitorsEnabled) return null;
  const client = getParallelClient();
  try {
    const res = (await client.monitor.create({
      type: "event_stream",
      objective: args.objective,
      search_queries: args.queries,
      webhook: { url: args.webhookUrl },
      metadata: args.metadata,
    } as any)) as { monitor_id?: string; id?: string };
    const id = res.monitor_id ?? res.id;
    return id ? { monitorId: id } : null;
  } catch (err) {
    console.warn("[parallel] monitor creation unavailable:", (err as Error).message);
    return null;
  }
}
