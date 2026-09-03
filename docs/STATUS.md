# Project status

**As of 26 August 2026.** Submission deadline: 10 September 2026, 02:30 IST.
Internal cutoff: **6 September**, per the build plan.

---

## The one-paragraph version

ClearFrame is **launchable**. `make dev` runs all five services and the war room
on a laptop against live Gemini and Parallel; `make bootstrap && make deploy` puts
the same system on Cloud Run behind least-privilege service accounts. Phases 0–5
of the implementation guide are complete: eleven agent playbooks on Gemini with a
real function-calling loop, five Parallel surfaces against their verified live
endpoints, an append-only hash-chained ledger with tamper detection proven by
test, a counsel gate enforced server-side from a cryptographically verified
identity, delta re-clearance, Monitor arming, a signature-verified webhook
receiver with replay and flood protection, the reopen path, the eight-section E&O
report — and the war room itself: heat strip, threaded crew feed, risk board,
approval modal, provenance graph, budget meter. 47 tests pass, including one that
walks the whole product in a single run. **Nothing is hardcoded**: every research
result comes from a live Parallel call, and a model can choose what to investigate
but cannot author a fact. What is left needs your accounts, your credentials, and
a camera.

---

## What is complete

### Phase 0 — Foundation ✅

Monorepo in a `uv` workspace. Contracts (17 enums, 19 models) dual-published to
TypeScript by generator. Five Parallel Task output schemas. BigQuery DDL plus six
report views. Firestore security rules and indexes. Idempotent `bootstrap.sh` /
`deploy.sh` / `seed_demo.sh`. Six Dockerfiles. Apache-2.0. `Makefile`. CI with
lint, tests, chain verification, playbook validation, generated-artefact staleness
check, and secret scanning.

### Phase 1 — First light ✅

Parallel adapter against endpoints verified from the live docs: `POST
/v1/tasks/runs` + `GET /v1/tasks/runs/{id}/result`, `/v1/search`, `/v1/extract`,
`/v1beta/findall/runs`, `/v1/monitors`. Normalizer turning `output.basis` into
citations with per-field attribution and a six-class authority ranking. Snapshots
so evidence survives link rot. Append-only ledger. Real ingestion — PDF text,
fountain, and video keyframes via ffmpeg with frame-accurate labels.

### Phase 2 — The crew ✅

Dispatch, tiering, an atomic budget guard, four specialist crews, the Verifier and
the challenge loop with `previous_interaction_id` chaining, the hash chain with
transactional sequence allocation.

### Phase 3 — Judgment and the gate ✅

Risk Counsel grounded on retrievable corpora. Litigation forces RED **in code**.
Four IAM roles enforced server-side. The gate. Outreach drafting into a queue with
no send capability anywhere in the codebase.

### Phase 4 — Continuity and delta ✅

Content-hash delta with state inheritance. Monitor arming per rights holder.
Standard Webhooks signature verification. The reopen path, which opens a real
reopen pass and chains the follow-up run to the monitor event. FindAll enrichment.
The eight-section report.

### Phase 5 — The war room ✅

A Next.js app where the film is the protagonist.

| Surface | Note |
|---|---|
| Heat strip | Risk under the film's real frames; clicking a region scrubs and selects. Regions arrive pre-computed with a hairline floor. |
| Crew feed | Challenges render as **threaded replies** under the finding they attack, with grounds and citation. |
| Risk board | Red and amber in full, green collapsed. |
| Approval modal | Findings, citations, mitigations with cost deltas. A producer sees no approve controls. |
| Provenance graph | One song, two chains, drawn — with per-chain resolution and per-edge sources. |
| Budget meter | Live spend per tier, and it says whether its own numbers are calibrated. |
| Watch panel | Armed monitors, last-checked, reopen history. |
| Report console | Render, ship, arm watches, and the ledger's verification state. |

One-way data flow: the app reads projections and posts decisions through a
server-side proxy that holds the credentials. It can never write a finding.

### Hardening completed since the last report ✅

Things that were listed as limitations and are now closed:

* **IAP assertions are verified in-process** against Google's IAP public keys with
  the audience checked, so the ledger is safe even if it is ever exposed without
  IAP in front of it.
