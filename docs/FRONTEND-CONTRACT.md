# Frontend contract — everything the war room needs

The war room is built (`web/`), and this document is the seam it plugs into —
still the reference for changing it, replacing it, or building a second client
against the same API. Every surface in the war room (FIG. 09 of the concept) has a
working endpoint behind it.

**One rule that keeps the live demo reliable:** the web app never calls an agent
and never writes a finding. It reads projections and posts human decisions. Data
flows one way.

```
   war room ──read──▶  orchestrator  (projections, live state)
            ──read──▶  Firestore     (live subscriptions, optional)
            ──write─▶  ledger API    (decisions only, role-enforced server-side)
```

## Base URLs

The browser never calls a service directly. The war room proxies every request
through its own server, which holds the credential:

| From the browser | Proxied to | Auth added server-side |
|---|---|---|
| `/api/cf/*` | orchestrator | Google identity token + acting subject |
| `/api/ledger/*` | ledger API (decisions and roles only) | same |
| `/api/session` | the app itself | sets the acting role cookie (demo mode only) |

| Service | Local | Deployed | Auth |
|---|---|---|---|
| Orchestrator (read + pass control) | `http://localhost:8080` | `$URL_ORCHESTRATOR` | Cloud Run IAM, verified OIDC |
| Ledger API (human decisions) | `http://localhost:8082` | `$URL_LEDGER` | verified IAP assertion, or the trusted proxy |
| Report renderer (preview) | `http://localhost:8084` | `$URL_RENDERER` | Cloud Run IAM |

Interactive OpenAPI for every service is at `/docs`, and the generated documents
are committed at `agents/tools/*.json` (`make tools` regenerates them).

## Identity

The API resolves the caller server-side and never trusts a body field.

* **Deployed:** IAP puts `x-goog-iap-jwt-assertion` on the request; the API
  verifies its signature against Google's IAP keys, then looks up the project role
  binding.
* **Through the war room:** the app presents its own Google OIDC token and names
  the human in `x-clearframe-subject`. The API accepts that name only from the
  service account configured as `TRUSTED_PROXY_SA`.
* **Local:** `x-clearframe-subject: counsel@example.dev` stands in, and only when
  `CLEARFRAME_BACKEND=local`.

Bind roles with `PUT /projects/{project_id}/roles` — `{"subject": "...", "role":
"producer|coordinator|counsel|reviewer"}`.

Capabilities (mirror these for affordances; the server enforces them regardless):

| Role | upload/start | edit item | approve red | approve outreach | sign report |
|---|---|---|---|---|---|
| producer | ✅ | — | — | — | — |
| coordinator | — | ✅ | — | — | — |
| counsel | — | ✅ | ✅ | ✅ | ✅ |
| reviewer | — | — | — | — | — |

The Producer's approve control must be **absent**, not disabled — the API returns
403 either way, but absence is the honest UI.

## Component → endpoint map

| War-room component | Endpoint | Notes |
|---|---|---|
| Project header, cut list, pass history | `GET /projects/{project_id}` | Includes live budget. |
| **Heat strip** ★ | `GET /cuts/{cut_id}/heatstrip` | Returns `regions[]` pre-computed as `start_pct` / `width_pct` / `risk` / `frame_in`. `width_pct` already has the 0.4% hairline floor so every region stays clickable. |
| Cut player scrub target | region `frame_in` ÷ `fps` | `fps` and `duration_frames` come back with the strip. |
| Item register table | `GET /cuts/{cut_id}/items` | Each item carries `tc_in` / `tc_out` pre-formatted. |
| **Crew feed** ★ | `GET /passes/{pass_id}/feed?limit=200` | Newest first. Each entry: `kind`, `agent`, `colour`, `item_id`, `message`, `detail`, `ts`. |
| Threaded challenges | feed entries where `kind == "challenge.filed"` | `detail.challenge.finding_id` is the parent — render as a reply under that finding's `finding.added` entry. |
| **Risk board** | `GET /projects/{project_id}/riskboard?cut_id=...` | `columns.red / amber / green / unknown`, plus counts. Collapse green by default. |
| Item detail drawer | `GET /items/{item_id}` | Item + live findings + challenges + latest assessment. |
| **Provenance graph** ★ | `GET /items/{item_id}/provenance` | `nodes[]` (`item`, `chain`, `holder`, `litigation`), `edges[]` (`has_chain`, `controlled_by`, `transferred`, `party_to`, `encumbers`), `resolved` per chain, `open_questions[]`. Every edge carries `sources[]`. |
| **Budget meter** | `GET /projects/{project_id}/budget` | `spent_usd`, `cap_usd`, `pct`, `warn` (true at 80%), `by_tier`, `calls_by_tier`, plus `pricing_note` — which says plainly whether the numbers are calibrated. |
| **Approval modal** | `GET /projects/{project_id}/approvals` | Items pending counsel, each with its assessment (mitigations + cost deltas) and the findings behind it, plus the outreach queue. |
| Approve / reject | `POST {LEDGER}/projects/{project_id}/decisions` | See below. |
| Outreach queue | `GET /projects/{project_id}/outreach` | Drafts only. There is no send endpoint anywhere in this system. |
| **Watch panel** | `GET /projects/{project_id}/watches` | Armed monitors, `last_checked_ts`, `reopen_count`. |
| Report preview | `GET {RENDERER}/preview/{project_id}/{cut_id}` | Full HTML. `GET {RENDERER}/data/...` for the same content as JSON. |
| Ship the report | `POST /projects/{project_id}/reports` | Renders, stores, and arms the watches. |
| Ledger integrity badge | `GET /projects/{project_id}/ledger/verify` | `{valid, events, head_hash}`. Worth a permanent corner of the UI. |
| Delta preview | `GET /cuts/{cut_id}/delta` | `added` / `removed` / `inherited` / `re_researched` before committing to a pass. |

