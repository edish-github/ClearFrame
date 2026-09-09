import type { FastifyInstance } from "fastify";
import { authRoutes } from "./auth.js";
import { productionRoutes } from "./productions.js";
import { findingRoutes } from "./findings.js";
import { approvalRoutes } from "./approvals.js";
import { reportRoutes } from "./reports.js";
import { webhookRoutes } from "./webhooks.js";
import { internalRoutes } from "./internal.js";

/** Single place that knows the whole HTTP surface. */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(authRoutes);
  await app.register(productionRoutes);
  await app.register(findingRoutes);
  await app.register(approvalRoutes);
  await app.register(reportRoutes);
  await app.register(webhookRoutes);
  await app.register(internalRoutes);
}