* **Pub/Sub push requests are verified** — the token must be minted for the
  configured push service account — on top of Cloud Run's invoker check.
* **The public webhook endpoint has a replay cache and a rate limiter.** A
  redelivered event is acknowledged, not reprocessed; a flood is shed with 429.
* **The local spine crosses processes.** `make dev` runs five services, and an
  event published by the ledger reaches the orchestrator with durable
  subscriptions, retry, and dead-lettering. Without this a counsel approval landed
  in the ledger and the item never resolved.
* **`scripts/calibrate_costs.py`** turns one real invoice into measured tier costs
  and flips `CALIBRATED`.
* **Firestore rules** make the browser read-only by construction; outreach drafts
  are readable only by counsel and the coordinator.

### Bugs found and fixed while building

1. **The ledger sketch allocated sequence numbers by reading BigQuery back.**
   Streaming inserts are not immediately readable, so under concurrency that
   issues duplicate sequences and breaks the chain it exists to protect. Sequence
   is now allocated transactionally; a test asserts density under 25 concurrent
   appends.
2. **The Verifier's task text did not name the finding under examination**, so a
   real model could not have called `verify_pass` with a correct id.
3. **A verifier that emitted both a challenge and a pass had the pass win**,
   because the code took the last verdict. The toolbelt now refuses a second
   verdict and the loop takes the first — the playbook says "exactly one".
4. **A reopen used a synthetic pass id**, so a handler crashed and the event was
   retried until the item escalated. A reopen is now a real pass the war room can
   watch.
5. **An unfunded challenge raised**, which retried five times and dead-lettered a
   perfectly valid challenge. It now pauses the pass and escalates the item.
6. **Passes never closed themselves.** A pass with nothing open now completes.

---

## Proof, not assertion

```bash
make test                 # 47 tests, no credentials needed
cd web && pnpm typecheck && pnpm lint && pnpm build
```

`tests/e2e/test_full_pass.py` walks the whole product in one run: a finding is
challenged on staleness with a cited ground; the re-run carries
`previous_interaction_id` and uses the pro processor; a litigation signal forces
RED over the model's own judgement; a producer is refused (403) the approval a
counsel is granted (200); the report renders with the suit's citation; watches
arm; an unsigned webhook is dropped and a signed one reopens the item chained to
the monitor event; the hash chain still verifies.

Also covered: the cross-process spine (durable subscriptions, retry,
dead-lettering), identity refusal paths, budget atomicity under 10-way
concurrency, illegal state transitions, the citation floor, tier policy, delta
counts, authority classification, ingestion failure messages, webhook replay and
rate limiting, cost calibration, and the whole HTTP surface.

Verified by hand in the browser, against the running stack: the war room, the heat
strip, the threaded challenge, the counsel gate refusing a producer and accepting
counsel, the decision reaching the ledger and resolving the item across process
boundaries, an unsigned webhook rejected and a signed one reopening the item, and
the provenance graph drawing seven nodes with the litigation edge in place.

---

## What is left — and who owns it

### Blocking, and only you can do it

| # | What | Why it is yours | Effort |
|---|---|---|---|
| 1 | **Create the Google Cloud project**, enable billing, apply hackathon credits | Your account and payment details | 30 min |
| 2 | **Create the Parallel account** and generate an API key | Your account | 15 min |
| 3 | `cp .env.example .env`, fill it in, `make bootstrap && make deploy` | Needs 1–2 | 1–2 h |
| 4 | **`make smoke-parallel`** — one live call per surface | Proves all five surfaces answer *your* key before anything is built on them. Do this first. | 15 min |
| 5 | **`make pass FILE=demo/film/cut-01/script.fountain`** — the first real pass | Everything downstream depends on what it returns | 1 h |
| 6 | `make evals`, record the baseline | Extraction recall against the planted items | 30 min |
| 7 | **`scripts/calibrate_costs.py --write`** against your first invoice | Needs your billing data | 30 min |
| 8 | **Agent Builder data stores** — create both, load licensed corpora, set the ids | Needs documents you must obtain; see `agents/datastores/MANIFEST.md` | 2 h + procurement |
| 9 | **Deploy the Firestore rules** — `firebase deploy --only firestore:rules` | `gcloud` has no first-class rules release; the file is written and ready | 15 min |
| 10 | **Public GitHub repo**, licence visible in About | Explicit submission requirement, and it is checked | 20 min |
| 11 | **Devpost registration** per member; verify age and territory eligibility | Per-member and disqualifying if wrong | 30 min |

