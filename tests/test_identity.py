"""Identity is proved or refused. There is no third option."""

from __future__ import annotations

import pytest
from clearframe_ledger.auth import resolve_subject
from clearframe_runtime import reset_settings_cache
from clearframe_runtime.identity import IdentityError, bearer, service_account_email


def test_bearer_parsing():
    assert bearer("Bearer abc.def.ghi") == "abc.def.ghi"
    assert bearer("bearer abc") == "abc"
    assert bearer("Basic abc") is None
    assert bearer(None) is None
    assert bearer("Bearer ") is None


def test_unverified_email_is_not_an_identity():
    assert service_account_email({"email": "a@b.c"}) == "a@b.c"
    assert service_account_email({"email": "a@b.c", "email_verified": False}) is None


def test_a_request_with_no_proof_is_refused(workspace):
    with pytest.raises(IdentityError, match="no verified identity"):
        resolve_subject(iap_assertion=None, authorization=None, proxied_subject=None)


def test_the_dev_header_works_locally(workspace):
    subject, how = resolve_subject(
        iap_assertion=None, authorization=None, proxied_subject="counsel@example.test"
    )
    assert subject == "counsel@example.test"
    assert how == "local-dev-header"


def test_the_dev_header_is_refused_outside_local_mode(workspace, monkeypatch):
    monkeypatch.setenv("CLEARFRAME_BACKEND", "gcp")
    reset_settings_cache()
    with pytest.raises(IdentityError):
        resolve_subject(
            iap_assertion=None, authorization=None, proxied_subject="counsel@example.test"
        )


def test_a_proxied_identity_needs_the_proxys_own_token(workspace, monkeypatch):
    monkeypatch.setenv("CLEARFRAME_BACKEND", "gcp")
    monkeypatch.setenv("TRUSTED_PROXY_SA", "sa-web@example.iam.gserviceaccount.com")
    reset_settings_cache()

    # A subject header with no proof of who sent it proves nothing.
    with pytest.raises(IdentityError, match="proxy's own OIDC token"):
        resolve_subject(
            iap_assertion=None, authorization=None, proxied_subject="counsel@example.test"
        )