## Writes the UI is allowed to make

| Action | Call |
|---|---|
| Create a project | `POST /projects` |
| Raise the budget cap | `PUT /projects/{id}/budget` |
| Upload a cut or script | `POST /projects/{id}/cuts?label=cut-02` (multipart `file`) |
| Start a pass | `POST /projects/{id}/passes` `{cut_id, mode: "full"｜"delta"}` |
| Pause a pass (kill switch) | `POST /passes/{pass_id}/pause` — drains, never drops |
| Record a decision | `POST {LEDGER}/projects/{id}/decisions` |

Decision body:

```json
{
  "action": "approve_mitigation",
  "rationale": "Licence from the current administrator; budget approved.",
  "item_id": "itm_...",
  "target_id": "mit_..."
}
```

Actions: `approve_mitigation`, `reject_mitigation`, `approve_outreach`,
`reject_outreach`, `request_reinvestigation`, `sign_report`, `raise_budget`,
`flag_for_watch`. A rationale is required — it lands in the ledger and prints in
the report next to the actor and their role.

## Live updates

Two options, same data:

1. **Firestore listeners** (the design in the concept doc). Collections:
   `passes/{pass_id}`, `items` (filter `cut_id`), `feed` (filter `pass_id`, order
   `ts` desc, limit 200), `projects/{project_id}` for the budget. Grant the web
   service account read-only, project-scoped access.
2. **Polling** the endpoints above. The feed and heat strip are cheap; 1–2s is
   comfortable, and it is what the local runner uses.

Firestore documents are written with the same field names as the REST payloads —
the models in `packages/contracts` are the single source for both.

## Shapes

TypeScript types are generated from the Python contracts:

```bash
uv run python scripts/export_ts_contracts.py    # → packages/contracts/ts/src/index.ts
```

Import them in the web app rather than re-declaring shapes; a schema change is a
change in `packages/contracts` first, then everywhere else in the same commit.

## Empty and failure states the UI must handle

These are real paths, not hypotheticals — the backend already produces them:

| Situation | What comes back |
|---|---|
| Upload is a scanned PDF with no text | `422` with a message naming OCR as the fix |
| Upload is an unsupported type | `422` listing the accepted types |
| Nothing clearable in the material | `items_extracted: 0` — an empty register, not an error |
| No reasoning backend configured | `503` from upload/pass start; `GET /readyz` says which piece is missing |
| Budget cap reached mid-pass | Pass status `paused`, feed entry `approval.required` with `reason: budget_cap_reached` |
| An item's research failed | Item status `failed`, feed entry `agent.error`; the rest of the pass continues |
| Machines could not agree | Item status `escalated` — show it as needing a human, not as an error |
| Chain of title unresolved | The finding says so in `unresolved_questions`; render it, do not hide it |

The last one matters most: an honest gap is the product working. The UI should
have a first-class treatment for "we could not establish this", not just for red
and green.
