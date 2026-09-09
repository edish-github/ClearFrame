<div align="center">

# ClearFrame

**Autonomous rights clearance and chain-of-title investigation for film and television.**

[![Google Cloud](https://img.shields.io/badge/Google_Cloud-Vertex_AI-4285F4?style=flat&logo=googlecloud&logoColor=white)](https://cloud.google.com/vertex-ai)
[![Parallel AI](https://img.shields.io/badge/Parallel_AI-Search_%26_Task-6366F1?style=flat)](https://parallel.ai)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16_Cloud_SQL-336791?style=flat&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Cloud Run](https://img.shields.io/badge/Google_Cloud-Cloud_Run-4285F4?style=flat&logo=googlecloud&logoColor=white)](https://cloud.google.com/run)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8_Strict-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

<p align="center">
  <a href="#live-deployment">Live Demo</a> •
  <a href="#the-problem">The Problem</a> •
  <a href="#system-architecture">Architecture</a> •
  <a href="#the-dual-chain-music-breakthrough">Dual-Chain Rights</a> •
  <a href="#core-guarantees--invariants">Guarantees</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#documentation-suite">Documentation</a>
</p>

</div>

---

### Live Deployment

| Service | Endpoint / Access |
|---|---|
| **Web Workspace** | [https://clearframe-web-690834564732.us-central1.run.app](https://clearframe-web-690834564732.us-central1.run.app) |
| **Demo Access** | Register a workspace at [`/register`](https://clearframe-web-690834564732.us-central1.run.app/register) (or see private hackathon testing instructions) |
| **API Base URL** | `https://clearframe-api-690834564732.us-central1.run.app` |
| **Infrastructure** | Serverless Google Cloud Run (`us-central1`) + Google Cloud SQL + Cloud Storage (GCS) |

---

## The Problem

No film or television production reaches an audience without clearance. Every song, visible brand, artwork, depicted real person, and archival clip must be traced to whoever controls the rights **today**. A distributor will not accept delivery without Errors & Omissions (E&O) insurance, and underwriters will not issue a policy without an exhaustive, auditable clearance report.

A standard 110-page feature screenplay routinely yields **200 to 400 distinct clearable items**.

Today, this process is broken:
* **The Manual Grind**: Handled via spreadsheets, clearance coordinators, and weeks of paralegal hours.
* **Instant Obsolescence**: The moment the director issues a revision (e.g. from shooting draft to blue revision), the clearance spreadsheet is immediately out of date.
* **Post-Signoff Blindness**: If a music catalog is acquired or an estate lawsuit is filed after sign-off, the production remains blind until hit with a cease-and-desist.

### The Dual-Chain Music Trap
A single song represents two separate legal properties with independent chains of title:
1. **The Master Recording** (controlled by a record label).
2. **The Underlying Composition** (controlled by publishers, songwriters, or fractured estates).

Licensing one clears nothing. A standard database lookup finds the label. Only a live investigation uncovers the probate dispute or unadministered catalog split sitting on the composition.

---

## System Architecture

ClearFrame is built around four decoupled planes. The API never invokes an LLM directly; instead, it writes a job to a durable PostgreSQL queue (`FOR UPDATE SKIP LOCKED`) and returns in milliseconds. Background workers execute the multi-stage research pipeline, and live updates travel back through PostgreSQL `LISTEN`/`NOTIFY` into Server-Sent Events (SSE).

![ClearFrame System Context](docs/diagrams/png/01-system-context.png)

```
   ┌────────────────────────────────────────────────────────────────────────┐
   │  EXPERIENCE PLANE           React 19 · Vite · Server-Sent Events (SSE) │
   │  Producer │ Coordinator │ Legal Counsel │ Underwriting Reviewer        │
   └────────────────────────────────┬───────────────────────────────────────┘
                                    │  REST + JWT
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │  CONTROL PLANE              Fastify API · Zod Validation · RBAC Gates  │
   │                                                                        │
   │      ★ THE API NEVER CALLS A MODEL DIRECTLY ★                          │
   │      Validates input → INSERTS job to queue → Returns in milliseconds  │
   └────────────────────────────────┬───────────────────────────────────────┘
                                    │  PostgreSQL Job Queue (SKIP LOCKED)
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │  EXECUTION PLANE            Worker Daemon · Resumable Step Pipeline    │
   │                                                                        │
   │   Breakdown ──► Recon ──► Synthesis ──► Verify ──► Trace ──► Assess    │
   └────────┬───────────────────────────────────────────────────┬───────────┘
            │                                                   │
            ▼                                                   ▼
   ┌────────────────────┐                          ┌────────────────────────┐
   │  GEMINI (Vertex)   │                          │  PARALLEL AI           │
   │  Reasons & Judges. │                          │  Retrieves & Scrapes.  │
   │  Never retrieves.  │                          │  Never reasons.        │
   └────────┬───────────┘                          └────────────┬───────────┘
            │                                                   │
            └───────────────────────┬───────────────────────────┘
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │  MEMORY PLANE      PostgreSQL 16 (14 Tables) · Cloud Storage (GCS)     │
   │  Findings · Evidence Citations · SHA-256 Ledger · Cost Events · Audits │
   └────────────────────────────────┬───────────────────────────────────────┘
                                    │  PostgreSQL LISTEN / NOTIFY
                                    └──────────► SSE Stream ──► Back to UI
```

---

## End-to-End Clearance Pass Sequence

When a screenplay PDF is uploaded, ClearFrame executes an orchestrated sequence across specialized autonomous agents:

![ClearFrame Clearance Pass Sequence](docs/diagrams/png/02-clearance-pass-sequence.png)

1. **Breakdown Agent** (`gemini-2.5-pro`): Extracts all clearable cues anchored to scene slugline, page number, context, and prominence (`hero`, `featured`, `background`).
2. **Recon & Retrieval** (`parallel-web`): Queries live-web registries and archives, capturing HTML crawl snapshots.
3. **Continuity Verifier Agent** (`gemini-2.5-pro`): Adversarially red-teams findings—challenging stale sources (>24 months) and conflicting registry claims before risk scoring.
4. **Studio Risk Counsel Agent** (`gemini-2.5-pro`): Maps findings to E&O underwriting standards (`GREEN`, `AMBER`, `RED`) with costed mitigations.
5. **Outreach Drafting Agent** (`gemini-2.5-flash`): Auto-drafts sync license inquiries held strictly behind human legal counsel authorization.

---

## The Dual-Chain Music Breakthrough

```
                    ┌──────────────────────────────────────────────┐
                    │  Scene 42 — "Midnight City" (Cover Version)  │
                    └──────────────────────┬───────────────────────┘
                                           │
                    ┌──────────────────────┴───────────────────────┐
                    ▼                                              ▼
          ╔═════════════════════╗                        ╔═════════════════════╗
          ║   MASTER CHAIN  ℗   ║                        ║ COMPOSITION CHAIN © ║
          ║  (This Performance) ║                        ║ (The Written Work)  ║
          ╚═════════╤═══════════╝                        ╚═════════╤═══════════╝
                    │                                              │
                    ▼                                              ▼
          ┌─────────────────────┐                        ┌─────────────────────┐
          │ Indie Label Roster  │                        │ Original Publisher  │
          └─────────┬───────────┘                        └─────────┬───────────┘
                    │                                              │
                    │                                              ▼
                    │                                    ┌─────────────────────┐
                    │                                    │ Catalog Acquisition │
                    │                                    │ (2023 Transfer)     │
                    │                                    └─────────┬───────────┘
                    │                                              │
                    │                                              ▼
                    │                                    ┌─────────────────────┐
                    │                                    │ ESTATE LITIGATION   │
                    │                                    │ (Disputed Split)    │
                    │                                    └─────────┬───────────┘
                    ▼                                              ▼
          ┌─────────────────────┐                        ┌─────────────────────┐
          │   Status: CLEAR     │                        │  Status: CONTESTED  │
          └─────────┬───────────┘                        └─────────┬───────────┘
                    │                                              │
                    └──────────────────────┬───────────────────────┘
                                           ▼
                             ┌───────────────────────────┐
                             │  Clearable ⟺ ALL Chains   │
                             │  Resolve Clear.           │
                             │                           │
                             │  → FLAGGED FOR COUNSEL    │
                             └───────────────────────────┘
```

ClearFrame enforces a mathematical rule: **clearance is a conjunction, not an average**. If the master is 100% clear but the composition is disputed, the item is strictly flagged for human counsel resolution.

---

## Delta Re-Clearance Engine

When a director submits a revised screenplay cut (Pass $N+1$), ClearFrame hashes scene content:
$$\text{ContentHash} = \text{SHA256}(\text{scene} \,\|\, \text{page} \,\|\, \text{context})$$

![ClearFrame Delta Re-Clearance](docs/diagrams/png/05-delta-reclearance.png)

* **Unchanged Items**: Carried forward with full evidence and counsel decisions intact (**$0.00 compute spend**).
* **Modified Items**: Re-queued and re-investigated in context.
* **Deleted Items**: Marked `withdrawn`—never deleted from the audit ledger.

---

## Core Guarantees & Invariants

> **The One Rule**: Every finding, source URL, spend penny, risk score, and report originates from a real user action or live pipeline execution. Where data does not exist, the UI renders an empty state rather than inventing placeholder content.

| Guarantee | Enforcement Mechanism | Code Location |
|---|---|---|
| **Zero Hallucinated Citations** | Model-emitted URLs not present in the live Parallel retrieval pool are dropped at the gateway | [`services/api/src/pipeline/stages.ts`](services/api/src/pipeline/stages.ts) |
| **Tamper-Proof Audit History** | SHA-256 hash-chained ledger; PostgreSQL trigger unconditionally rejects `UPDATE` and untagged `DELETE` | [`services/api/src/core/ledger.ts`](services/api/src/core/ledger.ts) |
| **No Floating Point Money** | 64-bit integer micro-dollars (`bigint`); token counts and retrieval units deduct atomically in the same statement | [`services/api/src/core/db.ts`](services/api/src/core/db.ts) |
| **Authority is Server-Side** | Only authenticated legal counsel can resolve findings, release outreach, or sign reports | [`services/api/src/core/auth.ts`](services/api/src/core/auth.ts) |
| **No Rogue Outbound Messages** | System contains zero email-sending mechanisms; licensing inquiries are draft-only | [`services/api/src/pipeline/stages.ts`](services/api/src/pipeline/stages.ts) |

---

## Cryptographic Ledger Integrity

Every finding lifecycle event, adversarial challenge, counsel decision, and spend record appends to an immutable SHA-256 hash chain:

$$\text{Hash}_n = \text{SHA256}\big(\,\mathcal{C}(\text{production\_id},\ \text{seq}_n,\ ts_n,\ \text{actor}_n,\ \text{event}_n,\ \text{Hash}_{n-1})\,\big)$$

![ClearFrame Ledger Integrity](docs/diagrams/png/06-ledger-integrity.png)

Underwriters can verify mathematical chain integrity at any time via `GET /api/productions/:id/integrity` or by clicking **"Verify Chain"** in the workspace.

---

## Quick Start

### Option A: Docker Compose (Recommended)

```bash
# 1. Clone and configure environment
cp .env.example .env

# Configure your keys in .env:
# - GOOGLE_CLOUD_PROJECT
# - PARALLEL_API_KEY
# - DATABASE_URL=postgres://clearframe:clearframe@localhost:5433/clearframe

# 2. Boot PostgreSQL, API, Worker, and Web
make up

# 3. Verify provider connectivity
make smoke
```

### Option B: Bare-Metal Development

```bash
# Install all workspace dependencies
make install

# Initialize database
createdb clearframe
make migrate

# Start API, Worker, and React Web concurrently
make dev
```
- Web Workspace: `http://localhost:3000`
- API Server: `http://localhost:8080`

---

## Testing & Verification Suite

```bash
make typecheck   # Strict TypeScript across all workspaces (noUncheckedIndexedAccess)
make test        # 22 integration tests against a live PostgreSQL instance
make smoke       # Live round-trip connectivity test to Vertex AI & Parallel AI
```

`make test` covers SHA-256 hash chaining, adversarial tamper detection, PostgreSQL trigger immutability, concurrent advisory locking under 10 parallel workers, queue stall reaping, integer money attribution, and citation pool containment.

---

## Role-Based Access Control (RBAC)

| Role | Permissions | Restricted Actions |
|---|---|---|
| **Producer** | Upload cuts, start passes, raise budgets, read all findings | Cannot resolve findings, release outreach, or sign reports |
| **Coordinator** | Correct item metadata, prioritize items, view all findings | Cannot resolve findings, release outreach, or sign reports |
| **Counsel** | Full access + approve/license findings, authorize outreach, sign E&O reports | Cannot delete ledger history (nobody can) |
| **Reviewer** | Read-only access to register, evidence snapshots, and reports | Cannot modify any production state |

---

## Production Deployment Topology

ClearFrame runs serverlessly on **Google Cloud Platform** in `us-central1`:

![ClearFrame Deployment Topology](docs/diagrams/png/07-deployment.png)

* **Google Cloud Run**: `clearframe-web` (SPA), `clearframe-api` (Fastify REST/SSE), and `clearframe-worker` (Background Daemon).
* **Google Cloud SQL**: Managed PostgreSQL 16 database with advisory locks and row-level security triggers.
* **Google Cloud Storage (GCS)**: Secure bucket storage for screenplay PDFs, signed PDF reports, and immutable HTML crawl snapshots.
* **Google Cloud Scheduler**: Automated cron triggering periodic job sweeps and Sentinel watch schedules.

---

## Documentation Suite

Comprehensive technical guides and specifications are available in the [`docs/`](docs/) directory:

* 📘 **[System Architecture](docs/architecture.md)** — The Four Planes, multi-stage pipelines, SSE streaming, and GCP topology.
* 🗄️ **[Data Model & Schema](docs/data-model.md)** — Complete 14-table PostgreSQL schema, integer micro-dollars, and state machines.
* 🔌 **[REST API & SSE Reference](docs/api.md)** — Endpoints, request/response schemas, error codes, and HMAC webhooks.
* 🛠️ **[Operations & Deployment](docs/operations.md)** — Cloud Run deployment guide, environment variables, and runbooks.
* 🔒 **[Security & Cryptographic Ledger](docs/security-ledger.md)** — SHA-256 chaining, PostgreSQL triggers, and anti-tamper proofs.
* 🤖 **[Autonomous Agent Playbooks](docs/agent-playbooks.md)** — Playbooks, prompts, tools, and guardrails for all 11 autonomous agents.
* 📊 **[Architecture Diagrams](docs/diagrams/README.md)** — High-resolution rendered PNGs and Mermaid source files.

---

## Licence

Licensed under the [Apache-2.0](LICENSE) License. See [NOTICE](NOTICE), [SECURITY.md](SECURITY.md), and [CONTRIBUTING.md](CONTRIBUTING.md).
