# Architecture

## The shape of it

```
                         browser
                            │  REST + Server-Sent Events
                            ▼
              ┌──────────────────────────┐
              │      API (Fastify)       │  auth · uploads · reads · human gates
              └────────────┬─────────────┘
                           │ jobs table
                           ▼
              ┌──────────────────────────┐
              │          Worker          │  breakdown · investigate · recheck
              └───┬──────────────────┬───┘  outreach · report render
                  │                  │
           Gemini │                  │ Parallel
        (reasoning)                  (retrieval)
                  │                  │
                  ▼                  ▼
              ┌──────────────────────────┐
              │  Postgres + object store │  findings · evidence · ledger · PDFs
              └──────────────────────────┘
```

**The API never calls a model.** It validates, writes a job, and returns. Every
external call belongs to the worker. That single decision is why a pass survives
a closed laptop, a redeploy, a rate limit or a worker crash — and why the upload
endpoint answers in milliseconds instead of minutes.

Live updates travel back the other way through Postgres `LISTEN`/`NOTIFY` into
SSE, so the stream keeps working with several API instances behind a load
balancer and with workers on entirely separate machines.

## Layers

| Layer | Location | Responsibility |
|---|---|---|
| `core` | `services/api/src/core` | Config, database, auth, storage, ledger, event bus, error shapes |
| `providers` | `services/api/src/providers` | Every outbound call to Gemini and Parallel, and the schemas that constrain them |
| `pipeline` | `services/api/src/pipeline` | Stages, and the orchestrator that sequences them under a budget |
| `jobs` | `services/api/src/jobs` | Durable queue and the worker process |
| `routes` | `services/api/src/routes` | HTTP surface, one file per concern |
| `report` | `services/api/src/report` | PDF rendered from persisted rows |
| `shared` | `packages/shared` | Vocabulary both sides speak: statuses, categories, labels, DTOs |
| `web` | `apps/web` | The workspace |

Providers never reason. The pipeline never opens a socket. Routes never call a
model. Keeping those boundaries is what makes the system testable without keys.

## The pipeline, per finding

```
recon ──► synthesise ──► verify ──┬── sufficient ─────────────────► trace ──► assess
(Parallel  (Gemini,      (Gemini) │                                (Gemini)  (Gemini)
 Search)  pool-locked)            └── challenged ──► escalate ──► re-synthesise ──► re-verify
                                                  (Parallel Task,
                                                   core or pro)
```

Escalation to the expensive processor fires only on a **cited objection** from
the verifier. That is what keeps deep research away from the boring ninety
percent of a register while still spending real money where exposure justifies
it. The budget is checked before dispatch and again before escalation; at the
cap, remaining items are marked `held` rather than guessed, and `POST /resume`
picks them up after the cap is raised.

Music always resolves two chains — composition and master — because licensing
one clears nothing. An unresolved or contested chain forces human review no
matter how confident the assessment reads. That floor lives in code
(`stages.ts`, `assess`), not in a prompt.

## Three guarantees, and where they are enforced

**A citation cannot be fabricated.** Parallel returns the source pool; Gemini
synthesises against it; any URL the model emits that is not in the pool is
dropped before insert, and the count of rejected citations is written to the
activity feed. `services/api/src/pipeline/stages.ts`, `synthesise`.

**History cannot be edited.** Every state change appends to a hash-chained
ledger. `UPDATE` is refused by a database trigger; `DELETE` needs an explicit
session flag. `verifyChain` recomputes the whole chain on demand and reports the
exact entry where it breaks. `services/api/src/core/ledger.ts`.

**Authority is server side.** Only counsel resolves a finding, releases an
inquiry, or signs a report. The client cannot grant itself a role; the UI only
decides what to grey out. `services/api/src/core/auth.ts`, `requireRole`.

## Things that will bite you

**`jsonb` does not preserve key order.** Ledger hashing therefore runs through a
recursive key-sorting canonicaliser. Hash the naive `JSON.stringify` and every
chain fails verification the moment it is read back from disk. This failure is
silent and this paragraph is the only warning.

**Money is integer micro-dollars.** Every provider call writes a `cost_events`
row with real token counts and increments the production total in the same
statement. The budget meter is measured, not modelled. Never introduce a float.

**Findings are keyed on category plus a normalised item name.** That key is what
makes delta re-clearance work: a moved item is re-researched, an untouched one
keeps its evidence and its decision, and one that has left the cut becomes
`withdrawn` rather than being deleted.

**Signatures belong to a report, not to a production.** Generating a new report
after signing an older one leaves the old signature intact.

**Deep research is an escalation, not a dependency.** If the Task API is down
the pipeline falls back to a targeted second search and records that it did,
rather than abandoning the finding.
