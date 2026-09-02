"""Secret access. Services hold credentials; agents never see them."""

from __future__ import annotations

from functools import lru_cache

from .config import settings


class SecretUnavailable(RuntimeError):
    pass


@lru_cache(maxsize=16)
def get_secret(name: str, dev_fallback: str = "") -> str:
    """Read a secret from Secret Manager, or from the environment in local mode.

    In local mode the value comes from `.env` so a laptop run works; in `gcp`
    mode the process must have Secret Manager access and nothing else.
    """
    cfg = settings()
    if cfg.is_local:
        if not dev_fallback:
            raise SecretUnavailable(f"secret '{name}' unavailable: set it in .env for local runs")
        return dev_fallback

    from google.cloud import secretmanager  # imported lazily: local runs need no GCP deps

    client = secretmanager.SecretManagerServiceClient()
    path = f"projects/{cfg.project_id}/secrets/{name}/versions/latest"
    try:
        return client.access_secret_version(name=path).payload.data.decode().strip()
    except Exception as exc:  # noqa: BLE001 — surfaced to the caller, never swallowed
        raise SecretUnavailable(f"secret '{name}' unreadable: {exc}") from exc


def parallel_api_key() -> str:
    cfg = settings()
    return get_secret(cfg.parallel_api_key_secret, cfg.parallel_api_key)


def parallel_webhook_secret() -> str:
    cfg = settings()
    return get_secret(cfg.parallel_webhook_secret_name, cfg.parallel_webhook_secret)
