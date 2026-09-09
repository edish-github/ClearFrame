import PDFDocument from "pdfkit";
import { q, one, must } from "../core/db.js";
import { putObject } from "../core/storage.js";
import { verifyChain } from "../core/ledger.js";
import {
  CATEGORY_LABEL, DECISION_LABEL, STATUS_LABEL,
  type Category, type DecisionAction, type FindingStatus,
} from "@clearframe/shared";

/**
 * The report is a view over the database. Nothing is composed here that is not
 * already a persisted row, which is why it can be regenerated at any time and
 * still match the ledger.
 */

const INK = "#15171B";
const MUTED = "#5C6068";
const FAINT = "#8C9098";
const LINE = "#D6D8D2";
const RISK: Record<string, string> = { HIGH: "#AE2A1C", MEDIUM: "#96650F", LOW: "#1E6B4C" };

const MARGIN = 54;
const WIDTH = 595.28 - MARGIN * 2; // A4

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
const when = (d: string | Date) =>
  new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export interface ReportTotals {
  total: number;
  resolved: number;
  review: number;
  open: number;
  withdrawn: number;
  sources: number;
}

export interface ReportSignature {
  name: string; role: string; at: string; head: string;
}

export interface ReportSnapshot {
  signature: ReportSignature | null;
  production: any;
  cuts: any[];
  findings: any[];
  evidenceByFinding: Record<string, any[]>;
  decisions: any[];
  outreach: any[];
  totals: ReportTotals;
  integrity: { ok: boolean; length: number; head: string; brokenAt?: number };
}

/**
 * A report is a snapshot of the database plus, if it has been signed, the
 * signature recorded against that specific report. Signatures belong to a
 * report, not to the production, so an earlier signed report keeps its
 * signature when a newer unsigned one is generated.
 */
export async function collectSnapshot(productionId: string, reportId?: string): Promise<ReportSnapshot> {
  const production = await must<any>("SELECT * FROM productions WHERE id = $1", [productionId]);

  let signature: ReportSignature | null = null;
  if (reportId) {
    const r = await one<any>(
      "SELECT signed_name, signed_role, signed_at, ledger_head FROM reports WHERE id = $1",
      [reportId]
    );
    if (r?.signed_at) {
      signature = { name: r.signed_name, role: r.signed_role, at: r.signed_at, head: r.ledger_head };
    }
  }
  const cuts = await q("SELECT n, filename, stats, created_at FROM cuts WHERE production_id = $1 ORDER BY n", [productionId]);
  const findings = await q<any>(
    `SELECT id, item, category, scene, page, context, status, risk, confidence, summary,
            assessment, recommendation, verification, chains, pass_n
     FROM findings WHERE production_id = $1
     ORDER BY (risk = 'HIGH') DESC NULLS LAST, item ASC`,
    [productionId]
  );
  const evidence = await q<any>(
    `SELECT e.finding_id, e.url, e.title, e.domain, e.stance, e.note, e.publish_date, e.retrieved_at
     FROM evidence e JOIN findings f ON f.id = e.finding_id
     WHERE f.production_id = $1 ORDER BY e.round, e.id`,
    [productionId]
  );
  const decisions = await q(
    `SELECT f.item, d.action, d.rationale, d.actor_name, d.actor_role, d.created_at
     FROM decisions d JOIN findings f ON f.id = d.finding_id
     WHERE f.production_id = $1 ORDER BY d.created_at`,
    [productionId]
  );
  const outreach = await q(
    `SELECT f.item, o.addressed_to, o.subject, o.state, o.approved_name, o.approved_at
     FROM outreach o JOIN findings f ON f.id = o.finding_id
     WHERE f.production_id = $1 AND o.state <> 'drafting' ORDER BY o.created_at`,
    [productionId]
  );

  const evidenceByFinding: Record<string, any[]> = {};
  for (const e of evidence) (evidenceByFinding[e.finding_id] ??= []).push(e);

  const live = findings.filter((f) => f.status !== "withdrawn");
  const totals: ReportTotals = {
    total: live.length,
    resolved: live.filter((f) => ["cleared", "approved", "licensed", "replaced", "rejected"].includes(f.status)).length,
    review: live.filter((f) => f.status === "review").length,
    open: live.filter((f) => ["queued", "researching", "verifying", "tracing", "assessing", "held", "failed"].includes(f.status)).length,
    withdrawn: findings.length - live.length,
    sources: evidence.length,
  };

  return {
    signature, production, cuts, findings, evidenceByFinding, decisions, outreach, totals,
    integrity: await verifyChain(productionId),
  };
}

