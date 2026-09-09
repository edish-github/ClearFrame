import { pool, q, one, must } from "../core/db.js";
import { appendLedger } from "../core/ledger.js";
import { publish } from "../core/events.js";
import { getObject, putObject } from "../core/storage.js";
import { enqueue } from "../jobs/queue.js";
import { env } from "../core/env.js";
import * as stages from "./stages.js";
import type { Category } from "../providers/schemas.js";
import type { ChainRow, EvidenceRow, RetrievedSource, Spend } from "./stages.js";

/* ------------------------------------------------------------------ utils */

export const normaliseItem = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export const itemKeyOf = (category: string, item: string): string =>
  `${category}|${normaliseItem(item)}`;

const contentHashOf = (scene: string, page: string | null, context: string): string =>
  normaliseItem(`${scene}|${page ?? ""}|${context}`);

// Crew credits for a human audience in the activity feed and ledger.
// Machine-facing stage names for accounting remain unchanged in cost_events.
async function activity(productionId: string, findingId: string | null, stage: string, text: string) {
  await q(
    "INSERT INTO activity (production_id, finding_id, stage, text) VALUES ($1,$2,$3,$4)",
    [productionId, findingId, stage, text]
  );
  await publish(pool, productionId, "activity", { findingId, stage, text });
}

/** Records real spend and returns the production's running total. */
async function charge(productionId: string, findingId: string | null, s: Spend): Promise<number> {
  const row = await must<{ spent_micros: number }>(
    `WITH ins AS (
       INSERT INTO cost_events
         (production_id, finding_id, stage, provider, detail, input_tokens, output_tokens, units, cost_micros)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     )
     UPDATE productions SET spent_micros = spent_micros + $9, updated_at = now()
     WHERE id = $1 RETURNING spent_micros`,
    [
      productionId, findingId, s.stage, s.provider, s.detail ?? null,
      s.inputTokens ?? 0, s.outputTokens ?? 0, s.units ?? 0, s.costMicros,
    ]
  );
  return row.spent_micros;
}

interface Budget { spent: number; cap: number; }

async function budget(productionId: string): Promise<Budget> {
  const p = await must<{ spent_micros: number; budget_cap_micros: number }>(
    "SELECT spent_micros, budget_cap_micros FROM productions WHERE id = $1",
    [productionId]
  );
  return { spent: p.spent_micros, cap: p.budget_cap_micros };
}

