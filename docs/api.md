# ClearFrame REST API & Streaming Specification

The ClearFrame API is a high-performance, stateless HTTP service built on Fastify. It handles authentication, screenplay uploads, clearance triage, counsel approvals, cryptographic chain verification, and Server-Sent Events (SSE).

---

## Global Conventions

### Base URL & Protocol
```http
https://clearframe-api-<hash>.run.app
```
- All request and response bodies use JSON (`application/json`) except file uploads which use `multipart/form-data`.
- All timestamps are RFC 3339 / ISO 8601 UTC strings (e.g. `2026-09-09T14:30:00.000Z`).
- All monetary amounts are 64-bit integer micro-dollars (`1 USD = 1,000,000 micros`).

### Authentication & Tenant Isolation
Authenticate all requests using an HTTP `Authorization` header:
```http
Authorization: Bearer <jwt_token>
```
ClearFrame enforces multi-tenant isolation at the database layer. Any request accessing a resource belonging to a different organization returns `404 Not Found` rather than `403 Forbidden` to prevent resource enumeration.

### Standard Error Envelope
All error responses adhere to a unified JSON contract:
```json
{
  "code": "forbidden",
  "error": "Only legal counsel can approve clearance decisions.",
  "issues": []
}
```

| HTTP Status | Error Code | Description |
|---|---|---|
| `400` | `bad_request` | Invalid schema payload or malformed query parameter |
| `401` | `unauthorized` | Missing, expired, or cryptographically invalid JWT |
| `402` | `budget_exhausted` | Production has reached its allocated `budget_cap_micros` |
| `403` | `forbidden` | Authenticated user lacks the necessary RBAC role |
| `404` | `not_found` | Resource does not exist within the caller's organization |
| `409` | `conflict` | State machine collision (e.g. modifying an immutable report) |
| `500` | `internal_error` | Unhandled server exception |

---

## 1. Authentication & Team Management

### `POST /api/auth/register`
Creates a new organization and provisions the initial administrative user.
- **Access**: Public
- **Request Body**:
  ```json
  {
    "orgName": "A24 Films",
    "email": "producer@a24films.com",
    "name": "David Fenkel",
    "password": "SecurePassword123!",
    "role": "producer"
  }
  ```
- **Response** (`201 Created`):
  ```json
  {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "7b8f9e6a-1234-4567-89ab-cdef01234567",
      "orgId": "9c1a2b3c-4d5e-6f7a-8b9c-0d1e2f3a4b5c",
      "email": "producer@a24films.com",
      "name": "David Fenkel",
      "role": "producer"
    }
  }
  ```

### `POST /api/auth/login`
Authenticates an existing user and returns a signed session token.
- **Access**: Public
- **Request Body**:
  ```json
  {
    "email": "counsel@a24films.com",
    "password": "SecurePassword123!"
  }
  ```

### `GET /api/auth/me`
Fetches current session identity and organizational permissions.
- **Access**: Any authenticated user

### `POST /api/auth/invite`
Invites a collaborator into the caller's organization.
- **Access**: `producer`, `coordinator`, `counsel`
- **Request Body**:
  ```json
  {
    "email": "rights@outsidecounsel.com",
    "name": "Sarah Koenig",
    "role": "counsel"
  }
  ```

---

## 2. Productions & Screenplay Cuts

### `GET /api/productions`
Lists all film and television productions in the organization with spend summaries.
- **Access**: Any authenticated user

### `POST /api/productions`
Creates a production and triggers Pass 1 autonomous screenplay breakdown.
- **Access**: `producer`, `coordinator`, `counsel`
- **Content-Type**: `multipart/form-data`
- **Form Fields**:
  - `title` (string): Project title (e.g. "Neon Velvet")
  - `format` (string): Production format ("Feature film", "TV Series (1hr)", "Documentary")
  - `budgetUsd` (number): AI research budget cap in dollars (e.g. `25` → `25,000,000` micros)
  - `file` (file): Script PDF file (`application/pdf`)
- **Response** (`201 Created`):
  ```json
  {
    "production": {
      "id": "2b9a76d8-1111-2222-3333-444455556666",
      "title": "Neon Velvet",
      "format": "Feature film",
      "status": "breakdown",
      "budgetCapMicros": 25000000,
      "spentMicros": 0
    },
    "cut": {
      "id": "fa8e1234-5678-90ab-cdef-1234567890ab",
      "n": 1,
      "filename": "neon_velvet_shooting_draft.pdf",
      "contentHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  }
  ```