/* ------------------------------------------------------------ pdf layout */

class Sheet {
  public doc: PDFKit.PDFDocument;
  private section = 0;

  constructor() {
    this.doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true, autoFirstPage: true });
    this.doc.registerFont("body", "Helvetica");
    this.doc.registerFont("bold", "Helvetica-Bold");
    this.doc.registerFont("mono", "Courier");
  }

  space(n = 10) { this.doc.moveDown(n / 12); }

  /** pdfkit carries x forward from positioned writes; always re-anchor. */
  private home() { this.doc.x = MARGIN; }

  need(height: number) {
    if (this.doc.y + height > this.doc.page.height - MARGIN - 24) this.doc.addPage();
  }

  heading(title: string) {
    this.section += 1;
    this.need(50);
    this.home();
    this.doc.moveDown(0.9);
    this.doc
      .font("bold").fontSize(9.5).fillColor(INK)
      .text(`${this.section} · ${title.toUpperCase()}`, MARGIN, this.doc.y, { width: WIDTH });
    const y = this.doc.y + 3;
    this.doc.moveTo(MARGIN, y).lineTo(MARGIN + WIDTH, y).lineWidth(0.8).strokeColor(INK).stroke();
    this.doc.y = y + 8;
    this.home();
  }

  para(text: string, opts: { color?: string; size?: number; font?: string } = {}) {
    if (!text) return;
    this.need(28);
    this.home();
    this.doc
      .font(opts.font ?? "body")
      .fontSize(opts.size ?? 9.5)
      .fillColor(opts.color ?? "#2C2F35")
      .text(text, MARGIN, this.doc.y, { width: WIDTH, lineGap: 2.2 });
    this.doc.moveDown(0.35);
    this.home();
  }

  kv(pairs: [string, string][]) {
    for (const [k, v] of pairs) {
      this.need(16);
      const y = this.doc.y;
      this.doc.font("body").fontSize(9).fillColor(FAINT).text(k, MARGIN, y, { width: 150 });
      this.doc.font("mono").fontSize(8.5).fillColor(INK)
        .text(v, MARGIN + 155, y, { width: WIDTH - 155 });
      this.doc.y = y + Math.max(
        this.doc.font("mono").fontSize(8.5).heightOfString(v, { width: WIDTH - 155 }),
        11
      ) + 3;
    }
    this.home();
    this.doc.moveDown(0.4);
  }

  table(columns: { label: string; width: number }[], rows: (string | { text: string; color: string })[][]) {
    const total = columns.reduce((n, c) => n + c.width, 0);
    const widths = columns.map((c) => (c.width / total) * WIDTH);

    const header = () => {
      this.need(26);
      let x = MARGIN;
      const y = this.doc.y;
      this.doc.font("bold").fontSize(7.5).fillColor(FAINT);
      columns.forEach((c, i) => {
        this.doc.text(c.label.toUpperCase(), x + 2, y, { width: widths[i]! - 4 });
        x += widths[i]!;
      });
      const ly = y + 11;
      this.doc.moveTo(MARGIN, ly).lineTo(MARGIN + WIDTH, ly).lineWidth(0.6).strokeColor(INK).stroke();
      this.doc.y = ly + 5;
      this.doc.x = MARGIN;
    };

    header();

    for (const row of rows) {
      const heights = row.map((cell, i) => {
        const text = typeof cell === "string" ? cell : cell.text;
        return this.doc.font("body").fontSize(8.5).heightOfString(text || "—", { width: widths[i]! - 6 });
      });
      const h = Math.max(...heights, 11) + 7;

      if (this.doc.y + h > this.doc.page.height - MARGIN - 24) {
        this.doc.addPage();
        header();
      }

      let x = MARGIN;
      const y = this.doc.y;
      row.forEach((cell, i) => {
        const text = typeof cell === "string" ? cell : cell.text;
        const color = typeof cell === "string" ? "#2C2F35" : cell.color;
        this.doc.font("body").fontSize(8.5).fillColor(color)
          .text(text || "—", x + 2, y, { width: widths[i]! - 6 });
        x += widths[i]!;
      });
      this.doc.y = y + h - 4;
      this.doc.moveTo(MARGIN, this.doc.y).lineTo(MARGIN + WIDTH, this.doc.y)
        .lineWidth(0.4).strokeColor(LINE).stroke();
      this.doc.y += 4;
    }
    this.home();
    this.doc.moveDown(0.5);
  }

  finish(title: string): void {
    const range = this.doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      this.doc.switchToPage(range.start + i);
      // Writing below the bottom margin makes pdfkit start a new page, which
      // would append a blank sheet per footer. Drop the margin while stamping.
      const bottom = this.doc.page.margins.bottom;
      this.doc.page.margins.bottom = 0;
      const y = this.doc.page.height - MARGIN + 14;
      this.doc.font("body").fontSize(7.5).fillColor(FAINT)
        .text(title, MARGIN, y, { width: WIDTH / 2, lineBreak: false })
        .text(`${i + 1} / ${range.count}`, MARGIN + WIDTH / 2, y, {
          width: WIDTH / 2, align: "right", lineBreak: false,
        });
      this.doc.page.margins.bottom = bottom;
    }
  }
}

