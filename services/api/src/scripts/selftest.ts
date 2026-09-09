/**
 * Integration checks against a real database. Run with:
 *   DATABASE_URL=... npx tsx src/selftest.ts
 * These test the parts that must not be wrong: ledger integrity, append-only
 * enforcement, queue claim safety under concurrency, and money accounting.
 */
import { pool, q, must, one } from "../core/db.js";
import { appendLedger, verifyChain, ledgerHead } from "../core/ledger.js";
import { claim, complete, enqueue, reapStalled, release } from "../jobs/queue.js";
import { itemKeyOf, normaliseItem } from "../pipeline/pass.js";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) console.log(`  pass  ${name}`);
  else { failures++; console.log(`  FAIL  ${name} ${detail}`); }
}

async function main() {
  console.log("\nClearFrame self-test\n");

  // ------------------------------------------------------- hermetic start
  // Clear anything a previous crashed run left behind, or the queue checks
  // below will pick up orphaned jobs and report a false failure.
  const reset = await pool.connect();
  try {
    await reset.query("BEGIN");
    await reset.query("SET LOCAL clearframe.allow_purge = 'on'");
    await reset.query("DELETE FROM orgs WHERE name = 'Selftest Pictures'");
    await reset.query("DELETE FROM jobs WHERE production_id IS NULL");
    // Release anything a crashed run left claimed, so contention counts are honest.
    await reset.query("UPDATE jobs SET state = 'ready', locked_at = NULL, locked_by = NULL WHERE state = 'running'");
    await reset.query("COMMIT");
  } finally { reset.release(); }

  // ---------------------------------------------------------------- setup
  const org = await must<{ id: string }>("INSERT INTO orgs (name) VALUES ('Selftest Pictures') RETURNING id");
  const user = await must<{ id: string }>(
    `INSERT INTO users (org_id, email, name, password_hash, role)
     VALUES ($1, $2, 'Test Counsel', 'x', 'counsel') RETURNING id`,
    [org.id, `counsel+${Date.now()}@example.test`]
  );
  const prod = await must<{ id: string }>(
    `INSERT INTO productions (org_id, title, budget_cap_micros, created_by)
     VALUES ($1, 'The Selftest', 25000000, $2) RETURNING id`,
    [org.id, user.id]
  );

  console.log("ledger");
  // ------------------------------------------------------- hash chaining
  await appendLedger(prod.id, "Producer", { type: "pass_opened", cut: 1 });
  await appendLedger(prod.id, "Breakdown", { type: "breakdown", extracted: 12 });
  await appendLedger(prod.id, "Verifier", { type: "challenge", reason: "stale citation" });
  const head = await ledgerHead(prod.id);
  check("chain has three entries", head.length === 3, `got ${head.length}`);

  const clean = await verifyChain(prod.id);
  check("clean chain verifies", clean.ok === true);
  check("head matches last entry", clean.head === head.head);

  // ------------------------------------------------- append-only enforced
  let blockedUpdate = false;
  try {
    await q("UPDATE ledger SET actor = 'forged' WHERE production_id = $1 AND seq = 2", [prod.id]);
  } catch { blockedUpdate = true; }
  check("UPDATE on ledger is rejected", blockedUpdate);

  let blockedDelete = false;
  try {
    await q("DELETE FROM ledger WHERE production_id = $1 AND seq = 2", [prod.id]);
  } catch { blockedDelete = true; }
  check("DELETE on ledger is rejected", blockedDelete);

  // ---------------------------------------------------- tamper detection
  // Drop the trigger to simulate an attacker with direct database access.
  await q("ALTER TABLE ledger DISABLE TRIGGER ledger_no_mutate");
  await q("UPDATE ledger SET event = '{\"type\":\"decision\",\"action\":\"approved\"}'::jsonb WHERE production_id = $1 AND seq = 2", [prod.id]);
  const tampered = await verifyChain(prod.id);
  check("edited history is detected", tampered.ok === false && tampered.brokenAt === 2,
    `ok=${tampered.ok} at=${tampered.brokenAt}`);

  // restore and confirm it verifies again
  await q("UPDATE ledger SET event = '{\"type\":\"challenge\",\"reason\":\"stale citation\"}'::jsonb WHERE production_id = $1 AND seq = 3", [prod.id]);
  await q("UPDATE ledger SET event = '{\"type\":\"breakdown\",\"extracted\":12}'::jsonb WHERE production_id = $1 AND seq = 2", [prod.id]);
  await q("ALTER TABLE ledger ENABLE TRIGGER ledger_no_mutate");
  const restored = await verifyChain(prod.id);
  check("restored history verifies again", restored.ok === true);

  // -------------------------------------------- concurrent appends do not fork
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => appendLedger(prod.id, "Assessment", { type: "assessment", n: i }))
  );
  const after = await verifyChain(prod.id);
  check("12 concurrent appends keep one unbroken chain", after.ok === true && after.length === 15,
    `ok=${after.ok} len=${after.length}`);
  const seqs = await q<{ seq: number }>("SELECT seq FROM ledger WHERE production_id = $1 ORDER BY seq", [prod.id]);
  check("sequence numbers are contiguous", seqs.every((r, i) => r.seq === i + 1));

  console.log("\ncheckpoints");
  const cp = await must<{ id: string }>(
    `INSERT INTO findings (production_id, item, category, context, item_key, content_hash)
     VALUES ($1,'Checkpoint Test','OTHER','x',$2,'h9') RETURNING id`,
    [prod.id, itemKeyOf("OTHER", "Checkpoint Test")]
  );
  await q("UPDATE findings SET stages_done = ARRAY['recon','verify'] WHERE id = $1", [cp.id]);
  await q("UPDATE findings SET stages_done = array_append(stages_done, 'recon') WHERE id = $1 AND NOT ('recon' = ANY(stages_done))", [cp.id]);
  const marks = await must<{ stages_done: string[] }>("SELECT stages_done FROM findings WHERE id = $1", [cp.id]);
  check("a stage is never checkpointed twice", marks.stages_done.length === 2, `got ${marks.stages_done.join(",")}`);

  console.log("\nqueue");
  // ------------------------------------------------------------ claiming
  // The queue is shared, so this cannot assume it is empty. It asserts on its
  // own jobs and hands anything else straight back, which is also a fair test
  // of claiming under contention with unrelated work present.
  const foreign = await must<{ n: number }>(
    "SELECT count(*)::int AS n FROM jobs WHERE state = 'ready' AND run_at <= now()"
  );

  const mine = new Set<string>();
  for (let i = 0; i < 10; i++) {
    mine.add(await enqueue({ productionId: prod.id, kind: "finding.investigate", payload: { findingId: `f-${i}` } }));
  }

  const claimed = await Promise.all(
    Array.from({ length: 10 + foreign.n }, (_, i) => claim(`worker-${i}`))
  );
  const got = claimed.filter((j): j is NonNullable<typeof j> => j !== null);
  const ids = got.map((j) => j.id);

  check("concurrent workers never claim the same job twice", new Set(ids).size === ids.length,
    `${ids.length} claims, ${new Set(ids).size} distinct`);

  const mineClaimed = ids.filter((id) => mine.has(id));
  check("every queued job is claimed exactly once", mineClaimed.length === 10, `got ${mineClaimed.length}`);

  const extra = await claim("worker-extra");
  check("a worker gets nothing once the queue is drained", extra === null);
  if (extra) await release(extra.id);

  for (const id of ids) {
    if (mine.has(id)) await complete(id);
    else await release(id); // someone else's work; put it straight back
  }
  const done = await must<{ n: number }>(
    "SELECT count(*)::int AS n FROM jobs WHERE production_id = $1 AND state = 'done'", [prod.id]
  );
  check("all ten complete", done.n === 10, `got ${done.n}`);

  // ---------------------------------------------------------- stall reaper
  await enqueue({ productionId: prod.id, kind: "finding.investigate", payload: { findingId: "stalled" } });
  const stalled = await claim("worker-that-dies");
  if (!stalled) throw new Error("expected to claim the job just enqueued");
  await q("UPDATE jobs SET locked_at = now() - interval '45 minutes' WHERE id = $1", [stalled.id]);
  const reaped = await reapStalled(20);
  check("a dead worker's job is released", reaped === 1, `reaped=${reaped}`);
  const back = await one<{ state: string }>("SELECT state FROM jobs WHERE id = $1", [stalled.id]);
  check("released job is claimable again", back?.state === "ready");

  console.log("\naccounting");
  // ------------------------------------------------------------ cost math
  const finding = await must<{ id: string }>(
    `INSERT INTO findings (production_id, item, category, context, item_key, content_hash)
     VALUES ($1, 'Midnight City', 'MUSIC', 'plays in a bar', $2, 'h1') RETURNING id`,
    [prod.id, itemKeyOf("MUSIC", "Midnight City")]
  );
  for (const [stage, micros] of [["recon", 5000], ["synthesis", 12345], ["assessment", 40200]] as const) {
    await q(
      `WITH ins AS (
         INSERT INTO cost_events (production_id, finding_id, stage, provider, cost_micros)
         VALUES ($1,$2,$3,'test',$4)
       ) UPDATE productions SET spent_micros = spent_micros + $4 WHERE id = $1`,
      [prod.id, finding.id, stage, micros]
    );
  }
  const spend = await must<{ spent_micros: number; sum: number }>(
    `SELECT p.spent_micros, (SELECT sum(cost_micros)::bigint FROM cost_events WHERE production_id = p.id) AS sum
     FROM productions p WHERE p.id = $1`,
    [prod.id]
  );
  check("production total matches the sum of cost events", spend.spent_micros === spend.sum,
    `${spend.spent_micros} vs ${spend.sum}`);
  check("total is exact integer micros, no float drift", spend.spent_micros === 57545, `got ${spend.spent_micros}`);

  console.log("\ndelta identity");
  // ---------------------------------------------------------- item keying
  check("item key is stable across punctuation and case",
    itemKeyOf("MUSIC", '"Midnight City"') === itemKeyOf("MUSIC", "midnight city"));
  check("item key separates categories",
    itemKeyOf("MUSIC", "Apollo") !== itemKeyOf("BRAND", "Apollo"));
  check("normalisation collapses whitespace", normaliseItem("  The   Last  Hour ") === "the last hour");

  // ---------------------------------------------- one finding per item key
  let duplicateBlocked = false;
  try {
    await q(
      `INSERT INTO findings (production_id, item, category, context, item_key, content_hash)
       VALUES ($1, 'MIDNIGHT CITY', 'MUSIC', 'again', $2, 'h2')`,
      [prod.id, itemKeyOf("MUSIC", "Midnight City")]
    );
  } catch { duplicateBlocked = true; }
  check("the same element cannot be filed twice", duplicateBlocked);

  console.log("\nevidence");
  // ----------------------------------------------- no duplicate citations
  for (let i = 0; i < 2; i++) {
    await q(
      `INSERT INTO evidence (finding_id, url, title, domain, stance, note)
       VALUES ($1,'https://example.test/a','A','example.test','supports','same source twice')
       ON CONFLICT (finding_id, url) DO NOTHING`,
      [finding.id]
    );
  }
  const ev = await must<{ n: number }>("SELECT count(*)::int AS n FROM evidence WHERE finding_id = $1", [finding.id]);
  check("a source is recorded once per finding", ev.n === 1, `got ${ev.n}`);

  let badStance = false;
  try {
    await q(
      `INSERT INTO evidence (finding_id, url, domain, stance) VALUES ($1,'https://x.test','x.test','invented')`,
      [finding.id]
    );
  } catch { badStance = true; }
  check("an unknown stance is rejected at the database", badStance);

  // ------------------------------------------------------------- cleanup
  let purgeBlocked = false;
  try {
    await q("DELETE FROM orgs WHERE id = $1", [org.id]);
  } catch { purgeBlocked = true; }
  check("deleting a production cannot silently drop its ledger", purgeBlocked);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL clearframe.allow_purge = 'on'");
    await client.query("DELETE FROM orgs WHERE id = $1", [org.id]);
    await client.query("COMMIT");
  } finally { client.release(); }
  const gone = await one("SELECT 1 FROM orgs WHERE id = $1", [org.id]);
  check("an explicit purge does remove everything", gone === null);

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}\n`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("self-test crashed:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
