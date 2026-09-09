import { generate } from "../providers/gemini.js";
import * as parallel from "../providers/parallel.js";
import {
  ASSESS_SYSTEM, BREAKDOWN_SYSTEM, CATEGORIES, CHAIN_SYSTEM, OUTREACH_SYSTEM,
  SYNTHESIS_SYSTEM, VERIFY_SYSTEM, assessSchema, breakdownSchema, chainSchema,
  dossierSchema, outreachSchema, synthesisSchema, verifySchema,
  type Category,
} from "../providers/schemas.js";

export interface Spend { stage: string; provider: string; detail?: string; inputTokens?: number; outputTokens?: number; units?: number; costMicros: number; }

export interface FindingSeed {
  item: string; category: Category; scene: string; page: string | null; context: string;
}

export interface RetrievedSource {
  url: string; title: string | null; publishDate: string | null; excerpts: string[];
}

export interface EvidenceRow {
  url: string; title: string | null; domain: string; stance: "supports" | "conflicts" | "context";
  note: string; publishDate: string | null; excerpt: string;
}

export const domainOf = (url: string): string => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "source"; }
};

// ---------------------------------------------------------------- breakdown

export async function breakdown(args: {
  title: string; format: string; file?: { mimeType: string; base64: string }; text?: string; limit?: number;
}): Promise<{ items: FindingSeed[]; spend: Spend }> {
  const limit = args.limit ?? 24;
  const prompt = [
    `Production: "${args.title}" (${args.format}).`,
    `Identify up to ${limit} of the most clearance-relevant third-party elements in the screenplay.`,
    args.text ? `\nScreenplay:\n${args.text.slice(0, 400_000)}` : "",
  ].join("\n");

  const { data, usage } = await generate<{ items: any[] }>({
    tier: "pro",
    system: BREAKDOWN_SYSTEM,
    prompt,
    schema: breakdownSchema as unknown as Record<string, unknown>,
    file: args.file ? { mimeType: args.file.mimeType, base64: args.file.base64 } : undefined,
    maxOutputTokens: 8192,
  });

  const items: FindingSeed[] = (data.items ?? [])
    .slice(0, limit)
    .map((r) => {
      const cat = String(r.category ?? "").toUpperCase() as Category;
      return {
        item: String(r.item ?? "").trim().slice(0, 200),
        category: (CATEGORIES as readonly string[]).includes(cat) ? cat : ("OTHER" as Category),
        scene: String(r.scene ?? "").trim().slice(0, 80),
        page: r.page ? String(r.page).trim().slice(0, 12) : null,
        context: String(r.context ?? "").trim().slice(0, 400),
      };
    })
    .filter((r) => r.item.length > 0);

  return {
    items,
    spend: {
      stage: "breakdown", provider: "gemini", detail: usage.model,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costMicros: usage.costMicros,
    },
  };
}

// -------------------------------------------------------------------- recon

