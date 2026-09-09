# Submission notes

A map from the brief to the code, so nothing has to be taken on trust.

## Build with Gemini Enterprise, on Google Cloud

| What the brief asks for | Where it is |
|---|---|
| Gemini doing the reasoning | `services/api/src/providers/gemini.ts`; six distinct stages in `pipeline/stages.ts` |
| Multi-step tool calling | `pipeline/pass.ts` sequences recon → synthesis → verification → escalation → chain → assessment |
| Sub-agents handing off state | Each stage's output is a persisted row the next stage reads; handoff survives a process restart |
| Updating dynamic databases | Postgres throughout; 14 tables in `services/api/db/schema.sql` |
| Triggering cloud jobs | Durable queue in `jobs/queue.ts`, drained by `jobs/worker.ts` |
| Workflows continue asynchronously | The API writes a job and returns; a pass survives a closed laptop or a redeploy |
| Guardrails | `requireRole` server side, citation allowlisting, append-only ledger, budget caps |
| Token efficiency | Flash for routing and drafting, Pro for judgement; deep research only on a cited objection |
| Respects user boundaries | Four roles, org scoping on every query, counsel-only gates |

## Parallel, and why removing it removes the product

Hallucinated rights data is not a degraded answer in a legal context; it is a
liability. So the product cannot be built on model recall, and that is a
structural dependency rather than an integration.

| Surface | Where | What it makes possible |
|---|---|---|
| Search `/v1/search` | `providers/parallel.ts`, `search` | Recon on every item; the source pool every citation must come from |
| Task `/v1/tasks/runs` | `providers/parallel.ts`, `runTask` | Deep structured dossiers when the verifier objects |
| Processor tiers | `pipeline/pass.ts` | `core` on challenge, `pro` on escalation; pennies on the boring items |
| Task citations | `escalate` | Deep-research URLs enter the same allowlist as search results |
| Monitor + webhooks | `createMonitor`, `routes/webhooks.ts` | A cleared item reopens when the web changes |

The one surface deliberately unused is Parallel's Chat/Responses API. The brief
mandates Gemini as the reasoning layer, so Gemini reasons and Parallel retrieves.

## The claim that the product is real

Judges can test this on their own upload rather than on a recorded path.

- **No fixture data exists anywhere in the codebase.** Search it. Empty states
  are empty states.
- **Citations cannot be fabricated.** URLs the model emits that are not in the
  retrieved pool are dropped before insert, and the rejected count is written to
  the activity feed where a judge can see it happen.
- **History is tamper-evident.** `POST /api/reports/:id/sign` refuses on a broken
  chain. `src/scripts/selftest.ts` proves detection by editing an entry with the
  trigger disabled and asserting the exact break point.
- **The budget meter is measured.** Integer micro-dollars, summed from real
  token counts per call.
- **Authority is server side.** A producer's decision attempt returns `403`
  regardless of what the client sends.

## Two beats that cannot be simulated

**The verifier challenges its own research.** A cited objection reopens the
investigation at a higher processor tier with the objection attached, and the
re-run can return a different answer. The challenge, the follow-up and the
outcome are all in the finding's activity and in the ledger.

**A cleared item reopens itself.** Resolving a finding arms a watch. When a
re-check retrieves a source that conflicts with the record, the finding returns
to review and the ledger records the reopen. Nothing in the monitoring path can
close a finding — only a person can.

## Verification

```bash
make typecheck   # every workspace, strict, noUncheckedIndexedAccess
make test        # 22 integration checks against a real Postgres
make smoke       # one live call to each provider
```

`make test` covers hash chaining, tamper detection, append-only enforcement,
concurrent appends under contention, queue claim safety with ten simultaneous
workers, the stall reaper, integer money accounting, delta item identity and
evidence constraints.

## Compliance

| Requirement | Status |
|---|---|
| Public repository | This repository |
| OSS licence visible | Apache-2.0 in `LICENSE`, declared in every `package.json` |
| Hosted URL | Cloud Run; see `docs/operations.md` |
| Demo video | Linked from the README |
| Partner track | Parallel |

## Honest limits

The report is research and a record of decisions. It is not a certification of
clearance and says so on its final page; the signature block belongs to a
person. Risk assessment is labelled research output, never legal advice. And
ClearFrame drafts licence inquiries but has no send capability anywhere in the
codebase, so an inquiry cannot leave the building without a person copying it.
