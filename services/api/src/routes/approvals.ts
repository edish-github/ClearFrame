import type { FastifyInstance } from "fastify";
import { q } from "../core/db.js";
import { authenticate } from "../core/auth.js";

/** Everything waiting on a person: decisions to make, inquiries to release. */
export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  app.get("/api/approvals", async (req) => {
    const decisions = await q(
      `SELECT f.id, f.item, f.category, f.scene, f.page, f.risk, f.confidence,
              f.assessment, f.recommendation, f.chains, f.summary,
              p.id AS production_id, p.title AS production_title,
              (SELECT count(*) FROM evidence e WHERE e.finding_id = f.id)::int AS evidence_count,
              (SELECT count(*) FROM evidence e WHERE e.finding_id = f.id AND e.stance = 'conflicts')::int AS conflicts
       FROM findings f JOIN productions p ON p.id = f.production_id
       WHERE p.org_id = $1 AND f.status = 'review'
       ORDER BY (f.risk = 'HIGH') DESC NULLS LAST, f.updated_at ASC`,
      [req.user!.orgId]
    );
    const outreach = await q(
      `SELECT f.id, f.item, f.category, p.id AS production_id, p.title AS production_title,
              o.addressed_to, o.subject, o.body, o.state, o.created_at
       FROM outreach o
       JOIN findings f ON f.id = o.finding_id
       JOIN productions p ON p.id = f.production_id
       WHERE p.org_id = $1 AND o.state = 'draft'
       ORDER BY o.created_at ASC`,
      [req.user!.orgId]
    );
    return { decisions, outreach };
  });
}

// -------------------------------------------------------------- webhooks
