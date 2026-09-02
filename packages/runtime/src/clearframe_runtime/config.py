"""One place that reads the environment. Nothing else calls os.environ directly."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel


def _find_dotenv() -> Path | None:
    here = Path.cwd()
    for d in (here, *here.parents):
        cand = d / ".env"
        if cand.exists():
            return cand
    return None


def load_dotenv() -> None:
    """Minimal .env loader — no dependency, no surprises. Real env always wins."""
    path = _find_dotenv()
    if not path:
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


class Settings(BaseModel):
    """Runtime configuration.

    `backend` decides the data plane:
      * ``gcp``   — Firestore, Pub/Sub, BigQuery, GCS, Secret Manager
      * ``local`` — the same interfaces over a directory on disk, for tests and
                    laptop runs. Research still hits the live Parallel API; only
                    the plumbing is local.
    """

    project_id: str = "clearframe-local"
    region: str = "us-central1"
    backend: str = "local"
    local_root: Path = Path(".local")
    #: Which local spine to use: "file" crosses processes, "inproc" does not.
    bus: str = "file"
    #: Names this process on the local spine, so events fan out to the right inbox.
    service_name: str = "orchestrator"

    # Vertex AI / Gemini
    vertex_project: str = ""
    vertex_location: str = "us-central1"
    model_pro: str = "gemini-2.5-pro"
    model_flash: str = "gemini-2.5-flash"

    # Gemini Enterprise Agent Builder (optional — playbooks also run on Vertex directly)
    agent_app_id: str = ""
    datastore_eo_id: str = ""
    datastore_handbooks_id: str = ""

    # Pub/Sub topic names
    topic_research: str = "cf-research"
    topic_findings: str = "cf-findings"
    topic_decisions: str = "cf-decisions"
    topic_monitor: str = "cf-monitor"

    # Storage / data
    bucket_cuts: str = "cf-cuts"
    bucket_reports: str = "cf-reports"
    bucket_snapshots: str = "cf-snapshots"
    bq_dataset: str = "clearframe"

    # Service URLs (populated by deploy.sh)
    url_adapter: str = ""
    url_ledger: str = ""
    url_webhook: str = ""
    url_renderer: str = ""
    url_orchestrator: str = ""

    # Parallel
    parallel_base: str = "https://api.parallel.ai"
    parallel_mcp_url: str = "https://mcp.parallel.ai/v1beta/search_mcp"
    parallel_api_key_secret: str = "parallel-api-key"
    parallel_webhook_secret_name: str = "parallel-webhook-secret"
    parallel_api_key: str = ""  # dev only; production reads Secret Manager
    parallel_webhook_secret: str = ""  # dev only

    # Identity
    iap_audience: str = ""  # /projects/N/global/backendServices/ID
    push_audience: str = ""  # audience the Pub/Sub push token is minted for
    pubsub_push_sa: str = ""  # service account Pub/Sub pushes as
    trusted_proxy_sa: str = ""  # the web app's service account
    demo_identity: bool = False  # accept a role chosen in the UI (public demo)

    # Policy
    default_budget_cap_usd: float = 60.0
    max_challenges: int = 2
    monitor_frequency: str = "1d"

    @property
    def is_local(self) -> bool:
        return self.backend == "local"

    @property
    def vertex_configured(self) -> bool:
        """A project id that nobody set is not a configured reasoning backend.

        Reporting readiness on the default sentinel would turn a missing setting
        into a confusing failure halfway through a pass.
        """
        project = self.vertex_project or self.project_id
        return bool(project) and project != "clearframe-local"

    def topic(self, short: str) -> str:
        return {
            "research": self.topic_research,
            "findings": self.topic_findings,
            "decisions": self.topic_decisions,
            "monitor": self.topic_monitor,
        }[short]


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


@lru_cache(maxsize=1)
def settings() -> Settings:
    load_dotenv()
    return Settings(
        project_id=_env("PROJECT_ID", "clearframe-local"),
        region=_env("REGION", "us-central1"),
        backend=_env("CLEARFRAME_BACKEND", "local").lower(),
        local_root=Path(_env("CLEARFRAME_LOCAL_ROOT", ".local")),
        bus=_env("CLEARFRAME_BUS", "file").lower(),
        service_name=_env("CLEARFRAME_SERVICE", "orchestrator"),
        vertex_project=_env("VERTEX_PROJECT") or _env("PROJECT_ID", ""),
        vertex_location=_env("VERTEX_LOCATION", "us-central1"),
        model_pro=_env("MODEL_PRO", "gemini-2.5-pro"),
        model_flash=_env("MODEL_FLASH", "gemini-2.5-flash"),
        agent_app_id=_env("AGENT_APP_ID"),
        datastore_eo_id=_env("DATASTORE_EO_ID"),
        datastore_handbooks_id=_env("DATASTORE_HANDBOOKS_ID"),
        topic_research=_env("TOPIC_RESEARCH", "cf-research"),
        topic_findings=_env("TOPIC_FINDINGS", "cf-findings"),
        topic_decisions=_env("TOPIC_DECISIONS", "cf-decisions"),
        topic_monitor=_env("TOPIC_MONITOR", "cf-monitor"),
        bucket_cuts=_env("BUCKET_CUTS", "cf-cuts"),
        bucket_reports=_env("BUCKET_REPORTS", "cf-reports"),
        bucket_snapshots=_env("BUCKET_SNAPSHOTS", "cf-snapshots"),
        bq_dataset=_env("BQ_DATASET", "clearframe"),
        url_adapter=_env("URL_ADAPTER"),
        url_ledger=_env("URL_LEDGER"),
        url_webhook=_env("URL_WEBHOOK"),
        url_renderer=_env("URL_RENDERER"),
        url_orchestrator=_env("URL_ORCHESTRATOR"),
        parallel_base=_env("PARALLEL_BASE", "https://api.parallel.ai"),
        parallel_mcp_url=_env("PARALLEL_MCP_URL", "https://mcp.parallel.ai/v1beta/search_mcp"),
        parallel_api_key=_env("PARALLEL_API_KEY"),
        parallel_webhook_secret=_env("PARALLEL_WEBHOOK_SECRET"),
        iap_audience=_env("IAP_AUDIENCE"),
        push_audience=_env("PUSH_AUDIENCE"),
        pubsub_push_sa=_env("PUBSUB_PUSH_SA"),
        trusted_proxy_sa=_env("TRUSTED_PROXY_SA"),
        demo_identity=_env("DEMO_IDENTITY", "").lower() in {"1", "true", "yes"},
        default_budget_cap_usd=float(_env("DEFAULT_BUDGET_CAP_USD", "60") or 60),
        max_challenges=int(_env("MAX_CHALLENGES", "2") or 2),
        monitor_frequency=_env("MONITOR_FREQUENCY", "1d"),
    )


def reset_settings_cache() -> None:
    settings.cache_clear()