async function setFinding(id: string, patch: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await q(`UPDATE findings SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => patch[k])]);
}

async function markStage(findingId: string, stage: string): Promise<void> {
  await q(
    `UPDATE findings SET stages_done = array_append(stages_done, $2), updated_at = now()
     WHERE id = $1 AND NOT ($2 = ANY(stages_done))`,
    [findingId, stage]
  );
}

async function saveEvidence(findingId: string, rows: EvidenceRow[], round: number): Promise<number> {
  let added = 0;
  for (const e of rows) {
    // The excerpt is captured at retrieval time so the report survives link rot.
    let snapshotKey: string | null = null;
    if (e.excerpt) {
      const obj = await putObject(
        `snapshots/${findingId}`,
        Buffer.from(`${e.url}\nRetrieved ${new Date().toISOString()}\n\n${e.excerpt}`, "utf8"),
        "text/plain",
        `${stages.domainOf(e.url)}.txt`
      );
      snapshotKey = obj.key;
    }
    const res = await q(
      `INSERT INTO evidence (finding_id, url, title, domain, stance, note, publish_date, snapshot_key, round)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (finding_id, url) DO NOTHING
       RETURNING id`,
      [findingId, e.url, e.title, e.domain, e.stance, e.note, e.publishDate, snapshotKey, round]
    );
    if (res.length) added++;
  }
  return added;
}

async function refreshProductionStatus(productionId: string): Promise<void> {
  await q(
    `UPDATE productions p SET status = CASE
        WHEN EXISTS (SELECT 1 FROM jobs j WHERE j.production_id = p.id AND j.state IN ('ready','running')) THEN 'running'
        WHEN EXISTS (SELECT 1 FROM findings f WHERE f.production_id = p.id AND f.status = 'review') THEN 'review'
        ELSE 'complete'
      END::production_status,
      updated_at = now()
     WHERE p.id = $1 AND p.status NOT IN ('failed')`,
    [productionId]
  );
  await publish(pool, productionId, "production", {});
}

/* -------------------------------------------------------------- breakdown */

export async function runBreakdown(productionId: string, cutId: string): Promise<void> {
  const production = await must<{ id: string; title: string; format: string }>(
    "SELECT id, title, format FROM productions WHERE id = $1",
    [productionId]
  );
  const cut = await must<{ id: string; n: number; filename: string; storage_key: string; mime_type: string }>(
    "SELECT id, n, filename, storage_key, mime_type FROM cuts WHERE id = $1",
    [cutId]
  );

  await q("UPDATE productions SET status = 'breakdown', error = NULL, updated_at = now() WHERE id = $1", [productionId]);
  await publish(pool, productionId, "production", {});

  const buf = await getObject(cut.storage_key);
  const isPdf = cut.mime_type === "application/pdf";

  const out = await stages.breakdown({
    title: production.title,
    format: production.format,
    file: isPdf ? { mimeType: "application/pdf", base64: buf.toString("base64") } : undefined,
    text: isPdf ? undefined : buf.toString("utf8"),
  });
  await charge(productionId, null, out.spend);

  if (!out.items.length) {
    await q("UPDATE productions SET status = 'failed', error = $2 WHERE id = $1", [
      productionId,
      "The screenplay was read but no clearance items could be extracted from it.",
    ]);
    await publish(pool, productionId, "production", {});
    return;
  }

  const existing = await q<{ id: string; item_key: string; content_hash: string; status: string }>(
    "SELECT id, item_key, content_hash, status FROM findings WHERE production_id = $1",
    [productionId]
  );
  const priorByKey = new Map(existing.map((f) => [f.item_key, f]));
  const isDelta = cut.n > 1;

  const seen = new Set<string>();
  const toInvestigate: string[] = [];
  let added = 0, changed = 0, carried = 0;

  for (const seed of out.items) {
    const key = itemKeyOf(seed.category, seed.item);
    if (seen.has(key)) continue;
    seen.add(key);
    const hash = contentHashOf(seed.scene, seed.page, seed.context);
    const prior = priorByKey.get(key);

    if (!prior) {
      const row = await must<{ id: string }>(
        `INSERT INTO findings
           (production_id, first_cut_id, pass_n, item, category, scene, page, context, item_key, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [productionId, cutId, cut.n, seed.item, seed.category, seed.scene, seed.page, seed.context, key, hash]
      );
      added++;
      toInvestigate.push(row.id);
      await activity(productionId, row.id, "Script supervisor",
        isDelta ? `New in cut ${cut.n}: ${seed.scene || "unlocated"}` : `Identified in ${seed.scene || "the screenplay"}`);
    } else if (prior.content_hash !== hash) {
      await setFinding(prior.id, {
        scene: seed.scene, page: seed.page, context: seed.context,
        content_hash: hash, pass_n: cut.n, status: "queued", error: null,
        stages_done: [], research_sources: null,
      });
      changed++;
      toInvestigate.push(prior.id);
      await activity(productionId, prior.id, "Delta", `Changed in cut ${cut.n}, re-clearing`);
    } else {
      carried++;
      if (prior.status === "withdrawn") {
        await setFinding(prior.id, {
          status: "queued",
          stages_done: [],
          research_sources: null,
        });
        toInvestigate.push(prior.id);
        await activity(productionId, prior.id, "Delta", `Returned in cut ${cut.n}`);
      } else if (isDelta) {
        await activity(productionId, prior.id, "Delta", `Unchanged in cut ${cut.n}, state and sources carried forward`);
      }
    }
  }

  let withdrawn = 0;
  if (isDelta) {
    for (const f of existing) {
      if (seen.has(f.item_key) || f.status === "withdrawn") continue;
      await setFinding(f.id, { status: "withdrawn" });
      withdrawn++;
      await activity(productionId, f.id, "Delta", `No longer present in cut ${cut.n}`);
    }
  }

  await q("UPDATE cuts SET stats = $2 WHERE id = $1", [
    cutId, JSON.stringify({ extracted: out.items.length, added, changed, withdrawn, carried }),
  ]);

  await appendLedger(productionId, "Script supervisor", {
    type: isDelta ? "delta_pass" : "breakdown",
    cut: cut.n, document: cut.filename,
    extracted: out.items.length, added, changed, withdrawn, carried,
  });

  await q("UPDATE productions SET status = 'running', updated_at = now() WHERE id = $1", [productionId]);
  for (const id of toInvestigate) {
    await enqueue({ productionId, kind: "finding.investigate", payload: { findingId: id } });
  }
  await publish(pool, productionId, "production", {});
  if (!toInvestigate.length) await refreshProductionStatus(productionId);
}

