# Running it

## Locally

```bash
cp .env.example .env      # set GEMINI_API_KEY and PARALLEL_API_KEY
make up                   # Postgres, API and worker in Docker, schema applied
make smoke                # one real call to each provider
```

Without Docker:

```bash
make install
createdb clearframe
make migrate
make dev                  # api, worker and web together
```

The API refuses to boot without both provider keys. There is deliberately no
offline fallback: a fallback that invented rights data would be worse than an
outage.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | Required |
| `JWT_SECRET` | — | Required; 32+ random bytes in production |
| `INTERNAL_SWEEP_SECRET` | — | Secret shared between Cloud Scheduler and the sweep endpoint |
| `GOOGLE_CLOUD_PROJECT` | — | Required for Vertex AI reasoning layer |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | GCP region for Vertex AI |
| `PARALLEL_API_KEY` | — | Required |
| `GEMINI_MODEL_PRO` / `_FLASH` | `gemini-2.5-pro` / `-flash` | Pro reasons and judges, Flash routes and drafts |
| `*_PER_MTOK` | published rates | Drive the live budget meter; correct these when prices move |
| `PARALLEL_MONITORS_ENABLED` | `false` | When false, the worker's own scheduler re-checks |
| `MONITOR_INTERVAL_HOURS` | `24` | Cadence for internal re-checks |
| `WORKER_CONCURRENCY` | `4` | Findings investigated in parallel per worker |
| `STORAGE_DRIVER` | `local` | `local` or `gcs` |

## Scaling

The API is stateless; run as many as you like. Workers coordinate through the
`jobs` table, so `docker compose up -d --scale worker=3` triples throughput with
no configuration. SSE works across instances because notifications travel
through Postgres rather than process memory.

## Deploying to Cloud Run

Two services from one image, plus one static service:

```bash
gcloud run deploy clearframe-api    --source . --port 8080 --command node --args dist/server.js
gcloud run deploy clearframe-worker --source . --no-allow-unauthenticated --command node --args dist/jobs/worker.js
gcloud run deploy clearframe-web    --source apps/web
```

Set `STORAGE_DRIVER=gcs` and `GCS_BUCKET`, put the provider keys in Secret
Manager, and point `DATABASE_URL` at Cloud SQL. Give the worker a minimum
instance count of 1 so queued work is picked up promptly.

## Scheduled Sweeps (Cloud Scheduler)

Trigger periodic job sweeps and watch scheduling via Cloud Scheduler:

```bash
gcloud scheduler jobs create http clearframe-sweep \
  --schedule "0 * * * *" \
  --uri "$API_URL/api/internal/sweep" \
  --http-method POST \
  --headers "x-clearframe-sweep=$INTERNAL_SWEEP_SECRET"
```

## Health and observability

- `GET /health` checks the database round trip.
- Every provider call writes a `cost_events` row; that table is the spend audit.
- `activity` is the human-readable feed; `ledger` is the tamper-evident one.
- Stalled jobs are released automatically after 20 minutes.

## When something looks wrong

**A finding is stuck `researching`.** Check `jobs` for a `failed` row and read
`last_error`. Three attempts with backoff precede a park.

**The budget meter looks low.** It is measured from real usage. If a provider
changed prices, update the `*_PER_MTOK` variables.

**A report will not sign.** Signing refuses on a broken chain. Run
`GET /api/productions/:id/integrity` and read `brokenAt`.
