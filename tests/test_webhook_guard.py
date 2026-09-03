"""The public endpoint's two non-cryptographic defences."""

from __future__ import annotations

from clearframe_webhook.guard import RateLimiter, ReplayCache


def test_replay_cache_acknowledges_a_redelivery_once():
    cache = ReplayCache()
    assert cache.seen("msg_1") is False
    assert cache.seen("msg_1") is True
    assert cache.seen("msg_2") is False


def test_replay_cache_expires_and_stays_bounded():
    cache = ReplayCache(limit=3, ttl_s=10)
    for i in range(5):
        cache.seen(f"msg_{i}", now=1000.0)
    assert len(cache) == 3, "the cache must not grow without bound"

    cache.seen("msg_old", now=1000.0)
    assert cache.seen("msg_old", now=1000.0 + 11) is False, "expired ids are forgotten"


def test_rate_limiter_sheds_a_flood_then_recovers():
    limiter = RateLimiter(limit=3, window_s=60)
    assert all(limiter.allow(now=100.0) for _ in range(3))
    assert limiter.allow(now=100.0) is False

    assert limiter.allow(now=200.0) is True, "the window rolls forward"
