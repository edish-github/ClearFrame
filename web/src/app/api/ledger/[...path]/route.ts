import { NextRequest, NextResponse } from "next/server";
import { callUpstream } from "@/lib/upstream";

/**
 * Proxy to the ledger API — the only write path the war room has.
 *
 * Deliberately narrow: the app may post decisions and bind roles, and nothing
 * else. A finding can never be written from a browser.
 */
const ALLOWED = [/^projects\/[^/]+\/decisions$/, /^projects\/[^/]+\/roles$/];

type Ctx = { params: Promise<{ path: string[] }> };

export async function POST(request: NextRequest, ctx: Ctx) {
  const path = (await ctx.params).path.join("/");
  if (!ALLOWED.some((pattern) => pattern.test(path))) {
    return NextResponse.json(
      { detail: "the war room may only post decisions to the ledger" },
      { status: 403 },
    );
  }

  const response = await callUpstream("ledger", `/${path}`, {
    method: "POST",
    body: await request.text(),
    headers: { "content-type": "application/json" },
  });
  const payload = await response.text();
  return new NextResponse(payload, {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  return POST(request, ctx);
}
