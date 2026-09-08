import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  FileText, Upload, ArrowLeft, ArrowUpRight, Search, Check, Plus, Copy,
  Loader2, AlertTriangle, ChevronDown, Printer, RotateCw, Square, Shield, Send
} from "lucide-react";

/* ================================================================== */
/*  storage                                                            */
/* ================================================================== */

const mem = new Map();

const store = {
  async get(key) {
    try {
      const r = await window.storage.get(key);
      return r ? JSON.parse(r.value) : null;
    } catch (e) {
      return mem.has(key) ? JSON.parse(mem.get(key)) : null;
    }
  },
  async set(key, value) {
    const s = JSON.stringify(value);
    mem.set(key, s);
    try { await window.storage.set(key, s); } catch (e) { /* memory fallback */ }
  },
};

/* ================================================================== */
/*  model access                                                       */
/* ================================================================== */

const PRICE_IN = 3 / 1000000;
const PRICE_OUT = 15 / 1000000;
const PRICE_SEARCH = 0.01;

async function callModel(messages, opts = {}) {
  const body = { model: "claude-sonnet-4-6", max_tokens: 1000, messages };
  if (opts.system) body.system = opts.system;
  if (opts.tools) body.tools = opts.tools;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Analysis service returned ${res.status}. This step did not complete.`);

  const data = await res.json();
  const blocks = Array.isArray(data.content) ? data.content : [];

  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

  const sources = [];
  let searches = 0;
  for (const b of blocks) {
    if (b.type === "server_tool_use" && b.name === "web_search") searches += 1;
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r && r.url) sources.push({ url: r.url, title: r.title || r.url });
    }
  }

  const u = data.usage || {};
  const cost = (u.input_tokens || 0) * PRICE_IN + (u.output_tokens || 0) * PRICE_OUT + searches * PRICE_SEARCH;
  return { text, sources, cost, searches };
}

function parseJSON(raw) {
  if (!raw) return null;
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();

  const starts = [t.indexOf("{"), t.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) return null;
  t = t.slice(Math.min.apply(null, starts));

  try { return JSON.parse(t); } catch (e) { /* repair below */ }

  const open = t[0];
  const lastObj = t.lastIndexOf("}");
  if (lastObj > 0) {
    try { return JSON.parse(t.slice(0, lastObj + 1) + (open === "[" ? "]" : "")); } catch (e) { /* give up */ }
  }
  return null;
}

/* ================================================================== */
/*  append-only ledger, hash chained                                   */
/* ================================================================== */

const ZERO = "0".repeat(64);

async function sha256(str) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, "0").repeat(8);
  }
}

const ledgerPayload = (e) =>
  JSON.stringify({ seq: e.seq, t: e.t, actor: e.actor, event: e.event, prevHash: e.prevHash });

async function appendLedger(rec, actor, event) {
  rec.ledger = rec.ledger || [];
  const prev = rec.ledger[rec.ledger.length - 1];
  const entry = {
    seq: rec.ledger.length + 1,
    t: new Date().toISOString(),
    actor,
    event,
    prevHash: prev ? prev.hash : ZERO,
  };
  entry.hash = await sha256(ledgerPayload(entry));
  rec.ledger.push(entry);
  return entry;
}

async function verifyLedger(ledger) {
  let prevHash = ZERO;
  for (const e of ledger || []) {
    if (e.prevHash !== prevHash) return { ok: false, at: e.seq };
    const h = await sha256(ledgerPayload({ ...e, prevHash }));
    if (h !== e.hash) return { ok: false, at: e.seq };
    prevHash = e.hash;
  }
  return { ok: true, head: prevHash, length: (ledger || []).length };
}

/* ================================================================== */
/*  pipeline stages                                                    */
/* ================================================================== */

const BREAKDOWN_SYSTEM =
  "You are the breakdown pass in a film production clearance system. You read screenplays and identify third-party elements that need rights clearance before a title can be distributed: songs and music cues, visible brands and trademarks, artworks, murals and posters, archival or news footage, and real people depicted or named. You locate and describe items only. You never draw rights conclusions. You reply with JSON and nothing else.";

async function stageBreakdown(payload, title) {
  const instruction = `Screenplay for the production "${title}" follows.

Identify up to 16 of the most clearance-relevant third-party elements in it. Prefer specific, named, researchable elements over generic set dressing.

Reply with a JSON array only. Each object:
{"item":"the element as named in the script","category":"MUSIC|BRAND|ARTWORK|FOOTAGE|LIKENESS|OTHER","scene":"scene number or short slugline","page":"page number as a string, or null","context":"one sentence, 22 words maximum, on how it appears"}

No prose. No code fences.`;

  const content = [];
  if (payload.kind === "pdf") {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: payload.data } });
  } else {
    content.push({ type: "text", text: payload.data.slice(0, 90000) });
  }
  content.push({ type: "text", text: instruction });

  const r = await callModel([{ role: "user", content }], { system: BREAKDOWN_SYSTEM });
  const parsed = parseJSON(r.text);
  const rows = Array.isArray(parsed) ? parsed : parsed && parsed.items ? parsed.items : null;
  if (!rows || !rows.length) throw new Error("The screenplay was read but no clearance items could be extracted from it.");
  return { rows, cost: r.cost };
}

const RESEARCH_SYSTEM =
  "You are a rights-clearance researcher working for a film production. Using live web search, you establish the current rights position for the element you are given: who controls it now, any transfer or catalogue acquisition, any active dispute or litigation, and whether the position is contested. Ownership facts must come from search results, never from memory. You reply with JSON and nothing else.";

async function stageResearch(finding, production, challenge) {
  const musicNote =
    finding.category === "MUSIC"
      ? "\nThis is music, so it is two separate properties with separate owners: the underlying composition and the master recording. Establish both."
      : "";

  const ask = `Element: ${finding.item}
Category: ${finding.category}
How it appears: ${finding.context}
Production: ${production.title} (${production.format})${musicNote}
${challenge ? `\nA verifier rejected the earlier research on this element. Its objection: ${challenge}\nResolve that objection specifically.` : ""}

Search the web, then reply with only this object:
{"summary":"the current rights position, 3 sentences maximum","evidence":[{"url":"an exact URL from your search results","title":"the page title","stance":"supports|conflicts|context","note":"what this source establishes, 14 words maximum"}]}

Include between 2 and 3 evidence entries. Every url must be one you actually retrieved.`;

  const r = await callModel([{ role: "user", content: ask }], {
    system: RESEARCH_SYSTEM,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
  });

  const parsed = parseJSON(r.text) || {};
  const pool = new Map();
  for (const s of r.sources) pool.set(s.url, s.title);

  const evidence = (Array.isArray(parsed.evidence) ? parsed.evidence : [])
    .filter((e) => e && e.url && pool.has(e.url))
    .map((e) => ({
      url: e.url,
      title: e.title || pool.get(e.url),
      domain: domainOf(e.url),
      stance: ["supports", "conflicts", "context"].includes(e.stance) ? e.stance : "context",
      note: String(e.note || "").slice(0, 160),
      retrieved: new Date().toISOString(),
    }));

  return { summary: parsed.summary || "", evidence, retrieved: r.sources.length, cost: r.cost };
}

const VERIFY_SYSTEM =
  "You are the verification pass in a clearance system. You do not establish truth. You judge one thing only: whether the recorded evidence adequately supports the stated rights position, checking for source authority, internal conflict, and gaps. You reply with JSON and nothing else.";

async function stageVerify(finding, summary, evidence) {
  const ask = `Element: ${finding.item} (${finding.category})
Stated position: ${summary}

Recorded evidence:
${evidence.map((e, i) => `${i + 1}. [${e.stance}] ${e.domain} — ${e.note}`).join("\n") || "none"}

Reply with only:
{"sufficient":true|false,"reason":"24 words maximum","followUp":"a specific search instruction, or null if sufficient"}`;

  const r = await callModel([{ role: "user", content: ask }], { system: VERIFY_SYSTEM });
  const p = parseJSON(r.text) || {};
  return {
    sufficient: p.sufficient !== false,
    reason: p.reason || "",
    followUp: p.followUp || null,
    cost: r.cost,
  };
}

const CHAIN_SYSTEM =
  "You trace chains of title for a film clearance team. A chain is one line of ownership that must resolve before an element can be used. Music always has two: the underlying composition and the master recording. Other elements usually have one. You only state what the recorded evidence supports, and you mark a chain unresolved when the evidence does not reach an owner. You reply with JSON and nothing else.";

async function stageChain(finding, summary, evidence) {
  const ask = `Element: ${finding.item} (${finding.category})
Position established by research: ${summary}

Evidence on record:
${evidence.map((e, i) => `${i + 1}. [${e.stance}] ${e.domain} — ${e.note}`).join("\n") || "none"}

Reply with only:
{"chains":[{"right":"the name of the right, e.g. Composition, Master recording, Trademark, Artwork copyright, Publicity rights, Archive licence","holder":"who the evidence says controls it now, or null","status":"clear|contested|unresolved","note":"12 words maximum on what stands in the way, or empty"}]}

Music must return exactly two chains. Everything else returns one, unless the evidence clearly shows more.`;

  const r = await callModel([{ role: "user", content: ask }], { system: CHAIN_SYSTEM });
  const p = parseJSON(r.text) || {};
  const chains = (Array.isArray(p.chains) ? p.chains : [])
    .filter((c) => c && c.right)
    .slice(0, 4)
    .map((c) => ({
      right: String(c.right).slice(0, 40),
      holder: c.holder ? String(c.holder).slice(0, 90) : null,
      status: ["clear", "contested", "unresolved"].includes(c.status) ? c.status : "unresolved",
      note: String(c.note || "").slice(0, 120),
    }));
  return { chains, cost: r.cost };
}

const ASSESS_SYSTEM =
  "You are the clearance assessment pass. Given verified research about a third-party element appearing in a film, you assign a risk level, state what the evidence shows, and recommend the production's next step. Your output is research for human review, not legal advice. You reply with JSON and nothing else.";

async function stageAssess(finding, summary, evidence, verification, chains) {
  const ask = `Element: ${finding.item} (${finding.category})
How it appears: ${finding.context}
Position established by research: ${summary}
Verification: ${verification.sufficient ? "evidence accepted" : "evidence challenged"} — ${verification.reason}
Chains of title: ${chains.length ? chains.map((c) => `${c.right} -> ${c.holder || "unresolved"} (${c.status})`).join("; ") : "none traced"}

Evidence:
${evidence.map((e, i) => `${i + 1}. [${e.stance}] ${e.domain} — ${e.note}`).join("\n") || "none"}

Reply with only:
{"risk":"HIGH|MEDIUM|LOW","confidence":0.0,"assessment":"2 sentences maximum","recommendation":"one imperative sentence","requiresReview":true|false}`;

  const r = await callModel([{ role: "user", content: ask }], { system: ASSESS_SYSTEM });
  const p = parseJSON(r.text) || {};
  const risk = ["HIGH", "MEDIUM", "LOW"].includes(p.risk) ? p.risk : "MEDIUM";
  return {
    risk,
    confidence: typeof p.confidence === "number" ? Math.max(0, Math.min(1, p.confidence)) : 0.5,
    assessment: p.assessment || "",
    recommendation: p.recommendation || "",
    requiresReview: risk === "HIGH" ? true : p.requiresReview !== false,
    cost: r.cost,
  };
}

const OUTREACH_SYSTEM =
  "You draft licence inquiries for a film production's clearance office. You write short, plain, professional emails that ask for licensing terms and confirm who controls the right. You never assert a rights position as settled, never quote a fee, and never claim to have cleared anything. You reply with JSON and nothing else.";

async function stageOutreach(finding, production, chains) {
  const target = chains.find((c) => c.holder) || {};
  const ask = `Production: ${production.title} (${production.format})
Element: ${finding.item} (${finding.category})
How it appears: ${finding.context}
Chains of title on record: ${chains.map((c) => `${c.right} -> ${c.holder || "unresolved"} (${c.status})`).join("; ") || "none traced"}

Draft a licence inquiry to the party most likely to control this right.

Reply with only:
{"to":"the rights holder or licensing desk being addressed","subject":"a subject line","body":"the email, 120 words maximum, signed off as the clearance office"}`;

  const r = await callModel([{ role: "user", content: ask }], { system: OUTREACH_SYSTEM });
  const p = parseJSON(r.text) || {};
  return {
    to: p.to || target.holder || "Rights holder",
    subject: p.subject || `Licence inquiry — ${finding.item}`,
    body: p.body || "",
    cost: r.cost,
  };
}

/* ================================================================== */
/*  helpers                                                            */
/* ================================================================== */

const uid = () => Math.random().toString(36).slice(2, 10);

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return "source"; }
}

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

const stamp = (iso) =>
  new Date(iso).toLocaleString([], {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });

const money = (n) => `$${(n || 0).toFixed(2)}`;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const RESOLVED = ["cleared", "approved", "licensed", "replaced", "rejected"];
const WORKING = ["queued", "researching", "verifying", "tracing", "assessing"];

const CATEGORY_LABEL = {
  MUSIC: "Music", BRAND: "Brand", ARTWORK: "Artwork",
  FOOTAGE: "Footage", LIKENESS: "Likeness", OTHER: "Other",
};

const STATUS_LABEL = {
  queued: "Queued", researching: "Researching", verifying: "Verifying", tracing: "Tracing title",
  assessing: "Assessing", review: "Needs review", cleared: "Cleared", approved: "Approved",
  licensed: "Licensing", replaced: "Replaced", rejected: "Rejected", withdrawn: "Withdrawn from cut",
  held: "Held at cap", failed: "Failed",
};

const ACTIONS = [
  { key: "approved", label: "Clear for use" },
  { key: "licensed", label: "Pursue licence" },
  { key: "replaced", label: "Replace element" },
  { key: "rejected", label: "Remove from cut" },
];

function tally(findings) {
  const t = { total: 0, cleared: 0, review: 0, open: 0, withdrawn: 0, outreach: 0 };
  for (const f of findings) {
    if (f.outreach && f.outreach.state === "draft") t.outreach += 1;
    if (f.status === "withdrawn") { t.withdrawn += 1; continue; }
    t.total += 1;
    if (RESOLVED.includes(f.status)) t.cleared += 1;
    else if (f.status === "review") t.review += 1;
    else t.open += 1;
  }
  return t;
}

function feedOf(rec) {
  const all = [];
  for (const f of rec.findings) for (const e of f.activity || []) all.push({ ...e, item: f.item });
  all.sort((a, b) => (a.t < b.t ? 1 : -1));
  return all;
}

async function runQueue(items, width, worker) {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      await worker(items[i]);
    }
  });
  await Promise.all(lanes);
}

function readScript(f) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(new Error("The file could not be read."));
    if (/\.pdf$/i.test(f.name)) {
      r.onload = () => res({ kind: "pdf", data: String(r.result).split(",")[1] });
      r.readAsDataURL(f);
    } else {
      r.onload = () => res({ kind: "text", data: String(r.result) });
      r.readAsText(f);
    }
  });
}

function acceptScript(f) {
  if (!f) return "No file was chosen.";
  if (!/\.(pdf|txt|fountain|md)$/i.test(f.name)) return "That file type cannot be read. Use a PDF, .txt or .fountain screenplay.";
  if (f.size > 24 * 1024 * 1024) return "That file is over 24 MB. Use a smaller export of the script.";
  return null;
}

/* ================================================================== */
/*  styles                                                             */
/* ================================================================== */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

.cf, .cf * { box-sizing: border-box; }
.cf {
  --paper:#E7E8E4; --card:#FFFFFF; --ink:#15171B; --ink2:#5C6068; --ink3:#8C9098;
  --line:#D6D8D2; --line2:#EAEBE7; --sig:#2A2BD8; --sig-soft:#EDEDFB;
  --red:#AE2A1C; --amber:#96650F; --green:#1E6B4C;
  font-family:'Inter Tight',system-ui,sans-serif;
  color:var(--ink); background:var(--paper);
  height:100vh; min-height:560px; display:flex; letter-spacing:-0.011em; overflow:hidden;
  -webkit-font-smoothing:antialiased;
}
.cf .mono { font-family:'JetBrains Mono',ui-monospace,monospace; letter-spacing:-0.02em; }

.cf .rail { width:248px; flex:0 0 248px; border-right:1px solid var(--line); display:flex; flex-direction:column; padding:26px 0 16px; }
.cf .brand { padding:0 22px 24px; }
.cf .brand b { display:block; font-size:17px; font-weight:600; letter-spacing:-0.03em; }
.cf .brand span { display:block; font-size:12.5px; color:var(--ink3); margin-top:2px; }
.cf .navgroup { padding:18px 14px; border-top:1px solid var(--line); }
.cf .nav { width:100%; display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:8px; background:none; border:0; font:inherit; font-size:14px; color:var(--ink2); cursor:pointer; text-align:left; }
.cf .nav:hover { background:#DEDFDA; color:var(--ink); }
.cf .nav.on { background:var(--ink); color:#fff; }
.cf .nav .count { margin-left:auto; font-size:11.5px; font-family:'JetBrains Mono',monospace; opacity:.65; }
.cf .railcard { margin:0; padding:14px; background:var(--card); border:1px solid var(--line); border-radius:10px; }
.cf .railcard .t { font-size:13.5px; font-weight:500; line-height:1.3; }
.cf .railfoot { margin-top:auto; padding:16px 22px 0; border-top:1px solid var(--line); }
.cf .rolebtn { display:flex; align-items:center; gap:8px; width:100%; background:none; border:0; padding:6px 0; font:inherit; font-size:13.5px; color:var(--ink); cursor:pointer; }
.cf .rolemenu { border:1px solid var(--line); border-radius:8px; background:var(--card); padding:4px; margin-top:6px; }
.cf .rolemenu button { display:block; width:100%; text-align:left; padding:7px 9px; border:0; background:none; font:inherit; font-size:13px; border-radius:6px; cursor:pointer; color:var(--ink2); }
.cf .rolemenu button:hover { background:var(--line2); color:var(--ink); }
.cf .rolemenu .why { padding:6px 9px 4px; font-size:11.5px; color:var(--ink3); line-height:1.4; }

.cf .main { flex:1; overflow-y:auto; }
.cf .wrap { max-width:1080px; padding:38px 44px 80px; }
.cf h1 { font-size:30px; font-weight:600; letter-spacing:-0.035em; margin:0; line-height:1.1; }
.cf h2 { font-size:19px; font-weight:600; letter-spacing:-0.025em; margin:0; }
.cf .lede { color:var(--ink2); font-size:14.5px; margin:8px 0 0; max-width:62ch; line-height:1.5; }
.cf .row { display:flex; align-items:center; gap:12px; }
.cf .between { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; }

.cf .btn { display:inline-flex; align-items:center; gap:7px; padding:9px 16px; border-radius:999px; background:var(--ink); color:#fff; border:1px solid var(--ink); font:inherit; font-size:13.5px; font-weight:500; cursor:pointer; }
.cf .btn:hover { background:#2C2F35; }
.cf .btn:disabled { opacity:.38; cursor:not-allowed; }
.cf .btn.ghost { background:var(--card); color:var(--ink); border-color:var(--line); }
.cf .btn.ghost:hover { background:var(--line2); }
.cf .btn.sm { padding:6px 12px; font-size:12.5px; }

.cf .card { background:var(--card); border:1px solid var(--line); border-radius:12px; }
.cf .pad { padding:20px 22px; }

.cf .pill { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px; border:1px solid var(--line); font-size:11.5px; font-family:'JetBrains Mono',monospace; color:var(--ink2); background:var(--card); white-space:nowrap; }
.cf .dot { width:6px; height:6px; border-radius:50%; background:var(--ink3); flex:0 0 6px; }
.cf .dot.live { background:var(--sig); animation:cfp 1.6s ease-in-out infinite; }
.cf .dot.green { background:var(--green); } .cf .dot.amber { background:var(--amber); } .cf .dot.red { background:var(--red); }
@keyframes cfp { 0%,100%{opacity:1} 50%{opacity:.25} }
@media (prefers-reduced-motion: reduce) { .cf .dot.live { animation:none } }

.cf .stats { display:grid; grid-template-columns:repeat(4,1fr); border:1px solid var(--line); border-radius:12px; overflow:hidden; background:var(--card); }
.cf .stat { padding:18px 20px; border-right:1px solid var(--line2); }
.cf .stat:last-child { border-right:0; }
.cf .stat .n { font-family:'JetBrains Mono',monospace; font-size:26px; font-weight:500; letter-spacing:-0.04em; }
.cf .stat .l { font-size:12.5px; color:var(--ink3); margin-top:3px; }

.cf .bar { height:4px; background:var(--line); border-radius:999px; overflow:hidden; }
.cf .bar i { display:block; height:100%; background:var(--ink); transition:width .5s ease; }

.cf .tabs { display:flex; gap:2px; border-bottom:1px solid var(--line); margin:22px 0 0; }
.cf .tab { padding:9px 14px; border:0; background:none; font:inherit; font-size:13.5px; color:var(--ink3); cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; }
.cf .tab.on { color:var(--ink); border-bottom-color:var(--ink); font-weight:500; }

.cf .filters { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.cf .chip { padding:6px 12px; border-radius:999px; border:1px solid var(--line); background:var(--card); font:inherit; font-size:12.5px; color:var(--ink2); cursor:pointer; }
.cf .chip.on { background:var(--ink); color:#fff; border-color:var(--ink); }
.cf .chip:disabled { opacity:.4; cursor:not-allowed; }
.cf .chip .mono { font-size:11px; opacity:.6; margin-left:5px; }

.cf .field { display:block; margin-bottom:22px; }
.cf .field .lab { display:block; font-size:13px; color:var(--ink2); margin-bottom:7px; }
.cf input[type=text], .cf input[type=number], .cf select, .cf textarea { width:100%; padding:11px 13px; border:1px solid var(--line); border-radius:9px; background:var(--card); font:inherit; font-size:14px; color:var(--ink); }
.cf textarea { resize:vertical; min-height:70px; line-height:1.5; }
.cf input:focus, .cf select:focus, .cf textarea:focus { outline:2px solid var(--sig); outline-offset:-1px; border-color:transparent; }
.cf .btn:focus-visible, .cf .nav:focus-visible, .cf .chip:focus-visible, .cf .tab:focus-visible { outline:2px solid var(--sig); outline-offset:2px; }

.cf .drop { border:1px dashed var(--line); border-radius:12px; background:var(--card); padding:36px 20px; text-align:center; cursor:pointer; }
.cf .drop.tight { padding:22px 18px; }
.cf .drop.hot { border-color:var(--sig); background:var(--sig-soft); }
.cf .drop .h { font-size:14.5px; font-weight:500; }
.cf .drop .s { font-size:12.5px; color:var(--ink3); margin-top:4px; }

.cf table { width:100%; border-collapse:collapse; }
.cf th { text-align:left; font-size:11.5px; font-weight:500; color:var(--ink3); padding:0 12px 9px; font-family:'JetBrains Mono',monospace; border-bottom:1px solid var(--line); }
.cf td { padding:13px 12px; border-bottom:1px solid var(--line2); font-size:14px; vertical-align:top; }
.cf tr.click { cursor:pointer; }
.cf tr.click:hover td { background:#FAFAF8; }
.cf .sub { font-size:12px; color:var(--ink3); margin-top:3px; }

.cf .risk { display:inline-flex; align-items:center; gap:7px; font-size:12.5px; font-weight:500; }
.cf .sq { width:8px; height:8px; border-radius:2px; display:inline-block; }
.cf .sq.HIGH{background:var(--red)} .cf .sq.MEDIUM{background:var(--amber)} .cf .sq.LOW{background:var(--green)} .cf .sq.none{background:var(--line)}

.cf .chain { border-top:1px solid var(--line2); padding:14px 0; display:flex; gap:14px; }
.cf .chain:first-of-type { border-top:0; padding-top:4px; }
.cf .chain .mark { width:9px; height:9px; border-radius:2px; margin-top:5px; flex:0 0 9px; }
.cf .chain .mark.clear{background:var(--green)} .cf .chain .mark.contested{background:var(--red)} .cf .chain .mark.unresolved{background:var(--amber)}
.cf .chain .right { font-size:12px; color:var(--ink3); font-family:'JetBrains Mono',monospace; }
.cf .chain .holder { font-size:15px; font-weight:500; margin-top:3px; letter-spacing:-0.02em; }
.cf .chain .cnote { font-size:13px; color:var(--ink2); margin-top:4px; line-height:1.5; }

.cf .ev { display:flex; gap:16px; padding:16px 0; border-bottom:1px solid var(--line2); }
.cf .ev .idx { font-family:'JetBrains Mono',monospace; font-size:12px; color:var(--ink3); padding-top:2px; width:20px; flex:0 0 20px; }
.cf .ev a { color:var(--ink); text-decoration:none; font-size:14.5px; font-weight:500; display:inline-flex; align-items:center; gap:5px; }
.cf .ev a:hover { color:var(--sig); }
.cf .stance { font-family:'JetBrains Mono',monospace; font-size:11px; padding:2px 7px; border-radius:4px; }
.cf .stance.supports { background:#E6F1EC; color:var(--green); }
.cf .stance.conflicts { background:#F7E7E4; color:var(--red); }
.cf .stance.context { background:var(--line2); color:var(--ink2); }

.cf .tl { position:relative; padding-left:22px; }
.cf .tl:before { content:''; position:absolute; left:4px; top:6px; bottom:6px; width:1px; background:var(--line); }
.cf .tlrow { position:relative; padding:9px 0; }
.cf .tlrow:before { content:''; position:absolute; left:-22px; top:14px; width:9px; height:9px; border-radius:50%; background:var(--card); border:1.5px solid var(--ink3); }
.cf .tlrow.sig:before { border-color:var(--sig); background:var(--sig); }

.cf .empty { border:1px dashed var(--line); border-radius:12px; padding:44px 28px; text-align:center; background:var(--card); }
.cf .empty h3 { margin:0 0 6px; font-size:16px; font-weight:600; }
.cf .empty p { margin:0 auto 18px; color:var(--ink2); font-size:14px; max-width:44ch; line-height:1.5; }

.cf .banner { border:1px solid var(--red); background:#FBEEEC; border-radius:10px; padding:13px 16px; font-size:13.5px; color:var(--red); display:flex; gap:10px; align-items:flex-start; }
.cf .banner.calm { border-color:var(--line); background:var(--card); color:var(--ink2); }

.cf .note { font-size:12px; color:var(--ink3); line-height:1.5; }
.cf .split { display:grid; grid-template-columns:1fr 320px; gap:22px; align-items:start; }
.cf .split2 { display:grid; grid-template-columns:1fr 300px; gap:20px; align-items:start; }
@media (max-width:1080px){ .cf .split,.cf .split2 { grid-template-columns:1fr; } .cf .rail{ width:210px; flex-basis:210px } .cf .wrap{ padding:30px 26px 70px } }

.cf .mail { background:#FBFBF9; border:1px solid var(--line); border-radius:10px; padding:18px 20px; }
.cf .mail .hdr { display:grid; grid-template-columns:64px 1fr; gap:4px 12px; font-size:13px; padding-bottom:12px; border-bottom:1px solid var(--line2); }
.cf .mail .hdr span:nth-child(odd) { color:var(--ink3); font-family:'JetBrains Mono',monospace; font-size:11.5px; padding-top:2px; }
.cf .mail .body { font-size:14px; line-height:1.65; white-space:pre-wrap; margin-top:14px; color:var(--ink); }

.cf .spendrow { display:flex; align-items:center; gap:10px; font-size:12.5px; padding:5px 0; }
.cf .spendrow .k { width:104px; color:var(--ink2); }
.cf .spendrow .track { flex:1; height:3px; background:var(--line2); border-radius:999px; overflow:hidden; }
.cf .spendrow .track i { display:block; height:100%; background:var(--ink3); }
.cf .spendrow .v { width:58px; text-align:right; font-family:'JetBrains Mono',monospace; color:var(--ink2); }

.cf .doc { background:#fff; border:1px solid var(--line); border-radius:12px; padding:52px 56px; }
.cf .doc h3 { font-size:13px; font-weight:600; margin:34px 0 12px; padding-bottom:7px; border-bottom:1px solid var(--ink); letter-spacing:-0.01em; }
.cf .doc p { font-size:13.5px; line-height:1.6; color:#2C2F35; margin:0 0 10px; }
.cf .doc table td, .cf .doc table th { font-size:12.5px; }
.cf .doc .kv { display:grid; grid-template-columns:190px 1fr; gap:4px 16px; font-size:13px; }
.cf .doc .kv span:first-child { color:var(--ink3); }
.cf .doc .sign { border:1px solid var(--ink); border-radius:8px; padding:18px 20px; margin-top:14px; }

@media print {
  .cf .rail, .cf .no-print { display:none !important; }
  .cf, .cf .main { height:auto; overflow:visible; background:#fff; }
  .cf .wrap { max-width:none; padding:0; }
  .cf .doc { border:0; padding:0; }
}
`;

/* ================================================================== */
/*  small components                                                   */
/* ================================================================== */

function Risk({ level }) {
  return (
    <span className="risk">
      <i className={`sq ${level || "none"}`} />
      {level ? level.charAt(0) + level.slice(1).toLowerCase() : "Pending"}
    </span>
  );
}

function StatusPill({ status }) {
  const cls = WORKING.includes(status) ? "live"
    : status === "review" ? "amber"
    : RESOLVED.includes(status) ? "green"
    : status === "failed" || status === "held" ? "red" : "";
  return <span className="pill"><i className={`dot ${cls}`} />{STATUS_LABEL[status] || status}</span>;
}

function Stats({ t }) {
  return (
    <div className="stats">
      {[["Findings", t.total], ["Resolved", t.cleared], ["Needs review", t.review], ["In progress", t.open]].map(
        ([l, n]) => (
          <div className="stat" key={l}>
            <div className="n">{String(n).padStart(2, "0")}</div>
            <div className="l">{l}</div>
          </div>
        )
      )}
    </div>
  );
}

function ChainOfTitle({ chains, category }) {
  if (!chains || !chains.length) return null;
  return (
    <div className="card pad" style={{ marginTop: 22 }}>
      <div className="between">
        <h2 style={{ fontSize: 15 }}>Chain of title</h2>
        {category === "MUSIC" && chains.length > 1 && (
          <span className="note">Both chains must resolve before the cue can be used.</span>
        )}
      </div>
      <div style={{ marginTop: 14 }}>
        {chains.map((c, i) => (
          <div className="chain" key={i}>
            <i className={`mark ${c.status}`} />
            <div style={{ flex: 1 }}>
              <div className="between">
                <div className="right">{c.right}</div>
                <div className="right">{c.status}</div>
              </div>
              <div className="holder">{c.holder || "No owner established"}</div>
              {c.note && <div className="cnote">{c.note}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DecisionPanel({ finding, role, onRecord }) {
  const [choice, setChoice] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const counsel = role === "Counsel";

  const submit = async () => {
    if (!choice || !counsel) return;
    setBusy(true);
    await onRecord(finding, choice, note.trim());
    setBusy(false);
  };

  return (
    <div className="card pad" style={{ marginTop: 20 }}>
      <h2 style={{ fontSize: 15 }}>Record a decision</h2>
      <p className="note" style={{ margin: "6px 0 14px" }}>
        {counsel
          ? "Written to this production's ledger and carried into the report. Pursuing a licence also drafts the inquiry."
          : "Only counsel can resolve a finding. Switch role at the bottom of the sidebar to record this decision."}
      </p>
      <div className="filters" style={{ marginBottom: 14 }}>
        {ACTIONS.map((a) => (
          <button key={a.key} className={`chip ${choice === a.key ? "on" : ""}`} disabled={!counsel}
            onClick={() => setChoice(a.key)}>{a.label}</button>
        ))}
      </div>
      <label className="field" style={{ marginBottom: 14 }}>
        <span className="lab">Rationale</span>
        <textarea value={note} disabled={!counsel} onChange={(e) => setNote(e.target.value)}
          placeholder="Why this resolves the finding." />
      </label>
      <button className="btn" disabled={!choice || !counsel || busy} onClick={submit}>
        {busy ? <Loader2 size={14} /> : <Check size={14} />} Record decision
      </button>
    </div>
  );
}

function makeFinding(r, pass) {
  const cat = String(r.category || "").toUpperCase();
  return {
    id: uid(),
    item: String(r.item || "Unnamed element").slice(0, 90),
    category: CATEGORY_LABEL[cat] ? cat : "OTHER",
    scene: r.scene ? String(r.scene) : "—",
    page: r.page ? String(r.page) : null,
    context: String(r.context || "").slice(0, 220),
    status: "queued",
    risk: null,
    pass,
    evidence: [],
    chains: [],
    activity: [{
      t: new Date().toISOString(),
      stage: "Breakdown",
      text: `Identified in ${r.scene ? `scene ${String(r.scene).replace(/^scene\s*/i, "")}` : "the screenplay"}`,
    }],
  };
}

/* ================================================================== */
/*  app                                                                */
/* ================================================================== */

export default function ClearFrame() {
  const [ready, setReady] = useState(false);
  const [index, setIndex] = useState([]);
  const [record, setRecord] = useState(null);
  const [view, setView] = useState({ name: "productions" });
  const [role, setRole] = useState("Producer");
  const [roleOpen, setRoleOpen] = useState(false);
  const [error, setError] = useState(null);

  const recRef = useRef(null);
  const stopRef = useRef(false);
  const saveTimer = useRef(null);

  useEffect(() => {
    (async () => {
      setIndex((await store.get("cf:index")) || []);
      setReady(true);
    })();
  }, []);

  const persist = useCallback((rec, immediate) => {
    const write = async () => {
      await store.set(`cf:p:${rec.id}`, rec);
      const t = tally(rec.findings);
      const idx = (await store.get("cf:index")) || [];
      const row = {
        id: rec.id, title: rec.title, format: rec.format, status: rec.status,
        createdAt: rec.createdAt, updatedAt: rec.updatedAt, script: rec.script,
        spent: rec.spent, cap: rec.cap, passes: (rec.passes || []).length,
        signed: !!rec.signoff, ...t,
      };
      const next = idx.some((p) => p.id === rec.id) ? idx.map((p) => (p.id === rec.id ? row : p)) : [row, ...idx];
      await store.set("cf:index", next);
      setIndex(next);
    };
    clearTimeout(saveTimer.current);
    if (immediate) write(); else saveTimer.current = setTimeout(write, 900);
  }, []);

  const commit = useCallback((immediate) => {
    const rec = recRef.current;
    if (!rec) return;
    rec.updatedAt = new Date().toISOString();
    setRecord({ ...rec });
    persist(rec, immediate);
  }, [persist]);

  const log = (finding, stage, text) => {
    finding.activity = finding.activity || [];
    finding.activity.push({ t: new Date().toISOString(), stage, text });
  };

  const spend = (rec, stage, c) => {
    rec.spent = (rec.spent || 0) + (c || 0);
    rec.spendBy = rec.spendBy || {};
    rec.spendBy[stage] = (rec.spendBy[stage] || 0) + (c || 0);
  };

  const openProduction = async (id, name = "workspace") => {
    const live = recRef.current && recRef.current.id === id ? recRef.current : null;
    const rec = live || (await store.get(`cf:p:${id}`));
    if (!rec) return;
    recRef.current = rec;
    setRecord(rec);
    setView({ name, productionId: id });
  };

  /* ---------------- investigation ---------------- */

  const investigate = async (rec, list) => {
    await runQueue(list, 3, async (f) => {
      if (stopRef.current) { f.status = "held"; log(f, "Dispatch", "Pass stopped before research began"); commit(); return; }
      if ((rec.spent || 0) >= rec.cap) {
        f.status = "held";
        log(f, "Dispatch", "Held: research budget reached");
        commit();
        return;
      }

      try {
        f.status = "researching";
        log(f, "Research", "Web investigation started");
        commit();

        const r = await stageResearch(f, rec, null);
        spend(rec, "Research", r.cost);
        f.summary = r.summary;
        f.evidence = r.evidence;
        log(f, "Research", `${r.evidence.length} source${r.evidence.length === 1 ? "" : "s"} recorded from ${r.retrieved} retrieved`);
        commit();

        f.status = "verifying";
        commit();
        let v = await stageVerify(f, f.summary, f.evidence);
        spend(rec, "Verification", v.cost);
        f.verification = { ...v, followUpRun: false };

        if (!v.sufficient && (rec.spent || 0) < rec.cap && !stopRef.current) {
          log(f, "Verification", `Challenged — ${v.reason}`);
          await appendLedger(rec, "Verifier", `Challenge filed on "${f.item}": ${v.reason}`);
          f.status = "researching";
          commit();

          const r2 = await stageResearch(f, rec, `${v.reason}${v.followUp ? ` ${v.followUp}` : ""}`);
          spend(rec, "Research", r2.cost);
          const seen = new Set(f.evidence.map((e) => e.url));
          const added = r2.evidence.filter((e) => !seen.has(e.url));
          f.evidence = [...f.evidence, ...added];
          if (r2.summary) f.summary = r2.summary;
          log(f, "Follow-up", `${added.length} further source${added.length === 1 ? "" : "s"} recorded`);
          commit();

          f.status = "verifying";
          commit();
          const v2 = await stageVerify(f, f.summary, f.evidence);
          spend(rec, "Verification", v2.cost);
          f.verification = { ...v2, followUpRun: true, priorReason: v.reason };
          v = v2;
        }
        log(f, "Verification", v.sufficient ? "Evidence accepted" : `Unresolved — ${v.reason}`);
        commit();

        f.status = "tracing";
        commit();
        const ch = await stageChain(f, f.summary, f.evidence);
        spend(rec, "Chain of title", ch.cost);
        f.chains = ch.chains;
        log(f, "Chain of title", ch.chains.length
          ? ch.chains.map((c) => `${c.right} → ${c.holder || "unresolved"}`).join(" · ")
          : "No chain could be traced");
        commit();

        f.status = "assessing";
        commit();
        const a = await stageAssess(f, f.summary, f.evidence, v, f.chains);
        spend(rec, "Assessment", a.cost);
        f.risk = a.risk;
        f.confidence = a.confidence;
        f.assessment = a.assessment;
        f.recommendation = a.recommendation;
        f.status = a.requiresReview ? "review" : "cleared";
        log(f, "Assessment", `${a.risk.charAt(0) + a.risk.slice(1).toLowerCase()} risk at ${Math.round(a.confidence * 100)}% confidence — ${a.requiresReview ? "human review required" : "cleared without review"}`);
        await appendLedger(rec, "Assessment", `"${f.item}" assessed ${a.risk} at ${Math.round(a.confidence * 100)}% confidence`);
        commit();
      } catch (e) {
        f.status = "failed";
        f.errorText = e.message;
        log(f, "Research", `Stopped: ${e.message}`);
        commit();
      }
    });

    rec.status = rec.findings.some((f) => f.status === "review") ? "review" : "complete";
    rec.completedAt = new Date().toISOString();
    commit(true);
  };

  const runPass = async (rec, payload) => {
    recRef.current = rec;
    stopRef.current = false;
    setRecord({ ...rec });

    rec.status = "breakdown";
    rec.error = null;
    rec.ledger = [];
    await appendLedger(rec, "Producer", `Pass 1 opened on ${rec.script}`);
    commit(true);

    let rows;
    try {
      const out = await stageBreakdown(payload, rec.title);
      spend(rec, "Breakdown", out.cost);
      rows = out.rows;
    } catch (e) {
      rec.status = "failed";
      rec.error = e.message;
      commit(true);
      return;
    }

    rec.findings = rows.slice(0, 16).map((r) => makeFinding(r, 1));
    rec.passes = [{ n: 1, script: rec.script, at: new Date().toISOString(), added: rec.findings.length, changed: 0, withdrawn: 0, carried: 0 }];
    rec.status = "running";
    await appendLedger(rec, "Breakdown", `${rec.findings.length} clearance items extracted from ${rec.script}`);
    commit(true);

    await investigate(rec, rec.findings);
  };

  const runDelta = async (payload, scriptName) => {
    const rec = recRef.current;
    if (!rec) return;
    stopRef.current = false;
    const n = (rec.passes?.length || 1) + 1;

    rec.status = "breakdown";
    rec.error = null;
    commit(true);

    let rows;
    try {
      const out = await stageBreakdown(payload, rec.title);
      spend(rec, "Breakdown", out.cost);
      rows = out.rows;
    } catch (e) {
      rec.status = rec.findings.some((f) => f.status === "review") ? "review" : "complete";
      rec.error = e.message;
      commit(true);
      return;
    }

    const incoming = rows.slice(0, 16).map((r) => makeFinding(r, n));
    const byKey = new Map(rec.findings.map((f) => [`${f.category}|${norm(f.item)}`, f]));
    const seen = new Set();
    const added = [];
    const changed = [];
    let carried = 0;

    for (const row of incoming) {
      const key = `${row.category}|${norm(row.item)}`;
      seen.add(key);
      const prior = byKey.get(key);
      if (!prior) {
        rec.findings.push(row);
        added.push(row);
      } else if (norm(prior.context) !== norm(row.context) || norm(prior.scene) !== norm(row.scene)) {
        prior.context = row.context;
        prior.scene = row.scene;
        prior.page = row.page;
        prior.status = "queued";
        prior.pass = n;
        log(prior, "Delta", `Changed in cut ${n} — re-clearing against the recorded evidence`);
        changed.push(prior);
      } else {
        carried += 1;
        log(prior, "Delta", `Unchanged in cut ${n} — state and sources carried forward`);
      }
    }

    const withdrawn = [];
    for (const f of rec.findings) {
      const key = `${f.category}|${norm(f.item)}`;
      if (!seen.has(key) && f.status !== "withdrawn") {
        f.status = "withdrawn";
        log(f, "Delta", `No longer present in cut ${n}`);
        withdrawn.push(f);
      }
    }

    rec.script = scriptName;
    rec.passes = [...(rec.passes || []), {
      n, script: scriptName, at: new Date().toISOString(),
      added: added.length, changed: changed.length, withdrawn: withdrawn.length, carried,
    }];
    rec.status = "running";
    await appendLedger(rec, "Breakdown", `Cut ${n}: ${added.length} new, ${changed.length} changed, ${withdrawn.length} withdrawn, ${carried} carried forward`);
    commit(true);

    await investigate(rec, [...added, ...changed]);
  };

  const resume = async () => {
    const rec = recRef.current;
    if (!rec) return;
    stopRef.current = false;
    const list = rec.findings.filter((f) => ["held", "queued", "failed"].includes(f.status));
    if (!list.length) return;
    rec.status = "running";
    commit(true);
    await investigate(rec, list);
  };

  /* ---------------- human actions ---------------- */

  const recordDecision = async (finding, action, note) => {
    const rec = recRef.current;
    const f = rec.findings.find((x) => x.id === finding.id);
    if (!f) return;
    f.status = action;
    f.decision = { action, note, actor: role, t: new Date().toISOString() };
    const label = ACTIONS.find((a) => a.key === action).label;
    log(f, "Decision", `${label} — recorded by ${role}`);
    await appendLedger(rec, role, `"${f.item}" — ${label}${note ? `: ${note}` : ""}`);
    rec.status = rec.findings.some((x) => x.status === "review") ? "review" : "complete";
    commit(true);

    if (action === "licensed") {
      f.outreach = { state: "drafting" };
      commit();
      try {
        const o = await stageOutreach(f, rec, f.chains || []);
        spend(rec, "Outreach", o.cost);
        f.outreach = { state: "draft", to: o.to, subject: o.subject, body: o.body, drafted: new Date().toISOString() };
        log(f, "Outreach", `Licence inquiry drafted to ${o.to}`);
      } catch (e) {
        f.outreach = { state: "failed", error: e.message };
        log(f, "Outreach", `Draft failed: ${e.message}`);
      }
      commit(true);
    }
  };

  const approveOutreach = async (finding) => {
    const rec = recRef.current;
    const f = rec.findings.find((x) => x.id === finding.id);
    if (!f || !f.outreach) return;
    f.outreach = { ...f.outreach, state: "approved", approvedBy: role, approvedAt: new Date().toISOString() };
    log(f, "Outreach", `Inquiry approved for sending by ${role}`);
    await appendLedger(rec, role, `Licence inquiry for "${f.item}" approved to send to ${f.outreach.to}`);
    commit(true);
  };

  const reverify = async (finding) => {
    const rec = recRef.current;
    const f = rec.findings.find((x) => x.id === finding.id);
    if (!f) return;
    f.monitoring = { running: true, last: f.monitoring?.last || null };
    commit();
    try {
      log(f, "Monitoring", "Re-check started");
      const r = await stageResearch(f, rec, "Check whether the rights position has changed since it was last recorded.");
      spend(rec, "Monitoring", r.cost);
      const seen = new Set(f.evidence.map((e) => e.url));
      const added = r.evidence.filter((e) => !seen.has(e.url));
      f.evidence = [...f.evidence, ...added];
      const conflict = added.some((e) => e.stance === "conflicts");
      if (conflict) {
        f.status = "review";
        rec.status = "review";
        log(f, "Monitoring", `Reopened — ${added.length} new source${added.length === 1 ? "" : "s"} conflict with the recorded position`);
        await appendLedger(rec, "Monitoring", `"${f.item}" reopened: new evidence conflicts with the recorded position`);
      } else {
        log(f, "Monitoring", added.length
          ? `${added.length} new source${added.length === 1 ? "" : "s"}, position unchanged`
          : "No material change found");
      }
      f.monitoring = { running: false, last: new Date().toISOString() };
    } catch (e) {
      f.monitoring = { running: false, last: f.monitoring?.last || null, error: e.message };
      log(f, "Monitoring", `Stopped: ${e.message}`);
    }
    commit(true);
  };

  const signReport = async () => {
    const rec = recRef.current;
    if (!rec) return;
    const head = rec.ledger?.length ? rec.ledger[rec.ledger.length - 1].hash : ZERO;
    rec.signoff = { actor: role, t: new Date().toISOString(), head };
    await appendLedger(rec, role, "Clearance report signed off");
    commit(true);
  };

  /* ---------------- derived ---------------- */

  const pending = useMemo(
    () => index.reduce((n, p) => n + (p.review || 0) + (p.outreach || 0), 0),
    [index]
  );
  const active = useMemo(
    () => index.find((p) => ["running", "breakdown"].includes(p.status)) || index[0] || null,
    [index]
  );

  if (!ready) {
    return (
      <div className="cf">
        <style>{CSS}</style>
        <div className="main" style={{ display: "grid", placeItems: "center" }}><Loader2 size={18} /></div>
      </div>
    );
  }

  const go = (v) => { setError(null); setView(v); };

  return (
    <div className="cf">
      <style>{CSS}</style>

      <aside className="rail no-print">
        <div className="brand">
          <b>ClearFrame</b>
          <span>Every frame cleared.</span>
        </div>

        <nav className="navgroup">
          {[
            ["productions", "Productions", index.length],
            ["approvals", "Approvals", pending],
            ["reports", "Reports", index.filter((p) => p.total > 0).length],
          ].map(([key, label, n]) => (
            <button key={key}
              className={`nav ${view.name === key || (key === "productions" && ["workspace", "finding", "new"].includes(view.name)) ? "on" : ""}`}
              onClick={() => go({ name: key })}>
              {label}{n > 0 && <span className="count">{n}</span>}
            </button>
          ))}
        </nav>

        <div className="navgroup" style={{ paddingTop: 16 }}>
          {active ? (
            <button className="railcard" style={{ display: "block", textAlign: "left", cursor: "pointer", width: "100%" }}
              onClick={() => openProduction(active.id)}>
              <div className="t">{active.title}</div>
              <div style={{ marginTop: 8 }}>
                <StatusPill status={
                  ["running", "breakdown"].includes(active.status) ? "researching"
                    : active.status === "review" ? "review" : "cleared"} />
              </div>
              {active.passes > 1 && <div className="note mono" style={{ marginTop: 8 }}>Cut {active.passes}</div>}
            </button>
          ) : (
            <div className="railcard"><div className="note">No production open.</div></div>
          )}
        </div>

        <div className="railfoot">
          <button className="rolebtn" onClick={() => setRoleOpen((o) => !o)}>
            {role} <ChevronDown size={13} style={{ marginLeft: "auto" }} />
          </button>
          {roleOpen && (
            <div className="rolemenu">
              <div className="why">Only counsel can resolve findings, approve outreach or sign a report.</div>
              {["Producer", "Counsel"].map((r) => (
                <button key={r} onClick={() => { setRole(r); setRoleOpen(false); }}>
                  {r === role ? "• " : ""}{r}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        <div className="wrap">
          {error && (
            <div className="banner" style={{ marginBottom: 22 }}>
              <AlertTriangle size={16} style={{ flex: "0 0 16px", marginTop: 1 }} /><span>{error}</span>
            </div>
          )}

          {view.name === "productions" && (
            <Productions index={index} onOpen={openProduction} onNew={() => go({ name: "new" })} />
          )}

          {view.name === "new" && (
            <NewPass onCancel={() => go({ name: "productions" })}
              onStart={(rec, payload) => { setView({ name: "workspace", productionId: rec.id }); runPass(rec, payload); }} />
          )}

          {view.name === "workspace" && record && (
            <Workspace rec={record}
              onOpenFinding={(id) => setView({ name: "finding", productionId: record.id, findingId: id, tab: "overview" })}
              onStop={() => { stopRef.current = true; }}
              onResume={resume}
              onDelta={runDelta} />
          )}

          {view.name === "finding" && record && (
            <FindingDetail rec={record} findingId={view.findingId} tab={view.tab || "overview"} role={role}
              onTab={(t) => setView((v) => ({ ...v, tab: t }))}
              onBack={() => setView({ name: "workspace", productionId: record.id })}
              onRecord={recordDecision} onReverify={reverify} onApproveOutreach={approveOutreach} />
          )}

          {view.name === "approvals" && (
            <Approvals index={index} role={role} onRecord={recordDecision} onApproveOutreach={approveOutreach}
              recRef={recRef} setRecord={setRecord} />
          )}

          {view.name === "reports" && (
            <Reports index={index} record={record} role={role} onLoad={(id) => openProduction(id, "reports")}
              onSign={signReport} />
          )}
        </div>
      </main>
    </div>
  );
}

/* ================================================================== */
/*  productions                                                        */
/* ================================================================== */

function Productions({ index, onOpen, onNew }) {
  return (
    <>
      <div className="between">
        <div>
          <h1>Productions</h1>
          <p className="lede">Every clearance pass you have run, and what is still open on each.</p>
        </div>
        <button className="btn" onClick={onNew}><Plus size={14} /> New pass</button>
      </div>

      <div style={{ marginTop: 30 }}>
        {index.length === 0 ? (
          <div className="empty">
            <h3>Start with a screenplay</h3>
            <p>Upload a script and ClearFrame breaks it down, researches each rights item on the live web, and hands you what needs a decision.</p>
            <button className="btn" onClick={onNew}><Upload size={14} /> Start a clearance pass</button>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 14 }}>
            {index.map((p) => {
              const done = p.total ? Math.round(((p.cleared + p.review) / p.total) * 100) : 0;
              return (
                <button key={p.id} className="card pad" onClick={() => onOpen(p.id)}
                  style={{ display: "block", textAlign: "left", cursor: "pointer", width: "100%", font: "inherit", color: "inherit" }}>
                  <div className="between">
                    <div>
                      <h2>{p.title}</h2>
                      <div className="sub mono" style={{ marginTop: 5 }}>
                        {p.format} · {p.script}{p.passes > 1 ? ` · cut ${p.passes}` : ""}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      {p.signed && <span className="pill"><Shield size={11} /> Signed</span>}
                      <StatusPill status={
                        ["running", "breakdown"].includes(p.status) ? "researching"
                          : p.status === "review" ? "review"
                          : p.status === "failed" ? "failed" : "cleared"} />
                    </div>
                  </div>

                  <div className="row mono" style={{ marginTop: 16, gap: 22, fontSize: 12.5, color: "var(--ink2)", flexWrap: "wrap" }}>
                    <span>{p.total} findings</span>
                    <span>{p.cleared} resolved</span>
                    <span>{p.review} in review</span>
                    <span>{p.open} in progress</span>
                    {p.withdrawn > 0 && <span>{p.withdrawn} withdrawn</span>}
                  </div>

                  <div className="bar" style={{ marginTop: 14 }}><i style={{ width: `${done}%` }} /></div>

                  <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
                    <span className="note mono">{money(p.spent)} of {money(p.cap)} · updated {stamp(p.updatedAt)}</span>
                    <span className="row" style={{ fontSize: 13, gap: 5 }}>Open <ArrowUpRight size={13} /></span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

/* ================================================================== */
/*  new pass                                                           */
/* ================================================================== */

function NewPass({ onStart, onCancel }) {
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState("Feature film");
  const [cap, setCap] = useState("25.00");
  const [file, setFile] = useState(null);
  const [text, setText] = useState("");
  const [hot, setHot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const inputRef = useRef(null);

  const take = (f) => {
    const bad = acceptScript(f);
    if (bad) { setMsg(bad); return; }
    setMsg(null);
    setFile(f);
  };

  const start = async () => {
    if (!title.trim()) { setMsg("Give the production a title."); return; }
    if (!file && text.trim().length < 400) { setMsg("Add a screenplay file, or paste at least a few pages of script."); return; }
    const capNum = parseFloat(cap);
    if (!capNum || capNum <= 0) { setMsg("Set a research budget above zero."); return; }

    setBusy(true); setMsg(null);
    try {
      const payload = file ? await readScript(file) : { kind: "text", data: text };
      onStart({
        id: uid(), title: title.trim(), format, cap: capNum, spent: 0, spendBy: {},
        script: file ? file.name : "pasted script",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        status: "breakdown", findings: [], ledger: [], passes: [],
      }, payload);
    } catch (e) {
      setMsg(e.message); setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 620 }}>
      <button className="btn ghost sm" onClick={onCancel}><ArrowLeft size={13} /> Productions</button>
      <h1 style={{ marginTop: 22 }}>Start a clearance pass</h1>
      <p className="lede">The script is read once, then every item found in it is researched against live sources.</p>

      <div style={{ marginTop: 30 }}>
        <label className="field">
          <span className="lab">Production title</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="As it appears on the slate" />
        </label>

        <label className="field">
          <span className="lab">Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option>Feature film</option><option>Documentary</option>
            <option>Series episode</option><option>Short film</option>
          </select>
        </label>

        <div className="field">
          <span className="lab">Screenplay</span>
          <div className={`drop ${hot ? "hot" : ""}`} onClick={() => inputRef.current && inputRef.current.click()}
            onDragOver={(e) => { e.preventDefault(); setHot(true); }}
            onDragLeave={() => setHot(false)}
            onDrop={(e) => { e.preventDefault(); setHot(false); take(e.dataTransfer.files && e.dataTransfer.files[0]); }}>
            {file ? (
              <>
                <FileText size={18} style={{ marginBottom: 8, color: "var(--sig)" }} />
                <div className="h mono">{file.name}</div>
                <div className="s">{(file.size / 1024 / 1024).toFixed(2)} MB · click to choose a different file</div>
              </>
            ) : (
              <>
                <Upload size={18} style={{ marginBottom: 8, color: "var(--ink3)" }} />
                <div className="h">Drop the screenplay here</div>
                <div className="s">PDF, .txt or .fountain</div>
              </>
            )}
          </div>
          <input ref={inputRef} type="file" accept=".pdf,.txt,.fountain,.md" style={{ display: "none" }}
            onChange={(e) => take(e.target.files && e.target.files[0])} />
          {!file && (
            <textarea style={{ marginTop: 10 }} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="Or paste the script here." />
          )}
        </div>

        <label className="field">
          <span className="lab">Research budget</span>
          <input type="number" step="0.5" min="1" value={cap} onChange={(e) => setCap(e.target.value)} />
          <span className="note" style={{ display: "block", marginTop: 7 }}>
            Research stops when live spend reaches this cap. Anything not yet investigated is held rather than guessed.
          </span>
        </label>

        {msg && (
          <div className="banner" style={{ marginBottom: 18 }}>
            <AlertTriangle size={16} style={{ flex: "0 0 16px", marginTop: 1 }} /><span>{msg}</span>
          </div>
        )}

        <button className="btn" onClick={start} disabled={busy}>
          {busy ? <Loader2 size={14} /> : <Check size={14} />} Start the pass
        </button>
      </div>
    </div>
  );
}

/* ================================================================== */
/*  workspace                                                          */
/* ================================================================== */

const FILTERS = [["all", "All"], ["review", "Needs review"], ["open", "In progress"], ["resolved", "Resolved"]];

function Workspace({ rec, onOpenFinding, onStop, onResume, onDelta }) {
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [cutOpen, setCutOpen] = useState(false);
  const t = tally(rec.findings);
  const running = rec.status === "running" || rec.status === "breakdown";
  const feed = feedOf(rec).slice(0, 40);
  const heldCount = rec.findings.filter((f) => ["held", "queued", "failed"].includes(f.status)).length;

  const rows = rec.findings.filter((f) => {
    const bucket =
      filter === "all" ? f.status !== "withdrawn"
        : filter === "review" ? f.status === "review"
        : filter === "open" ? WORKING.includes(f.status) || f.status === "held" || f.status === "failed"
        : RESOLVED.includes(f.status) || f.status === "withdrawn";
    return bucket && (!q || (f.item + f.category + f.scene).toLowerCase().includes(q.toLowerCase()));
  });

  const pct = t.total ? Math.round(((t.cleared + t.review) / t.total) * 100) : 0;
  const spendBy = Object.entries(rec.spendBy || {}).sort((a, b) => b[1] - a[1]);
  const maxSpend = spendBy.length ? spendBy[0][1] : 1;
  const passes = rec.passes || [];
  const lastPass = passes[passes.length - 1];

  return (
    <>
      <div className="between">
        <div>
          <h1>{rec.title}</h1>
          <div className="sub mono" style={{ marginTop: 7 }}>
            {rec.format} · {rec.script} · started {stamp(rec.createdAt)}
          </div>
        </div>
        <div className="row">
          {running && <button className="btn ghost sm" onClick={onStop}><Square size={12} /> Stop pass</button>}
          {!running && heldCount > 0 && (
            <button className="btn ghost sm" onClick={onResume}><RotateCw size={12} /> Resume {heldCount}</button>
          )}
          {!running && rec.findings.length > 0 && (
            <button className="btn ghost sm" onClick={() => setCutOpen((o) => !o)}><Upload size={12} /> New cut</button>
          )}
          <StatusPill status={running ? "researching" : rec.status === "review" ? "review" : rec.status === "failed" ? "failed" : "cleared"} />
        </div>
      </div>

      {rec.status === "failed" && (
        <div className="banner" style={{ marginTop: 22 }}>
          <AlertTriangle size={16} style={{ flex: "0 0 16px", marginTop: 1 }} /><span>{rec.error}</span>
        </div>
      )}

      {cutOpen && <NewCut onCancel={() => setCutOpen(false)} onGo={(p, name) => { setCutOpen(false); onDelta(p, name); }} />}

      {lastPass && lastPass.n > 1 && (
        <div className="banner calm" style={{ marginTop: 22 }}>
          <span>
            Cut {lastPass.n} · {lastPass.added} new, {lastPass.changed} changed, {lastPass.withdrawn} withdrawn.
            {" "}{lastPass.carried} items kept their state and sources from the previous cut.
          </span>
        </div>
      )}

      <div style={{ marginTop: 26 }}><Stats t={t} /></div>

      <div style={{ marginTop: 18 }}>
        <div className="bar"><i style={{ width: `${pct}%` }} /></div>
        <div className="row" style={{ justifyContent: "space-between", marginTop: 9 }}>
          <span className="note">
            {rec.status === "breakdown" ? "Reading the screenplay" : running ? "Investigation running" : "Investigation complete"}
            {t.withdrawn > 0 ? ` · ${t.withdrawn} withdrawn from the cut` : ""}
          </span>
          <span className="note mono">{money(rec.spent)} of {money(rec.cap)} spent</span>
        </div>
      </div>

      <div className="split" style={{ marginTop: 30 }}>
        <div>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
            <div className="filters">
              {FILTERS.map(([k, l]) => {
                const n = k === "all" ? t.total : k === "review" ? t.review : k === "open" ? t.open : t.cleared + t.withdrawn;
                return (
                  <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
                    {l}<span className="mono">{n}</span>
                  </button>
                );
              })}
            </div>
            <div className="row" style={{ gap: 7 }}>
              <Search size={14} color="var(--ink3)" />
              <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search findings"
                style={{ width: 170, padding: "7px 10px", fontSize: 13 }} />
            </div>
          </div>

          {rec.findings.length === 0 ? (
            <div className="empty">
              <h3>{rec.status === "breakdown" ? "Reading the screenplay" : "Nothing found yet"}</h3>
              <p>{rec.status === "breakdown"
                ? "Items appear here as soon as the breakdown finishes."
                : "The breakdown returned no clearance items for this script."}</p>
            </div>
          ) : (
            <div className="card" style={{ padding: "16px 10px 4px" }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Risk</th>
                    <th>Item</th>
                    <th style={{ width: 100 }}>Type</th>
                    <th style={{ width: 150 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f) => (
                    <tr key={f.id} className="click" onClick={() => onOpenFinding(f.id)}>
                      <td><Risk level={f.risk} /></td>
                      <td>
                        <div style={{ fontWeight: 500, opacity: f.status === "withdrawn" ? 0.5 : 1 }}>{f.item}</div>
                        <div className="sub mono">
                          {f.scene !== "—" ? `Scene ${String(f.scene).replace(/^scene\s*/i, "")}` : "Unlocated"}
                          {f.page ? ` · Page ${f.page}` : ""}
                          {f.chains && f.chains.length > 1 ? ` · ${f.chains.length} chains` : ""}
                        </div>
                      </td>
                      <td style={{ color: "var(--ink2)" }}>{CATEGORY_LABEL[f.category]}</td>
                      <td><StatusPill status={f.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && <div className="note" style={{ padding: "18px 12px" }}>No findings match that filter.</div>}
            </div>
          )}
        </div>

        <div>
          <div className="card pad">
            <h2 style={{ fontSize: 15 }}>Activity</h2>
            <p className="note" style={{ margin: "5px 0 16px" }}>Every step the pass has actually taken.</p>
            {feed.length === 0 ? (
              <div className="note">Nothing has happened yet.</div>
            ) : (
              <div className="tl">
                {feed.map((e, i) => (
                  <div className={`tlrow ${i === 0 && running ? "sig" : ""}`} key={i}>
                    <div className="row" style={{ gap: 8, fontSize: 12.5 }}>
                      <span className="mono" style={{ color: "var(--ink3)" }}>{clock(e.t)}</span>
                      <span style={{ fontWeight: 500 }}>{e.stage}</span>
                    </div>
                    <div className="note" style={{ marginTop: 2 }}>{e.item} — {e.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {spendBy.length > 0 && (
            <div className="card pad" style={{ marginTop: 16 }}>
              <h2 style={{ fontSize: 15 }}>Where the budget went</h2>
              <div style={{ marginTop: 12 }}>
                {spendBy.map(([k, v]) => (
                  <div className="spendrow" key={k}>
                    <span className="k">{k}</span>
                    <span className="track"><i style={{ width: `${Math.round((v / maxSpend) * 100)}%` }} /></span>
                    <span className="v">{money(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function NewCut({ onCancel, onGo }) {
  const [file, setFile] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [hot, setHot] = useState(false);
  const ref = useRef(null);

  const take = (f) => {
    const bad = acceptScript(f);
    if (bad) { setMsg(bad); return; }
    setMsg(null); setFile(f);
  };

  const go = async () => {
    if (!file) { setMsg("Choose the revised screenplay."); return; }
    setBusy(true);
    try { onGo(await readScript(file), file.name); }
    catch (e) { setMsg(e.message); setBusy(false); }
  };

  return (
    <div className="card pad" style={{ marginTop: 22 }}>
      <div className="between">
        <div>
          <h2 style={{ fontSize: 15 }}>Re-clear a revised cut</h2>
          <p className="note" style={{ marginTop: 6, maxWidth: "56ch" }}>
            Only items that are new or changed are researched again. Everything unchanged keeps its evidence, its risk and its decision.
          </p>
        </div>
        <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
      </div>

      <div className={`drop tight ${hot ? "hot" : ""}`} style={{ marginTop: 14 }} onClick={() => ref.current && ref.current.click()}
        onDragOver={(e) => { e.preventDefault(); setHot(true); }}
        onDragLeave={() => setHot(false)}
        onDrop={(e) => { e.preventDefault(); setHot(false); take(e.dataTransfer.files && e.dataTransfer.files[0]); }}>
        <div className="h mono">{file ? file.name : "Drop the revised screenplay"}</div>
        <div className="s">{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "PDF, .txt or .fountain"}</div>
      </div>
      <input ref={ref} type="file" accept=".pdf,.txt,.fountain,.md" style={{ display: "none" }}
        onChange={(e) => take(e.target.files && e.target.files[0])} />

      {msg && <div className="banner" style={{ marginTop: 14 }}>
        <AlertTriangle size={16} style={{ flex: "0 0 16px", marginTop: 1 }} /><span>{msg}</span>
      </div>}

      <button className="btn" style={{ marginTop: 16 }} disabled={busy} onClick={go}>
        {busy ? <Loader2 size={14} /> : <Check size={14} />} Run the delta pass
      </button>
    </div>
  );
}

/* ================================================================== */
/*  finding detail                                                     */
/* ================================================================== */

function FindingDetail({ rec, findingId, tab, role, onTab, onBack, onRecord, onReverify, onApproveOutreach }) {
  const f = rec.findings.find((x) => x.id === findingId);
  if (!f) return <div className="note">That finding is no longer in this production.</div>;
  const resolved = RESOLVED.includes(f.status);

  return (
    <>
      <button className="btn ghost sm" onClick={onBack}><ArrowLeft size={13} /> {rec.title}</button>

      <div className="between" style={{ marginTop: 22 }}>
        <div>
          <h1>{f.item}</h1>
          <div className="sub mono" style={{ marginTop: 7 }}>
            {CATEGORY_LABEL[f.category]}
            {f.scene !== "—" ? ` · Scene ${String(f.scene).replace(/^scene\s*/i, "")}` : ""}
            {f.page ? ` · Page ${f.page}` : ""}
            {f.pass > 1 ? ` · added in cut ${f.pass}` : ""}
          </div>
        </div>
        <StatusPill status={f.status} />
      </div>

      <div className="tabs">
        {[["overview", "Overview"], ["evidence", `Evidence ${(f.evidence || []).length}`], ["activity", "Activity"]].map(
          ([k, l]) => <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => onTab(k)}>{l}</button>
        )}
      </div>

      {tab === "overview" && (
        <div style={{ marginTop: 22 }}>
          <div className="split2">
            <div className="card pad">
              <h2 style={{ fontSize: 15 }}>How it appears</h2>
              <p style={{ fontSize: 14.5, lineHeight: 1.6, margin: "8px 0 0", color: "var(--ink2)" }}>{f.context}</p>
              {f.summary && (
                <>
                  <h2 style={{ fontSize: 15, marginTop: 22 }}>Rights position found</h2>
                  <p style={{ fontSize: 14.5, lineHeight: 1.6, margin: "8px 0 0", color: "var(--ink2)" }}>{f.summary}</p>
                </>
              )}
            </div>

            <div className="card pad">
              <div className="note">Risk</div>
              <div style={{ margin: "8px 0 14px", fontSize: 20, fontWeight: 600, letterSpacing: "-0.03em" }}>
                <Risk level={f.risk} />
              </div>
              {typeof f.confidence === "number" && (
                <>
                  <div className="bar"><i style={{ width: `${Math.round(f.confidence * 100)}%` }} /></div>
                  <div className="note mono" style={{ marginTop: 7 }}>{Math.round(f.confidence * 100)}% confidence</div>
                </>
              )}
              {f.verification && (
                <div className="note" style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line2)" }}>
                  {f.verification.sufficient ? "Evidence accepted by verification." : "Evidence still contested."}
                  {f.verification.followUpRun ? " Follow-up research was run." : ""}
                </div>
              )}
            </div>
          </div>

          <ChainOfTitle chains={f.chains} category={f.category} />

          {f.assessment && (
            <div style={{ marginTop: 22 }}>
              <h2 style={{ fontSize: 15 }}>Assessment</h2>
              <p style={{ fontSize: 15, lineHeight: 1.65, margin: "9px 0 0", maxWidth: "68ch" }}>{f.assessment}</p>
              <h2 style={{ fontSize: 15, marginTop: 22 }}>Recommended next step</h2>
              <p style={{ fontSize: 15, lineHeight: 1.65, margin: "9px 0 0", maxWidth: "68ch" }}>{f.recommendation}</p>
              <p className="note" style={{ marginTop: 14 }}>
                Based on the sources recorded under Evidence. Research output for human review.
              </p>
            </div>
          )}

          {f.status === "failed" && (
            <div className="banner" style={{ marginTop: 20 }}>
              <AlertTriangle size={16} style={{ flex: "0 0 16px", marginTop: 1 }} /><span>{f.errorText}</span>
            </div>
          )}

          {f.status === "held" && (
            <div className="card pad" style={{ marginTop: 20 }}>
              <div className="note">This item was not investigated because the pass reached its research budget. Resume the pass from the production to pick it up.</div>
            </div>
          )}

          {f.status === "withdrawn" && (
            <div className="card pad" style={{ marginTop: 20 }}>
              <div className="note">This element is not in the current cut. Its research stays on record in case it returns.</div>
            </div>
          )}

          {f.status === "review" && <DecisionPanel finding={f} role={role} onRecord={onRecord} />}

          {f.outreach && <Outreach finding={f} role={role} onApprove={onApproveOutreach} />}

          {resolved && (
            <div className="card pad" style={{ marginTop: 22 }}>
              <h2 style={{ fontSize: 15 }}>Decision</h2>
              {f.decision ? (
                <>
                  <p style={{ fontSize: 14.5, margin: "8px 0 0" }}>
                    {(ACTIONS.find((a) => a.key === f.decision.action) || {}).label || f.decision.action}
                    {f.decision.note ? ` — ${f.decision.note}` : ""}
                  </p>
                  <div className="note mono" style={{ marginTop: 6 }}>{f.decision.actor} · {stamp(f.decision.t)}</div>
                </>
              ) : (
                <p style={{ fontSize: 14.5, margin: "8px 0 0", color: "var(--ink2)" }}>Cleared by assessment without human review.</p>
              )}

              <div style={{ marginTop: 20, paddingTop: 18, borderTop: "1px solid var(--line2)" }}>
                <div className="between">
                  <div>
                    <h2 style={{ fontSize: 15 }}>Monitoring</h2>
                    <p className="note" style={{ marginTop: 6, maxWidth: "48ch" }}>
                      Re-run the research against today's web. If a new source conflicts with what is on record, the finding reopens.
                    </p>
                    {f.monitoring && f.monitoring.last && (
                      <div className="note mono" style={{ marginTop: 8 }}>Last checked {stamp(f.monitoring.last)}</div>
                    )}
                  </div>
                  <button className="btn ghost sm" disabled={f.monitoring && f.monitoring.running} onClick={() => onReverify(f)}>
                    {f.monitoring && f.monitoring.running ? <Loader2 size={13} /> : <RotateCw size={13} />} Check again
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "evidence" && (
        <div style={{ marginTop: 22 }}>
          {!(f.evidence || []).length ? (
            <div className="empty">
              <h3>{WORKING.includes(f.status) ? "Research in progress" : "No sources recorded"}</h3>
              <p>{WORKING.includes(f.status)
                ? "Sources appear here as they are retrieved."
                : "Nothing was retrieved for this item. Only sources actually returned by a search are stored."}</p>
            </div>
          ) : (
            <div className="card pad">
              {f.evidence.map((e, i) => (
                <div className="ev" key={e.url + i} style={i === f.evidence.length - 1 ? { borderBottom: 0 } : undefined}>
                  <span className="idx">{String(i + 1).padStart(2, "0")}</span>
                  <div style={{ flex: 1 }}>
                    <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                      <a href={e.url} target="_blank" rel="noreferrer">{e.title} <ArrowUpRight size={13} /></a>
                      <span className={`stance ${e.stance}`}>{e.stance}</span>
                    </div>
                    <div style={{ fontSize: 14, color: "var(--ink2)", marginTop: 5, lineHeight: 1.5 }}>{e.note}</div>
                    <div className="note mono" style={{ marginTop: 6 }}>{e.domain} · retrieved {stamp(e.retrieved)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {f.verification && (
            <div className="card pad" style={{ marginTop: 18 }}>
              <h2 style={{ fontSize: 15 }}>Verification</h2>
              {f.verification.priorReason && (
                <p style={{ fontSize: 14, margin: "10px 0 0", color: "var(--red)" }}>Challenged: {f.verification.priorReason}</p>
              )}
              <p style={{ fontSize: 14.5, margin: "10px 0 0", color: "var(--ink2)", lineHeight: 1.6 }}>
                {f.verification.sufficient ? `Accepted. ${f.verification.reason}` : `Unresolved. ${f.verification.reason}`}
              </p>
            </div>
          )}
        </div>
      )}

      {tab === "activity" && (
        <div className="card pad" style={{ marginTop: 22 }}>
          <div className="tl">
            {(f.activity || []).slice().reverse().map((e, i) => (
              <div className="tlrow" key={i}>
                <div className="row" style={{ gap: 8, fontSize: 13 }}>
                  <span className="mono" style={{ color: "var(--ink3)" }}>{clock(e.t)}</span>
                  <span style={{ fontWeight: 500 }}>{e.stage}</span>
                </div>
                <div className="note" style={{ marginTop: 2 }}>{e.text}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/* ================================================================== */
/*  outreach                                                           */
/* ================================================================== */

function Outreach({ finding, role, onApprove, compact }) {
  const o = finding.outreach;
  const [copied, setCopied] = useState(false);
  const counsel = role === "Counsel";

  if (o.state === "drafting") {
    return (
      <div className="card pad" style={{ marginTop: 22 }}>
        <h2 style={{ fontSize: 15 }}>Licence inquiry</h2>
        <div className="note" style={{ marginTop: 8 }}>Drafting the inquiry from the traced chain of title.</div>
      </div>
    );
  }
  if (o.state === "failed") {
    return (
      <div className="banner" style={{ marginTop: 22 }}>
        <AlertTriangle size={16} style={{ flex: "0 0 16px", marginTop: 1 }} /><span>{o.error}</span>
      </div>
    );
  }

  const copy = () => {
    const text = `To: ${o.to}\nSubject: ${o.subject}\n\n${o.body}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      });
    }
  };

  return (
    <div className={compact ? "" : "card pad"} style={{ marginTop: compact ? 18 : 22 }}>
      <div className="between">
        <div>
          <h2 style={{ fontSize: 15 }}>Licence inquiry</h2>
          <p className="note" style={{ marginTop: 6, maxWidth: "56ch" }}>
            {o.state === "approved"
              ? `Approved for sending by ${o.approvedBy} on ${stamp(o.approvedAt)}. ClearFrame does not send mail — copy it into your own outbox.`
              : "Drafted from the chain of title on record. It sits here until counsel approves it."}
          </p>
        </div>
        <span className="pill">
          <i className={`dot ${o.state === "approved" ? "green" : "amber"}`} />
          {o.state === "approved" ? "Approved" : "Awaiting approval"}
        </span>
      </div>

      <div className="mail" style={{ marginTop: 14 }}>
        <div className="hdr">
          <span>To</span><span>{o.to}</span>
          <span>Subject</span><span>{o.subject}</span>
        </div>
        <div className="body">{o.body}</div>
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        {o.state === "draft" && (
          <button className="btn" disabled={!counsel} onClick={() => onApprove(finding)}>
            <Send size={13} /> Approve for sending
          </button>
        )}
        <button className="btn ghost" onClick={copy}><Copy size={13} /> {copied ? "Copied" : "Copy"}</button>
      </div>
      {o.state === "draft" && !counsel && (
        <div className="note" style={{ marginTop: 10 }}>Only counsel can approve outbound inquiries.</div>
      )}
    </div>
  );
}

/* ================================================================== */
/*  approvals                                                          */
/* ================================================================== */

function Approvals({ index, role, onRecord, onApproveOutreach, recRef, setRecord }) {
  const [loaded, setLoaded] = useState([]);
  const [busy, setBusy] = useState(true);
  const [tab, setTab] = useState("decisions");

  useEffect(() => {
    (async () => {
      setBusy(true);
      const out = [];
      for (const p of index.filter((x) => (x.review || 0) > 0 || (x.outreach || 0) > 0)) {
        const live = recRef.current && recRef.current.id === p.id ? recRef.current : null;
        const rec = live || (await store.get(`cf:p:${p.id}`));
        if (rec) out.push(rec);
      }
      setLoaded(out);
      setBusy(false);
    })();
  }, [index, recRef]);

  const focus = (finding) => {
    const parent = loaded.find((r) => r.findings.some((x) => x.id === finding.id));
    if (!parent) return null;
    recRef.current = parent;
    setRecord(parent);
    return parent;
  };

  const handleDecision = async (finding, action, note) => {
    const parent = focus(finding);
    if (!parent) return;
    await onRecord(finding, action, note);
    setLoaded((ls) => ls.map((r) => (r.id === parent.id ? { ...parent } : r)));
  };

  const handleOutreach = async (finding) => {
    const parent = focus(finding);
    if (!parent) return;
    await onApproveOutreach(finding);
    setLoaded((ls) => ls.map((r) => (r.id === parent.id ? { ...parent } : r)));
  };

  const decisions = loaded.flatMap((rec) => rec.findings.filter((f) => f.status === "review").map((f) => ({ rec, f })));
  const outreach = loaded.flatMap((rec) =>
    rec.findings.filter((f) => f.outreach && f.outreach.state === "draft").map((f) => ({ rec, f })));

  return (
    <>
      <h1>Approvals</h1>
      <p className="lede">What research cannot settle on its own: findings that need a decision, and inquiries that need clearing before they leave the building.</p>

      <div className="tabs">
        <button className={`tab ${tab === "decisions" ? "on" : ""}`} onClick={() => setTab("decisions")}>
          Decisions {decisions.length > 0 ? decisions.length : ""}
        </button>
        <button className={`tab ${tab === "outreach" ? "on" : ""}`} onClick={() => setTab("outreach")}>
          Outreach {outreach.length > 0 ? outreach.length : ""}
        </button>
      </div>

      <div style={{ marginTop: 26 }}>
        {busy ? (
          <div className="note">Loading the queue.</div>
        ) : tab === "decisions" ? (
          decisions.length === 0 ? (
            <div className="empty">
              <h3>Nothing waiting</h3>
              <p>When an assessment calls for human review, the finding lands here with its evidence and chain of title attached.</p>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 18 }}>
              {decisions.map(({ rec, f }) => (
                <div className="card pad" key={f.id}>
                  <div className="between">
                    <div>
                      <div className="note mono">{rec.title}</div>
                      <h2 style={{ marginTop: 5 }}>{f.item}</h2>
                      <div className="sub mono" style={{ marginTop: 4 }}>
                        {CATEGORY_LABEL[f.category]}
                        {f.scene !== "—" ? ` · Scene ${String(f.scene).replace(/^scene\s*/i, "")}` : ""}
                      </div>
                    </div>
                    <Risk level={f.risk} />
                  </div>

                  <div className="row mono" style={{ marginTop: 16, gap: 22, fontSize: 12.5, color: "var(--ink2)", flexWrap: "wrap" }}>
                    <span>{Math.round((f.confidence || 0) * 100)}% confidence</span>
                    <span>{(f.evidence || []).length} sources</span>
                    <span>{(f.evidence || []).filter((e) => e.stance === "conflicts").length} conflicting</span>
                    {(f.chains || []).length > 0 && (
                      <span>{f.chains.filter((c) => c.status !== "clear").length} of {f.chains.length} chains open</span>
                    )}
                  </div>

                  {(f.chains || []).length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      {f.chains.map((c, i) => (
                        <div className="chain" key={i}>
                          <i className={`mark ${c.status}`} />
                          <div style={{ flex: 1 }}>
                            <div className="right">{c.right} · {c.status}</div>
                            <div className="holder" style={{ fontSize: 14 }}>{c.holder || "No owner established"}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {f.assessment && <p style={{ fontSize: 14.5, lineHeight: 1.6, margin: "18px 0 0", maxWidth: "70ch" }}>{f.assessment}</p>}
                  {f.recommendation && (
                    <p style={{ fontSize: 14.5, lineHeight: 1.6, margin: "10px 0 0", maxWidth: "70ch", fontWeight: 500 }}>{f.recommendation}</p>
                  )}

                  <DecisionPanel finding={f} role={role} onRecord={handleDecision} />
                </div>
              ))}
            </div>
          )
        ) : outreach.length === 0 ? (
          <div className="empty">
            <h3>No inquiries waiting</h3>
            <p>Choosing to pursue a licence on a finding drafts the inquiry to the traced rights holder. It waits here for counsel.</p>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 18 }}>
            {outreach.map(({ rec, f }) => (
              <div className="card pad" key={f.id}>
                <div className="note mono">{rec.title}</div>
                <h2 style={{ marginTop: 5 }}>{f.item}</h2>
                <Outreach finding={f} role={role} onApprove={handleOutreach} compact />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ================================================================== */
/*  reports                                                            */
/* ================================================================== */

function Reports({ index, record, role, onLoad, onSign }) {
  const [openId, setOpenId] = useState(null);
  const ready = index.filter((p) => p.total > 0);

  if (openId && record && record.id === openId) {
    return <ReportDoc rec={record} role={role} onSign={onSign} onBack={() => setOpenId(null)} />;
  }

  return (
    <>
      <h1>Reports</h1>
      <p className="lede">A clearance record built from what the pass actually found, verified, traced and decided.</p>

      <div style={{ marginTop: 30 }}>
        {ready.length === 0 ? (
          <div className="empty">
            <h3>No completed passes</h3>
            <p>Run a clearance pass and its report becomes available here.</p>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 14 }}>
            {ready.map((p) => (
              <div className="card pad" key={p.id}>
                <div className="between">
                  <div>
                    <div className="row" style={{ gap: 10 }}>
                      <h2>{p.title}</h2>
                      {p.signed && <span className="pill"><Shield size={11} /> Signed</span>}
                    </div>
                    <div className="row mono" style={{ marginTop: 10, gap: 20, fontSize: 12.5, color: "var(--ink2)", flexWrap: "wrap" }}>
                      <span>{p.total} findings</span>
                      <span>{p.cleared} resolved</span>
                      <span>{p.review} open</span>
                      {p.passes > 1 && <span>{p.passes} cuts</span>}
                    </div>
                    {p.review > 0 && (
                      <div className="note" style={{ marginTop: 10 }}>
                        {p.review} finding{p.review === 1 ? "" : "s"} still awaiting a decision. The report will list them as unresolved.
                      </div>
                    )}
                  </div>
                  <button className="btn" onClick={async () => { await onLoad(p.id); setOpenId(p.id); }}>Build report</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function ReportDoc({ rec, role, onSign, onBack }) {
  const t = tally(rec.findings);
  const [generated] = useState(() => new Date().toISOString());
  const [integrity, setIntegrity] = useState(null);
  const [checking, setChecking] = useState(false);

  const detailed = rec.findings.filter((f) => f.status !== "withdrawn" && (f.risk !== "LOW" || f.status === "review"));
  const outreach = rec.findings.filter((f) => f.outreach && f.outreach.state !== "failed" && f.outreach.state !== "drafting");
  const deltas = (rec.passes || []).filter((p) => p.n > 1);
  const ledger = rec.ledger || [];

  const check = async () => {
    setChecking(true);
    setIntegrity(await verifyLedger(ledger));
    setChecking(false);
  };

  return (
    <>
      <div className="row no-print" style={{ justifyContent: "space-between", marginBottom: 22, flexWrap: "wrap", gap: 10 }}>
        <button className="btn ghost sm" onClick={onBack}><ArrowLeft size={13} /> Reports</button>
        <div className="row">
          {!rec.signoff && (
            <button className="btn ghost" disabled={role !== "Counsel"} onClick={onSign}>
              <Shield size={14} /> Sign off
            </button>
          )}
          <button className="btn" onClick={() => window.print()}><Printer size={14} /> Save as PDF</button>
        </div>
      </div>
      {!rec.signoff && role !== "Counsel" && (
        <div className="note no-print" style={{ marginBottom: 20, textAlign: "right" }}>Sign-off is counsel's to give.</div>
      )}

      <div className="doc">
        <div style={{ borderBottom: "2px solid var(--ink)", paddingBottom: 16 }}>
          <div className="mono" style={{ fontSize: 12, color: "var(--ink3)" }}>ClearFrame</div>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.035em", marginTop: 6 }}>Production clearance report</div>
          <div style={{ fontSize: 14, color: "var(--ink2)", marginTop: 4 }}>
            Research findings, chains of title, evidence, risk assessments and recorded decisions.
          </div>
        </div>

        <h3>1 · Production</h3>
        <div className="kv mono">
          <span>Title</span><span>{rec.title}</span>
          <span>Format</span><span>{rec.format}</span>
          <span>Current cut</span><span>{rec.script}{(rec.passes || []).length > 1 ? ` (cut ${rec.passes.length})` : ""}</span>
          <span>Pass opened</span><span>{stamp(rec.createdAt)}</span>
          <span>Report generated</span><span>{stamp(generated)}</span>
          <span>Research spend</span><span>{money(rec.spent)} against a {money(rec.cap)} cap</span>
        </div>

        <h3>2 · Summary</h3>
        <p>
          {t.total} clearance item{t.total === 1 ? "" : "s"} are live in the current cut.
          {" "}{t.cleared} {t.cleared === 1 ? "has" : "have"} been resolved, {t.review} remain{t.review === 1 ? "s" : ""} open for a decision,
          and {t.open} {t.open === 1 ? "was" : "were"} not completed.
          {t.withdrawn > 0 ? ` A further ${t.withdrawn} ${t.withdrawn === 1 ? "item was" : "items were"} withdrawn as the cut changed.` : ""}
        </p>

        <h3>3 · Item register</h3>
        <table>
          <thead><tr><th>Risk</th><th>Item</th><th>Type</th><th>Location</th><th>Status</th></tr></thead>
          <tbody>
            {rec.findings.map((f) => (
              <tr key={f.id}>
                <td><Risk level={f.risk} /></td>
                <td>{f.item}</td>
                <td>{CATEGORY_LABEL[f.category]}</td>
                <td className="mono">
                  {f.scene !== "—" ? `Sc ${String(f.scene).replace(/^scene\s*/i, "")}` : "—"}{f.page ? ` / p${f.page}` : ""}
                </td>
                <td>{STATUS_LABEL[f.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>4 · Chains of title and evidence</h3>
        {detailed.length === 0 && <p>No item in the current cut carried elevated risk.</p>}
        {detailed.map((f) => (
          <div key={f.id} style={{ marginBottom: 26 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{f.item}</div>
            <div className="mono" style={{ fontSize: 12, color: "var(--ink3)", marginTop: 3 }}>
              {CATEGORY_LABEL[f.category]}
              {f.scene !== "—" ? ` · Scene ${String(f.scene).replace(/^scene\s*/i, "")}` : ""}
              {typeof f.confidence === "number" ? ` · ${Math.round(f.confidence * 100)}% confidence` : ""}
            </div>

            {(f.chains || []).length > 0 && (
              <table style={{ margin: "10px 0" }}>
                <thead><tr><th>Right</th><th>Controlled by</th><th>Status</th><th>Note</th></tr></thead>
                <tbody>
                  {f.chains.map((c, i) => (
                    <tr key={i}>
                      <td>{c.right}</td>
                      <td>{c.holder || "Not established"}</td>
                      <td>{c.status}</td>
                      <td>{c.note || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {f.summary && <p>{f.summary}</p>}
            {f.assessment && <p>{f.assessment}</p>}
            {f.recommendation && <p style={{ fontWeight: 600 }}>{f.recommendation}</p>}
            {f.verification && (
              <p style={{ color: "var(--ink3)" }}>
                Verification: {f.verification.sufficient ? "evidence accepted" : "evidence contested"}
                {f.verification.priorReason ? ` after a challenge — ${f.verification.priorReason}` : ""}.
              </p>
            )}
            <ol style={{ margin: "10px 0 0", paddingLeft: 18 }}>
              {(f.evidence || []).map((e, i) => (
                <li key={i} style={{ fontSize: 12.5, lineHeight: 1.6, marginBottom: 5 }}>
                  <span style={{ fontWeight: 500 }}>{e.title}</span> — {e.note}{" "}
                  <span className="mono" style={{ color: "var(--ink3)" }}>[{e.stance}] {e.url}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}

        <h3>5 · Recorded decisions</h3>
        {rec.findings.filter((f) => f.decision).length === 0 ? (
          <p>No decisions have been recorded on this production.</p>
        ) : (
          <table>
            <thead><tr><th>Item</th><th>Decision</th><th>Rationale</th><th>Recorded by</th><th>When</th></tr></thead>
            <tbody>
              {rec.findings.filter((f) => f.decision).map((f) => (
                <tr key={f.id}>
                  <td>{f.item}</td>
                  <td>{(ACTIONS.find((a) => a.key === f.decision.action) || {}).label}</td>
                  <td>{f.decision.note || "—"}</td>
                  <td>{f.decision.actor}</td>
                  <td className="mono">{stamp(f.decision.t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3>6 · Licence outreach</h3>
        {outreach.length === 0 ? (
          <p>No licence inquiries were drafted on this production.</p>
        ) : (
          <table>
            <thead><tr><th>Item</th><th>Addressed to</th><th>Subject</th><th>State</th><th>Approved by</th></tr></thead>
            <tbody>
              {outreach.map((f) => (
                <tr key={f.id}>
                  <td>{f.item}</td>
                  <td>{f.outreach.to}</td>
                  <td>{f.outreach.subject}</td>
                  <td>{f.outreach.state === "approved" ? "Approved to send" : "Awaiting approval"}</td>
                  <td>{f.outreach.approvedBy || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {deltas.length > 0 && (
          <>
            <h3>7 · Delta annex</h3>
            <p>Each revised cut re-cleared only what changed. Everything else kept its evidence, risk and decision.</p>
            <table>
              <thead><tr><th>Cut</th><th>Document</th><th>New</th><th>Changed</th><th>Withdrawn</th><th>Carried</th><th>When</th></tr></thead>
              <tbody>
                {deltas.map((p) => (
                  <tr key={p.n}>
                    <td className="mono">{p.n}</td><td>{p.script}</td>
                    <td className="mono">{p.added}</td><td className="mono">{p.changed}</td>
                    <td className="mono">{p.withdrawn}</td><td className="mono">{p.carried}</td>
                    <td className="mono">{stamp(p.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <h3>{deltas.length > 0 ? "8" : "7"} · Source index</h3>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          {rec.findings.flatMap((f) => (f.evidence || []).map((e) => ({ ...e, item: f.item }))).map((e, i) => (
            <li key={i} className="mono" style={{ fontSize: 11.5, lineHeight: 1.7, wordBreak: "break-all" }}>
              {e.url} · retrieved {stamp(e.retrieved)} · {e.item}
            </li>
          ))}
        </ol>

        <h3>{deltas.length > 0 ? "9" : "8"} · Provenance and sign-off</h3>
        <p>
          Every state change on this production was appended to a hash-chained ledger of {ledger.length} entries.
          Each entry carries the hash of the one before it, so any alteration to the history breaks the chain from that point on.
        </p>
        <div className="kv mono" style={{ marginBottom: 12 }}>
          <span>Ledger entries</span><span>{ledger.length}</span>
          <span>Chain head</span>
          <span style={{ wordBreak: "break-all" }}>{ledger.length ? ledger[ledger.length - 1].hash : "—"}</span>
        </div>

        <div className="no-print" style={{ marginBottom: 16 }}>
          <button className="btn ghost sm" onClick={check} disabled={checking}>
            {checking ? <Loader2 size={13} /> : <Shield size={13} />} Verify chain
          </button>
          {integrity && (
            <span className="note" style={{ marginLeft: 12 }}>
              {integrity.ok
                ? `Intact across all ${integrity.length} entries.`
                : `Chain breaks at entry ${integrity.at}. This history has been altered.`}
            </span>
          )}
        </div>

        {rec.signoff ? (
          <div className="sign">
            <div style={{ fontSize: 15, fontWeight: 600 }}>Signed off by {rec.signoff.actor}</div>
            <div className="mono" style={{ fontSize: 12, color: "var(--ink3)", marginTop: 5 }}>{stamp(rec.signoff.t)}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--ink3)", marginTop: 8, wordBreak: "break-all" }}>
              Ledger head at signature: {rec.signoff.head}
            </div>
          </div>
        ) : (
          <p style={{ color: "var(--ink3)" }}>Unsigned. This report has not yet been accepted by counsel.</p>
        )}

        <p style={{ marginTop: 34, paddingTop: 14, borderTop: "1px solid var(--line)", color: "var(--ink3)", fontSize: 12 }}>
          Every claim in this report is drawn from the sources listed above, retrieved at the times shown. It is research
          and a record of decisions, not a legal opinion.
        </p>
      </div>
    </>
  );
}
