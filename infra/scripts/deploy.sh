#!/usr/bin/env bash
# Build and deploy every service. Only the web app and the webhook receiver are
# publicly invokable; everything else requires an authenticated caller.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
set -a; source "$ROOT/.env"; set +a

: "${PROJECT_ID:?set PROJECT_ID in .env}"
: "${REGION:?set REGION in .env}"

cd "$ROOT"
say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

COMMON_ENV="PROJECT_ID=$PROJECT_ID,REGION=$REGION,CLEARFRAME_BACKEND=gcp"
COMMON_ENV="$COMMON_ENV,BQ_DATASET=$BQ_DATASET"
COMMON_ENV="$COMMON_ENV,BUCKET_CUTS=$BUCKET_CUTS,BUCKET_REPORTS=$BUCKET_REPORTS"
COMMON_ENV="$COMMON_ENV,BUCKET_SNAPSHOTS=$BUCKET_SNAPSHOTS"
COMMON_ENV="$COMMON_ENV,TOPIC_RESEARCH=$TOPIC_RESEARCH,TOPIC_FINDINGS=$TOPIC_FINDINGS"
COMMON_ENV="$COMMON_ENV,TOPIC_DECISIONS=$TOPIC_DECISIONS,TOPIC_MONITOR=$TOPIC_MONITOR"

deploy() {                       # deploy <name> <dir> <service-account> <public?>
  local name="$1" dir="$2" sa="$3" public="${4:-no}" extra="${5:-}"
  say "Deploying cf-$name"
  local flags=(--source "$dir" --region "$REGION"
               --service-account "$sa@$PROJECT_ID.iam.gserviceaccount.com"
               --set-env-vars "$COMMON_ENV${extra:+,$extra}"
               --cpu 1 --memory 1Gi --timeout 900 --max-instances 10)
  if [[ "$public" == "yes" ]]; then flags+=(--allow-unauthenticated)
  else flags+=(--no-allow-unauthenticated); fi
  gcloud run deploy "cf-$name" "${flags[@]}"
  gcloud run services describe "cf-$name" --region "$REGION" --format 'value(status.url)'
}

URL_ADAPTER=$(deploy parallel-adapter services/parallel-adapter sa-parallel-adapter no)
URL_LEDGER=$(deploy ledger-api      services/ledger-api       sa-ledger          no)
URL_RENDERER=$(deploy report-renderer services/report-renderer sa-renderer       no)
# The webhook receiver is the one public endpoint — every callback is signature-verified.
URL_WEBHOOK=$(deploy webhook-receiver services/webhook-receiver sa-webhook       yes)

URL_ORCHESTRATOR=$(deploy orchestrator . sa-orchestrator no \
  "URL_ADAPTER=$URL_ADAPTER,URL_LEDGER=$URL_LEDGER,URL_WEBHOOK=$URL_WEBHOOK,URL_RENDERER=$URL_RENDERER,VERTEX_PROJECT=${VERTEX_PROJECT:-$PROJECT_ID},VERTEX_LOCATION=${VERTEX_LOCATION:-$REGION},AGENT_APP_ID=${AGENT_APP_ID:-},DATASTORE_EO_ID=${DATASTORE_EO_ID:-},DATASTORE_HANDBOOKS_ID=${DATASTORE_HANDBOOKS_ID:-},PUBSUB_PUSH_SA=sa-orchestrator@$PROJECT_ID.iam.gserviceaccount.com,PUSH_AUDIENCE=${PUSH_AUDIENCE:-},TRUSTED_PROXY_SA=sa-web@$PROJECT_ID.iam.gserviceaccount.com")

say "Deploying the war room"
# The web app is the judge-facing surface, so it is public — and it is the only
# thing that is. It reaches the private services with its own identity token.
gcloud run deploy cf-web \
  --source web --region "$REGION" \
  --service-account "sa-web@$PROJECT_ID.iam.gserviceaccount.com" \
  --allow-unauthenticated \
  --set-env-vars "URL_ORCHESTRATOR=$URL_ORCHESTRATOR,URL_LEDGER=$URL_LEDGER,URL_RENDERER=$URL_RENDERER,NEXT_PUBLIC_DEMO_IDENTITY=${DEMO_IDENTITY:-false}" \
  --cpu 1 --memory 512Mi --max-instances 10
URL_WEB=$(gcloud run services describe cf-web --region "$REGION" --format 'value(status.url)')

# The war room calls the private services as itself.
for target in cf-orchestrator cf-ledger-api cf-report-renderer; do
  gcloud run services add-iam-policy-binding "$target" --region "$REGION" \
    --member "serviceAccount:sa-web@$PROJECT_ID.iam.gserviceaccount.com" \
    --role roles/run.invoker >/dev/null
done

# Cloud Run services call each other as themselves, not as allUsers.
for caller in sa-orchestrator; do
  for target in cf-parallel-adapter cf-ledger-api cf-report-renderer; do
    gcloud run services add-iam-policy-binding "$target" --region "$REGION" \
      --member "serviceAccount:$caller@$PROJECT_ID.iam.gserviceaccount.com" \
      --role roles/run.invoker >/dev/null
  done
done

say "Deployed"
cat <<EOF
Put these in .env, then re-run bootstrap.sh so the push subscriptions point at the
orchestrator:

URL_ADAPTER=$URL_ADAPTER
URL_LEDGER=$URL_LEDGER
URL_WEBHOOK=$URL_WEBHOOK
URL_RENDERER=$URL_RENDERER
URL_ORCHESTRATOR=$URL_ORCHESTRATOR

The war room is live at:
  $URL_WEB

Set DEMO_IDENTITY=true in .env and redeploy if a visitor should be able to choose
which role they act as — that is what lets a judge walk the counsel gate without
four accounts. Leave it false for any project holding real material.
EOF
