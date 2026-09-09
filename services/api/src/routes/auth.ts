import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { one, must, tx } from "../core/db.js";
import { checkPassword, hashPassword, issueToken, authenticate, requireRole, type Role } from "../core/auth.js";
import { conflict, unauthorized } from "../core/errors.js";

/** Accounts, sessions and org membership. Roles are assigned here and enforced everywhere else. */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/register", async (req) => {
    const body = z
      .object({
        orgName: z.string().min(1).max(120),
        name: z.string().min(1).max(120),
        email: z.string().email(),
        password: z.string().min(10, "Use at least 10 characters."),
        role: z.enum(["producer", "coordinator", "counsel", "reviewer"]).default("producer"),
      })
      .parse(req.body);

    const existing = await one("SELECT id FROM users WHERE lower(email) = lower($1)", [body.email]);
    if (existing) throw conflict("That email already has an account.");

    return tx(async (c) => {
      const org = (await c.query("INSERT INTO orgs (name) VALUES ($1) RETURNING id, name", [body.orgName])).rows[0];
      const user = (
        await c.query(
          `INSERT INTO users (org_id, email, name, password_hash, role)
           VALUES ($1,$2,$3,$4,$5) RETURNING id, org_id, email, name, role`,
          [org.id, body.email, body.name, await hashPassword(body.password), body.role]
        )
      ).rows[0];
      const principal = { id: user.id, orgId: user.org_id, email: user.email, name: user.name, role: user.role as Role };
      return { token: issueToken(principal), user: principal, org };
    });
  });

  // Invite a teammate into the caller's org. Counsel seats are what gate decisions.
  app.post("/api/auth/invite", { preHandler: [authenticate, requireRole("producer", "coordinator", "counsel")] }, async (req) => {
    const body = z
      .object({
        name: z.string().min(1).max(120),
        email: z.string().email(),
        password: z.string().min(10),
        role: z.enum(["producer", "coordinator", "counsel", "reviewer"]),
      })
      .parse(req.body);
    const existing = await one("SELECT id FROM users WHERE lower(email) = lower($1)", [body.email]);
    if (existing) throw conflict("That email already has an account.");
    const user = await must(
      `INSERT INTO users (org_id, email, name, password_hash, role)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role`,
      [req.user!.orgId, body.email, body.name, await hashPassword(body.password), body.role]
    );
    return { user };
  });

  app.post("/api/auth/login", async (req) => {
    const body = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const user = await one<{
      id: string; org_id: string; email: string; name: string; role: Role; password_hash: string;
    }>("SELECT id, org_id, email, name, role, password_hash FROM users WHERE lower(email) = lower($1)", [body.email]);
    if (!user || !(await checkPassword(body.password, user.password_hash))) {
      throw unauthorized("That email and password do not match.");
    }
    const principal = { id: user.id, orgId: user.org_id, email: user.email, name: user.name, role: user.role };
    return { token: issueToken(principal), user: principal };
  });

  app.get("/api/auth/me", { preHandler: [authenticate] }, async (req) => ({ user: req.user }));
}
