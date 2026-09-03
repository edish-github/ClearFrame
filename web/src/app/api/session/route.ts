import { NextRequest, NextResponse } from "next/server";
import { ROLE_COOKIE, demoIdentityEnabled } from "@/lib/upstream";
import type { Role } from "@/lib/contracts";

const ROLES: Role[] = ["producer", "coordinator", "counsel", "reviewer"];

/**
 * Choose which role you are acting as.
 *
 * Only available in demo mode. In a real deployment the role comes from the
 * signed-in identity, and this endpoint refuses. Either way the *authority* lives
 * in the ledger's role binding, not in this cookie: picking "counsel" here does
 * nothing unless that subject is actually bound to counsel on the project.
 */
export async function POST(request: NextRequest) {
  if (!demoIdentityEnabled) {
    return NextResponse.json(
      { detail: "role selection is disabled; sign in instead" },
      { status: 403 },
    );
  }

  const { role } = (await request.json()) as { role?: Role };
  if (!role || !ROLES.includes(role)) {
    return NextResponse.json({ detail: `role must be one of ${ROLES}` }, { status: 400 });
  }

  const response = NextResponse.json({ ok: true, role });
  response.cookies.set(ROLE_COOKIE, role, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return response;
}
