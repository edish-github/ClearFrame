# ClearFrame

**The autonomous clearance & chain-of-title engine.** A crew of AI agents
investigates every song, brand, artwork, likeness and archival clip in a film
across the live web — traces ownership, scores legal exposure, drafts licence
outreach for human approval, and keeps watching after the credits roll.

> Built for **Agentic Cinema: The Blockbuster Hackathon** · **Parallel** track ·
> Gemini Enterprise Agent Builder × Google Cloud × Parallel

---

## The problem

Before any film ships, every third-party element in it must be cleared. A feature
script yields two to four hundred clearable items. Today that is two to eight
weeks of paralegals and spreadsheets, costing tens of thousands on an indie and
six figures on a studio picture — and the output is a static document that is
stale the moment the picture is re-cut, and blind the moment the world changes.

The commercial gate is E&O insurance: distributors will not accept delivery
without a policy, and underwriters will not issue one without a credible clearance
report. Clearance is not an efficiency problem. It is the structural gate between
a finished film and any revenue at all.

**Music is the canonical trap.** One song is two properties with separate chains of
title — the master recording and the underlying composition. Licensing one clears
nothing. A lookup finds the label. Only an investigation finds the lawsuit.

## What this repository is

A working backend for that investigation: eleven agent playbooks running on Gemini,
five Parallel API surfaces, an append-only hash-chained ledger, and an E&O report
in which every claim is a live link with a stored snapshot.

```
   upload ─▶ breakdown ─▶ dispatch ─▶ research ─▶ verify ─▶ risk ─▶ GATE ─▶ act
                              ▲                     │                        │
                              └──── challenge ──────┘                        ▼
                              ▲                                          report
                              └──────────── reopen ◀── sentinel ◀── monitor webhook
```

* **Gemini is the brain, Parallel is the senses.** Gemini reasons, plans, judges
  and drafts. Parallel retrieves, extracts, structures and watches. Neither
  substitutes for the other.
* **No claim without a citation.** Enforced in code at the ledger boundary, not
  requested in a prompt. A finding with no citation cannot be written.
* **A model cannot author a fact.** Claims only enter the ledger from Parallel's
  structured output. Gemini chooses what to investigate and how to phrase the
  question; it never fills in the answer.
* **Agents are supervised by other agents and by humans.** The Verifier attacks
  every finding; counsel gates every red item and every outbound message.
* **The ledger is append-only and the report is a view.** Tampering is detectable
  by recomputation. Audit is a property, not a feature.
* **Clearance is continuous.** A cleared item is an armed monitor, not a closed row.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 · Foundation | Monorepo, contracts, SQL, IaC scripts, licence | ✅ complete |
| 1 · First light | Parallel adapter, ledger + hash chain, breakdown, music crew | ✅ complete |
| 2 · The crew | Dispatch, tiering, budget, all four crews, Verifier + challenge loop | ✅ complete |
| 3 · Judgment & the gate | Risk Counsel on grounded corpora, IAM roles, approvals, outreach queue | ✅ complete (backend) |
| 4 · Continuity & delta | Delta re-clearance, Monitor arming, webhook receiver, reopen path, FindAll, report renderer | ✅ complete |
| 5 · The war room | Next.js app: heat strip, crew feed, risk board, counsel gate, provenance graph | ✅ complete |
| 6 · The film | Demo shoot, hosted deployment, submission | ⬜ open |

The system is **launchable**: `make dev` runs all five services and the war room
against live Gemini and Parallel; `make bootstrap && make deploy` puts the same
thing on Cloud Run.

See [`docs/STATUS.md`](docs/STATUS.md) for what is done, what is left, and what
needs a human decision.

## Quickstart

```bash
uv sync                       # Python workspace
cp .env.example .env          # then fill in PARALLEL_API_KEY and VERTEX_PROJECT
make test                     # 47 tests, no credentials required
```

Run the whole thing locally — five services and the war room:

```bash
make dev                      # http://localhost:3000
```

Run a real pass on a real script, on your laptop, against the live web:

```bash
gcloud auth application-default login
uv sync --extra gemini
uv run python scripts/run_local_pass.py \
  --file demo/film/cut-01/script.fountain --title "The Last Hour" --report
```

