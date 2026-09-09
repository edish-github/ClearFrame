import pg from "pg";
import { env } from "./env.js";

// bigint columns come back as strings by default; we want numbers for money.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 12,
  idleTimeoutMillis: 30_000,
});

export type Row = Record<string, any>;

export async function q<T extends Row = Row>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function one<T extends Row = Row>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

export async function must<T extends Row = Row>(text: string, params: any[] = []): Promise<T> {
  const row = await one<T>(text, params);
  if (!row) throw new Error("Expected exactly one row");
  return row;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Postgres advisory lock keyed on a uuid, used to serialise ledger writes.
export function lockKey(uuid: string): number {
  let h = 0;
  for (let i = 0; i < uuid.length; i++) h = (Math.imul(h, 31) + uuid.charCodeAt(i)) | 0;
  return h;
}
