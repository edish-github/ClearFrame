"""Two small defences in front of the one public endpoint.

Signature verification already makes a forged callback useless. These handle the
other two failure modes a public endpoint actually meets: the same real event
delivered twice, and a flood.
"""

from __future__ import annotations

import time
from collections import OrderedDict, deque

#: Standard Webhooks retries on non-2xx, so duplicates are expected, not hostile.
SEEN_LIMIT = 4096
SEEN_TTL_S = 24 * 3600

#: A monitor firing hourly across a few hundred watches is nowhere near this.
RATE_LIMIT = 120
RATE_WINDOW_S = 60.0


class ReplayCache:
    """Remembers webhook ids so a redelivery is acknowledged, not reprocessed."""

    def __init__(self, limit: int = SEEN_LIMIT, ttl_s: float = SEEN_TTL_S) -> None:
        self._seen: OrderedDict[str, float] = OrderedDict()
        self._limit = limit
        self._ttl = ttl_s

    def seen(self, webhook_id: str, *, now: float | None = None) -> bool:
        now = now if now is not None else time.time()
        self._evict(now)
        if webhook_id in self._seen:
            return True
        self._seen[webhook_id] = now
        if len(self._seen) > self._limit:
            self._seen.popitem(last=False)
        return False

    def _evict(self, now: float) -> None:
        while self._seen:
            key, stamp = next(iter(self._seen.items()))
            if now - stamp <= self._ttl:
                break
            self._seen.popitem(last=False)

    def __len__(self) -> int:
        return len(self._seen)


class RateLimiter:
    """A fixed-window counter. Deliberately simple: this endpoint is one route."""

    def __init__(self, limit: int = RATE_LIMIT, window_s: float = RATE_WINDOW_S) -> None:
        self._hits: deque[float] = deque()
        self._limit = limit
        self._window = window_s

    def allow(self, *, now: float | None = None) -> bool:
        now = now if now is not None else time.time()
        while self._hits and now - self._hits[0] > self._window:
            self._hits.popleft()
        if len(self._hits) >= self._limit:
            return False
        self._hits.append(now)
        return True

    @property
    def in_window(self) -> int:
        return len(self._hits)
