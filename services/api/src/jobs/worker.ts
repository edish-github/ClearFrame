import { assertProvidersConfigured, env } from "../core/env.js";
import { pool } from "../core/db.js";
import {
  claim, complete, fail, newWorkerId, reapStalled, scheduleDueWatches, type Job,
} from "./queue.js";
import { draftOutreachFor, investigateFinding, recheckFinding, runBreakdown } from "../pipeline/pass.js";
import { renderReport } from "../report/pdf.js";

assertProvidersConfigured();

const workerId = newWorkerId();
let shuttingDown = false;
let inFlight = 0;

async function handle(job: Job): Promise<void> {
  switch (job.kind) {
    case "pass.breakdown":
      await runBreakdown(job.payload.productionId, job.payload.cutId);
      return;
    case "finding.investigate":
      await investigateFinding(job.payload.findingId);
      return;
    case "finding.recheck":
      await recheckFinding(job.payload.findingId, job.payload.trigger ?? "scheduled");
      return;
    case "outreach.draft":
      await draftOutreachFor(job.payload.findingId);
      return;
    case "report.render":
      await renderReport(job.payload.reportId);
      return;
    default:
      throw new Error(`Unknown job kind ${job.kind}`);
  }
}

async function lane(): Promise<void> {
  while (!shuttingDown) {
    let job: Job | null = null;
    try {
      job = await claim(workerId);
    } catch (err) {
      console.error("[worker] claim failed:", (err as Error).message);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    if (!job) {
      await new Promise((r) => setTimeout(r, env.worker.pollMs));
      continue;
    }

    inFlight++;
    const started = Date.now();
    try {
      await handle(job);
      await complete(job.id);
      console.log(`[worker] ${job.kind} done in ${Date.now() - started}ms`);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      console.error(`[worker] ${job.kind} failed (attempt ${job.attempts}):`, message);
      await fail(job, message).catch(() => {});
      // Surface a terminal failure on the finding itself rather than leaving it spinning.
      if (job.kind === "finding.investigate" && job.attempts >= job.max_attempts) {
        await pool
          .query("UPDATE findings SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [
            job.payload.findingId, message.slice(0, 1000),
          ])
          .catch(() => {});
      }
    } finally {
      inFlight--;
    }
  }
}

async function housekeeping(): Promise<void> {
  while (!shuttingDown) {
    try {
      const reaped = await reapStalled();
      if (reaped) console.log(`[worker] released ${reaped} stalled job(s)`);
      const scheduled = await scheduleDueWatches();
      if (scheduled) console.log(`[worker] queued ${scheduled} monitor re-check(s)`);
    } catch (err) {
      console.error("[worker] housekeeping failed:", (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} received, draining`);
  shuttingDown = true;
  const deadline = Date.now() + 30_000;
  while (inFlight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`[worker] ${workerId} up, concurrency ${env.worker.concurrency}`);
void housekeeping();
await Promise.all(Array.from({ length: env.worker.concurrency }, () => lane()));