/* ------------------------------------------------------------ investigate */

export async function investigateFinding(findingId: string): Promise<void> {
  const f = await one<{
    id: string; production_id: string; item: string; category: Category;
    context: string; status: string; parallel_run_id: string | null;
    stages_done: string[] | null; research_sources: any | null;
    verification: any | null; chains: any | null; summary: string | null;
  }>(
    `SELECT id, production_id, item, category, context, status, parallel_run_id,
            stages_done, research_sources, verification, chains, summary
     FROM findings WHERE id = $1`,
    [findingId]
  );
  if (!f) return;
  if (f.status === "withdrawn") return;

  const done = new Set(f.stages_done ?? []);

  const production = await must<{ title: string; format: string }>(
    "SELECT title, format FROM productions WHERE id = $1",
    [f.production_id]
  );

  const b0 = await budget(f.production_id);
  if (b0.spent >= b0.cap) {
    await setFinding(f.id, { status: "held" });
    await activity(f.production_id, f.id, "First AD", "Held: the pass reached its research budget");
    await refreshProductionStatus(f.production_id);
    return;
  }

  const charged = (s: Spend) => charge(f.production_id, f.id, s);

  // ---- tier 0/1: recon on every item
  let sources: RetrievedSource[] = [];
  let sessionId: string | undefined;

  if (done.has("recon") && f.research_sources) {
    sources = (typeof f.research_sources === "string" ? JSON.parse(f.research_sources) : f.research_sources) as RetrievedSource[];
  } else {
    await setFinding(f.id, { status: "researching", tier: "recon" });
    await activity(f.production_id, f.id, "Clearance crew", "Web investigation started");
    await publish(pool, f.production_id, "finding", { findingId: f.id, status: "researching" });

    const r0 = await stages.recon({
      item: f.item, category: f.category, context: f.context, production: production.title,
    });
    await charged(r0.spend);
    sources = r0.sources;
    sessionId = r0.sessionId;
    await setFinding(f.id, { research_sources: JSON.stringify(sources) });
    await markStage(f.id, "recon");
  }

  let round = 1;

  let synth = await stages.synthesise({
    item: f.item, category: f.category, context: f.context, sources,
  });
  await charged(synth.spend);
  let addedCount = await saveEvidence(f.id, synth.evidence, round);
  await setFinding(f.id, { summary: synth.summary });
  await activity(
    f.production_id, f.id, "Clearance crew",
    `${addedCount} source${addedCount === 1 ? "" : "s"} recorded from ${sources.length} retrieved` +
      (synth.dropped ? `, ${synth.dropped} citation${synth.dropped === 1 ? "" : "s"} rejected as unverifiable` : "")
  );

  // ---- verification
  let v: { sufficient: boolean; reason: string; followUpObjective: string; followUpQueries: string[]; spend?: Spend };

  if (done.has("verify") && f.verification) {
    const parsed = typeof f.verification === "string" ? JSON.parse(f.verification) : f.verification;
    v = {
      sufficient: Boolean(parsed.sufficient),
      reason: parsed.reason ?? "",
      followUpObjective: parsed.followUpObjective ?? "",
      followUpQueries: parsed.followUpQueries ?? [],
    };
  } else {
    await setFinding(f.id, { status: "verifying" });
    await publish(pool, f.production_id, "finding", { findingId: f.id, status: "verifying" });

    const vRes = await stages.verify({
      item: f.item, category: f.category, summary: synth.summary,
      evidence: synth.evidence, gaps: synth.gaps,
    });
    await charged(vRes.spend);
    v = vRes;
    await markStage(f.id, "verify");
  }

  let escalated = false;
  let priorReason: string | null = null;
  let runId = f.parallel_run_id;

  // ---- tier 2/3: escalate only on a cited objection, and only within budget
  if (!done.has("escalate")) {
    const b1 = await budget(f.production_id);
    if (!v.sufficient && b1.spent < b1.cap) {
      escalated = true;
      priorReason = v.reason;
      await activity(f.production_id, f.id, "Continuity", `Challenged — ${v.reason}`);
      await appendLedger(f.production_id, "Continuity", {
        type: "challenge", finding: f.item, reason: v.reason,
      });

      await setFinding(f.id, { status: "researching", tier: "escalated" });
      await publish(pool, f.production_id, "finding", { findingId: f.id, status: "researching" });

      const objective = v.followUpObjective || v.reason;
      let followSources: RetrievedSource[] = [];

      try {
        const esc = await stages.escalate({
          item: f.item, category: f.category, context: f.context, production: production.title,
          objective, previousRunId: runId, deep: false,
        });
        await charged(esc.spend);
        runId = esc.runId;
        followSources = esc.sources;
        if (esc.dossier) {
          await activity(f.production_id, f.id, "Clearance crew",
            `Controller: ${esc.dossier.current_controller ?? "not established"} · Disputes: ${esc.dossier.disputes ?? "none found"}`);
        }
      } catch (err) {
        // Deep research is an escalation, not a dependency. Fall back to a
        // targeted second search rather than abandoning the finding.
        await activity(f.production_id, f.id, "Clearance crew",
          `Unavailable, falling back to targeted search: ${(err as Error).message}`);
        const r1 = await stages.recon({
          item: f.item, category: f.category, context: f.context, production: production.title,
          objectiveOverride: objective,
          queriesOverride: v.followUpQueries.length ? v.followUpQueries : undefined,
          sessionId,
        });
        await charged(r1.spend);
        followSources = r1.sources;
      }

      const known = new Set(sources.map((s) => s.url));
      sources = [...sources, ...followSources.filter((s) => !known.has(s.url))];
      round = 2;

      synth = await stages.synthesise({
        item: f.item, category: f.category, context: f.context, sources, challenge: v.reason,
      });
      await charged(synth.spend);
      const more = await saveEvidence(f.id, synth.evidence, round);
      await setFinding(f.id, { summary: synth.summary });
      await activity(f.production_id, f.id, "Clearance crew",
        `${more} further source${more === 1 ? "" : "s"} recorded`);

      await setFinding(f.id, { status: "verifying" });
      const v2 = await stages.verify({
        item: f.item, category: f.category, summary: synth.summary,
        evidence: synth.evidence, gaps: synth.gaps,
      });
      await charged(v2.spend);
      v = v2;
    }

    await markStage(f.id, "escalate");
  }

  await setFinding(f.id, {
    verification: JSON.stringify({
      sufficient: v.sufficient, reason: v.reason, escalated, priorReason,
      at: new Date().toISOString(),
    }),
    parallel_run_id: runId,
  });
  await activity(f.production_id, f.id, "Continuity",
    v.sufficient ? "Evidence accepted" : `Unresolved — ${v.reason}`);

  // ---- chain of title
  const stored = await q<EvidenceRow & { publish_date: string | null }>(
    `SELECT url, title, domain, stance, note, publish_date FROM evidence WHERE finding_id = $1 ORDER BY id`,
    [f.id]
  );
  const evidenceRows: EvidenceRow[] = stored.map((e: any) => ({
    url: e.url, title: e.title, domain: e.domain, stance: e.stance,
    note: e.note, publishDate: e.publish_date, excerpt: "",
  }));

  let chains: ChainRow[] = [];
  const existingChains = f.chains ? (typeof f.chains === "string" ? JSON.parse(f.chains) : f.chains) : [];
  if (done.has("chain") && Array.isArray(existingChains) && existingChains.length > 0) {
    chains = existingChains;
  } else {
    await setFinding(f.id, { status: "tracing" });
    await publish(pool, f.production_id, "finding", { findingId: f.id, status: "tracing" });

    const chainOut = await stages.traceChains({
      item: f.item, category: f.category, summary: synth.summary, evidence: evidenceRows,
    });
    await charged(chainOut.spend);
    chains = chainOut.chains;
    await setFinding(f.id, { chains: JSON.stringify(chains) });
    await markStage(f.id, "chain");
    await activity(f.production_id, f.id, "Chain of title",
      chains.length
        ? chains.map((c) => `${c.right} → ${c.holder ?? "unresolved"}`).join(" · ")
        : "No chain could be traced");
  }

  // ---- assessment
  await setFinding(f.id, { status: "assessing" });
  await publish(pool, f.production_id, "finding", { findingId: f.id, status: "assessing" });

  const a = await stages.assess({
    item: f.item, category: f.category, context: f.context, summary: synth.summary,
    evidence: evidenceRows, chains,
    verification: { sufficient: v.sufficient, reason: v.reason },
  });
  await charged(a.spend);

  const finalStatus = a.requiresReview ? "review" : "cleared";
  await setFinding(f.id, {
    status: finalStatus, risk: a.risk, confidence: a.confidence,
    assessment: a.assessment, recommendation: a.recommendation,
  });
  await activity(f.production_id, f.id, "Risk counsel",
    `${a.risk[0]}${a.risk.slice(1).toLowerCase()} risk at ${Math.round(a.confidence * 100)}% confidence — ` +
      `${a.requiresReview ? "human review required" : "cleared without review"}`);
  await appendLedger(f.production_id, "Risk counsel", {
    type: "assessment", finding: f.item, risk: a.risk,
    confidence: a.confidence, requiresReview: a.requiresReview,
  });

  // A cleared item is an armed watch, not a closed row.
  if (finalStatus === "cleared") await armWatch(f.id);

  await publish(pool, f.production_id, "finding", { findingId: f.id, status: finalStatus });
  await refreshProductionStatus(f.production_id);
}