function reconQueries(f: { item: string; category: Category }): string[] {
  const base = f.item.replace(/["']/g, "").slice(0, 60);
  switch (f.category) {
    case "MUSIC":
      return [`${base} song rights owner`, `${base} publisher composition`, `${base} master recording label`];
    case "BRAND":
      return [`${base} trademark owner`, `${base} trademark registration status`, `${base} brand litigation`];
    case "ARTWORK":
      return [`${base} artist copyright`, `${base} artwork rights holder`, `${base} artwork licensing`];
    case "FOOTAGE":
      return [`${base} archival footage rights`, `${base} stock footage licensing`, `${base} footage owner`];
    case "LIKENESS":
      return [`${base} publicity rights`, `${base} estate representation`, `${base} likeness lawsuit`];
    default:
      return [`${base} rights owner`, `${base} copyright holder`];
  }
}

export async function recon(args: {
  item: string; category: Category; context: string; production: string;
  objectiveOverride?: string; queriesOverride?: string[]; sessionId?: string;
}): Promise<{ sources: RetrievedSource[]; sessionId: string; spend: Spend }> {
  const objective =
    args.objectiveOverride ??
    `Establish who currently controls the rights to "${args.item}" for use in the film "${args.production}". ` +
      `It appears as: ${args.context}. Find the current rights holder, any catalogue acquisition or assignment ` +
      `that moved control, and any litigation or dispute over ownership.` +
      (args.category === "MUSIC"
        ? " Music has two separate chains: the underlying composition and the master recording. Cover both."
        : "");

  const out = await parallel.search({
    objective,
    queries: args.queriesOverride ?? reconQueries({ item: args.item, category: args.category }),
    mode: "advanced",
    maxResults: 8,
    sessionId: args.sessionId,
  });

  return {
    sources: out.results,
    sessionId: out.sessionId,
    spend: {
      stage: "recon", provider: "parallel", detail: "search",
      units: out.units, costMicros: out.costMicros,
    },
  };
}

// ---------------------------------------------------------------- synthesis

/**
 * Turns retrieved sources into evidence rows. Any url the model returns that is
 * not in the retrieved set is dropped before it can reach the database, so a
 * fabricated citation is structurally impossible rather than merely discouraged.
 */
export async function synthesise(args: {
  item: string; category: Category; context: string; sources: RetrievedSource[]; challenge?: string;
}): Promise<{ summary: string; evidence: EvidenceRow[]; gaps: string[]; dropped: number; spend: Spend }> {
  const pool = new Map(args.sources.map((s) => [s.url, s]));

  const rendered = args.sources
    .map((s, i) =>
      `[${i + 1}] ${s.url}\nTitle: ${s.title ?? "untitled"}\nPublished: ${s.publishDate ?? "unknown"}\n` +
      `Excerpt: ${s.excerpts.join(" … ").slice(0, 2000)}`
    )
    .join("\n\n");

  const prompt = [
    `Element: ${args.item} (${args.category})`,
    `How it appears in the film: ${args.context}`,
    args.challenge ? `\nA verifier rejected the earlier research. Its objection: ${args.challenge}\nAddress it specifically.` : "",
    `\nSources retrieved just now. Cite only these, copying each url exactly.\n\n${rendered}`,
  ].join("\n");

  const { data, usage } = await generate<{ summary: string; evidence: any[]; searchGaps?: string[] }>({
    tier: "flash",
    system: SYNTHESIS_SYSTEM,
    prompt,
    schema: synthesisSchema as unknown as Record<string, unknown>,
    maxOutputTokens: 2048,
  });

  let dropped = 0;
  const seen = new Set<string>();
  const evidence: EvidenceRow[] = [];
  for (const e of data.evidence ?? []) {
    const url = String(e?.url ?? "");
    const src = pool.get(url);
    if (!src) { dropped++; continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    evidence.push({
      url,
      title: src.title,
      domain: domainOf(url),
      stance: (["supports", "conflicts", "context"] as const).includes(e.stance) ? e.stance : "context",
      note: String(e.note ?? "").slice(0, 300),
      publishDate: src.publishDate,
      excerpt: src.excerpts.join("\n\n").slice(0, 20_000),
    });
  }

  return {
    summary: String(data.summary ?? "").slice(0, 4000),
    evidence,
    gaps: (data.searchGaps ?? []).map(String).slice(0, 5),
    dropped,
    spend: {
      stage: "synthesis", provider: "gemini", detail: usage.model,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costMicros: usage.costMicros,
    },
  };
}

// ------------------------------------------------------------------- verify

export async function verify(args: {
  item: string; category: Category; summary: string; evidence: EvidenceRow[]; gaps: string[];
}): Promise<{ sufficient: boolean; reason: string; followUpObjective: string; followUpQueries: string[]; spend: Spend }> {
  const prompt = [
    `Element: ${args.item} (${args.category})`,
    `Stated position: ${args.summary}`,
    `\nRecorded evidence:`,
    args.evidence.length
      ? args.evidence.map((e, i) => `${i + 1}. [${e.stance}] ${e.domain} (${e.publishDate ?? "undated"}) — ${e.note}`).join("\n")
      : "none",
    args.gaps.length ? `\nGaps the researcher flagged: ${args.gaps.join("; ")}` : "",
  ].join("\n");

  const { data, usage } = await generate<{
    sufficient: boolean; reason: string; followUpObjective?: string; followUpQueries?: string[];
  }>({
    tier: "pro",
    system: VERIFY_SYSTEM,
    prompt,
    schema: verifySchema as unknown as Record<string, unknown>,
    maxOutputTokens: 1024,
  });

  return {
    sufficient: data.sufficient !== false,
    reason: String(data.reason ?? "").slice(0, 500),
    followUpObjective: String(data.followUpObjective ?? "").slice(0, 2000),
    followUpQueries: (data.followUpQueries ?? []).map(String).slice(0, 4),
    spend: {
      stage: "verification", provider: "gemini", detail: usage.model,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costMicros: usage.costMicros,
    },
  };
}

// ----------------------------------------------------------------- escalate

/**
 * Tier 2/3. Used only when the verifier files a challenge, which is what keeps
 * the expensive processor off the boring 90 percent of the register.
 */
export async function escalate(args: {
  item: string; category: Category; context: string; production: string;
  objective: string; previousRunId?: string | null; deep?: boolean;
}): Promise<{ sources: RetrievedSource[]; dossier: Record<string, string> | null; runId: string; spend: Spend }> {
  const input = [
    `Establish the current chain of title for "${args.item}" (${args.category}) as used in the film "${args.production}".`,
    `It appears as: ${args.context}`,
    `Specific question to resolve: ${args.objective}`,
    args.category === "MUSIC"
      ? "Music has two separate properties: the underlying composition and the master recording. Resolve both."
      : "",
  ].join("\n");

  const out = await parallel.runTask<Record<string, string>>({
    input,
    outputSchema: dossierSchema as unknown as Record<string, unknown>,
    processor: args.deep ? "pro" : "core",
    previousRunId: args.previousRunId ?? null,
    metadata: { product: "clearframe", category: args.category },
  });

  return {
    runId: out.interactionId ?? out.runId,
    dossier: out.output,
    sources: out.citations.map((c) => ({
      url: c.url, title: c.title, publishDate: null, excerpts: c.excerpts,
    })),
    spend: {
      stage: "escalation", provider: "parallel",
      detail: args.deep ? "task:pro" : "task:core",
      units: 1, costMicros: out.costMicros,
    },
  };
}

// ------------------------------------------------------------------- chains

export interface ChainRow { right: string; holder: string | null; status: "clear" | "contested" | "unresolved"; note: string; }

export async function traceChains(args: {
  item: string; category: Category; summary: string; evidence: EvidenceRow[];
}): Promise<{ chains: ChainRow[]; spend: Spend }> {
  const prompt = [
    `Element: ${args.item} (${args.category})`,
    `Position established by research: ${args.summary}`,
    `\nEvidence on record:`,
    args.evidence.length
      ? args.evidence.map((e, i) => `${i + 1}. [${e.stance}] ${e.domain} — ${e.note}`).join("\n")
      : "none",
  ].join("\n");

  const { data, usage } = await generate<{ chains: any[] }>({
    tier: "pro",
    system: CHAIN_SYSTEM,
    prompt,
    schema: chainSchema as unknown as Record<string, unknown>,
    maxOutputTokens: 1024,
  });

  const chains: ChainRow[] = (data.chains ?? []).slice(0, 4).map((c) => ({
    right: String(c.right ?? "Right").slice(0, 60),
    holder: c.holder && String(c.holder).trim() ? String(c.holder).slice(0, 160) : null,
    status: (["clear", "contested", "unresolved"] as const).includes(c.status) ? c.status : "unresolved",
    note: String(c.note ?? "").slice(0, 240),
  }));

  return {
    chains,
    spend: {
      stage: "chain of title", provider: "gemini", detail: usage.model,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costMicros: usage.costMicros,
    },
  };
}

// ------------------------------------------------------------------- assess

export async function assess(args: {
  item: string; category: Category; context: string; summary: string;
  evidence: EvidenceRow[]; chains: ChainRow[]; verification: { sufficient: boolean; reason: string };
}): Promise<{
  risk: "LOW" | "MEDIUM" | "HIGH"; confidence: number; assessment: string;
  recommendation: string; requiresReview: boolean; spend: Spend;
}> {
  const prompt = [
    `Element: ${args.item} (${args.category})`,
    `How it appears: ${args.context}`,
    `Position established by research: ${args.summary}`,
    `Verification: ${args.verification.sufficient ? "evidence accepted" : "evidence challenged"} — ${args.verification.reason}`,
    `Chains of title: ${args.chains.length
      ? args.chains.map((c) => `${c.right} -> ${c.holder ?? "not established"} (${c.status})`).join("; ")
      : "none traced"}`,
    `\nEvidence:`,
    args.evidence.length
      ? args.evidence.map((e, i) => `${i + 1}. [${e.stance}] ${e.domain} — ${e.note}`).join("\n")
      : "none",
  ].join("\n");

  const { data, usage } = await generate<{
    risk: "LOW" | "MEDIUM" | "HIGH"; confidence: number; assessment: string;
    recommendation: string; requiresReview: boolean;
  }>({
    tier: "pro",
    system: ASSESS_SYSTEM,
    prompt,
    schema: assessSchema as unknown as Record<string, unknown>,
    maxOutputTokens: 1024,
  });

  const risk = (["LOW", "MEDIUM", "HIGH"] as const).includes(data.risk) ? data.risk : "MEDIUM";
  const contested = args.chains.some((c) => c.status !== "clear");

  return {
    risk,
    confidence: Math.max(0, Math.min(1, Number(data.confidence ?? 0.5))),
    assessment: String(data.assessment ?? "").slice(0, 2000),
    recommendation: String(data.recommendation ?? "").slice(0, 1000),
    // Two floors the model cannot lower: high risk, and any chain that does not resolve.
    requiresReview: risk === "HIGH" || contested || data.requiresReview !== false,
    spend: {
      stage: "assessment", provider: "gemini", detail: usage.model,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costMicros: usage.costMicros,
    },
  };
}

// ----------------------------------------------------------------- outreach

export async function draftOutreach(args: {
  item: string; category: Category; context: string; production: string; format: string; chains: ChainRow[];
}): Promise<{ addressedTo: string; subject: string; body: string; spend: Spend }> {
  const prompt = [
    `Production: ${args.production} (${args.format})`,
    `Element: ${args.item} (${args.category})`,
    `How it appears: ${args.context}`,
    `Chains of title on record: ${args.chains.length
      ? args.chains.map((c) => `${c.right} -> ${c.holder ?? "not established"} (${c.status})`).join("; ")
      : "none traced"}`,
    `\nDraft a licence inquiry to the party most likely to control this right.`,
  ].join("\n");

  const { data, usage } = await generate<{ addressedTo: string; subject: string; body: string }>({
    tier: "flash",
    system: OUTREACH_SYSTEM,
    prompt,
    schema: outreachSchema as unknown as Record<string, unknown>,
    maxOutputTokens: 1024,
  });

  const fallback = args.chains.find((c) => c.holder)?.holder ?? "Rights holder";
  return {
    addressedTo: String(data.addressedTo ?? fallback).slice(0, 200),
    subject: String(data.subject ?? `Licence inquiry — ${args.item}`).slice(0, 200),
    body: String(data.body ?? "").slice(0, 4000),
    spend: {
      stage: "outreach", provider: "gemini", detail: usage.model,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costMicros: usage.costMicros,
    },
  };
}
