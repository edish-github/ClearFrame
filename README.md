<div align="center">

# ClearFrame

**Autonomous rights clearance and chain-of-title investigation for film and television.**

A producer uploads a screenplay. A pipeline breaks it into clearable elements, researches
each one against the live web, challenges its own findings, traces ownership, scores
exposure, routes what it cannot settle to human counsel, and renders an auditable
clearance report where every claim links to a source that was actually retrieved.

[Architecture](docs/architecture.md) · [API](docs/api.md) · [Data model](docs/data-model.md) · [Running it](docs/operations.md) · [Submission notes](docs/judging.md)

[![CI](https://github.com/OWNER/clearframe/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/clearframe/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-informational)](LICENSE)

</div>

---

## The problem

No film reaches an audience without clearance. Every song, visible brand, artwork,
depicted person and second of archival footage has to be traced to whoever controls it
today, and a distributor will not accept delivery without errors-and-omissions insurance,
which underwriters will not issue without a credible clearance report. A 110-page feature
routinely yields two to four hundred clearable items.

Today that work is a spreadsheet, a clearance coordinator and two to eight weeks of
paralegal hours. The output is stale the moment the picture is re-cut, and blind the
moment the world changes — a catalogue acquisition or a lawsuit filed after sign-off is
invisible until it becomes a claim.

Music is the trap that makes this investigation rather than lookup. One song is two
properties with separate chains of title: the master recording and the underlying
composition. Licensing one clears nothing. A lookup finds the label. Only an
investigation finds the estate dispute sitting on the composition.

## What this does

```
upload → break down → research → verify → trace → assess → decide → report → monitor
```

Every arrow is real. Gemini reasons; Parallel retrieves; Postgres remembers. When a new
cut arrives, only what changed is re-cleared. When a cleared item's rights position moves
later, the finding reopens itself.

## The one rule

> Every production, finding, status, evidence source, timestamp, confidence score, risk
> assessment, activity event, decision and report in this system originates from a real
> user action or a real backend pipeline execution. Where data does not exist, the
> interface shows an empty or pending state rather than inventing placeholder content.

There is no fixture data in this repository. Three mechanisms keep that enforceable
rather than aspirational:

| Guarantee | How it is enforced | Where |
|---|---|---|
| A citation cannot be fabricated | URLs the model emits that are not in the retrieved source pool are dropped before insert, and the rejected count is written to the activity feed | [`pipeline/stages.ts`](services/api/src/pipeline/stages.ts) |
| History cannot be edited | Hash-chained append-only ledger; `UPDATE` refused by a database trigger; signing refuses on a broken chain | [`core/ledger.ts`](services/api/src/core/ledger.ts) |
| Authority is not client-side | Only counsel resolves findings, releases outreach or signs reports; the UI only decides what to grey out | [`core/auth.ts`](services/api/src/core/auth.ts) |

## Quick start

```bash
cp .env.example .env      # set GEMINI_API_KEY and PARALLEL_API_KEY
make up                   # Postgres, API and worker, schema applied
make smoke                # one real call to each provider
```

Then in a second terminal:

```bash
npm run dev -w @clearframe/web    # http://localhost:3000
```

The API refuses to boot without both provider keys. There is deliberately no offline
fallback, because a fallback that invented rights data would be worse than an outage.

## Repository

```
clearframe/
├── apps/web                  the clearance workspace (React, Vite)
│   └── src
│       ├── api               typed transport, one file
│       ├── components        ui · findings · production · shell
│       ├── hooks             auth, async loading, live stream
│       ├── pages             one per route
│       └── styles            tokens · base · layout · components
│
├── services/api              API and pipeline worker (Fastify, Postgres)
│   ├── db/schema.sql         14 tables; money in integer micro-dollars
│   └── src
│       ├── core              config · db · auth · storage · ledger · events
│       ├── providers         Gemini and Parallel adapters, and their schemas
│       ├── pipeline          six stages, and the orchestrator that sequences them
│       ├── jobs              durable queue and the worker process
│       ├── routes            one file per concern
│       ├── report            PDF rendered from persisted rows
│       └── scripts           migrate · selftest · smoketest
│
├── packages/shared           vocabulary both sides speak
└── docs                      architecture · api · data model · operations · judging
```

Providers never reason. The pipeline never opens a socket. Routes never call a model.

## Architecture in one picture

```
   browser ──REST + SSE──►  API  ──jobs table──►  Worker  ──►  Gemini   (reasoning)
                             │                       │      ──►  Parallel (retrieval)
                             └──────► Postgres ◄─────┘
                                   findings · evidence · ledger
```

The API never calls a model. It validates, writes a job and returns. Every external call
belongs to the worker, which is why a pass survives a closed laptop, a redeploy or a rate
limit, and why the upload endpoint answers in milliseconds instead of minutes. Live
updates travel back through Postgres `LISTEN`/`NOTIFY` into Server-Sent Events, so the
stream works with several API instances and workers on separate machines.

Full detail in [docs/architecture.md](docs/architecture.md).

## Verifying it

```bash
make typecheck   # every workspace, strict, noUncheckedIndexedAccess
make test        # 22 integration checks against a real Postgres
make smoke       # one live call to each provider
```

`make test` covers hash chaining and tamper detection, append-only enforcement,
concurrent appends under contention, queue claim safety with ten simultaneous workers,
the stall reaper, integer money accounting, delta item identity and evidence constraints.

It proves tamper detection the hard way: it disables the trigger, edits an entry as an
attacker with direct database access would, and asserts the chain breaks at exactly that
sequence number.

## Roles

| Role | Can | Cannot |
|---|---|---|
| Producer | Upload cuts, start passes, raise budgets, read everything | Resolve findings, release outreach, sign reports |
| Coordinator | Correct item metadata, prioritise, read everything | Resolve findings, release outreach, sign reports |
| Counsel | Everything above, plus decisions, outreach approval and sign-off | Delete ledger history — nobody can |
| Reviewer | Read the register, the evidence and the report | Everything else |

Autonomy is spent on investigation. It is never spent on legal judgement or on
contacting a rights holder.

## What ClearFrame does not do

It does not send email. Licence inquiries are drafted and held behind counsel approval;
there is no send capability in the codebase to misfire.

It does not certify clearance. The report is research and a record of decisions, and says
so on its last page. The signature block belongs to a person.

It does not resolve conflicting sources silently. Where evidence disagrees, the
disagreement is recorded, the chain is marked contested, and a human decides.

## Built with

Gemini on Google Cloud for reasoning · [Parallel](https://parallel.ai) for live web
research · Postgres · Fastify · React

## Licence

[Apache-2.0](LICENSE). See [NOTICE](NOTICE), [SECURITY.md](SECURITY.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).
