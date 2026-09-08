# syntax=docker/dockerfile:1
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libpango-1.0-0 libpangoft2-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 libffi-dev \
 && rm -rf /var/lib/apt/lists/*

# Workspace packages this service depends on, then the service itself.
COPY packages/contracts /app/packages/contracts
COPY packages/runtime   /app/packages/runtime
COPY services/ledger-api /app/services/ledger-api
COPY services/report-renderer /app/services/report-renderer

RUN pip install --no-deps \
      /app/packages/contracts /app/packages/runtime \
 && pip install /app/services/report-renderer \
 && pip install "google-cloud-firestore>=2.16" "google-cloud-pubsub>=2.21" \
                "google-cloud-bigquery>=3.20" "google-cloud-storage>=2.16" \
                "google-cloud-secret-manager>=2.20"

ENV PORT=8080
EXPOSE 8080
CMD exec uvicorn clearframe_renderer.main:app --host 0.0.0.0 --port $PORT --workers 1
