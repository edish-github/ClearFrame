#!/usr/bin/env bash
# Everything a fresh Google Cloud project needs before `deploy.sh` will work:
# APIs, service accounts with least privilege, secrets, topics, tables, buckets.
#
#   cp .env.example .env && $EDITOR .env
#   ./infra/scripts/bootstrap.sh
#
# Safe to re-run: every step is idempotent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
set -a; source "$ROOT/.env"; set +a

: "${PROJECT_ID:?set PROJECT_ID in .env}"
: "${REGION:?set REGION in .env}"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

gcloud config set project "$PROJECT_ID" >/dev/null

say "Enabling APIs"
gcloud services enable \
  aiplatform.googleapis.com \
  discoveryengine.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  pubsub.googleapis.com \
  firestore.googleapis.com \
  bigquery.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com

say "Creating service accounts (least privilege from the start)"
declare -A SA_ROLES=(
  [sa-orchestrator]="roles/pubsub.publisher roles/pubsub.subscriber roles/datastore.user roles/aiplatform.user roles/run.invoker"
  [sa-parallel-adapter]="roles/pubsub.publisher roles/storage.objectCreator"
  [sa-ledger]="roles/bigquery.dataEditor roles/bigquery.jobUser roles/pubsub.publisher roles/datastore.user"
  [sa-webhook]="roles/pubsub.publisher roles/datastore.viewer"
  [sa-renderer]="roles/bigquery.dataViewer roles/bigquery.jobUser roles/storage.objectCreator roles/datastore.viewer"
  [sa-web]="roles/datastore.viewer roles/run.invoker"
)
for sa in "${!SA_ROLES[@]}"; do
  email="$sa@$PROJECT_ID.iam.gserviceaccount.com"
  gcloud iam service-accounts describe "$email" >/dev/null 2>&1 \
    || gcloud iam service-accounts create "$sa" --display-name "ClearFrame $sa"
  for role in ${SA_ROLES[$sa]}; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member "serviceAccount:$email" --role "$role" --condition=None >/dev/null
  done
  echo "  $sa ✓"
done

say "Secrets — agents call tools; tools hold secrets"
create_secret() {
  local name="$1" value="$2"
  gcloud secrets describe "$name" >/dev/null 2>&1 \
    || gcloud secrets create "$name" --replication-policy=automatic
  if [[ -n "$value" ]]; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
  fi
}
create_secret parallel-api-key "${PARALLEL_API_KEY:-}"
# Standard Webhooks secret: whsec_ + base64 key material.
if [[ -z "${PARALLEL_WEBHOOK_SECRET:-}" ]]; then
  PARALLEL_WEBHOOK_SECRET="whsec_$(openssl rand -base64 32 | tr -d '\n')"
  echo "  generated a webhook signing secret — register it with Parallel"
fi
create_secret parallel-webhook-secret "$PARALLEL_WEBHOOK_SECRET"

gcloud secrets add-iam-policy-binding parallel-api-key \
  --member "serviceAccount:sa-parallel-adapter@$PROJECT_ID.iam.gserviceaccount.com" \
  --role roles/secretmanager.secretAccessor >/dev/null
gcloud secrets add-iam-policy-binding parallel-webhook-secret \
  --member "serviceAccount:sa-webhook@$PROJECT_ID.iam.gserviceaccount.com" \
  --role roles/secretmanager.secretAccessor >/dev/null

say "Firestore (native mode) for live state"
gcloud firestore databases describe --database='(default)' >/dev/null 2>&1 \
  || gcloud firestore databases create --location="$REGION"

# The browser subscribes to live state; it must never be able to write it. These
# rules make that architectural promise unforgeable rather than merely intended.
if [[ -f "$ROOT/infra/firestore.rules" ]]; then
  echo "  deploying security rules"
  gcloud firestore databases update --database='(default)' >/dev/null 2>&1 || true
  gcloud alpha firestore rules release "$ROOT/infra/firestore.rules" 2>/dev/null \
    || echo "  (rules not deployed — run: firebase deploy --only firestore:rules)"
fi
if [[ -f "$ROOT/infra/firestore.indexes.json" ]]; then
  echo "  indexes: infra/firestore.indexes.json (apply with the firebase CLI)"
fi

say "Pub/Sub topics, subscriptions, and dead-letter topics"
ORCH_URL="${URL_ORCHESTRATOR:-}"
for topic in "$TOPIC_RESEARCH" "$TOPIC_FINDINGS" "$TOPIC_DECISIONS" "$TOPIC_MONITOR"; do
  gcloud pubsub topics describe "$topic" >/dev/null 2>&1 \
    || gcloud pubsub topics create "$topic"
  gcloud pubsub topics describe "$topic-dead" >/dev/null 2>&1 \
    || gcloud pubsub topics create "$topic-dead"
done

if [[ -n "$ORCH_URL" ]]; then
  create_push() {
    local topic="$1" path="$2" name="$topic-push"
    gcloud pubsub subscriptions describe "$name" >/dev/null 2>&1 && return
    # The push token is minted for the orchestrator's own service account, and the
    # orchestrator verifies it on every /handle/* request.
    gcloud pubsub subscriptions create "$name" \
      --topic "$topic" \
      --push-endpoint "$ORCH_URL$path" \
      --push-auth-service-account "sa-orchestrator@$PROJECT_ID.iam.gserviceaccount.com" \
      --push-auth-token-audience "$ORCH_URL" \
      --ack-deadline 600 \
      --min-retry-delay 10s --max-retry-delay 600s \
      --dead-letter-topic "$topic-dead" --max-delivery-attempts 5
  }
  create_push "$TOPIC_RESEARCH"  /handle/research
  create_push "$TOPIC_FINDINGS"  /handle/finding
  create_push "$TOPIC_DECISIONS" /handle/decision
  create_push "$TOPIC_MONITOR"   /handle/monitor
else
  echo "  URL_ORCHESTRATOR is empty — run deploy.sh, put the URL in .env, re-run this"
fi

say "BigQuery dataset and tables"
bq --location="$REGION" mk --dataset --force "$PROJECT_ID:$BQ_DATASET" >/dev/null 2>&1 || true
for file in "$ROOT"/infra/sql/*.sql "$ROOT"/infra/sql/views/*.sql; do
  echo "  $(basename "$file")"
  sed "s|\${BQ_DATASET}|$PROJECT_ID.$BQ_DATASET|g" "$file" \
    | bq query --use_legacy_sql=false --project_id="$PROJECT_ID" >/dev/null
done

say "Cloud Storage buckets (uniform access, no public objects)"
for bucket in "$BUCKET_CUTS" "$BUCKET_REPORTS" "$BUCKET_SNAPSHOTS"; do
  gcloud storage buckets describe "gs://$bucket" >/dev/null 2>&1 \
    || gcloud storage buckets create "gs://$bucket" \
         --location="$REGION" --uniform-bucket-level-access --public-access-prevention
  echo "  gs://$bucket ✓"
done

say "Agent Builder data stores"
cat <<'NOTE'
  Data stores are created in the Gemini Enterprise / Agent Builder console:
    eo-underwriting     — E&O underwriting guidance
    clearance-handbooks — network and studio clearance practice

  Put their ids in .env as DATASTORE_EO_ID and DATASTORE_HANDBOOKS_ID. Until then
  Risk Counsel grounds on agents/datastores/ in this repository — see that
  directory's MANIFEST.md for what may and may not be committed.
NOTE

say "Bootstrap complete"
echo "Next:  ./infra/scripts/deploy.sh"