### `POST /api/productions/:id/cuts`
Uploads a revision (Pass $N+1$) and initiates **Delta Re-Clearance**.
- **Access**: `producer`, `coordinator`, `counsel`
- **Content-Type**: `multipart/form-data`
- **Form Fields**:
  - `file` (file): Revised screenplay PDF

### `POST /api/productions/:id/budget`
Adjusts the maximum spending cap for automated research.
- **Access**: `producer`, `counsel`
- **Request Body**:
  ```json
  {
    "budgetUsd": 50
  }
  ```

### `GET /api/productions/:id/integrity`
Recomputes and validates the entire SHA-256 ledger chain for this production.
- **Access**: Any authenticated user
- **Response** (`200 OK`):
  ```json
  {
    "valid": true,
    "length": 48,
    "head": "a8f5c3829b19e27c09384bbad345129847120349817203498172039847120349",
    "checkedAt": "2026-09-09T18:00:00.000Z"
  }
  ```

---

## 3. Findings & Legal Resolution

### `GET /api/findings/:id`
Retrieves full details for a finding, including dual-chain provenance, adversarial verification reports, and cited evidence.
- **Access**: Any authenticated user

### `POST /api/findings/:id/decision`
Submits a binding clearance resolution on a finding.
- **Access**: `counsel` strictly
- **Request Body**:
  ```json
  {
    "action": "approved",
    "rationale": "Fair use analysis confirms nominative background depiction without commercial dilution."
  }
  ```
- **Valid Actions**: `approved`, `licensed`, `replaced`, `rejected`

### `POST /api/findings/:id/outreach/approve`
Authorizes an agent-drafted rights holder licensing inquiry for human transmission.
- **Access**: `counsel` strictly

### `POST /api/findings/:id/recheck`
Manually triggers an immediate re-investigation pass against live web registries.
- **Access**: `producer`, `coordinator`, `counsel`

### `GET /api/evidence/:id/snapshot`
Retrieves the immutable HTML/text snapshot captured during source retrieval to safeguard against link rot.
- **Access**: Any authenticated user

---

## 4. Clearance Reports (E&O Insurance)

### `GET /api/reports`
Lists all generated clearance packages across productions.

### `POST /api/productions/:id/reports`
Generates a frozen E&O report snapshot anchored to the current ledger head.
- **Access**: `producer`, `coordinator`, `counsel`

### `POST /api/reports/:id/sign`
Applies a cryptographic legal signature to an E&O report.
- **Access**: `counsel` strictly
- **Response** (`200 OK`):
  ```json
  {
    "signed": true,
    "signedBy": "Sarah Koenig (counsel)",
    "signedAt": "2026-09-09T18:15:22.000Z",
    "ledgerHead": "a8f5c3829b19e27c09384bbad345129847120349817203498172039847120349",
    "pdfUrl": "/api/reports/12345/pdf"
  }
  ```

### `GET /api/reports/:id/pdf`
Streams the formatted, publication-ready PDF clearance binder.

---

## 5. Real-Time Streaming (SSE)

### `GET /api/productions/:id/stream`
Establishes a continuous Server-Sent Events stream for live pipeline execution.

```http
GET /api/productions/2b9a76d8-1111-2222-3333-444455556666/stream?token=<jwt_token> HTTP/1.1
Host: clearframe-api.run.app
Accept: text/event-stream
```

#### Event Payloads
- `event: ready` — Stream initialized.
- `event: activity` — Live log message from agent execution.
  ```json
  { "id": 142, "stage": "research", "text": "Parallel Search identified primary publisher for Midnight City" }
  ```
- `event: finding` — Finding state change or confidence update.
- `event: production` — Production spend update or status change.
- `event: outreach` — Drafted licensing letter ready for counsel review.

> [!NOTE]
> Event frames serve as **invalidation notifications, not complete state transfers**. Clients re-fetch the modified entity upon receipt to maintain a single source of truth.

---

## 6. Webhooks & Monitors

### `POST /api/webhooks/parallel`
Receives asynchronous change notifications from live web monitors.
- **Access**: Gated by HMAC-SHA256 signature in `X-Parallel-Signature` header.
- **Behavior**: Unverified payloads are dropped with HTTP `401`. Verified alerts trigger the **Sentinel Agent** to re-evaluate affected findings.
