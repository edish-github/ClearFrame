import { existsSync } from "node:fs";
import { resolve } from "node:path";

for (const p of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  if (existsSync(p)) {
    try { (process as any).loadEnvFile?.(p); } catch {}
  }
}

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing required env var ${name}`);
  return v;
}
const num = (name: string, fallback: number): number => {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number`);
  return n;
};
const bool = (name: string, fallback = false): boolean => {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: num("PORT", 8080),
  publicUrl: process.env.PUBLIC_URL ?? "http://localhost:8080",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  jwtSecret: req("JWT_SECRET", "dev-only-secret-change-me-0000000000"),
  databaseUrl: req("DATABASE_URL", "postgres://clearframe:clearframe@localhost:5432/clearframe"),

  storage: {
    driver: (process.env.STORAGE_DRIVER ?? "local") as "local" | "gcs",
    localDir: process.env.STORAGE_LOCAL_DIR ?? "./.data",
    gcsBucket: process.env.GCS_BUCKET ?? "",
  },

  gemini: {
    project: process.env.GOOGLE_CLOUD_PROJECT ?? "",
    location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
    pro: process.env.GEMINI_MODEL_PRO ?? "gemini-2.5-pro",
    flash: process.env.GEMINI_MODEL_FLASH ?? "gemini-2.5-flash",
    price: {
      pro: { in: num("GEMINI_PRO_INPUT_PER_MTOK", 1.25), out: num("GEMINI_PRO_OUTPUT_PER_MTOK", 10) },
      flash: { in: num("GEMINI_FLASH_INPUT_PER_MTOK", 0.3), out: num("GEMINI_FLASH_OUTPUT_PER_MTOK", 2.5) },
    },
  },

  parallel: {
    apiKey: process.env.PARALLEL_API_KEY ?? "",
    baseUrl: process.env.PARALLEL_BASE_URL ?? "https://api.parallel.ai",
    searchUsd: num("PARALLEL_SEARCH_USD", 0.005),
    taskCoreUsd: num("PARALLEL_TASK_CORE_USD", 0.05),
    taskProUsd: num("PARALLEL_TASK_PRO_USD", 0.3),
    monitorsEnabled: bool("PARALLEL_MONITORS_ENABLED", false),
    webhookSecret: process.env.PARALLEL_WEBHOOK_SECRET ?? "",
  },

  worker: {
    concurrency: num("WORKER_CONCURRENCY", 4),
    pollMs: num("WORKER_POLL_MS", 1000),
    monitorIntervalHours: num("MONITOR_INTERVAL_HOURS", 24),
  },

  internalSweepSecret: process.env.INTERNAL_SWEEP_SECRET ?? "",
};

export function assertProvidersConfigured(): void {
  const missing: string[] = [];
  if (!env.gemini.project) missing.push("GOOGLE_CLOUD_PROJECT");
  if (!env.parallel.apiKey) missing.push("PARALLEL_API_KEY");
  if (missing.length) {
    throw new Error(
      `${missing.join(" and ")} not set. ClearFrame will not start without them: ` +
        `the pipeline has no fallback that invents rights data.`
    );
  }
}
