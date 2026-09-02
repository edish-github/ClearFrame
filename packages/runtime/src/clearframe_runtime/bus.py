"""The event spine.

Pub/Sub in the cloud; an in-process asyncio fan-out on a laptop. Handlers are
registered by event type, so the orchestrator's routing code is identical in
both modes — which is what makes the local run a real rehearsal rather than a
different program.
"""

from __future__ import annotations

import asyncio
import json
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from typing import Any

from clearframe_contracts import Envelope, EventType

from .config import settings
from .logging import get_logger, log_event

log = get_logger("clearframe.bus")

Handler = Callable[[Envelope], Awaitable[None]]


class EventBus(ABC):
    def __init__(self) -> None:
        self._handlers: dict[EventType, list[Handler]] = {}

    def on(self, event_type: EventType, handler: Handler) -> None:
        self._handlers.setdefault(event_type, []).append(handler)

    def handlers_for(self, event_type: EventType) -> list[Handler]:
        return self._handlers.get(event_type, [])

    @abstractmethod
    async def publish(self, envelope: Envelope) -> None: ...

    async def deliver(self, envelope: Envelope) -> None:
        """Invoke local handlers. Cloud Run push subscriptions call this too."""
        handlers = self.handlers_for(envelope.type)
        if not handlers:
            log_event(log, "no handler", event_type=envelope.type.value)
            return
        for handler in handlers:
            await handler(envelope)


class InProcessBus(EventBus):
    """Ordered per-topic queues with a bounded worker pool and a dead-letter list.

    Mirrors the Pub/Sub contract that matters to the domain: at-least-once
    delivery, retry with backoff, and a dead-letter after N attempts.
    """

    def __init__(self, concurrency: int = 8, max_attempts: int = 5) -> None:
        super().__init__()
        self._queue: asyncio.Queue[tuple[Envelope, int]] = asyncio.Queue()
        self._workers: list[asyncio.Task] = []
        self._concurrency = concurrency
        self._max_attempts = max_attempts
        self.dead_letters: list[tuple[Envelope, str]] = []
        self._inflight = 0
        self._idle = asyncio.Event()
        self._idle.set()

    async def publish(self, envelope: Envelope) -> None:
        self._idle.clear()
        await self._queue.put((envelope, 0))

    def start(self) -> None:
        if self._workers:
            return
        self._workers = [asyncio.create_task(self._worker(i)) for i in range(self._concurrency)]

    async def stop(self) -> None:
        for task in self._workers:
            task.cancel()
        self._workers = []

    async def drain(self, timeout: float = 900.0) -> None:
        """Wait until the queue is empty and nothing is in flight — the kill switch
        drains rather than drops, so a paused pass resumes exactly."""
        if not self._workers:
            # Nothing is consuming, so there is nothing to wait for. Blocking here
            # would turn "pause a pass that never started" into a timeout.
            return
        try:
            await asyncio.wait_for(self._idle.wait(), timeout=timeout)
        except TimeoutError:
            log_event(log, "drain timeout", pending=self._queue.qsize(), inflight=self._inflight)

    async def _worker(self, index: int) -> None:
        while True:
            envelope, attempt = await self._queue.get()
            self._inflight += 1
            try:
                await self.deliver(envelope)
            except Exception as exc:  # noqa: BLE001 — retried, then dead-lettered
                if attempt + 1 >= self._max_attempts:
                    self.dead_letters.append((envelope, repr(exc)))
                    log_event(
                        log,
                        "dead letter",
                        event_type=envelope.type.value,
                        item_id=envelope.item_id,
                        error=repr(exc),
                    )
                else:
                    await asyncio.sleep(min(2**attempt * 0.05, 5.0))
                    await self._queue.put((envelope, attempt + 1))
            finally:
                self._inflight -= 1
                self._queue.task_done()
                if self._queue.empty() and self._inflight == 0:
                    self._idle.set()


class PubSubBus(EventBus):
    """Publishes to Pub/Sub; delivery arrives back as push requests to Cloud Run."""

    def __init__(self) -> None:
        super().__init__()
        from google.cloud import pubsub_v1

        self._publisher = pubsub_v1.PublisherClient()
        self._cfg = settings()

    def _topic_path(self, short: str) -> str:
        return self._publisher.topic_path(self._cfg.project_id, self._cfg.topic(short))

    async def publish(self, envelope: Envelope) -> None:
        data = envelope.model_dump_json().encode()
        future = self._publisher.publish(
            self._topic_path(envelope.topic()),
            data,
            event_type=envelope.type.value,
            project_id=envelope.project_id,
        )
        await asyncio.get_running_loop().run_in_executor(None, future.result)


def decode_push(body: dict[str, Any]) -> Envelope:
    """Turn a Pub/Sub push envelope into a ClearFrame Envelope."""
    import base64

    message = body.get("message", body)
    raw = message.get("data")
    if raw is None:
        raise ValueError("push body carried no data")
    payload = base64.b64decode(raw).decode()
    return Envelope(**json.loads(payload))


_BUS: EventBus | None = None


def get_bus() -> EventBus:
    """The spine this process talks to.

    * `gcp`   — Pub/Sub, with delivery arriving back as push requests.
    * `local` — a file-backed spine that crosses process boundaries, so running
      the five services on a laptop behaves like the deployment. Set
      `CLEARFRAME_BUS=inproc` for a single-process run (tests, the pass runner),
      where an in-memory queue is simpler and faster.
    """
    global _BUS
    if _BUS is not None:
        return _BUS

    cfg = settings()
    if not cfg.is_local:
        _BUS = PubSubBus()
    elif cfg.bus == "inproc":
        _BUS = InProcessBus()
    else:
        from .filebus import FileBus

        _BUS = FileBus(subscriber=cfg.service_name)
    return _BUS


def set_bus(bus: EventBus | None) -> None:
    global _BUS
    _BUS = bus
