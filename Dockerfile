# syntax=docker/dockerfile:1
# The orchestrator: the only component that holds cross-item state.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*

COPY packages /app/packages
COPY services /app/services
COPY orchestrator /app/orchestrator
COPY agents /app/agents

RUN pip install --no-deps /app/packages/contracts /app/packages/runtime \
 && pip install /app/services/parallel-adapter /app/services/ledger-api \
                /app/services/report-renderer /app/orchestrator \
 && pip install "google-genai>=1.0" \
                "google-cloud-firestore>=2.16" "google-cloud-pubsub>=2.21" \
                "google-cloud-bigquery>=3.20" "google-cloud-storage>=2.16" \
                "google-cloud-secret-manager>=2.20" \
                "google-cloud-discoveryengine>=0.11"

ENV PORT=8080 CLEARFRAME_PLAYBOOKS=/app/agents/playbooks CLEARFRAME_DATASTORES=/app/agents/datastores
EXPOSE 8080
CMD exec uvicorn clearframe_orch.main:app --host 0.0.0.0 --port $PORT --workers 1
