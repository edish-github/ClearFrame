# Architecture

Four planes on an asynchronous spine.

```
┌─ experience ────────────────────────────────────────────────────────────────┐
│  war room (Next.js) · reads projections · posts decisions                   │
│  producer · coordinator · counsel · reviewer                                │
└───────────────┬──────────────────────────────────────────┬──────────────────┘
                │ read                                     │ write (decisions)
┌─ reasoning ───▼──────────────────────────────────────────▼──────────────────┐
│  11 playbooks (agents/playbooks/*.yaml)                                     │
│  breakdown · 1st AD · music · marks · likeness · footage · verifier ·       │
│  risk counsel · outreach · ledger · sentinel                                │
│  run on Gemini via Vertex AI, or in Gemini Enterprise Agent Builder         │
└───────────────┬─────────────────────────────────────────────────────────────┘
                │ function calls (toolbelt.py)
┌─ tool ────────▼─────────────────────────────────────────────────────────────┐
│  parallel-adapter   ledger-api   webhook-receiver   report-renderer         │
│  (holds the key)    (hash chain) (verifies sigs)    (renders the view)      │
└───────────────┬─────────────────────────────────────────────────────────────┘
                │
┌─ data ────────▼─────────────────────────────────────────────────────────────┐
│  Firestore (live state) · BigQuery (the permanent past) · GCS (cuts,        │
│  snapshots, reports) · Secret Manager (keys)                                │
└─────────────────────────────────────────────────────────────────────────────┘
        ▲                                                          ▲
        └──── Pub/Sub spine: research · findings · decisions · monitor ────┘
```

## Why it is shaped this way

**The orchestrator is the only stateful component.** Everything else is stateless
and small enough to read in one sitting. That is what makes the security story
true rather than claimed: each service holds exactly the credentials it needs, and
the one that holds the Parallel key does no reasoning at all.

**Reasoning and perception are strictly separated.** Playbooks cannot fetch the
web except through registered tools; the adapter cannot form an opinion. The seam
is also insurance — if Parallel's surface shifts before September, it shifts in
one directory.

**The event spine is what makes a pass survive a closed laptop.** Every item is an
independent message. A 200-item pass is 200 messages with retry, backoff, and a
dead-letter after five attempts. Pausing drains rather than drops, so resume is
exact.

## A pass, step by step

1. **Upload.** `POST /projects/{id}/cuts`. `ingest.py` turns the file into
   something a model can read: a PDF becomes text, a `.mov` becomes keyframes on a
   fixed cadence, each labelled with its frame number so extracted items land on
   real timecodes. An unreadable upload fails with a message a producer can act on.
2. **Breakdown.** The playbook extracts items with anchors, prominence, and
   type-specific attributes, and nothing else — its output schema has no field in
   which to state ownership. Each item gets a `content_hash` computed from its
   content and deliberately *not* its timecode, which is what makes delta
   re-clearance work.
3. **Dispatch.** The 1st AD assigns a crew by item type and a tier by risk prior
   (`tiering.py`), reserves the spend (`budget.py`), and publishes one
   `research.requested` per item.
4. **Research.** The specialist runs T0 recon (Search/Extract), then one structured
   Task run against its schema. `normalize.py` turns the response into a Finding
   with Citations, classifying each source's authority. Cited pages are snapshotted
   to Cloud Storage so the report survives link rot.
5. **The write.** `submit_finding` is the only path into the ledger, and it rejects
   anything with no citation or confidence below the floor. The claim is Parallel's
   structured output, unedited.
6. **Verification.** The Verifier re-searches independently with different phrasing
   and runs four tests — staleness, authority, independence, consistency. It emits
   `verify_pass` or `file_challenge`, and a challenge without a cited ground is
   rejected by the tool itself.
7. **The challenge loop.** A challenge supersedes the finding, buys a pro run, and
   re-dispatches with the objection attached and `previous_interaction_id` set to
   the original run — so the re-run answers the objection instead of starting over.
   After `MAX_CHALLENGES` the item escalates to a human, which is the honest
   failure mode.
8. **Risk.** Risk Counsel grounds on the corpora, scores green/amber/red, and
   proposes mitigations with cost deltas. Any litigation signal forces RED in
   `toolbelt.submit_assessment` regardless of what the model concluded.
9. **The gate.** Red items — and amber items with a priced mitigation — move to
   `pending_approval` and stop. Only a counsel principal can move them, and the
   decision writes actor, role, rationale and timestamp to the ledger.