/* ------------------------------------------------------------- monitoring */

export async function armWatch(findingId: string): Promise<void> {
  const next = new Date(Date.now() + env.worker.monitorIntervalHours * 3_600_000);
  await q(
    `INSERT INTO watches (finding_id, provider, next_check_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (finding_id) DO UPDATE SET state = 'active', next_check_at = EXCLUDED.next_check_at`,
    [findingId, env.parallel.monitorsEnabled ? "parallel" : "internal", next]
  );
}

/**
 * Re-runs retrieval against today's web and compares with what is on record.
 * A new source that conflicts reopens the finding; nothing here ever closes one.
 */
export async function recheckFinding(findingId: string, trigger: string): Promise<void> {
  const f = await one<{
    id: string; production_id: string; item: string; category: Category; context: string; status: string;
  }>("SELECT id, production_id, item, category, context, status FROM findings WHERE id = $1", [findingId]);
  if (!f) return;

  const production = await must<{ title: string }>("SELECT title FROM productions WHERE id = $1", [f.production_id]);
  const b = await budget(f.production_id);
  if (b.spent >= b.cap) {
    await activity(f.production_id, f.id, "Night watch", "Skipped: the production is at its research budget");
    return;
  }

  await activity(f.production_id, f.id, "Night watch", `Re-check started (${trigger})`);

  const r = await stages.recon({
    item: f.item, category: f.category, context: f.context, production: production.title,
    objectiveOverride:
      `Determine whether the rights position for "${f.item}" has changed recently: new acquisitions, ` +
      `assignments, litigation, estate disputes or status changes.`,
  });
  await charge(f.production_id, f.id, r.spend);

  const known = new Set((await q<{ url: string }>("SELECT url FROM evidence WHERE finding_id = $1", [f.id])).map((e) => e.url));
  const fresh = r.sources.filter((s) => !known.has(s.url));

  if (!fresh.length) {
    await q("UPDATE watches SET last_checked_at = now(), next_check_at = now() + ($2 || ' hours')::interval WHERE finding_id = $1",
      [f.id, String(env.worker.monitorIntervalHours)]);
    await activity(f.production_id, f.id, "Night watch", "No material change found");
    return;
  }

  const synth = await stages.synthesise({
    item: f.item, category: f.category, context: f.context, sources: fresh,
  });
  await charge(f.production_id, f.id, synth.spend);
  const added = await saveEvidence(f.id, synth.evidence, 9);

  const conflicts = synth.evidence.filter((e) => e.stance === "conflicts").length;
  if (conflicts > 0) {
    await setFinding(f.id, { status: "review" });
    await activity(f.production_id, f.id, "Night watch",
      `Reopened — ${conflicts} new source${conflicts === 1 ? "" : "s"} conflict with the recorded position`);
    await appendLedger(f.production_id, "Night watch", {
      type: "reopen", finding: f.item, conflictingSources: conflicts, trigger,
    });
    await publish(pool, f.production_id, "finding", { findingId: f.id, status: "review" });
    await refreshProductionStatus(f.production_id);
  } else {
    await activity(f.production_id, f.id, "Night watch",
      added ? `${added} new source${added === 1 ? "" : "s"}, position unchanged` : "No material change found");
  }

  await q("UPDATE watches SET last_checked_at = now(), next_check_at = now() + ($2 || ' hours')::interval WHERE finding_id = $1",
    [f.id, String(env.worker.monitorIntervalHours)]);
}

