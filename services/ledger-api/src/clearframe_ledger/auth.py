"""Who is calling, resolved server-side.

The web app never tells the API what role it has. Identity is proved
cryptographically or the request is refused; the role comes from a
project-scoped binding in the state plane, which the caller cannot influence.
"""

from __future__ import annotations

from clearframe_contracts import Principal, Role
from clearframe_runtime import get_logger, get_store, log_event, settings
from clearframe_runtime.identity import (
    IdentityError,
    bearer,
    service_account_email,
    verify_google_oidc,
    verify_iap_assertion,
)
from fastapi import Header, HTTPException

log = get_logger("clearframe.ledger.auth")

BINDINGS = "role_bindings"  # doc id: f"{project_id}:{subject}" -> {"role": ...}


async def bind_role(project_id: str, subject: str, role: Role) -> None:
    await get_store().put(
        BINDINGS,
        f"{project_id}:{subject}",
        {"project_id": project_id, "subject": subject, "role": role.value},
    )


async def role_for(project_id: str, subject: str) -> Role | None:
    doc = await get_store().get(BINDINGS, f"{project_id}:{subject}")
    return Role(doc["role"]) if doc else None


async def list_bindings(project_id: str) -> list[dict]:
    return await get_store().query(BINDINGS, project_id=project_id)


def resolve_subject(
    *,
    iap_assertion: str | None,
    authorization: str | None,
    proxied_subject: str | None,
) -> tuple[str, str]:
    """Return (subject, how_it_was_proved), or raise IdentityError.

    Order matters: a human's own IAP assertion always wins over a proxy's claim
    about who they are.
    """
    cfg = settings()

    if iap_assertion:
        claims = verify_iap_assertion(iap_assertion, cfg.iap_audience or None)
        subject = claims.get("email") or claims.get("sub")
        if not subject:
            raise IdentityError("IAP assertion carried no identity")
        return subject, "iap"

    if proxied_subject and cfg.trusted_proxy_sa:
        token = bearer(authorization)
        if not token:
            raise IdentityError("a proxied identity needs the proxy's own OIDC token")
        caller = service_account_email(verify_google_oidc(token))
        if caller != cfg.trusted_proxy_sa:
            raise IdentityError(f"{caller} is not the trusted proxy")
        return proxied_subject, "trusted-proxy"

    if proxied_subject and cfg.is_local:
        # Local development only. Never reachable in `gcp` mode.
        return proxied_subject, "local-dev-header"

    raise IdentityError("no verified identity on the request")


async def current_principal(
    project_id: str,
    x_goog_iap_jwt_assertion: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
    x_clearframe_subject: str | None = Header(default=None),
) -> Principal:
    try:
        subject, how = resolve_subject(
            iap_assertion=x_goog_iap_jwt_assertion,
            authorization=authorization,
            proxied_subject=x_clearframe_subject,
        )
    except IdentityError as exc:
        log_event(log, "identity refused", project_id=project_id, error=str(exc))
        raise HTTPException(401, str(exc)) from exc

    role = await role_for(project_id, subject)
    if role is None:
        raise HTTPException(403, f"{subject} has no role on project {project_id}")

    log_event(
        log,
        "principal resolved",
        project_id=project_id,
        subject=subject,
        role=role.value,
        proved_by=how,
    )
    return Principal(subject=subject, role=role, project_ids=[project_id])
