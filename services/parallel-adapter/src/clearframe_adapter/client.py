"""HTTP seam for Parallel. Holds the key, retries, and nothing else.

Zero reasoning lives in this service — that is the whole point of the seam. If
Parallel's surface shifts before September, it shifts here and nowhere else.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
from clearframe_runtime import get_logger, log_event, parallel_api_key, settings

log = get_logger("clearframe.adapter.client")

#: Endpoints, all relative to `settings().parallel_base`.
TASK_RUNS = "/v1/tasks/runs"
TASK_RESULT = "/v1/tasks/runs/{run_id}/result"
TASK_RUN = "/v1/tasks/runs/{run_id}"
SEARCH = "/v1/search"
EXTRACT = "/v1/extract"
FINDALL_RUNS = "/v1beta/findall/runs"
FINDALL_RESULT = "/v1beta/findall/runs/{findall_id}/result"
MONITORS = "/v1/monitors"
MONITOR = "/v1/monitors/{monitor_id}"
MONITOR_EVENTS = "/v1/monitors/{monitor_id}/events"

RETRY_STATUS = {408, 429, 500, 502, 503, 504}


class ParallelError(RuntimeError):
    """A Parallel call failed after retries. Callers degrade visibly, never silently."""

    def __init__(self, message: str, *, status: int | None = None, body: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class ParallelClient:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 900.0,
        max_attempts: int = 4,
    ) -> None:
        cfg = settings()
        self._api_key = api_key or parallel_api_key()
        self._base = (base_url or cfg.parallel_base).rstrip("/")
        self._transport = transport
        self._timeout = timeout
        self._max_attempts = max_attempts

    def _headers(self, beta: str | None = None) -> dict[str, str]:
        headers = {"x-api-key": self._api_key, "Content-Type": "application/json"}
        if beta:
            headers["parallel-beta"] = beta
        return headers

    async def request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        beta: str | None = None,
        timeout: float | None = None,
    ) -> dict:
        url = f"{self._base}{path}"
        last: Exception | None = None
        for attempt in range(self._max_attempts):
            try:
                async with httpx.AsyncClient(
                    timeout=timeout or self._timeout, transport=self._transport
                ) as client:
                    response = await client.request(
                        method,
                        url,
                        json=json_body,
                        params=params,
                        headers=self._headers(beta),
                    )
                if response.status_code in RETRY_STATUS:
                    raise ParallelError(
                        f"{method} {path} -> {response.status_code}",
                        status=response.status_code,
                        body=response.text[:500],
                    )
                if response.status_code >= 400:
                    raise ParallelError(
                        f"{method} {path} -> {response.status_code}: {response.text[:500]}",
                        status=response.status_code,
                        body=response.text[:500],
                    )
                return response.json() if response.content else {}
            except (httpx.TransportError, ParallelError) as exc:
                last = exc
                status = getattr(exc, "status", None)
                if status is not None and status not in RETRY_STATUS:
                    raise
                backoff = min(2**attempt * 0.75, 20.0)
                log_event(
                    log,
                    "parallel retry",
                    path=path,
                    attempt=attempt + 1,
                    error=repr(exc),
                    backoff_s=backoff,
                )
                if attempt + 1 < self._max_attempts:
                    await asyncio.sleep(backoff)
        raise ParallelError(f"{method} {path} failed after {self._max_attempts} attempts: {last}")

    async def post(self, path: str, body: dict, **kw: Any) -> dict:
        return await self.request("POST", path, json_body=body, **kw)

    async def get(self, path: str, **kw: Any) -> dict:
        return await self.request("GET", path, **kw)


_CLIENT: ParallelClient | None = None


def get_client() -> ParallelClient:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = ParallelClient()
    return _CLIENT


def set_client(client: ParallelClient | None) -> None:
    global _CLIENT
    _CLIENT = client
