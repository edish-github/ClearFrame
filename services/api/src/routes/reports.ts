import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, one, must } from "../core/db.js";
import { authenticate, requireRole } from "../core/auth.js";
import { conflict, notFound } from "../core/errors.js";
import { appendLedger, ledgerHead, verifyChain } from "../core/ledger.js";
import { buildPdf, collectSnapshot, renderReport } from "../report/pdf.js";
import { getObject, putObject } from "../core/storage.js";

const uuid = z.object({ id: z.string().uuid() });

async function owned(orgId: string, productionId: string) {
  const p = await one<any>("SELECT * FROM productions WHERE id = $1 AND org_id = $2", [productionId, orgId]);
  if (!p) throw notFound("That production does not exist.");
  return p;
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  app.get("/api/reports", async (req) => {
    const rows = await q(
      `SELECT r.id, r.production_id, r.generated_at, r.ledger_head, r.ledger_length,
              r.signed_name, r.signed_role, r.signed_at, r.storage_key IS NOT NULL AS has_pdf,
              p.title, p.status
       FROM reports r JOIN productions p ON p.id = r.production_id
       WHERE p.org_id = $1 ORDER BY r.generated_at DESC`,
      [req.user!.orgId]
    );
    return { reports: rows };
  });

  /** Generating a report is itself a ledger event: it pins the chain head. */
  app.post("/api/productions/:id/reports", { preHandler: [requireRole("producer", "coordinator", "counsel")] }, async (req) => {
    const { id } = uuid.parse(req.params);
    await owned(req.user!.orgId, id);

    const snap = await collectSnapshot(id);
    const head = await ledgerHead(id);
    const report = await must<any>(
      `INSERT INTO reports (production_id, ledger_head, ledger_length, snapshot)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, head.head, head.length, JSON.stringify({ totals: snap.totals, integrity: snap.integrity })]
    );

    const pdf = await buildPdf({ ...snap, signature: null });
    const stored = await putObject(
      `reports/${id}`, pdf, "application/pdf",
      `${snap.production.title.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-clearance.pdf`
    );
    await q("UPDATE reports SET storage_key = $2 WHERE id = $1", [report.id, stored.key]);

    await appendLedger(id, req.user!.name, {
      type: "report_generated", reportId: report.id,
      totals: snap.totals, chainIntact: snap.integrity.ok, by: req.user!.email,
    });

    return { report: { ...report, storage_key: stored.key }, totals: snap.totals, integrity: snap.integrity };
  });

  app.get("/api/reports/:id/pdf", async (req, reply) => {
    const { id } = uuid.parse(req.params);
    const r = await one<{ storage_key: string | null; org_id: string; title: string }>(
      `SELECT r.storage_key, p.org_id, p.title FROM reports r JOIN productions p ON p.id = r.production_id
       WHERE r.id = $1`,
      [id]
    );
    if (!r || r.org_id !== req.user!.orgId) throw notFound("That report does not exist.");
    if (!r.storage_key) throw notFound("That report has no PDF yet.");
    const buf = await getObject(r.storage_key);
    reply.header("Content-Type", "application/pdf");
    reply.header(
      "Content-Disposition",
      `attachment; filename="${r.title.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-clearance.pdf"`
    );
    return buf;
  });

  /** Sign-off is counsel's alone, and it pins the ledger head at that moment. */
  app.post("/api/reports/:id/sign", { preHandler: [requireRole("counsel")] }, async (req) => {
    const { id } = uuid.parse(req.params);
    const r = await one<any>(
      `SELECT r.*, p.org_id, p.id AS production_id FROM reports r JOIN productions p ON p.id = r.production_id
       WHERE r.id = $1`,
      [id]
    );
    if (!r || r.org_id !== req.user!.orgId) throw notFound("That report does not exist.");
    if (r.signed_at) throw conflict(`That report was already signed by ${r.signed_name}.`);

    const integrity = await verifyChain(r.production_id);
    if (!integrity.ok) {
      throw conflict(`The ledger for this production is broken at entry ${integrity.brokenAt}. It cannot be signed.`);
    }

    const open = await one<{ n: number }>(
      "SELECT count(*)::int AS n FROM findings WHERE production_id = $1 AND status = 'review'",
      [r.production_id]
    );

    await q(
      `UPDATE reports SET signed_by = $2, signed_name = $3, signed_role = $4, signed_at = now(),
         ledger_head = $5, ledger_length = $6
       WHERE id = $1`,
      [id, req.user!.id, req.user!.name, req.user!.role, integrity.head, integrity.length]
    );
    await appendLedger(r.production_id, req.user!.name, {
      type: "report_signed", reportId: id, headAtSignature: integrity.head,
      openFindings: open?.n ?? 0, by: req.user!.email,
    });

    // Re-render so the stored PDF carries the signature block.
    await renderReport(id);

    return { signed: true, head: integrity.head, openFindings: open?.n ?? 0 };
  });

  app.get("/api/productions/:id/integrity", async (req) => {
    const { id } = uuid.parse(req.params);
    await owned(req.user!.orgId, id);
    return verifyChain(id);
  });
}