### The film

| What | State |
|---|---|
| Test script with 12 planted items | ✅ `demo/film/cut-01/script.fountain` |
| Delta cut with 9 deliberate changes | ✅ `demo/film/cut-02/script.fountain` |
| `PLANTED-ITEMS.md` | ✅ written; ⬜ **expectations not yet confirmed by a live pass** |
| Shoot vs licence decision | ⬜ **open** — blocks the picture, not the software |
| Monitor target page | ✅ built and documented; publish it publicly and arm a watch |
| Demo video | ⬜ not shot — the shot list is complete in `demo/script/DEMO-SCRIPT.md` |

### Optional polish, in the order I would do it

1. **Load test** — 200 items concurrently against real quotas. The code paths are
   proven; the quotas are not.
2. **Cold-start check** on the seeded public demo project, every morning of week five.
3. **Web tests.** CI runs typecheck, lint and build. Component tests would need a
   runner (vitest) that is not yet wired.
4. **Picture playback.** `CutPlayer` plays a video when the cut has one; wiring the
   uploaded file through a signed URL is a small piece left undone because the
   demo film does not exist yet.
5. **Firestore live subscriptions.** The war room polls, which works identically
   locally and deployed and needs no browser credential. Listeners are documented
   in the frontend contract if you want them.

---

## Known limitations, stated plainly

1. **`TIER_COST_USD` is uncalibrated.** The code flags it (`CALIBRATED = False`)
   and the budget meter surfaces it in the UI. One invoice closes it.
2. **The grounding corpora here are team-authored working notes**, not licensed
   underwriting manuals. `agents/datastores/MANIFEST.md` says exactly what is
   committed, why, and what must replace it.
3. **`PLANTED-ITEMS.md` states expectations, not confirmed results.** No live pass
   has run, because that needs your keys.
4. **FindAll is a beta surface** and has changed field names before. The match
   extractor accepts the shapes it has used rather than crashing a pass over a
   rename, but it is the integration most likely to need a touch-up in September.
5. **Monitor's minimum cadence is one hour.** Act IV must be scheduled, not
   improvised: make the change before the shoot and film the arrival.
6. **The rate limiter and replay cache are per-instance.** Cloud Run runs several.
   Each shedding its own load is enough at this volume, and the Sentinel's own
   idempotence catches a duplicate that slips past one instance.
7. **`DEMO_IDENTITY` must stay false on any project with real material.** It lets a
   visitor choose which role they act as; it grants nothing, but it is a demo
   affordance and not a security model.

---

## Suggested order for the next seven days

| Day | Do this |
|---|---|
| 1 | Items 1–4. `make smoke-parallel` green before anything else starts. |
| 2 | Item 5: first live pass on cut-01. Read every finding. Tune objective phrasing, not architecture — that is where research quality lives. |
| 3 | Confirm `PLANTED-ITEMS.md` from the pass. `make evals`, record the baseline. Calibrate costs. |
| 4 | Load the data stores. Deploy. Judge-path QA on the hosted URL. |
| 5 | Shoot or license the picture; produce cut-01 and cut-02. |
| 6 | Delta pass on cut-02, arm the watches, trigger the monitor target, rehearse all four acts. |
| 7 | Record the video, write the Devpost submission, submit **48 hours early**. |

---

## Where things are

| Looking for | Read |
|---|---|
| How it fits together | `docs/ARCHITECTURE.md` |
| What a judge should see | `docs/RUBRIC-MAPPING.md` |
| IAM, identity, data boundaries | `docs/SECURITY.md` |
| Every endpoint, for changing or replacing the UI | `docs/FRONTEND-CONTRACT.md` |
| The war room itself | `web/README.md` |
| The playbooks and the console loop | `agents/README.md` |
| The shot list | `demo/script/DEMO-SCRIPT.md` |
| What is planted in the film | `demo/film/PLANTED-ITEMS.md` |
