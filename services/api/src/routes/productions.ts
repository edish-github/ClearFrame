import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, one, must, tx } from "../core/db.js";
import { authenticate, requireRole } from "../core/auth.js";
import { badRequest, conflict, notFound } from "../core/errors.js";
import { putObject, sha256Hex } from "../core/storage.js";
import { appendLedger } from "../core/ledger.js";
import { enqueue } from "../jobs/queue.js";
import { subscribe } from "../core/events.js";

const USD = 1_000_000;

async function ownedProduction(orgId: string, id: string) {
  const p = await one<any>("SELECT * FROM productions WHERE id = $1 AND org_id = $2", [id, orgId]);
  if (!p) throw notFound("That production does not exist.");
  return p;
}

export async function productionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // ------------------------------------------------------------ list
  app.get("/api/productions", async (req) => {
    const rows = await q(
      `SELECT p.id, p.title, p.format, p.status, p.error,
              p.budget_cap_micros, p.spent_micros, p.created_at, p.updated_at,
              (SELECT count(*) FROM cuts c WHERE c.production_id = p.id)::int AS cuts,
              (SELECT filename FROM cuts c WHERE c.production_id = p.id ORDER BY n DESC LIMIT 1) AS script,
              (SELECT count(*) FROM findings f WHERE f.production_id = p.id AND f.status <> 'withdrawn')::int AS total,
              (SELECT count(*) FROM findings f WHERE f.production_id = p.id AND f.status IN ('cleared','approved','licensed','replaced','rejected'))::int AS resolved,
              (SELECT count(*) FROM findings f WHERE f.production_id = p.id AND f.status = 'review')::int AS review,
              (SELECT count(*) FROM findings f WHERE f.production_id = p.id AND f.status = 'withdrawn')::int AS withdrawn,
              (SELECT count(*) FROM findings f WHERE f.production_id = p.id
                 AND f.status IN ('queued','researching','verifying','tracing','assessing','held','failed'))::int AS open,
              (SELECT count(*) FROM outreach o JOIN findings f ON f.id = o.finding_id
                 WHERE f.production_id = p.id AND o.state = 'draft')::int AS outreach_pending,
              (SELECT signed_at IS NOT NULL FROM reports r WHERE r.production_id = p.id
                 ORDER BY generated_at DESC LIMIT 1) AS signed
       FROM productions p
       WHERE p.org_id = $1
       ORDER BY p.updated_at DESC`,
      [req.user!.orgId]
    );
    return { productions: rows };
  });

  // ---------------------------------------------------------- create
  app.post("/api/productions", { preHandler: [requireRole("producer", "coordinator", "counsel")] }, async (req) => {
    const parts = req.parts();
    const fields: Record<string, string> = {};
    let file: { buffer: Buffer; filename: string; mimetype: string } | null = null;

    for await (const part of parts) {
      if (part.type === "file") {
        const buffer = await part.toBuffer();
        file = { buffer, filename: part.filename, mimetype: part.mimetype };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    const body = z
      .object({
        title: z.string().min(1).max(200),
        format: z.string().min(1).max(60).default("Feature film"),
        budgetUsd: z.coerce.number().positive().max(10_000),
        scriptText: z.string().optional(),
      })
      .parse(fields);

    if (!file && !(body.scriptText && body.scriptText.trim().length > 400)) {
      throw badRequest("Attach a screenplay file, or paste at least a few pages of script.");
    }

    const payload = file
      ? { buffer: file.buffer, filename: file.filename, mime: file.mimetype || "application/pdf" }
      : { buffer: Buffer.from(body.scriptText!, "utf8"), filename: "pasted-script.txt", mime: "text/plain" };

    if (!/^(application\/pdf|text\/plain|text\/markdown)$/.test(payload.mime)) {
      throw badRequest("Screenplays must be PDF or plain text.");
    }
    if (payload.buffer.length > 25 * 1024 * 1024) {
      throw badRequest("That file is over 25 MB. Upload a smaller export of the script.");
    }

    const stored = await putObject("scripts", payload.buffer, payload.mime, payload.filename);

    const { production, cut } = await tx(async (c) => {
      const p = (
        await c.query(
          `INSERT INTO productions (org_id, title, format, budget_cap_micros, created_by, status)
           VALUES ($1,$2,$3,$4,$5,'breakdown') RETURNING *`,
          [req.user!.orgId, body.title, body.format, Math.round(body.budgetUsd * USD), req.user!.id]
        )
      ).rows[0];
      const cut = (
        await c.query(
          `INSERT INTO cuts (production_id, n, filename, storage_key, mime_type, content_hash)
           VALUES ($1,1,$2,$3,$4,$5) RETURNING *`,
          [p.id, payload.filename, stored.key, payload.mime, stored.sha256]
        )
      ).rows[0];
      return { production: p, cut };
    });

    await appendLedger(production.id, req.user!.name, {
      type: "pass_opened", cut: 1, document: payload.filename,
      documentSha256: stored.sha256, budgetUsd: body.budgetUsd, by: req.user!.email,
    });
    await enqueue({
      productionId: production.id, kind: "pass.breakdown",
      payload: { productionId: production.id, cutId: cut.id },
    });

    return { production, cut };
  });

  // -------------------------------------------------------- read one
  app.get("/api/productions/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const production = await ownedProduction(req.user!.orgId, id);

    const [findings, cuts, spendBy, activity] = await Promise.all([
      q(`SELECT f.id, f.item, f.category, f.scene, f.page, f.context, f.status, f.risk, f.confidence,
                f.summary, f.assessment, f.recommendation, f.verification, f.chains, f.pass_n, f.tier, f.error,
                (SELECT count(*) FROM evidence e WHERE e.finding_id = f.id)::int AS evidence_count,
                (SELECT count(*) FROM evidence e WHERE e.finding_id = f.id AND e.stance = 'conflicts')::int AS conflicts,
                (SELECT state FROM outreach o WHERE o.finding_id = f.id) AS outreach_state
         FROM findings f WHERE f.production_id = $1
         ORDER BY (f.risk = 'HIGH') DESC NULLS LAST, f.created_at ASC`, [id]),
      q("SELECT id, n, filename, stats, created_at FROM cuts WHERE production_id = $1 ORDER BY n ASC", [id]),
      q(`SELECT stage, sum(cost_micros)::bigint AS cost_micros, count(*)::int AS calls
         FROM cost_events WHERE production_id = $1 GROUP BY stage ORDER BY 2 DESC`, [id]),
      q(`SELECT a.id, a.finding_id, a.stage, a.text, a.created_at, f.item
         FROM activity a LEFT JOIN findings f ON f.id = a.finding_id
         WHERE a.production_id = $1 ORDER BY a.id DESC LIMIT 60`, [id]),
    ]);

    return { production, findings, cuts, spendBy, activity };
  });

  // --------------------------------------------------------- new cut
  app.post("/api/productions/:id/cuts", { preHandler: [requireRole("producer", "coordinator", "counsel")] }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const production = await ownedProduction(req.user!.orgId, id);

    const busy = await one(
      "SELECT 1 FROM jobs WHERE production_id = $1 AND state IN ('ready','running') LIMIT 1",
      [id]
    );
    if (busy) throw conflict("A pass is already running on this production. Wait for it to finish.");

    const data = await req.file();
    if (!data) throw badRequest("Attach the revised screenplay.");
    const buffer = await data.toBuffer();
    const mime = data.mimetype || "application/pdf";
    if (!/^(application\/pdf|text\/plain|text\/markdown)$/.test(mime)) {
      throw badRequest("Screenplays must be PDF or plain text.");
    }

    const hash = sha256Hex(buffer);
    const prior = await one<{ n: number }>(
      "SELECT n FROM cuts WHERE production_id = $1 AND content_hash = $2", [id, hash]
    );
    if (prior) throw conflict(`That file is byte-identical to cut ${prior.n}. Nothing would change.`);

    const stored = await putObject("scripts", buffer, mime, data.filename);
    const next = await must<{ n: number }>(
      "SELECT COALESCE(max(n),0) + 1 AS n FROM cuts WHERE production_id = $1", [id]
    );
    const cut = await must(
      `INSERT INTO cuts (production_id, n, filename, storage_key, mime_type, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, next.n, data.filename, stored.key, mime, hash]
    );

    await appendLedger(id, req.user!.name, {
      type: "cut_uploaded", cut: next.n, document: data.filename, documentSha256: hash, by: req.user!.email,
    });
    await enqueue({ productionId: id, kind: "pass.breakdown", payload: { productionId: id, cutId: cut.id } });
    return { cut, production };
  });

  // ---------------------------------------------------------- resume
  app.post("/api/productions/:id/resume", { preHandler: [requireRole("producer", "coordinator", "counsel")] }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await ownedProduction(req.user!.orgId, id);
    const stuck = await q<{ id: string }>(
      "SELECT id FROM findings WHERE production_id = $1 AND status IN ('held','queued','failed')", [id]
    );
    for (const f of stuck) {
      await enqueue({ productionId: id, kind: "finding.investigate", payload: { findingId: f.id } });
    }
    if (stuck.length) {
      await q("UPDATE productions SET status = 'running', updated_at = now() WHERE id = $1", [id]);
      await appendLedger(id, req.user!.name, { type: "pass_resumed", queued: stuck.length });
    }
    return { queued: stuck.length };
  });

  // ------------------------------------------------------ raise cap
  app.post("/api/productions/:id/budget", { preHandler: [requireRole("producer", "counsel")] }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ budgetUsd: z.number().positive().max(10_000) }).parse(req.body);
    const p = await ownedProduction(req.user!.orgId, id);
    const next = Math.round(body.budgetUsd * USD);
    if (next < p.spent_micros) throw badRequest("The new cap is below what this pass has already spent.");
    await q("UPDATE productions SET budget_cap_micros = $2, updated_at = now() WHERE id = $1", [id, next]);
    await appendLedger(id, req.user!.name, { type: "budget_raised", toUsd: body.budgetUsd });
    return { budgetCapMicros: next };
  });

  // ----------------------------------------------------- live stream
  app.get("/api/productions/:id/stream", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await ownedProduction(req.user!.orgId, id);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`event: ready\ndata: {"productionId":"${id}"}\n\n`);

    const unsubscribe = subscribe(id, (evt) => {
      reply.raw.write(`event: ${evt.kind}\ndata: ${JSON.stringify(evt)}\n\n`);
    });
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 20_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return reply;
  });

  // ---------------------------------------------------------- ledger
  app.get("/api/productions/:id/ledger", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await ownedProduction(req.user!.orgId, id);
    const entries = await q(
      "SELECT seq, ts, actor, event, prev_hash, hash FROM ledger WHERE production_id = $1 ORDER BY seq ASC", [id]
    );
    return { entries };
  });
}

export { ownedProduction };
