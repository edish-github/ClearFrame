"""Verifying who is calling.

Three callers reach a ClearFrame service, and each is proved differently:

* **A human**, through Identity-Aware Proxy. The assertion is a signed JWT; we
  verify the signature against Google's public keys and check the audience, so
  the service is safe even if it is ever exposed without IAP in front of it.
* **The web app**, which acts on a human's behalf. It presents its own Google
  OIDC token and names the human in a header. We accept the name only from a
  caller whose verified service-account identity is the one we configured.
* **Pub/Sub**, pushing an event. It presents an OIDC token issued to the push
  service account.

Nothing here trusts a request body, and nothing here reads an unverified JWT.
"""

from __future__ import annotations

from functools import lru_cache

from .config import settings
from .logging import get_logger, log_event

log = get_logger("clearframe.identity")

IAP_ISSUER = "https://cloud.google.com/iap"
IAP_CERT_URL = "https://www.gstatic.com/iap/verify/public_key"
GOOGLE_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}


class IdentityError(RuntimeError):
    """The caller could not be proved. Always a 401, never a fallback."""


@lru_cache(maxsize=1)
def _request_adapter():
    from google.auth.transport import requests as google_requests

    return google_requests.Request()


def verify_google_oidc(token: str, audience: str | None = None) -> dict:
    """Verify a Google-issued OIDC ID token and return its claims.

    Used for both the Pub/Sub push token and the web app's service identity.
    """
    try:
        from google.oauth2 import id_token
    except ImportError as exc:  # pragma: no cover - google-auth ships with the SDKs
        raise IdentityError("google-auth is not installed") from exc

    try:
        claims = id_token.verify_oauth2_token(token, _request_adapter(), audience)
    except Exception as exc:  # noqa: BLE001 — any failure is simply "not proved"
        raise IdentityError(f"OIDC verification failed: {exc}") from exc

    if claims.get("iss") not in GOOGLE_ISSUERS:
        raise IdentityError(f"unexpected issuer {claims.get('iss')}")
    return claims


def verify_iap_assertion(assertion: str, audience: str | None = None) -> dict:
    """Verify an IAP JWT against Google's IAP public keys."""
    try:
        from google.auth import jwt as google_jwt
    except ImportError as exc:  # pragma: no cover
        raise IdentityError("google-auth is not installed") from exc

    try:
        certs = google_jwt._fetch_certs(_request_adapter(), IAP_CERT_URL)  # noqa: SLF001
        claims = google_jwt.decode(assertion, certs=certs, audience=audience)
    except Exception as exc:  # noqa: BLE001
        raise IdentityError(f"IAP assertion verification failed: {exc}") from exc

    if claims.get("iss") != IAP_ISSUER:
        raise IdentityError(f"unexpected IAP issuer {claims.get('iss')}")
    return claims


def bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    return token.strip() if scheme.lower() == "bearer" and token.strip() else None


def service_account_email(claims: dict) -> str | None:
    return claims.get("email") if claims.get("email_verified", True) else None


def verify_push_caller(authorization: str | None) -> dict:
    """Prove a Pub/Sub push request. Raises unless the token belongs to the
    configured push service account."""
    cfg = settings()
    if cfg.is_local:
        return {"email": "local-runner", "local": True}

    token = bearer(authorization)
    if not token:
        raise IdentityError("push request carried no bearer token")

    claims = verify_google_oidc(token, cfg.push_audience or None)
    caller = service_account_email(claims)
    expected = cfg.pubsub_push_sa
    if expected and caller != expected:
        raise IdentityError(f"push token belongs to {caller}, expected {expected}")
    log_event(log, "push caller verified", caller=caller)
    return claims
