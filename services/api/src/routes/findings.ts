import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, q, one, must } from "../core/db.js";
import { authenticate, requireRole } from "../core/auth.js";
import { badRequest, conflict, forbidden, notFound } from "../core/errors.js";
import { appendLedger } from "../core/ledger.js";
import { publish } from "../core/events.js";
import { enqueue } from "../jobs/queue.js";
import { armWatch, recordActivity, refreshProductionStatus } from "../pipeline/pass.js";
import { getObject } from "../core/storage.js";

const uuid = z.object({ id: z.string().uuid() });

async function ownedFinding(orgId: string, findingId: string) {
  const f = await one<any>(
    `SELECT f.*, p.org_id, p.title AS production_title, p.format AS production_format
     FROM findings f JOIN productions p ON p.id = f.production_id
     WHERE f.id = $1`,
    [findingId]
  );
  if (!f || f.org_id !== orgId) throw notFound("That finding does not exist.");
  return f;
}

export async function findingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // ------------------------------------------------------------ detail
  app.get("/api/findings/:id", async (req) => {
    const { id } = uuid.parse(req.params);
    const finding = await ownedFinding(req.user!.orgId, id);

    const [evidence, activity, decision, outreach, watch] = await Promise.all([
      q(`SELECT id, url, title, domain, stance, note, publish_date, retrieved_at, round,
                snapshot_key IS NOT NULL AS has_snapshot
         FROM evidence WHERE finding_id = $1 ORDER BY round ASC, id ASC`, [id]),
      q("SELECT id, stage, text, created_at FROM activity WHERE finding_id = $1 ORDER BY id ASC", [id]),
      one(`SELECT action, rationale, actor_name, actor_role, created_at
           FROM decisions WHERE finding_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]),
      one("SELECT addressed_to, subject, body, state, approved_name, approved_at, error FROM outreach WHERE finding_id = $1", [id]),
      one("SELECT state, last_checked_at, next_check_at FROM watches WHERE finding_id = $1", [id]),
    ]);

    return { finding, evidence, activity, decision, outreach, watch };
  });

  // The excerpt captured when the source was retrieved, so evidence survives
  // the page changing or going dark.
  app.get("/api/evidence/:id/snapshot", async (req, reply) => {
    const { id } = uuid.parse(req.params);
    const row = await one<{ snapshot_key: string | null; org_id: string; url: string }>(
      `SELECT e.snapshot_key, e.url, p.org_id
       FROM evidence e JOIN findings f ON f.id = e.finding_id JOIN productions p ON p.id = f.production_id
       WHERE e.id = $1`,
      [id]
    );
    if (!row || row.org_id !== req.user!.orgId) throw notFound("That source does not exist.");
    if (!row.snapshot_key) throw notFound("No snapshot was captured for that source.");
    const buf = await getObject(row.snapshot_key);
    reply.header("Content-Type", "text/plain; charset=utf-8");
    return buf;
  });

  // ---------------------------------------------------------- decision
  app.post("/api/findings/:id/decision", { preHandler: [requireRole("counsel")] }, async (req) => {
    const { id } = uuid.parse(req.params);
    const body = z
      .object({
        action: z.enum(["approved", "licensed", "replaced", "rejected"]),
        rationale: z.string().max(4000).default(""),
      })
      .parse(req.body);

    const f = await ownedFinding(req.user!.orgId, id);
    if (f.status === "withdrawn") throw conflict("That element is not in the current cut.");
    if (!["review", "cleared", "approved", "licensed", "replaced", "rejected"].includes(f.status)) {
      throw conflict("That finding is still under investigation.");
    }

    await q(
      `INSERT INTO decisions (finding_id, action, rationale, actor_id, actor_name, actor_role)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, body.action, body.rationale, req.user!.id, req.user!.name, req.user!.role]
    );
    await q("UPDATE findings SET status = $2, updated_at = now() WHERE id = $1", [id, body.action]);

    const label = {
      approved: "Clear for use", licensed: "Pursue licence",
      replaced: "Replace element", rejected: "Remove from cut",
    }[body.action];

    await recordActivity(f.production_id, id, "Decision", `${label} — recorded by ${req.user!.name}`);
    await appendLedger(f.production_id, req.user!.name, {
      type: "decision", finding: f.item, action: body.action,
      rationale: body.rationale, role: req.user!.role, by: req.user!.email,
    });

    // Resolving a finding arms a watch on it. Nothing stays closed forever.
    await armWatch(id);

    if (body.action === "licensed") {
      await q(
        `INSERT INTO outreach (finding_id, addressed_to, subject, body, state)
         VALUES ($1,'','','','drafting')
         ON CONFLICT (finding_id) DO UPDATE SET state = 'drafting', error = NULL`,
        [id]
      );
      await enqueue({ productionId: f.production_id, kind: "outreach.draft", payload: { findingId: id } });
    }

    await publish(pool, f.production_id, "finding", { findingId: id, status: body.action });
    await refreshProductionStatus(f.production_id);
    return { status: body.action };
  });

  // ---------------------------------------------------- approve outreach
  app.post("/api/findings/:id/outreach/approve", { preHandler: [requireRole("counsel")] }, async (req) => {
    const { id } = uuid.parse(req.params);
    const f = await ownedFinding(req.user!.orgId, id);
    const o = await one<{ state: string; addressed_to: string }>(
      "SELECT state, addressed_to FROM outreach WHERE finding_id = $1", [id]
    );
    if (!o) throw notFound("No inquiry has been drafted for that finding.");
    if (o.state !== "draft") throw conflict(`That inquiry is ${o.state}, not awaiting approval.`);

    await q(
      `UPDATE outreach SET state = 'approved', approved_by = $2, approved_name = $3, approved_at = now()
       WHERE finding_id = $1`,
      [id, req.user!.id, req.user!.name]
    );
    await recordActivity(f.production_id, id, "Outreach", `Inquiry approved for sending by ${req.user!.name}`);
    await appendLedger(f.production_id, req.user!.name, {
      type: "outreach_approved", finding: f.item, addressedTo: o.addressed_to, by: req.user!.email,
    });
    await publish(pool, f.production_id, "outreach", { findingId: id });
    return { state: "approved" };
  });

  // ------------------------------------------------------- re-check now
  app.post("/api/findings/:id/recheck", { preHandler: [requireRole("producer", "coordinator", "counsel")] }, async (req) => {
    const { id } = uuid.parse(req.params);
    const f = await ownedFinding(req.user!.orgId, id);
    const pending = await one(
      `SELECT 1 FROM jobs WHERE kind = 'finding.recheck' AND state IN ('ready','running')
       AND payload->>'findingId' = $1 LIMIT 1`, [id]
    );
    if (pending) throw conflict("A re-check is already running on that finding.");
    await enqueue({
      productionId: f.production_id, kind: "finding.recheck",
      payload: { findingId: id, trigger: `manual by ${req.user!.name}` },
    });
    return { queued: true };
  });

  // ----------------------------------------------- coordinator metadata
  app.patch("/api/findings/:id", { preHandler: [requireRole("coordinator", "producer", "counsel")] }, async (req) => {
    const { id } = uuid.parse(req.params);
    const body = z
      .object({
        scene: z.string().max(80).optional(),
        page: z.string().max(12).nullable().optional(),
        context: z.string().max(400).optional(),
      })
      .parse(req.body);
    const f = await ownedFinding(req.user!.orgId, id);
    const keys = Object.keys(body) as (keyof typeof body)[];
    if (!keys.length) throw badRequest("Nothing to change.");
    await q(
      `UPDATE findings SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
      [id, ...keys.map((k) => body[k])]
    );
    await appendLedger(f.production_id, req.user!.name, {
      type: "metadata_edited", finding: f.item, fields: keys, by: req.user!.email,
    });
    return { ok: true };
  });
}

// ------------------------------------------------------------- approvals

export { ownedFinding };

