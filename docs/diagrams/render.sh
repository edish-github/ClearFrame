#!/usr/bin/env bash
# Renders every .mmd in src/ to png/ at 2x for legibility in the submission.
# GitHub renders the inline mermaid in the markdown natively; these PNGs exist
# because Devpost does not.
set -euo pipefail
cd "$(dirname "$0")"
command -v mmdc >/dev/null || npm install -g @mermaid-js/mermaid-cli
# Containers and CI need chrome without a sandbox; harmless locally.
PUPPETEER_CFG="$(mktemp)"
echo '{"args":["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]}' > "$PUPPETEER_CFG"

mkdir -p png
for f in src/*.mmd; do
  out="png/$(basename "${f%.mmd}").png"
  mmdc -i "$f" -o "$out" -b white -s 2 -c mermaid.config.json -p "$PUPPETEER_CFG"
  echo "$out"
done
rm -f "$PUPPETEER_CFG"
