"""Standard Webhooks signature verification.

Parallel signs with the Standard Webhooks scheme: the secret carries a `whsec_`
prefix over base64 key material, and the signed content is
`{webhook-id}.{webhook-timestamp}.{body}`. The header can carry several
space-delimited `v1,<sig>` entries; any one matching is a pass.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time

TOLERANCE_S = 5 * 60


class SignatureError(ValueError):
    pass


def signing_key(secret: str) -> bytes:
    raw = secret.strip()
    if raw.startswith("whsec_"):
        raw = raw[len("whsec_") :]
    try:
        return base64.b64decode(raw + "=" * (-len(raw) % 4))
    except Exception as exc:  # noqa: BLE001
        raise SignatureError("webhook secret is not valid base64") from exc


def expected_signature(secret: str, webhook_id: str, timestamp: str, body: bytes) -> str:
    signed = f"{webhook_id}.{timestamp}.".encode() + body
    digest = hmac.new(signing_key(secret), signed, hashlib.sha256).digest()
    return base64.b64encode(digest).decode()


def verify(
    secret: str,
    body: bytes,
    *,
    webhook_id: str | None,
    timestamp: str | None,
    signature_header: str | None,
    tolerance_s: int = TOLERANCE_S,
) -> bool:
    """Constant-time comparison against every offered signature."""
    if not (webhook_id and timestamp and signature_header):
        return False

    try:
        age = abs(time.time() - int(timestamp))
    except (TypeError, ValueError):
        return False
    if age > tolerance_s:
        # A replayed callback is not a fresh event.
        return False

    expected = expected_signature(secret, webhook_id, timestamp, body)
    for entry in signature_header.split():
        _, _, candidate = entry.partition(",")
        if candidate and hmac.compare_digest(candidate, expected):
            return True
    return False