Local mode keeps state on disk and runs the event spine in-process. **The research
is not simulated** — Gemini and Parallel are called for real, and the citations in
the report are ones you can click.

Deploy to Google Cloud:

```bash
make bootstrap                # APIs, service accounts, secrets, topics, tables, buckets
make deploy                   # five services + the war room, on Cloud Run
make seed                     # the public demo project
```

Only two endpoints are public: the war room and the webhook receiver. Everything
else requires an authenticated caller, and every callback is signature-verified.

## Repository map

| Path | What lives there |
|---|---|
| `packages/contracts` | **Start here.** Every shape, dual-published to Python and TypeScript. |
| `packages/runtime` | Config, secrets, event bus, state store, blob store — GCP or local, same interface. |
| `agents/playbooks` | Eleven playbooks as version-controlled YAML: charter, toolbelt, guardrails. |
| `agents/tools` | Tool declarations for Agent Builder, generated from the code that implements them. |
| `agents/datastores` | Grounding corpora for Risk Counsel, with provenance recorded in `MANIFEST.md`. |
| `agents/evals` | Golden-item regression: extraction recall, and property checks on live research. |
| `orchestrator` | The 1st AD's runtime: dispatch, tiering, budget, the challenge loop, delta, the Sentinel. |
| `services/parallel-adapter` | One seam for every Parallel call. Holds the key. Zero reasoning. |
| `services/ledger-api` | Append-only writes, the hash chain, the rights-holder graph, role-enforced decisions. |
| `services/webhook-receiver` | Signature-verified Monitor callbacks. The one public endpoint. |
| `services/report-renderer` | Eight report sections, rendered from the ledger. |
| `infra` | BigQuery DDL, views, bootstrap and deploy scripts. |
| `demo` | The test script with planted items, the delta cut, the monitor target, the shot list. |
| `web` | The war room: Next.js, one-way data flow, every colour in one token file. |

## How the pieces prove themselves

```bash
make test                     # the full suite, offline
make smoke-parallel           # one live call per Parallel surface — proves the key works
make evals                    # extraction recall against the planted items
make verify-chain PROJECT=... # recompute the ledger hash chain
```

`make fixture` populates a local project so the UI can be developed without
spending API credit — it is a development fixture, never demo content.

`tests/e2e/test_full_pass.py` walks the entire product in one test: a finding is
challenged on staleness, the re-run is chained by `previous_interaction_id` and
comes back different, a litigation signal forces RED over the model's own
judgement, a producer is refused the approval a counsel is granted, the report
renders with the citation in it, watches arm, an unsigned webhook is dropped, a
signed one reopens the item, and the hash chain still verifies.

## Documentation

| Document | For |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The four planes and how a pass actually flows |
| [`docs/RUBRIC-MAPPING.md`](docs/RUBRIC-MAPPING.md) | Every judging criterion → the file that answers it |
| [`docs/SECURITY.md`](docs/SECURITY.md) | IAM model, secret handling, data boundaries, prompt-injection posture |
| [`docs/FRONTEND-CONTRACT.md`](docs/FRONTEND-CONTRACT.md) | Every endpoint the war room needs |
| [`docs/STATUS.md`](docs/STATUS.md) | What is built, what is left, what needs a decision |
| [`demo/script/DEMO-SCRIPT.md`](demo/script/DEMO-SCRIPT.md) | The three-minute shot list |
| [`agents/README.md`](agents/README.md) | The playbook export/import loop |

## What ClearFrame will not do

Some of these are guardrails; all of them are product decisions.

* **No legal conclusions.** Every Risk Counsel output is labelled research and
  drafting for review by production counsel.
* **No sending.** Outreach drafts and queues. There is no send capability in the
  codebase — the queue behind the counsel gate is the feature.
* **No auto-closing.** The Sentinel may reopen an item and alert counsel. It can
  never mark one resolved.
* **No answers without sources.** An unresolved chain of title is reported as
  unresolved. A named wrong owner is worse than an honest gap.
* **No reasoning from the partner.** Parallel's Chat/Responses surface is
  deliberately unused; Gemini owns all reasoning.

## Licence

Apache-2.0 — see [`LICENSE`](LICENSE).
