import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "./env.js";
import { one } from "./db.js";
import { forbidden, unauthorized } from "./errors.js";

export type Role = "producer" | "coordinator" | "counsel" | "reviewer";

export interface Principal {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest { user?: Principal; }
}

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);
export const checkPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

export function issueToken(p: Principal): string {
  return jwt.sign({ sub: p.id, org: p.orgId, role: p.role, name: p.name, email: p.email }, env.jwtSecret, {
    expiresIn: "12h",
  });
}

export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  let token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  // EventSource cannot set headers, so the SSE route alone accepts the token as
  // a query parameter. It is deliberately not honoured anywhere else, because
  // tokens in query strings end up in access logs and referrers.
  if (!token && req.url.split("?")[0]?.endsWith("/stream")) {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    if (q.token) token = q.token;
  }

  if (!token) throw unauthorized();

  let claims: jwt.JwtPayload;
  try {
    claims = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload;
  } catch {
    throw unauthorized("That session has expired. Sign in again.");
  }

  const user = await one<{ id: string; org_id: string; email: string; name: string; role: Role }>(
    "SELECT id, org_id, email, name, role FROM users WHERE id = $1",
    [claims.sub]
  );
  if (!user) throw unauthorized();
  req.user = { id: user.id, orgId: user.org_id, email: user.email, name: user.name, role: user.role };
}

/** Authority checks live server side. The client never decides who may act. */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) {
      // Only claim "counsel only" when that is actually true, otherwise name
      // the roles that would work.
      throw forbidden(
        roles.length === 1 && roles[0] === "counsel"
          ? "Only counsel can take this action."
          : req.user.role === "reviewer"
            ? "This account has read-only access."
            : `This action needs one of these roles: ${roles.join(", ")}.`
      );
    }
  };
}

export const canWrite = (role: Role): boolean => role !== "reviewer";
