"""A transport-level double for the Parallel API.

This stands in for the *network*, not for research. It replies with the exact
payload shapes the documented endpoints return, so the adapter, the normalizer,
and the citation-required policy are exercised against real structure in CI where
no API key exists. Every real run — local, staged, or demo — talks to
api.parallel.ai through the same client.
"""

from __future__ import annotations

import json
from typing import Any

import httpx


class ParallelStub:
    """Records requests and answers them in the documented shapes."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict]] = []
        self.task_payloads: list[dict] = []
        self.monitors: dict[str, dict] = {}
        self._run_seq = 0
        #: queue of (content, basis) tuples served to successive task runs
        self.task_results: list[tuple[dict, list[dict]]] = []
        #: results keyed by item, for fan-outs where run order is not deterministic
        self.task_results_by_item: dict[str, list[tuple[dict, list[dict]]]] = {}
        self._item_for_run: dict[str, str] = {}
        self.search_results: list[dict] = [
            {
                "url": "https://www.example-registry.gov/works/12345",
                "title": "Work registration record",
                "publish_date": "2025-02-11",
                "excerpts": ["Registration record for the work."],
            }
        ]

    # ------------------------------------------------------------- transport

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body = json.loads(request.content or b"{}") if request.content else {}
        self.requests.append((request.method, path, body))

        if path == "/v1/tasks/runs" and request.method == "POST":
            return self._create_run(body)
        if path.startswith("/v1/tasks/runs/") and path.endswith("/result"):
            return self._run_result(path.split("/")[-2])
        if path == "/v1/search":
            return httpx.Response(
                200,
                json={
                    "search_id": "search_stub",
                    "results": self.search_results,
                    "session_id": "session_stub",
                },
            )
        if path == "/v1/extract":
            return httpx.Response(
                200,
                json={
                    "extract_id": "extract_stub",
                    "results": [
                        {
                            "url": url,
                            "title": "Extracted page",
                            "publish_date": "2025-02-11",
                            "excerpts": ["Extracted excerpt."],
                            "full_content": "# Page\n\nBody.",
                        }
                        for url in body.get("urls", [])
                    ],
                    "errors": [],
                },
            )
        if path == "/v1beta/findall/runs" and request.method == "POST":
            return httpx.Response(
                200,
                json={
                    "findall_id": "far_stub",
                    "status": {"status": "queued"},
                },
            )
        if path.startswith("/v1beta/findall/runs/") and path.endswith("/result"):
            return httpx.Response(
                200,
                json={
                    "findall_id": "far_stub",
                    "status": {"status": "completed", "is_active": False},
                    "matches": [
                        {
                            "name": "Northwind Publishing Group",
                            "description": "Music publishing and catalog administration",
                            "url": "https://northwind.example.com",
                            "enrichments": {
                                "email": "sync@northwind.example.com",
                                "contact_name": "Licensing desk",
                                "source_url": "https://northwind.example.com/licensing",
                            },
                        }
                    ],
                },
            )
        if path == "/v1/monitors" and request.method == "POST":
            monitor_id = f"mon_{len(self.monitors) + 1:04d}"
            record = {
                "monitor_id": monitor_id,
                "status": "active",
                "frequency": body.get("frequency", "1d"),
                "settings": body.get("settings", {}),
                "webhook": body.get("webhook", {}),
            }
            self.monitors[monitor_id] = record
            return httpx.Response(200, json=record)
        if path.startswith("/v1/monitors/") and path.endswith("/events"):
            return httpx.Response(200, json={"events": [], "next_cursor": None})
        if path.startswith("/v1/monitors/") and request.method == "DELETE":
            monitor_id = path.rsplit("/", 1)[-1]
            self.monitors.pop(monitor_id, None)
            return httpx.Response(200, json={"monitor_id": monitor_id, "status": "cancelled"})

        return httpx.Response(404, json={"error": f"stub has no route for {path}"})

    # ----------------------------------------------------------------- tasks

    def _create_run(self, body: dict) -> httpx.Response:
        self._run_seq += 1
        run_id = f"trun_{self._run_seq:08d}"
        self.task_payloads.append(body)
        item_id = (body.get("metadata") or {}).get("item_id")
        if item_id:
            self._item_for_run[run_id] = item_id
        return httpx.Response(
            202,
            json={
                "run_id": run_id,
                "interaction_id": run_id,
                "status": "queued",
                "is_active": True,
                "processor": body.get("processor", "core"),
                "metadata": body.get("metadata", {}),
                "created_at": "2026-08-26T00:00:00Z",
                "modified_at": "2026-08-26T00:00:00Z",
            },
        )

    def _run_result(self, run_id: str) -> httpx.Response:
        item_id = self._item_for_run.get(run_id)
        queued = self.task_results_by_item.get(item_id or "")
        if queued:
            content, basis = queued.pop(0)
        elif self.task_results:
            content, basis = self.task_results.pop(0)
        else:
            content, basis = {"confidence": 0.5}, []
        return httpx.Response(
            200,
            json={
                "run": {
                    "run_id": run_id,
                    "interaction_id": run_id,
                    "status": "completed",
                    "is_active": False,
                    "processor": "core",
                    "metadata": {},
                    "created_at": "2026-08-26T00:00:00Z",
                    "modified_at": "2026-08-26T00:00:05Z",
                },
                "output": {"type": "json", "content": content, "basis": basis},
            },
        )

    # ------------------------------------------------------------- authoring

    def queue_task_result(self, content: dict, basis: list[dict] | None = None) -> None:
        self.task_results.append((content, basis or []))

    def queue_task_result_for(
        self, item_id: str, content: dict, basis: list[dict] | None = None
    ) -> None:
        """Pin a result to one item.

        A fan-out runs items concurrently, so a FIFO queue hands the wrong answer
        to the wrong item. Keying on the metadata the adapter already sends makes
        the double behave like the real API, which also answers per run.
        """
        self.task_results_by_item.setdefault(item_id, []).append((content, basis or []))

    @staticmethod
    def basis(
        field: str, url: str, *, title: str = "", excerpt: str = "", confidence: str = "high"
    ) -> dict:
        return {
            "field": field,
            "citations": [
                {"url": url, "title": title or url, "excerpts": [excerpt or "supporting excerpt"]}
            ],
            "reasoning": f"{field} established from {url}",
            "confidence": confidence,
        }

    def last_task_body(self) -> dict[str, Any]:
        return self.task_payloads[-1] if self.task_payloads else {}
