# Rubric mapping

Every judging criterion, mapped to the file that answers it. Written as the code
was built, not assembled at the end.

## Technological implementation

> *How well is the project built, and how effectively does it use Google Cloud and
> the Partner services as part of the solution?*

### Gemini Enterprise Agent Builder — the mandated core

| Claim | Where |
|---|---|
| Eleven roles as version-controlled playbooks: charter, toolbelt, hard guardrails | [`agents/playbooks/`](../agents/playbooks) |
| Playbooks are loaded and executed, not decoration — guardrails are appended to the system instruction verbatim | [`orchestrator/src/clearframe_orch/playbooks.py`](../orchestrator/src/clearframe_orch/playbooks.py) |
| The function-calling loop the console and the runner share | [`agents_client.py`](../orchestrator/src/clearframe_orch/agents_client.py) |
| Tool declarations for the console, generated from the code that implements them | [`agents/tools/`](../agents/tools), [`scripts/export_agent_tools.py`](../scripts/export_agent_tools.py) |
| Hosted Agent Builder sessions when `AGENT_APP_ID` is set | [`models.py::AgentBuilderClient`](../orchestrator/src/clearframe_orch/models.py) |
| Zero-config grounding on data stores, with a local corpus fallback | [`grounding.py`](../orchestrator/src/clearframe_orch/grounding.py), [`agents/datastores/MANIFEST.md`](../agents/datastores/MANIFEST.md) |

### Google Cloud — twelve services, each with a real job

| Service | Job | Where |
|---|---|---|
| Vertex AI (Gemini) | Extraction over scripts and keyframes (Pro), routing and drafting (Flash), risk reasoning (Pro) | [`models.py`](../orchestrator/src/clearframe_orch/models.py) |
| Cloud Run | Five services + the render job | [`infra/scripts/deploy.sh`](../infra/scripts/deploy.sh), `Dockerfile`, `services/*/Dockerfile` |
| Pub/Sub | Investigation fan-out, challenge routing, approvals, monitor ingestion; dead-letter after 5 attempts, 600s ack | [`bus.py`](../packages/runtime/src/clearframe_runtime/bus.py), [`bootstrap.sh`](../infra/scripts/bootstrap.sh) |
| Firestore | Live pass state and the feed the war room streams | [`store.py`](../packages/runtime/src/clearframe_runtime/store.py) |
| BigQuery | Append-only ledger, findings, citations, rights graph, cost meter | [`infra/sql/`](../infra/sql), [`chain.py`](../services/ledger-api/src/clearframe_ledger/chain.py) |
| Cloud Storage | Cuts, citation snapshots, rendered reports | [`blob.py`](../packages/runtime/src/clearframe_runtime/blob.py), [`snapshots.py`](../services/parallel-adapter/src/clearframe_adapter/snapshots.py) |
| Secret Manager | Parallel key and webhook signing secret; agents never see credentials | [`secrets.py`](../packages/runtime/src/clearframe_runtime/secrets.py) |
| Cloud IAM | Six least-privilege service accounts; four human roles; Firestore rules that make the browser read-only | [`bootstrap.sh`](../infra/scripts/bootstrap.sh), [`roles.py`](../packages/contracts/src/clearframe_contracts/roles.py), [`firestore.rules`](../infra/firestore.rules) |
| IAP | Caller identity verified in-process against Google's keys, never read from a request body | [`identity.py`](../packages/runtime/src/clearframe_runtime/identity.py), [`auth.py`](../services/ledger-api/src/clearframe_ledger/auth.py) |
| Cloud Logging | Structured JSON logs Cloud Logging parses without configuration | [`logging.py`](../packages/runtime/src/clearframe_runtime/logging.py) |
| Vertex AI Search | Grounding retrieval over the data stores | [`grounding.py`](../orchestrator/src/clearframe_orch/grounding.py) |
| Cloud Build | Source deploys via `gcloud run deploy --source` | [`deploy.sh`](../infra/scripts/deploy.sh) |

### Parallel — five surfaces, each load-bearing

| Surface | Owner agent | Remove it and… | Where |
|---|---|---|---|
| **Search** | every researcher, and the Verifier's independent re-check | there is no recon and no way to challenge a finding independently | [`search.py`](../services/parallel-adapter/src/clearframe_adapter/search.py) |
| **Extract** | researchers; snapshotting | citations cannot be read or preserved, and the report dies of link rot | [`snapshots.py`](../services/parallel-adapter/src/clearframe_adapter/snapshots.py) |
| **Task API** (`core`→`pro`) | all four specialist crews | there are no structured, cited findings — nothing can become a database row | [`task.py`](../services/parallel-adapter/src/clearframe_adapter/task.py) |
| **Deep Research** (`ultra`) | T3 escalation on litigation and counsel escalation | chain-of-title dossiers on red flags disappear | [`deep_research.py`](../services/parallel-adapter/src/clearframe_adapter/deep_research.py) |
| **FindAll** | Outreach | the rights-holder graph has no contacts and outreach has no addressee | [`findall.py`](../services/parallel-adapter/src/clearframe_adapter/findall.py), [`enrichment.py`](../orchestrator/src/clearframe_orch/enrichment.py) |
| **Monitor** | the Sentinel | continuous clearance does not exist; the report is a photograph again | [`monitor.py`](../services/parallel-adapter/src/clearframe_adapter/monitor.py), [`sentinel.py`](../orchestrator/src/clearframe_orch/sentinel.py) |

