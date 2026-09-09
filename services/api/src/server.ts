import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import { assertProvidersConfigured, env } from "./core/env.js";
import { pool } from "./core/db.js";
import { HttpError } from "./core/errors.js";
import { startEventListener } from "./core/events.js";
import { registerRoutes } from "./routes/index.js";

assertProvidersConfigured();

const app = Fastify({
  logger: { level: env.nodeEnv === "production" ? "info" : "debug" },
  bodyLimit: 30 * 1024 * 1024,
  trustProxy: true,
});

await app.register(cors, {
  origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(",").map((s) => s.trim()),
  credentials: true,
});
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

// Keep the raw body for webhook signature verification.
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  (req as any).rawBody = body as string;
  try { done(null, body ? JSON.parse(body as string) : {}); }
  catch (err) { done(err as Error, undefined); }
});

app.setErrorHandler((error, req, reply) => {
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return reply.code(400).send({
      error: first ? `${first.path.join(".") || "request"}: ${first.message}` : "Invalid request.",
      code: "bad_request",
      issues: error.issues,
    });
  }
  if (error instanceof HttpError) {
    return reply.code(error.status).send({ error: error.message, code: error.code });
  }
  if ((error as any).statusCode === 413) {
    return reply.code(413).send({ error: "That file is too large.", code: "too_large" });
  }
  req.log.error(error);
  return reply.code(500).send({ error: "Something went wrong on our side.", code: "internal" });
});

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true, service: "clearframe", time: new Date().toISOString() };
});

await registerRoutes(app);

await startEventListener();

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, closing`);
  await app.close();
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: env.port, host: "0.0.0.0" });
app.log.info(`ClearFrame API listening on ${env.publicUrl}`);
