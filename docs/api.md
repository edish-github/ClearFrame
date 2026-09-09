# HTTP API

Base URL is the API service. Authenticate with `Authorization: Bearer <token>`.
Everything is scoped to the caller's org; another org's resources return `404`
rather than `403`, so the API does not confirm they exist.

## Errors

```json
{ "error": "Only counsel can take this action.", "code": "forbidden" }
```

`error` is written for a person and is safe to display verbatim. Validation
failures also carry `issues` from the schema.

| Code | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | The request was malformed or incomplete |
| `unauthorized` | 401 | No session, or it expired |
| `forbidden` | 403 | The role cannot take this action |
| `not_found` | 404 | No such resource in this org |
| `conflict` | 409 | The action contradicts current state |
| `budget_exhausted` | 402 | The production is at its research cap |

## Endpoints

### Identity
| Method | Path | Who |
|---|---|---|
| `POST` | `/api/auth/register` | anyone — creates an org and its first user |
| `POST` | `/api/auth/login` | anyone |
| `POST` | `/api/auth/invite` | producer, coordinator, counsel |
| `GET` | `/api/auth/me` | any |

### Productions
| Method | Path | Who |
|---|---|---|
| `GET` | `/api/productions` | any |
| `POST` | `/api/productions` | not reviewer — multipart, opens pass 1 |
| `GET` | `/api/productions/:id` | any |
| `POST` | `/api/productions/:id/cuts` | not reviewer — triggers delta re-clearance |
| `POST` | `/api/productions/:id/resume` | not reviewer |
| `POST` | `/api/productions/:id/budget` | producer, counsel |
| `GET` | `/api/productions/:id/stream` | any — SSE |
| `GET` | `/api/productions/:id/ledger` | any |
| `GET` | `/api/productions/:id/integrity` | any |

### Findings
| Method | Path | Who |
|---|---|---|
| `GET` | `/api/findings/:id` | any |
| `PATCH` | `/api/findings/:id` | coordinator, producer, counsel |
| `POST` | `/api/findings/:id/decision` | **counsel** |
| `POST` | `/api/findings/:id/outreach/approve` | **counsel** |
| `POST` | `/api/findings/:id/recheck` | not reviewer |
| `GET` | `/api/evidence/:id/snapshot` | any |
| `GET` | `/api/approvals` | any |

### Reports
| Method | Path | Who |
|---|---|---|
| `GET` | `/api/reports` | any |
| `POST` | `/api/productions/:id/reports` | not reviewer |
| `POST` | `/api/reports/:id/sign` | **counsel** |
| `GET` | `/api/reports/:id/pdf` | any |

### Webhooks
`POST /api/webhooks/parallel` — HMAC-verified Monitor callback. Unverified
events are logged and dropped.

## The live stream

`GET /api/productions/:id/stream` is Server-Sent Events. Because `EventSource`
cannot set headers, this route alone accepts `?token=`; no other route does.

Event names: `ready`, `activity`, `finding`, `production`, `outreach`.

Frames are **notifications, not state**. A frame means something moved; the
client re-reads the resource. That keeps one source of truth and stops the UI
drifting from what was actually persisted.

## Starting a pass

```bash
curl -X POST "$API/api/productions" \
  -H "Authorization: Bearer $TOKEN" \
  -F "title=The Last Hour" \
  -F "format=Feature film" \
  -F "budgetUsd=25" \
  -F "file=@screenplay.pdf;type=application/pdf"
```

Returns immediately with the production and cut. The breakdown runs on the
worker; watch the stream or poll `GET /api/productions/:id`.
