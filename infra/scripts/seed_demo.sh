#!/usr/bin/env bash
# Seed the public demo project a judge lands on: a project, a cut, a completed
# pass, and the role bindings that make the gate demonstrable.
#
#   ./infra/scripts/seed_demo.sh                    # against the deployed system
#   CLEARFRAME_BACKEND=local ./infra/scripts/seed_demo.sh   # against a local run
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
set -a; source "$ROOT/.env"; set +a

ORCH="${URL_ORCHESTRATOR:-http://localhost:8080}"
LEDGER="${URL_LEDGER:-http://localhost:8082}"
SCRIPT="${DEMO_SCRIPT:-$ROOT/demo/film/cut-01/script.fountain}"
TITLE="${DEMO_TITLE:-The Last Hour}"

auth=()
if [[ "$ORCH" != http://localhost* ]]; then
  auth=(-H "Authorization: Bearer $(gcloud auth print-identity-token)")
fi

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
json() { python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

say "Readiness"
curl -sS "${auth[@]}" "$ORCH/readyz" | python3 -m json.tool

say "Creating the demo project"
PROJECT_ID=$(curl -sS "${auth[@]}" -X POST "$ORCH/projects" \
  -H 'content-type: application/json' \
  -d "{\"title\":\"$TITLE\",\"budget_cap_usd\":${DEMO_BUDGET:-25}}" | json project_id)
echo "  $PROJECT_ID"

say "Binding the four roles"
for pair in "producer@clearframe.dev:producer" "coord@clearframe.dev:coordinator" \
            "counsel@clearframe.dev:counsel" "reviewer@clearframe.dev:reviewer"; do
  curl -sS "${auth[@]}" -X PUT "$ORCH/projects/$PROJECT_ID/roles" \
    -H 'content-type: application/json' \
    -d "{\"subject\":\"${pair%%:*}\",\"role\":\"${pair##*:}\"}" >/dev/null
  echo "  ${pair%%:*} → ${pair##*:}"
done

say "Uploading cut-01 and breaking it down"
CUT_JSON=$(curl -sS "${auth[@]}" -X POST \
  "$ORCH/projects/$PROJECT_ID/cuts?label=cut-01" -F "file=@$SCRIPT")
echo "$CUT_JSON" | python3 -m json.tool
CUT_ID=$(echo "$CUT_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["cut"]["cut_id"])')

say "Starting the pass"
curl -sS "${auth[@]}" -X POST "$ORCH/projects/$PROJECT_ID/passes" \
  -H 'content-type: application/json' \
  -d "{\"cut_id\":\"$CUT_ID\",\"mode\":\"full\"}" | python3 -m json.tool

cat <<EOF

Seeded.
  PROJECT_ID=$PROJECT_ID
  CUT_ID=$CUT_ID

Watch it run:
  curl "$ORCH/projects/$PROJECT_ID" | python3 -m json.tool
  curl "$ORCH/cuts/$CUT_ID/heatstrip" | python3 -m json.tool
  curl "$ORCH/projects/$PROJECT_ID/approvals" | python3 -m json.tool

Ship the report and arm the watches when the pass settles:
  curl -X POST "$ORCH/projects/$PROJECT_ID/reports" \\
       -H 'content-type: application/json' -d '{"cut_id":"$CUT_ID"}'
EOF