Deliberately unused: **Parallel Chat/Responses**. The brief mandates Gemini as the
reasoning layer. Gemini is the brain; Parallel is the senses.

`previous_interaction_id` — Parallel's provenance chaining — is used in the two
places that matter and asserted in the end-to-end test:
[`challenge.py`](../orchestrator/src/clearframe_orch/challenge.py) (challenge
re-runs) and [`sentinel.py`](../orchestrator/src/clearframe_orch/sentinel.py)
(monitor reopens).

### The brief's phrases, satisfied literally

| Brief | ClearFrame |
|---|---|
| "multi-step tool calls" | Recon → structured run → submit, per item, with escalation ([`toolbelt.py`](../orchestrator/src/clearframe_orch/toolbelt.py)) |
| "updating dynamic databases" | Firestore live state + append-only BigQuery ledger |
| "triggering cloud functions" | Cloud Run services invoked by playbooks and by push subscriptions |
| "sub-agents securely hand off state" | Pub/Sub envelopes with typed payloads ([`events.py`](../packages/contracts/src/clearframe_contracts/events.py)) |
| "managed protocol adapters" | Parallel's managed MCP registered as an Agent Builder tool ([`agents/tools/parallel-mcp.json`](../agents/tools/parallel-mcp.json)) |
| "guardrails" | Per-playbook, appended verbatim to the system instruction, and enforced in code where it matters |
| "context window token efficiency" | Tier policy; context pruned to the item, never the whole register ([`tiering.py`](../orchestrator/src/clearframe_orch/tiering.py)) |
| "respects user boundaries" | Four roles, server-side enforcement, the gate ([`auth.py`](../services/ledger-api/src/clearframe_ledger/auth.py)) |
| "workflows continue asynchronously" | The whole spine; a pass survives a closed laptop |

## Design

> *Does the project deliver a complete, coherent product experience, not just a
> technical proof of concept?*

A production war room where the film is the hero surface, not a dashboard with a
table of results.

| Surface | Where | Why it is the design answer |
|---|---|---|
| **Heat strip** | [`HeatStrip.tsx`](../web/src/components/HeatStrip.tsx) | Clearance risk rendered under the film's real frames. A red region is not a row — clicking it scrubs to the frame where the poster hangs. Regions arrive pre-computed with a hairline floor, so the strip and the report can never disagree and a two-frame item stays clickable. |
| **Crew feed** | [`CrewFeed.tsx`](../web/src/components/CrewFeed.tsx) | Challenges render as **threaded replies** under the finding they attack, with the grounds and the citation. The argument is visible, not inferred from a status change. |
| **Provenance graph** | [`ProvenanceGraph.tsx`](../web/src/components/ProvenanceGraph.tsx) | One song, two chains, drawn — with a per-chain resolved flag and per-edge sources, so no line is unsupported. |
| **Counsel gate** | [`ApprovalModal.tsx`](../web/src/components/ApprovalModal.tsx) | The frame, the finding, the citations, the mitigations with cost deltas. A producer sees no approve controls — absent, not disabled. |
| **Budget meter** | [`BudgetMeter.tsx`](../web/src/components/BudgetMeter.tsx) | Cost-aware autonomy in one widget, which also reports whether its own numbers are calibrated. |
| **Design tokens** | [`tokens.css`](../web/src/styles/tokens.css) | Every colour, size and timing in one file; a light grade already stubbed. Motion is spent in exactly three places and nowhere else. |

One-way data flow is the architectural reason the live demo does not break: the
app reads projections and posts decisions, and can never write a finding.

Product experience is also what the system refuses to do: no send capability, no
legal conclusions, no auto-closing, and a first-class state for "we could not
establish this."

## Potential impact

> *Does the project make a credible, specific case for solving a real problem for
> a real audience?*

A mandatory industry gate (E&O) on a process priced in weeks and five-to-six
figures per title, for named buyers: studio business & legal affairs, line
producers, clearance coordinators, documentary and indie producers, E&O
underwriters. The market gap is documented in the concept: the adjacent products
administer rights you already hold or clean up content you generate. Nobody
automates finding out who owns what.

The delta pass is the difference between a demo and a system a post-production
schedule can live on: pictures get re-cut weekly, and clearance that restarts from
zero is clearance nobody runs twice.

## Quality of the idea

> *Is this a creative, non-obvious use of Google Cloud and the Partner services,
> and does the team show genuine understanding of the problem space?*

Content operations and legal infrastructure, while everyone else generates
content. The domain understanding shows in the specifics rather than the pitch:

* **Two chains for music**, and a cover recording near-certainly splitting them —
  the schema requires both, and the playbook refuses to stop with only one.
* **`conflicting_sources` in every schema**, because the worst failure in rights
  research is a confident single answer papering over a genuine dispute.
* **Authority ranking** of registries over courts over trade press over reference
  sites, which is what makes the Verifier's staleness test meaningful.
* **A living artist's work is never de minimis**, and an orphan work is an
  unresolved chain rather than a free one.
* **Any litigation signal is RED**, enforced in code because it is the fact pattern
  underwriters treat as uninsurable.
* **Prominence excludes timecode from the content hash**, because a scene that
  moved is not a new item.

The memory hook: *the agents found the lawsuit in scene 42.*
