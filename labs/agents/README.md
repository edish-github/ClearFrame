# The crew

Eleven playbooks. Each is a charter, a narrow toolbelt, and hard guardrails — the
vocabulary the UI and the demo speak.

| File | Credit | Model | Tools | What it does |
|---|---|---|---|---|
| `00-breakdown.yaml` | script supervisor | Pro | `record_items` | Extracts clearable elements with anchors. Says nothing about ownership. |
| `01-dispatcher-1st-ad.yaml` | first assistant director | Flash | `get_item_context` | The judgement calls the tier policy cannot make: ambiguous types, budget triage, stalled passes. |
| `02-music-rights.yaml` | clearance crew | Pro | search, extract, task, submit | Both chains, always. A cover splits them. |
| `03-marks-brands.yaml` | clearance crew | Pro | search, extract, task, submit | Owner of record, status, and documented enforcement behaviour. |
| `04-likeness.yaml` | clearance crew | Pro | search, extract, task, submit | Living or deceased, jurisdiction, representation, prior objections. |
| `05-footage-artwork.yaml` | clearance crew | Pro | search, extract, task, submit | Provenance, licence lineage, orphan signals. |
| `06-verifier.yaml` | continuity | Pro | search, extract, pass, challenge | Attacks findings on staleness, authority, independence, consistency. |
| `07-risk-counsel.yaml` | studio counsel (AI) | Pro | guidance, assessment | Grounded scoring and mitigations with cost deltas. Never an opinion. |
| `08-outreach.yaml` | production office | Flash | findall, draft | Finds the desk, drafts the inquiry. Cannot send. |
| `09-ledger.yaml` | post supervisor | Flash | context | Summarises the record for a human. |
| `10-sentinel.yaml` | night watch | Flash | context | Judges whether a detected change threatens a cleared item. Reopens and alerts only. |

## The console loop

Agent Builder is a console product, so the discipline is: **author in the console,
export here, commit.** The repository is what judges read; the console is where you
work. This runtime reads the same YAML, so nothing is authored twice.

**Console → repo.** Export the playbook, save it as `NN-name.yaml`, keep the field
names below, and commit. Run `make test` — the loader validates every playbook and
`declarations_for` fails loudly if a playbook asks for a tool that does not exist.

**Repo → console.** Create the agent, paste `goal` and `instructions`, add each
guardrail as a guardrail (not as prose in the instructions — they are appended
verbatim to the system instruction here for the same reason), and register the
tools from `agents/tools/`:

* `parallel-mcp.json` — Parallel's managed MCP server, for Search and Extract.
* `crew-functions.json` — every function declaration, with the per-playbook
  toolbelt listed under `playbook_toolbelts`.
* `parallel-adapter.json`, `ledger-api.json`, `dispatch.json` — the services'
  OpenAPI documents.

Regenerate the tool declarations from the code after any change to the toolbelt:

```bash
make tools
```

They are generated rather than hand-written because hand-maintained tool JSON
drifts from the functions it describes within a week.

## Playbook schema

```yaml
name: music-rights            # how the orchestrator refers to it
display_name: "Music rights — clearance crew"
credit: "clearance crew"      # the Hollywood credit the UI shows
model: pro                    # pro | flash | an explicit model id
max_turns: 12                 # tool-call budget for one invocation
goal: |                       # what this role is for
instructions: |               # how it works, step by step
tools: [parallel_search, ...] # must exist in orchestrator/.../toolbelt.py
guardrails:                   # appended verbatim; they override conflicting text
  - "..."
data_stores: [eo-underwriting]
output_contract: contracts/schemas/music_rights.json
```

## Grounding

`datastores/` holds Risk Counsel's corpora. Read `MANIFEST.md` before adding
anything: every document records its origin and licence, and nothing copyrighted
is committed. Licensed handbooks load into the Agent Builder data stores from a
private bucket at deploy time.

## Evals

`evals/golden_items.jsonl` holds 21 labelled items.

```bash
make evals                                            # extraction recall, free
uv run python agents/evals/run_evals.py --kind research   # property checks, costs money
```

Extraction ground truth is a fact about the script, so it is checkable. Research
ground truth lives on the live web and moves, so those checks assert the
*properties* a good finding must have — every claim cited, both chains named for
music, a stated basis for a public-domain claim, gaps reported as gaps — rather
than a specific owner that would make the suite lie the moment a catalog changes
hands.

Run them after every prompt change. Without this, week-four tuning silently breaks
week-two behaviour.

## Tuning the Verifier

It is the demo's best beat and the easiest thing to get wrong.

| Symptom | Cause | Fix |
|---|---|---|
| Challenges everything | Staleness threshold too aggressive | Raise the age bound; require two weak signals before challenging |
| Challenges nothing | "Cited grounds" being read as "must be certain" | Rephrase: challenge on demonstrable doubt, and cite the doubt's source |
| Challenges the same finding forever | — | `MAX_CHALLENGES` already caps it; the item escalates to a human |

Target roughly one challenge per five to ten findings. Measure it against the
golden items, not against a feeling.