/* --------------------------------------------------------------- outreach */

export async function draftOutreachFor(findingId: string): Promise<void> {
  const f = await one<{
    id: string; production_id: string; item: string; category: Category; context: string; chains: ChainRow[];
  }>("SELECT id, production_id, item, category, context, chains FROM findings WHERE id = $1", [findingId]);
  if (!f) return;

  const production = await must<{ title: string; format: string }>(
    "SELECT title, format FROM productions WHERE id = $1",
    [f.production_id]
  );

  try {
    const out = await stages.draftOutreach({
      item: f.item, category: f.category, context: f.context,
      production: production.title, format: production.format,
      chains: Array.isArray(f.chains) ? f.chains : [],
    });
    await charge(f.production_id, f.id, out.spend);
    await q(
      `INSERT INTO outreach (finding_id, addressed_to, subject, body, state)
       VALUES ($1,$2,$3,$4,'draft')
       ON CONFLICT (finding_id) DO UPDATE
         SET addressed_to = EXCLUDED.addressed_to, subject = EXCLUDED.subject,
             body = EXCLUDED.body, state = 'draft', error = NULL`,
      [f.id, out.addressedTo, out.subject, out.body]
    );
    await activity(f.production_id, f.id, "Production office", `Licence inquiry drafted to ${out.addressedTo}`);
  } catch (err) {
    await q(
      `INSERT INTO outreach (finding_id, addressed_to, subject, body, state, error)
       VALUES ($1,'','','','failed',$2)
       ON CONFLICT (finding_id) DO UPDATE SET state = 'failed', error = EXCLUDED.error`,
      [f.id, (err as Error).message]
    );
    await activity(f.production_id, f.id, "Production office", `Draft failed: ${(err as Error).message}`);
  }
  await publish(pool, f.production_id, "outreach", { findingId: f.id });
}

export { activity as recordActivity, refreshProductionStatus };
