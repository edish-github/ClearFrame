import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { reapStalled, scheduleDueWatches } from "../jobs/queue.js";
import { env } from "../core/env.js";

/**
 * Called by Cloud Scheduler, not by a person. Guarded by a shared secret rather
 * than a session, because there is no user behind it.
 */
export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/internal/sweep", async (req, reply) => {
    const secret = env.internalSweepSecret;
    if (!secret) return reply.code(503).send({ error: "Sweeps are not configured." });

    const provided = String(req.headers["x-clearframe-sweep"] ?? "");
    const ok =
      provided.length === secret.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
    if (!ok) return reply.code(401).send({ error: "Bad sweep credential." });

    const [released, queued] = [await reapStalled(), await scheduleDueWatches()];
    return { released, queued };
  });
}
