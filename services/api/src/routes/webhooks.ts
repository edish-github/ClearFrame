import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { one } from "../core/db.js";
import { enqueue } from "../jobs/queue.js";
import { env } from "../core/env.js";

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Inbound Monitor callbacks. The signature is verified before anything is
   * queued; unverified events are logged and dropped rather than trusted.
   */
  app.post("/api/webhooks/parallel", { config: { rawBody: true } }, async (req, reply) => {
    const secret = env.parallel.webhookSecret;
    if (!secret) return reply.code(503).send({ error: "Webhooks are not configured." });

    const signature = String(req.headers["webhook-signature"] ?? req.headers["x-parallel-signature"] ?? "");
    const raw = (req as any).rawBody as string | undefined;
    if (!raw || !signature) return reply.code(400).send({ error: "Missing signature." });

    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    const provided = signature.replace(/^sha256=/, "");
    const ok =
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!ok) {
      req.log.warn("[webhook] rejected event with bad signature");
      return reply.code(401).send({ error: "Bad signature." });
    }

    const body = req.body as any;
    const monitorId = body?.monitor_id ?? body?.data?.monitor_id;
    if (!monitorId) return reply.code(202).send({ ok: true });

    const watch = await one<{ finding_id: string; production_id: string }>(
      `SELECT w.finding_id, f.production_id FROM watches w
       JOIN findings f ON f.id = w.finding_id
       WHERE w.provider_watch_id = $1`,
      [String(monitorId)]
    );
    if (!watch) return reply.code(202).send({ ok: true });

    await enqueue({
      productionId: watch.production_id,
      kind: "finding.recheck",
      payload: { findingId: watch.finding_id, trigger: "monitor webhook" },
    });
    return reply.code(202).send({ ok: true });
  });
}