10. **Act.** Outreach drafts an inquiry per controlling entity, using FindAll to
    discover the licensing desk. It queues. Nothing sends.
11. **Report.** Eight sections rendered from the ledger, with the chain
    verification printed on the cover.
12. **Watch.** Shipping the report arms a Parallel Monitor per rights holder on
    every non-green item, watching the change classes that would move its risk
    state.
13. **Reopen.** A signed webhook puts the event on the spine. The Sentinel opens a
    *reopen pass*, chains a follow-up run to the monitor event id, and alerts
    counsel. It never re-closes an item.

## The two provenance chains

`previous_interaction_id` is the Parallel feature that makes the crew feel like one
investigation rather than many API calls, and it is used in exactly two places:

* **Challenge re-runs** chain to the challenged run, so the re-run inherits the
  original context and answers the objection.
* **Monitor reopens** chain to the monitor event, so an investigation reopened
  weeks later carries everything ever learned about the item.

In the ledger every finding therefore has an unbroken chain from first recon to
final re-verification — which is precisely the property an E&O underwriter wants.

## Cost-aware autonomy

| Tier | Surface | When the 1st AD assigns it |
|---|---|---|
| T0 | Search + Extract | Every item. Establish the obvious, harvest sources, set priors. |
| T1 | Task `core` | Anything not trivially green. |
| T2 | Task `pro` | Confidence below 0.70, sources conflict, or a challenge was filed. |
| T3 | Deep Research `ultra` | Litigation signals, or counsel escalation. |

The cap is a hard stop, reserved atomically before the call. Two concurrent crews
cannot both squeeze the last cent through. Every billable call writes a
`cost_events` row, so the tier policy is auditable against real spend rather than
asserted — `infra/sql/views/report_views.sql` has the query.

`TIER_COST_USD` in `services/parallel-adapter/src/clearframe_adapter/pricing.py`
is a **planning estimate**, and the code says so: `CALIBRATED` is `False` and the
budget meter labels the figure accordingly until measured against an invoice.

## The two backends

`packages/runtime` abstracts state, events, and blobs behind interfaces with two
implementations:

| | `CLEARFRAME_BACKEND=gcp` | `CLEARFRAME_BACKEND=local` |
|---|---|---|
| State | Firestore (native) | JSON on disk, same semantics |
| Events | Pub/Sub + push subscriptions | A file-backed spine that crosses processes, same durable-subscription, retry and dead-letter contract |
| Ledger | BigQuery | JSONL, same append-only interface |
| Blobs | Cloud Storage | A directory |
| **Research** | **Live Parallel + Gemini** | **Live Parallel + Gemini** |

The last row is the point. Local mode changes the plumbing, never the research —
so a laptop run is a rehearsal of the deployed system, not a different program.

## The local spine crosses processes

`make dev` runs the same five services the cloud runs, in five processes. An
in-memory queue would not carry an event from the ledger to the orchestrator, and
the symptom is precise and awful: a counsel approval lands in the ledger and the
item never resolves. `packages/runtime/filebus.py` is therefore a durable,
file-backed spine with the semantics that matter — subscriptions survive a
restart, delivery is at-least-once with backoff, and five failures dead-letter.

Set `CLEARFRAME_BUS=inproc` for a genuinely single-process run (the test suite,
`scripts/run_local_pass.py`), where an in-memory queue is simpler and faster.

## Who is allowed to call

Three callers reach a service, and each is proved differently
(`packages/runtime/identity.py`):

| Caller | Proof |
|---|---|
| A human | The IAP JWT, **signature-verified** against Google's IAP keys with the audience checked — so the service is safe even if it is ever exposed without IAP in front of it. |
| The war room, acting for a human | Its own Google OIDC token, plus a header naming the human. The name is accepted only from the configured service account. |
| Pub/Sub, pushing an event | An OIDC token minted for the push service account, verified on every `/handle/*` request on top of Cloud Run's own invoker check. |

Nothing reads an unverified JWT, and nothing trusts a request body.

## Sequence allocation, and a bug avoided

The hash chain's sequence numbers are allocated through a **transaction on a
per-project counter**, not by reading the last row back out of BigQuery. Streaming
inserts are not immediately readable; a read-back allocator silently issues
duplicate sequence numbers under concurrency and breaks the chain it exists to
protect. `tests/test_ledger_chain.py` asserts the chain stays dense under 25
concurrent appends.
