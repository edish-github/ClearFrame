import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, q, lockKey } from "./db.js";

export const ZERO_HASH = "0".repeat(64);

/**
 * Deterministic JSON with recursively sorted object keys.
 *
 * This matters more than it looks. Postgres jsonb does not preserve key order,
 * so an event written as {type, cut} reads back as {cut, type}. Hashing the
 * naive JSON.stringify would make every chain fail verification the moment it
 * was read from disk. Both write and verify go through this function, so the
 * hash depends on the event's content and not on how a store happened to
 * serialise it.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Canonical serialisation of a ledger entry. The hash covers the sequence
 * number, timestamp, actor, event body and the previous hash, so reordering,
 * editing or removing any entry breaks every hash after it.
 */
function canonical(e: {
  seq: number; ts: string; actor: string; event: unknown; prevHash: string;
}): string {
  return canonicalJson({ seq: e.seq, ts: e.ts, actor: e.actor, event: e.event, prev_hash: e.prevHash });
}

export function hashEntry(e: {
  seq: number; ts: string; actor: string; event: unknown; prevHash: string;
}): string {
  return createHash("sha256").update(canonical(e)).digest("hex");
}

export interface LedgerEvent {
  type: string;
  [k: string]: unknown;
}

/**
 * Append one entry. Takes an advisory lock on the production so two workers
 * can never allocate the same seq and fork the chain.
 */
export async function appendLedger(
  productionId: string,
  actor: string,
  event: LedgerEvent,
  client?: PoolClient
): Promise<{ seq: number; hash: string }> {
  const run = async (c: PoolClient) => {
    await c.query("SELECT pg_advisory_xact_lock($1, $2)", [lockKey(productionId), 7]);
    const prev = await c.query(
      "SELECT seq, hash FROM ledger WHERE production_id = $1 ORDER BY seq DESC LIMIT 1",
      [productionId]
    );
    const seq = (prev.rows[0]?.seq ?? 0) + 1;
    const prevHash: string = prev.rows[0]?.hash ?? ZERO_HASH;
    const ts = new Date().toISOString();
    const hash = hashEntry({ seq, ts, actor, event, prevHash });
    await c.query(
      `INSERT INTO ledger (production_id, seq, ts, actor, event, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [productionId, seq, ts, actor, JSON.stringify(event), prevHash, hash]
    );
    return { seq, hash };
  };

  if (client) return run(client);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await run(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

export interface Integrity {
  ok: boolean;
  length: number;
  head: string;
  brokenAt?: number;
}

/** Recompute the whole chain from stored rows. */
export async function verifyChain(productionId: string): Promise<Integrity> {
  const rows = await q<{ seq: number; ts: string; actor: string; event: unknown; prev_hash: string; hash: string }>(
    "SELECT seq, ts, actor, event, prev_hash, hash FROM ledger WHERE production_id = $1 ORDER BY seq ASC",
    [productionId]
  );
  let prevHash = ZERO_HASH;
  for (const r of rows) {
    if (r.prev_hash !== prevHash) return { ok: false, length: rows.length, head: prevHash, brokenAt: r.seq };
    const ts = typeof r.ts === "string" ? r.ts : new Date(r.ts).toISOString();
    const expected = hashEntry({ seq: r.seq, ts, actor: r.actor, event: r.event, prevHash });
    if (expected !== r.hash) return { ok: false, length: rows.length, head: prevHash, brokenAt: r.seq };
    prevHash = r.hash;
  }
  return { ok: true, length: rows.length, head: prevHash };
}

export async function ledgerHead(productionId: string): Promise<{ head: string; length: number }> {
  const rows = await q<{ hash: string; seq: number }>(
    "SELECT hash, seq FROM ledger WHERE production_id = $1 ORDER BY seq DESC LIMIT 1",
    [productionId]
  );
  const r = rows[0];
  return { head: r?.hash ?? ZERO_HASH, length: r?.seq ?? 0 };
}
