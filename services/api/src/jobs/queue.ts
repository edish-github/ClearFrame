import { randomUUID } from "node:crypto";
import { pool, q, one } from "../core/db.js";
import { env } from "../core/env.js";

/**
 * Durable job queue on Postgres. Claims use FOR UPDATE SKIP LOCKED so many
 * workers can drain the same queue, and a worker that dies mid-job releases its
 * claim on the reaper's next sweep rather than losing the work.
 */

export type JobKind =
  | "pass.breakdown"
  | "finding.investigate"
  | "finding.recheck"
  | "outreach.draft"
  | "report.render";

export interface Job {
  id: string;
  production_id: string | null;
  kind: JobKind;
  payload: Record<string, any>;
  attempts: number;
  max_attempts: number;
}

export async function enqueue(args: {
  productionId: string | null;
  kind: JobKind;
  payload?: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
}): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO jobs (production_id, kind, payload, run_at, max_attempts)
     VALUES ($1,$2,$3,COALESCE($4, now()),$5) RETURNING id`,
    [args.productionId, args.kind, JSON.stringify(args.payload ?? {}), args.runAt ?? null, args.maxAttempts ?? 3]
  );
  return row!.id;
}

export async function claim(workerId: string): Promise<Job | null> {
  const rows = await q<Job>(
    `UPDATE jobs SET state = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
       WHERE state = 'ready' AND run_at <= now()
       ORDER BY run_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, production_id, kind, payload, attempts, max_attempts`,
    [workerId]
  );
  return rows[0] ?? null;
}

export async function complete(id: string): Promise<void> {
  await q("UPDATE jobs SET state = 'done', locked_at = NULL, locked_by = NULL WHERE id = $1", [id]);
}

/** Hands a claimed job straight back, unchanged. Used when a worker declines it. */
export async function release(id: string): Promise<void> {
  await q(
    "UPDATE jobs SET state = 'ready', locked_at = NULL, locked_by = NULL WHERE id = $1 AND state = 'running'",
    [id]
  );
}

export async function fail(job: Job, error: string): Promise<void> {
  const exhausted = job.attempts >= job.max_attempts;
  if (exhausted) {
    await q("UPDATE jobs SET state = 'failed', last_error = $2, locked_at = NULL, locked_by = NULL WHERE id = $1",
      [job.id, error.slice(0, 2000)]);
    return;
  }
  // exponential backoff: 30s, 2m, 8m
  const delaySeconds = 30 * 4 ** (job.attempts - 1);
  await q(
    `UPDATE jobs SET state = 'ready', last_error = $2, locked_at = NULL, locked_by = NULL,
       run_at = now() + ($3 || ' seconds')::interval
     WHERE id = $1`,
    [job.id, error.slice(0, 2000), String(delaySeconds)]
  );
}

/** Releases jobs whose worker vanished. */
export async function reapStalled(olderThanMinutes = 20): Promise<number> {
  const rows = await q<{ id: string }>(
    `UPDATE jobs SET state = 'ready', locked_at = NULL, locked_by = NULL
     WHERE state = 'running' AND locked_at < now() - ($1 || ' minutes')::interval
     RETURNING id`,
    [String(olderThanMinutes)]
  );
  return rows.length;
}

/** Queues due monitor re-checks. */
export async function scheduleDueWatches(): Promise<number> {
  const due = await q<{ finding_id: string; production_id: string }>(
    `SELECT w.finding_id, f.production_id
     FROM watches w JOIN findings f ON f.id = w.finding_id
     WHERE w.state = 'active' AND w.next_check_at <= now()
       AND f.status IN ('cleared','approved','licensed','replaced','rejected')
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.kind = 'finding.recheck' AND j.state IN ('ready','running')
           AND j.payload->>'findingId' = w.finding_id::text
       )
     LIMIT 50`
  );
  for (const d of due) {
    await enqueue({
      productionId: d.production_id,
      kind: "finding.recheck",
      payload: { findingId: d.finding_id, trigger: "scheduled" },
    });
  }
  return due.length;
}

export const newWorkerId = (): string => `${process.env.HOSTNAME ?? "worker"}-${randomUUID().slice(0, 8)}`;
export { pool as queuePool, env as queueEnv };
