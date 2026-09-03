import { cookies } from "next/headers";
import { GoogleAuth } from "google-auth-library";
import type { Role } from "@/lib/contracts";

/**
 * The browser never talks to a ClearFrame service directly.
 *
 * The orchestrator and the ledger are deployed with no public invoker, so the war
 * room proxies through its own server, attaching a Google-issued identity token
 * for the service and naming the acting human in a header the ledger only accepts
 * from this service account. That keeps every credential on the server and keeps
 * the role decision where it belongs — server-side, in the ledger.
 */

export const ROLE_COOKIE = "cf_role";

export type Upstream = "orchestrator" | "ledger" | "renderer";

const BASE: Record<Upstream, string> = {
  orchestrator: process.env.URL_ORCHESTRATOR ?? "http://localhost:8080",
  ledger: process.env.URL_LEDGER ?? "http://localhost:8082",
  renderer: process.env.URL_RENDERER ?? "http://localhost:8084",
};

const DEMO_SUBJECTS: Record<Role, string> = {
  producer: process.env.DEMO_SUBJECT_PRODUCER ?? "producer@clearframe.dev",
  coordinator: process.env.DEMO_SUBJECT_COORDINATOR ?? "coord@clearframe.dev",
  counsel: process.env.DEMO_SUBJECT_COUNSEL ?? "counsel@clearframe.dev",
  reviewer: process.env.DEMO_SUBJECT_REVIEWER ?? "reviewer@clearframe.dev",
};

export function baseUrl(target: Upstream): string {
  return BASE[target].replace(/\/$/, "");
}

export const demoIdentityEnabled =
  (process.env.NEXT_PUBLIC_DEMO_IDENTITY ?? "").toLowerCase() === "true";

export async function actingRole(): Promise<Role> {
  const jar = await cookies();
  const value = jar.get(ROLE_COOKIE)?.value as Role | undefined;
  const known: Role[] = ["producer", "coordinator", "counsel", "reviewer"];
  return value && known.includes(value) ? value : "producer";
}

export async function actingSubject(): Promise<string> {
  return DEMO_SUBJECTS[await actingRole()];
}

let auth: GoogleAuth | null = null;

/** An identity token for a private Cloud Run service, cached by the library. */
async function identityToken(audience: string): Promise<string | null> {
  if (audience.startsWith("http://localhost")) return null;
  try {
    auth ??= new GoogleAuth();
    const client = await auth.getIdTokenClient(audience);
    const headers = await client.getRequestHeaders();
    const authorization = new Headers(headers).get("authorization");
    return authorization?.replace(/^Bearer\s+/i, "") ?? null;
  } catch (error) {
    console.error("could not mint an identity token", error);
    return null;
  }
}

export async function upstreamHeaders(
  target: Upstream,
  extra: HeadersInit = {},
): Promise<Headers> {
  const headers = new Headers(extra);
  const token = await identityToken(baseUrl(target));
  if (token) headers.set("authorization", `Bearer ${token}`);
  // Names the human on whose behalf this request is made. The ledger accepts it
  // only from this service account, and resolves the role itself.
  headers.set("x-clearframe-subject", await actingSubject());
  return headers;
}

export async function callUpstream(
  target: Upstream,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = await upstreamHeaders(target, init.headers ?? {});
  return fetch(`${baseUrl(target)}${path}`, { ...init, headers, cache: "no-store" });
}

/** Server-component helper: fetch JSON from a service, or null if it is unreachable. */
export async function fetchJson<T>(target: Upstream, path: string): Promise<T | null> {
  try {
    const response = await callUpstream(target, path);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
