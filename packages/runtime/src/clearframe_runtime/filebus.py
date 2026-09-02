"""A cross-process event spine for local runs.

The in-process bus is right for a single process — tests, the local pass runner.
But a laptop deployment runs the same five services the cloud does, in five
processes, and an event published by the ledger has to reach the orchestrator.
Without that, a counsel approval lands in the ledger and the item never resolves,
which is exactly the bug this file exists to prevent.

The semantics deliberately mirror Pub/Sub, because the point of local mode is that
it rehearses the deployed system rather than resembling it:

* subscriptions are durable — a subscriber that is not running when an event is
  published still receives it when it starts;
* delivery is at-least-once, with retry and exponential backoff;
* a message that fails five times goes to a dead-letter directory rather than
  spinning forever.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

from clearframe_contracts import Envelope

from .bus import EventBus
from .config import settings
from .logging import get_logger, log_event

log = get_logger("clearframe.filebus")

MAX_ATTEMPTS = 5
POLL_INTERVAL_S = 0.25


class FileBus(EventBus):
    def __init__(
        self,
        subscriber: str,
        root: Path | None = None,
        poll_interval_s: float = POLL_INTERVAL_S,
    ) -> None:
        super().__init__()
        self.subscriber = subscriber
        self.root = Path(root or settings().local_root) / "bus"
        self._poll = poll_interval_s
        self._task: asyncio.Task | None = None
        self._busy = False
        (self.root / "subs").mkdir(parents=True, exist_ok=True)
        (self.root / "dead").mkdir(parents=True, exist_ok=True)
        self.inbox.mkdir(parents=True, exist_ok=True)

    @property
    def inbox(self) -> Path:
        return self.root / "queue" / self.subscriber

    def _announce(self) -> None:
        """Register this subscriber's interest, so publishers can fan out to it."""
        topics = sorted({event_type.value for event_type in self._handlers})
        path = self.root / "subs" / f"{self.subscriber}.json"
        path.write_text(json.dumps({"subscriber": self.subscriber, "topics": topics}))

    def _subscribers_for(self, event_type: str) -> list[str]:
        out = []
        for path in (self.root / "subs").glob("*.json"):
            try:
                record = json.loads(path.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            if event_type in record.get("topics", []):
                out.append(record["subscriber"])
        return out

    async def publish(self, envelope: Envelope) -> None:
        payload = envelope.model_dump_json()
        targets = self._subscribers_for(envelope.type.value)

        for target in targets:
            queue = self.root / "queue" / target
            queue.mkdir(parents=True, exist_ok=True)
            name = f"{time.time():.6f}-{envelope.event_id}-0.json"
            tmp = queue / f".{name}"
            tmp.write_text(payload)
            tmp.rename(queue / name)

        if not targets:
            log_event(log, "no subscriber", event_type=envelope.type.value)

    # ------------------------------------------------------------- consuming

    def start(self) -> None:
        self._announce()
        if self._task is None:
            self._task = asyncio.create_task(self._consume())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None

    async def drain(self, timeout: float = 900.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not any(self.inbox.glob("*.json")) and not self._busy:
                await asyncio.sleep(self._poll * 2)
                if not any(self.inbox.glob("*.json")) and not self._busy:
                    return
            await asyncio.sleep(self._poll)
        log_event(log, "drain timeout", subscriber=self.subscriber)

    async def _consume(self) -> None:
        while True:
            try:
                messages = sorted(self.inbox.glob("*.json"))
                if not messages:
                    await asyncio.sleep(self._poll)
                    continue
                for path in messages:
                    await self._handle_file(path)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — the loop must outlive one bad file
                log_event(log, "consumer error", error=repr(exc))
                await asyncio.sleep(self._poll)

    async def _handle_file(self, path: Path) -> None:
        # Claiming by rename is atomic on a local filesystem, so two processes
        # sharing an inbox cannot both take the same message.
        claimed = path.with_suffix(f".{os.getpid()}.claimed")
        try:
            path.rename(claimed)
        except OSError:
            return

        self._busy = True
        try:
            envelope = Envelope(**json.loads(claimed.read_text()))
        except Exception as exc:  # noqa: BLE001 — an unparseable message is dead on arrival
            log_event(log, "undecodable message", error=repr(exc), file=str(claimed))
            claimed.rename(self.root / "dead" / claimed.name)
            self._busy = False
            return

        attempt = _attempt_of(path.name)
        try:
            await self.deliver(envelope)
            claimed.unlink(missing_ok=True)
        except Exception as exc:  # noqa: BLE001 — retried, then dead-lettered
            if attempt + 1 >= MAX_ATTEMPTS:
                log_event(
                    log,
                    "dead letter",
                    event_type=envelope.type.value,
                    item_id=envelope.item_id,
                    error=repr(exc),
                )
                claimed.rename(self.root / "dead" / claimed.name)
            else:
                await asyncio.sleep(min(2**attempt * 0.1, 5.0))
                retry = self.inbox / _with_attempt(path.name, attempt + 1)
                claimed.rename(retry)
        finally:
            self._busy = False

    @property
    def dead_letters(self) -> list[Path]:
        return sorted((self.root / "dead").glob("*"))


def _attempt_of(name: str) -> int:
    try:
        return int(name.rsplit("-", 1)[1].split(".")[0])
    except (IndexError, ValueError):
        return 0


def _with_attempt(name: str, attempt: int) -> str:
    head, _, _ = name.rpartition("-")
    return f"{head}-{attempt}.json"
