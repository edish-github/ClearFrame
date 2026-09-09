# ClearFrame Operations & Deployment Guide

This guide covers local environment setup, configuration parameters, multi-service Cloud Run deployment on Google Cloud Platform, and operational runbooks.

---

## 1. System Topology

```mermaid
flowchart TB
    subgraph Clients
        Browser["React 19 SPA (apps/web)"]
        Cron["GCP Cloud Scheduler (Sweeps)"]
    end

    subgraph GCP["Google Cloud Platform (us-central1)"]
        subgraph CloudRun["Cloud Run Services"]
            Web["clearframe-web<br/>(Static SPA Server)"]
            API["clearframe-api<br/>(Fastify REST & SSE)"]
            Worker["clearframe-worker<br/>(Queue Daemon)"]
        end

        subgraph Storage["State & Storage"]
            DB[("Cloud SQL PostgreSQL 16<br/>(clearframe-db)")]
            GCS["Cloud Storage Bucket<br/>(gs://clearframe-assets-*)"]
        end

        subgraph Providers["AI Reasoning & Web Intelligence"]
            Vertex["Vertex AI<br/>(gemini-2.5-pro / flash)"]
            Parallel["Parallel AI<br/>(Search & Task API)"]
        end
    end

    Browser -->|HTTPS| Web
    Browser -->|REST / SSE| API
    Cron -->|POST /api/internal/sweep| API
    API -->|TCP / UNIX Socket| DB
    API -->|Signed Read/Write| GCS
    Worker -->|FOR UPDATE SKIP LOCKED| DB
    Worker -->|Read/Write Artifacts| GCS
    Worker -->|Inference| Vertex
    Worker -->|Live Web Retrieval| Parallel
```

---

## 2. Local Development

### Option A: Docker Compose (Fastest)

```bash
# 1. Clone and configure environment
cp .env.example .env

# Edit .env with your credentials:
# - GOOGLE_CLOUD_PROJECT
# - PARALLEL_API_KEY
# - DATABASE_URL=postgres://postgres:postgres@localhost:5432/clearframe

# 2. Boot PostgreSQL, API, Worker, and Web
make up

# 3. Run live provider smoke test
make smoke
```

### Option B: Bare Metal Node.js

```bash
# 1. Install workspace dependencies
make install

# 2. Setup PostgreSQL database
createdb clearframe
make migrate

# 3. Start development servers concurrently
make dev
```
- **ClearFrame Web Workspace**: `http://localhost:3000`
- **Fastify API Server**: `http://localhost:8080`

---

## 3. Environment Variables

| Variable | Type | Default | Description |
|---|---|---|---|
| `PORT` | number | `8080` | Port for Fastify HTTP server |
| `DATABASE_URL` | string | — | PostgreSQL connection string (supports Unix socket for Cloud SQL) |
| `JWT_SECRET` | string | — | Secret key for signing session tokens (min 32 chars) |
| `INTERNAL_SWEEP_SECRET`| string | — | Secret token for securing Cloud Scheduler sweep invocations |
| `GOOGLE_CLOUD_PROJECT` | string | — | GCP Project ID hosting Vertex AI and Cloud SQL |
| `GOOGLE_CLOUD_LOCATION`| string | `us-central1` | Region for Vertex AI models |
| `PARALLEL_API_KEY` | string | — | API key for Parallel AI live search and extraction |
| `GEMINI_MODEL_PRO` | string | `gemini-2.5-pro` | Model ID for complex breakdown, reasoning, and counsel |
| `GEMINI_MODEL_FLASH` | string | `gemini-2.5-flash` | Model ID for routing, triage, and outreach drafting |
| `GEMINI_PRO_INPUT_PER_MTOK` | number | `1.25` | Published input pricing per million tokens |
| `GEMINI_PRO_OUTPUT_PER_MTOK` | number | `5.00` | Published output pricing per million tokens |
| `STORAGE_DRIVER` | string | `local` | Storage backend (`local` or `gcs`) |
| `GCS_BUCKET` | string | — | Cloud Storage bucket name for screenplay PDFs and reports |
| `WORKER_CONCURRENCY` | number | `4` | Number of simultaneous finding investigations per worker |
| `MONITOR_INTERVAL_HOURS`| number | `24` | Internal check frequency for Sentinel agent watches |

---

## 4. Production Deployment on Google Cloud

ClearFrame is designed to run serverlessly on **Google Cloud Run** connected to **Cloud SQL**.

### Step 1: Cloud SQL Provisioning
```bash
gcloud sql instances create clearframe-db \
  --database-version=POSTGRES_16 \
  --tier=db-custom-2-7680 \
  --region=us-central1

gcloud sql databases create clearframe --instance=clearframe-db
```

### Step 2: Cloud Storage Provisioning
```bash
gcloud storage buckets create gs://clearframe-assets-$PROJECT_ID \
  --location=us-central1 \
  --uniform-bucket-level-access
```

### Step 3: Service Deployment
```bash
# Build & Deploy API Service
gcloud run deploy clearframe-api \
  --source . \
  --port 8080 \
  --command node \
  --args dist/server.js \
  --add-cloudsql-instances $PROJECT_ID:us-central1:clearframe-db \
  --set-env-vars STORAGE_DRIVER=gcs,GCS_BUCKET=clearframe-assets-$PROJECT_ID \
  --allow-unauthenticated

# Build & Deploy Background Worker (Private)
gcloud run deploy clearframe-worker \
  --source . \
  --command node \
  --args dist/jobs/worker.js \
  --min-instances 1 \
  --max-instances 10 \
  --no-allow-unauthenticated

# Build & Deploy Web Frontend
gcloud run deploy clearframe-web \
  --source apps/web \
  --allow-unauthenticated
```

### Step 4: Cloud Scheduler Sweep Automation
```bash
gcloud scheduler jobs create http clearframe-hourly-sweep \
  --schedule="0 * * * *" \
  --uri="https://clearframe-api-$HASH.run.app/api/internal/sweep" \
  --http-method=POST \
  --headers="x-clearframe-sweep=$INTERNAL_SWEEP_SECRET"
```

---

## 5. Operational Runbooks

### Runbook 1: Finding Stalled in `researching`
1. Check worker logs in Cloud Logging:
   ```bash
   gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=clearframe-worker" --limit 50
   ```
2. Inspect the `jobs` table for failed attempts:
   ```sql
   SELECT id, kind, state, attempts, last_error FROM jobs WHERE state = 'failed';
   ```
3. Stalled jobs older than 20 minutes are automatically released by the built-in queue reaper. To manually retry:
   ```sql
   UPDATE jobs SET state = 'ready', attempts = 0 WHERE id = '<job_id>';
   ```

### Runbook 2: Resolving a Broken Ledger Chain
If `GET /api/productions/:id/integrity` reports `valid: false`:
1. Retrieve the exact broken sequence number `brokenAt`.
2. Inspect the ledger entries around that sequence:
   ```sql
   SELECT seq, actor, prev_hash, hash, ts FROM ledger 
   WHERE production_id = '<id>' AND seq BETWEEN <brokenAt>-1 AND <brokenAt>+1;
   ```
3. Determine if an out-of-band manual modification occurred.
4. E&O report signing is blocked until integrity is restored or a fresh production cut is submitted.

### Runbook 3: Live Provider Price Updates
When Vertex AI or Parallel AI adjusts model pricing:
1. Update `*_PER_MTOK` in the Cloud Run service environment variables.
2. New `cost_events` will automatically reflect the updated rate; historical cost records remain immutable.