export async function buildPdf(snap: ReportSnapshot): Promise<Buffer> {
  const s = new Sheet();
  const d = s.doc;
  const p = snap.production;
  const currentCut = snap.cuts[snap.cuts.length - 1];

  // cover block
  d.font("mono").fontSize(8).fillColor(FAINT).text("CLEARFRAME", MARGIN, d.y, { width: WIDTH });
  d.moveDown(0.3);
  d.font("bold").fontSize(19).fillColor(INK).text("Production clearance report", MARGIN, d.y, { width: WIDTH });
  d.moveDown(0.15);
  d.font("body").fontSize(10).fillColor(MUTED)
    .text("Research findings, chains of title, evidence, risk assessments and recorded decisions.",
      MARGIN, d.y, { width: WIDTH });
  d.moveDown(0.5);
  d.moveTo(MARGIN, d.y).lineTo(MARGIN + WIDTH, d.y).lineWidth(1.4).strokeColor(INK).stroke();

  s.heading("Production");
  s.kv([
    ["Title", p.title],
    ["Format", p.format],
    ["Current cut", currentCut ? `${currentCut.filename} (cut ${currentCut.n})` : "—"],
    ["Pass opened", when(p.created_at)],
    ["Report generated", when(new Date())],
    ["Research spend", `${usd(p.spent_micros)} against a ${usd(p.budget_cap_micros)} cap`],
    ["Sources on record", String(snap.totals.sources)],
  ]);

  s.heading("Summary");
  const t = snap.totals;
  s.para(
    `${t.total} clearance ${t.total === 1 ? "item is" : "items are"} live in the current cut. ` +
      `${t.resolved} ${t.resolved === 1 ? "has" : "have"} been resolved, ${t.review} ` +
      `${t.review === 1 ? "remains" : "remain"} open for a decision, and ${t.open} ` +
      `${t.open === 1 ? "was" : "were"} not completed.` +
      (t.withdrawn ? ` A further ${t.withdrawn} ${t.withdrawn === 1 ? "item was" : "items were"} withdrawn as the cut changed.` : "")
  );
  if (t.review > 0) {
    s.para(
      "This report is not a clearance. Items listed as needing review have not been resolved by a human decision.",
      { color: RISK.HIGH!, font: "bold" }
    );
  }

  s.heading("Item register");
  s.table(
    [
      { label: "Risk", width: 12 },
      { label: "Item", width: 34 },
      { label: "Type", width: 14 },
      { label: "Location", width: 16 },
      { label: "Status", width: 20 },
    ],
    snap.findings.map((f) => [
      { text: f.risk ?? "—", color: RISK[f.risk ?? ""] ?? FAINT },
      f.item,
      categoryLabel(f.category),
      `${f.scene ? `Sc ${f.scene}` : "—"}${f.page ? ` / p${f.page}` : ""}`,
      statusLabel(f.status),
    ])
  );

  s.heading("Chains of title and evidence");
  const detailed = snap.findings.filter((f) => f.status !== "withdrawn" && (f.risk !== "LOW" || f.status === "review"));
  if (!detailed.length) s.para("No item in the current cut carried elevated risk.");

  for (const f of detailed) {
    s.need(120);
    d.moveDown(0.5);
    d.x = MARGIN;
    d.font("bold").fontSize(11).fillColor(INK).text(f.item, MARGIN, d.y, { width: WIDTH });
    d.font("mono").fontSize(7.5).fillColor(FAINT).text(
      [
        categoryLabel(f.category),
        f.scene ? `Scene ${f.scene}` : null,
        f.confidence != null ? `${Math.round(Number(f.confidence) * 100)}% confidence` : null,
        f.pass_n > 1 ? `added in cut ${f.pass_n}` : null,
      ].filter(Boolean).join("  ·  "),
      MARGIN, d.y, { width: WIDTH }
    );
    d.moveDown(0.7);
    d.x = MARGIN;

    const chains = Array.isArray(f.chains) ? f.chains : [];
    if (chains.length) {
      s.table(
        [
          { label: "Right", width: 24 },
          { label: "Controlled by", width: 36 },
          { label: "Status", width: 14 },
          { label: "Note", width: 26 },
        ],
        chains.map((c: any) => [
          c.right,
          c.holder ?? "Not established",
          { text: c.status, color: c.status === "clear" ? RISK.LOW! : c.status === "contested" ? RISK.HIGH! : RISK.MEDIUM! },
          c.note ?? "",
        ])
      );
    }

    if (f.summary) s.para(f.summary);
    if (f.assessment) s.para(f.assessment);
    if (f.recommendation) s.para(f.recommendation, { font: "bold" });
    if (f.verification) {
      const v = f.verification;
      s.para(
        `Verification: ${v.sufficient ? "evidence accepted" : "evidence contested"}` +
          (v.escalated ? ` after a challenge — ${v.priorReason}` : "") + ".",
        { color: FAINT, size: 8.5 }
      );
    }

    const ev = snap.evidenceByFinding[f.id] ?? [];
    for (const [i, e] of ev.entries()) {
      s.need(30);
      d.font("body").fontSize(8.5).fillColor("#2C2F35")
        .text(`${String(i + 1).padStart(2, "0")}  ${e.title ?? e.domain} — ${e.note}`,
          MARGIN, d.y, { width: WIDTH, lineGap: 1.5 });
      d.font("mono").fontSize(7).fillColor(FAINT)
        .text(`      [${e.stance}] ${e.url}  ·  retrieved ${when(e.retrieved_at)}`,
          MARGIN, d.y, { width: WIDTH });
      d.moveDown(0.2);
    }
    d.moveDown(0.3);
    d.x = MARGIN;
  }

  s.heading("Recorded decisions");
  if (!snap.decisions.length) s.para("No decisions have been recorded on this production.");
  else
    s.table(
      [
        { label: "Item", width: 26 },
        { label: "Decision", width: 16 },
        { label: "Rationale", width: 30 },
        { label: "Recorded by", width: 15 },
        { label: "When", width: 13 },
      ],
      snap.decisions.map((x: any) => [
        x.item, decisionLabel(x.action), x.rationale || "—",
        `${x.actor_name} (${x.actor_role})`, when(x.created_at),
      ])
    );

  s.heading("Licence outreach");
  if (!snap.outreach.length) s.para("No licence inquiries were drafted on this production.");
  else {
    s.para("ClearFrame drafts inquiries and holds them behind counsel approval. It does not send mail.", { color: FAINT, size: 8.5 });
    s.table(
      [
        { label: "Item", width: 24 },
        { label: "Addressed to", width: 24 },
        { label: "Subject", width: 28 },
        { label: "State", width: 12 },
        { label: "Approved by", width: 12 },
      ],
      snap.outreach.map((o: any) => [
        o.item, o.addressed_to, o.subject,
        o.state === "approved" ? "Approved to send" : o.state === "failed" ? "Failed" : "Awaiting approval",
        o.approved_name ?? "—",
      ])
    );
  }

  const deltas = snap.cuts.filter((c: any) => c.n > 1);
  if (deltas.length) {
    s.heading("Delta annex");
    s.para("Each revised cut re-cleared only what changed. Everything unchanged kept its evidence, risk and decision.");
    s.table(
      [
        { label: "Cut", width: 7 }, { label: "Document", width: 33 }, { label: "New", width: 10 },
        { label: "Changed", width: 12 }, { label: "Withdrawn", width: 14 },
        { label: "Carried", width: 11 }, { label: "When", width: 13 },
      ],
      deltas.map((c: any) => [
        String(c.n), c.filename, String(c.stats?.added ?? 0), String(c.stats?.changed ?? 0),
        String(c.stats?.withdrawn ?? 0), String(c.stats?.carried ?? 0), when(c.created_at),
      ])
    );
  }

  s.heading("Source index");
  const all = Object.values(snap.evidenceByFinding).flat() as any[];
  if (!all.length) s.para("No sources are on record.");
  for (const e of all) {
    s.need(14);
    d.font("mono").fontSize(6.8).fillColor(MUTED)
      .text(`${e.url}  ·  retrieved ${when(e.retrieved_at)}`, MARGIN, d.y, { width: WIDTH });
  }
  d.moveDown(0.4);
  d.x = MARGIN;

  s.heading("Provenance and sign-off");
  s.para(
    `Every state change on this production was appended to a hash-chained ledger of ${snap.integrity.length} entries. ` +
      `Each entry carries the hash of the one before it, so altering, reordering or removing any entry breaks the chain ` +
      `from that point on. The chain was recomputed when this report was generated.`
  );
  s.kv([
    ["Ledger entries", String(snap.integrity.length)],
    ["Chain integrity", snap.integrity.ok ? "Intact" : `BROKEN at entry ${snap.integrity.brokenAt}`],
    ["Chain head", snap.integrity.head],
  ]);

  const sig = snap.signature;
  if (sig) {
    s.need(78);
    const y = d.y;
    d.roundedRect(MARGIN, y, WIDTH, 60, 4).lineWidth(0.8).strokeColor(INK).stroke();
    d.font("bold").fontSize(10.5).fillColor(INK)
      .text(`Signed off by ${sig.name}`, MARGIN + 14, y + 12, { width: WIDTH - 28 });
    d.font("mono").fontSize(7.5).fillColor(FAINT)
      .text(`${sig.role} · ${when(sig.at)}`, MARGIN + 14, y + 29, { width: WIDTH - 28 });
    d.font("mono").fontSize(6.5).fillColor(FAINT)
      .text(`Ledger head at signature: ${sig.head}`, MARGIN + 14, y + 42, { width: WIDTH - 28 });
    d.y = y + 72;
    d.x = MARGIN;
  } else {
    s.para("Unsigned. This report has not been accepted by counsel.", { color: FAINT });
  }

  s.para(
    "Every claim in this report is drawn from the sources listed above, retrieved at the times shown. " +
      "It is research and a record of decisions. It is not a legal opinion and it is not a certification of clearance.",
    { color: FAINT, size: 8 }
  );

  s.finish(`ClearFrame · ${p.title}`);

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    d.on("data", (c: Buffer) => chunks.push(c));
    d.on("end", () => resolve(Buffer.concat(chunks)));
    d.on("error", reject);
    d.end();
  });
}

const statusLabel = (s: string): string => STATUS_LABEL[s as FindingStatus] ?? s;
const decisionLabel = (a: string): string => DECISION_LABEL[a as DecisionAction] ?? a;
const categoryLabel = (c: string): string => CATEGORY_LABEL[c as Category] ?? c;

/** Job entry point: render and attach the PDF to an existing report row. */
export async function renderReport(reportId: string): Promise<void> {
  const report = await one<{ id: string; production_id: string }>(
    "SELECT id, production_id FROM reports WHERE id = $1", [reportId]
  );
  if (!report) return;
  const snap = await collectSnapshot(report.production_id, report.id);
  const pdf = await buildPdf(snap);
  const stored = await putObject(
    `reports/${report.production_id}`, pdf, "application/pdf",
    `${snap.production.title.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-clearance.pdf`
  );
  await q("UPDATE reports SET storage_key = $2, snapshot = $3 WHERE id = $1", [
    reportId, stored.key, JSON.stringify({ totals: snap.totals, integrity: snap.integrity }),
  ]);
}
