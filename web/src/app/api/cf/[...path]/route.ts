import { NextRequest, NextResponse } from "next/server";
import { callUpstream } from "@/lib/upstream";

/** Proxy to the orchestrator: everything the war room reads, plus pass control. */
async function proxy(request: NextRequest, path: string[]): Promise<NextResponse> {
  const target = `/${path.join("/")}${request.nextUrl.search}`;
  const method = request.method;
  const body =
    method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

  const init: RequestInit = { method, body };
  const contentType = request.headers.get("content-type");
  if (contentType) init.headers = { "content-type": contentType };

  try {
    const response = await callUpstream("orchestrator", target, init);
    const payload = await response.arrayBuffer();
    return new NextResponse(payload, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { detail: `the orchestrator is unreachable: ${(error as Error).message}` },
      { status: 502 },
    );
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).path);
}
export async function POST(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).path);
}
export async function PUT(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).path);
}
export async function DELETE(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).path);
}
