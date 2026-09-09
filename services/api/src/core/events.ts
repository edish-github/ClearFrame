import pg from "pg";
import { env } from "./env.js";

/**
 * Live updates. Producers NOTIFY on a Postgres channel; every API instance
 * LISTENs and fans out to its own SSE subscribers, so the stream works with
 * more than one server process and with workers on separate machines.
 */

export interface StreamEvent {
  productionId: string;
  kind: string;
  data: Record<string, unknown>;
  at: string;
}

type Sink = (e: StreamEvent) => void;

const subscribers = new Map<string, Set<Sink>>();
let listener: pg.Client | null = null;

export function subscribe(productionId: string, sink: Sink): () => void {
  let set = subscribers.get(productionId);
  if (!set) { set = new Set(); subscribers.set(productionId, set); }
  set.add(sink);
  return () => {
    set!.delete(sink);
    if (set!.size === 0) subscribers.delete(productionId);
  };
}

export async function startEventListener(): Promise<void> {
  if (listener) return;
  const client = new pg.Client({ connectionString: env.databaseUrl });
  client.on("error", (err) => {
    console.error("[events] listener error, reconnecting", err.message);
    listener = null;
    setTimeout(() => void startEventListener(), 2000);
  });
  await client.connect();
  await client.query("LISTEN clearframe_events");
  client.on("notification", (msg) => {
    if (!msg.payload) return;
    try {
      const evt = JSON.parse(msg.payload) as StreamEvent;
      for (const sink of subscribers.get(evt.productionId) ?? []) sink(evt);
    } catch { /* malformed payload, drop */ }
  });
  listener = client;
}

/** Publish through the pool the caller already owns. */
export async function publish(
  exec: { query: (t: string, p?: any[]) => Promise<unknown> },
  productionId: string,
  kind: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  const payload = JSON.stringify({ productionId, kind, data, at: new Date().toISOString() });
  // pg_notify payloads are capped at 8000 bytes; keep events small by design.
  if (payload.length > 7500) {
    await exec.query("SELECT pg_notify('clearframe_events', $1)", [
      JSON.stringify({ productionId, kind, data: {}, at: new Date().toISOString() }),
    ]);
    return;
  }
  await exec.query("SELECT pg_notify('clearframe_events', $1)", [payload]);
}
