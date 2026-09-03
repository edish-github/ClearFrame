"""An unsigned callback must never reach the spine."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

from clearframe_webhook.verify import expected_signature, signing_key, verify

SECRET = "whsec_" + base64.b64encode(b"clearframe-test-signing-key-32b!!").decode()


def sign(body: bytes, webhook_id: str, timestamp: str) -> str:
    signed = f"{webhook_id}.{timestamp}.".encode() + body
    digest = hmac.new(signing_key(SECRET), signed, hashlib.sha256).digest()
    return "v1," + base64.b64encode(digest).decode()


def test_valid_signature_passes():
    body = json.dumps({"monitor_id": "mon_1"}).encode()
    ts = str(int(time.time()))
    assert verify(
        SECRET, body, webhook_id="msg_1", timestamp=ts, signature_header=sign(body, "msg_1", ts)
    )


def test_tampered_body_fails():
    ts = str(int(time.time()))
    header = sign(b'{"monitor_id":"mon_1"}', "msg_1", ts)
    assert not verify(
        SECRET,
        b'{"monitor_id":"mon_EVIL"}',
        webhook_id="msg_1",
        timestamp=ts,
        signature_header=header,
    )


def test_replayed_old_timestamp_fails():
    body = b'{"monitor_id":"mon_1"}'
    old = str(int(time.time()) - 3600)
    assert not verify(
        SECRET, body, webhook_id="msg_1", timestamp=old, signature_header=sign(body, "msg_1", old)
    )


def test_multiple_signatures_any_match_passes():
    body = b'{"monitor_id":"mon_1"}'
    ts = str(int(time.time()))
    good = expected_signature(SECRET, "msg_1", ts, body)
    header = f"v1,ZmFrZXNpZ25hdHVyZQ== v1,{good}"
    assert verify(SECRET, body, webhook_id="msg_1", timestamp=ts, signature_header=header)


def test_missing_headers_fail():
    assert not verify(SECRET, b"{}", webhook_id=None, timestamp=None, signature_header=None)
