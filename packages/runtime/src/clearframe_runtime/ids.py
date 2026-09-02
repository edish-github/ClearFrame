"""Identifier helpers — prefixed so a stray id in a log is self-describing."""

from __future__ import annotations

import uuid


def _new(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def project_id() -> str:
    return _new("prj")


def cut_id() -> str:
    return _new("cut")


def pass_id() -> str:
    return _new("pass")


def item_id() -> str:
    return _new("itm")


def finding_id() -> str:
    return _new("fnd")


def citation_id() -> str:
    return _new("cit")


def challenge_id() -> str:
    return _new("chl")


def assessment_id() -> str:
    return _new("rsk")


def mitigation_id() -> str:
    return _new("mit")


def decision_id() -> str:
    return _new("dec")


def holder_id() -> str:
    return _new("hld")


def outreach_id() -> str:
    return _new("out")


def event_id() -> str:
    return _new("evt")


def report_id() -> str:
    return _new("rpt")
