"""The crews' toolbelt.

Every tool is declared once here and registered in Agent Builder from
`agents/tools/*.json`. Two properties are structural rather than instructed:

* A claim can only enter the ledger through `submit_finding`, and the only
  claims that exist are the ones Parallel returned from a structured run. The
  model chooses what to investigate and how to phrase the objective; it cannot
  author the facts.
* Every research call is metered and budget-guarded before it is made.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from clearframe_contracts import (
    Challenge,
    ChallengeGround,
    Citation,
    Finding,
    Mitigation,
    MitigationKind,
    OutreachDraft,
    OutreachStatus,
    RiskAssessment,
    RiskState,
    utcnow,
)
from clearframe_contracts.schema_registry import load_schema
from clearframe_runtime import get_logger, get_store, log_event
from clearframe_runtime.ids import (
    assessment_id,
    challenge_id,
    mitigation_id,
    outreach_id,
)

log = get_logger("clearframe.toolbelt")


@dataclass
class RunContext:
    """Everything a tool call needs to know about where it is happening."""

    project_id: str
    pass_id: str
    agent: str
    item_id: str | None = None
    tier: int = 1
    prev_interaction_id: str | None = None
    objection: str | None = None
    drafts: dict[str, Finding] = field(default_factory=dict)
    findings: list[Finding] = field(default_factory=list)
    challenges: list[Challenge] = field(default_factory=list)
    assessments: list[RiskAssessment] = field(default_factory=list)
    outreach: list[OutreachDraft] = field(default_factory=list)
    verdicts: list[dict] = field(default_factory=list)
    extracted: list[dict] = field(default_factory=list)
    spend_usd: float = 0.0
    notes: list[str] = field(default_factory=list)


ToolImpl = Callable[..., Awaitable[dict]]


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    impl: ToolImpl

    def declaration(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }


REGISTRY: dict[str, Tool] = {}


def tool(name: str, description: str, parameters: dict):
    def decorate(fn: ToolImpl) -> ToolImpl:
        REGISTRY[name] = Tool(name=name, description=description, parameters=parameters, impl=fn)
        return fn

    return decorate


def declarations_for(names: list[str]) -> list[dict]:
    missing = [n for n in names if n not in REGISTRY]
    if missing:
        raise KeyError(f"playbook requests unknown tools: {missing}")
    return [REGISTRY[n].declaration() for n in names]


def _string(desc: str) -> dict:
    return {"type": "string", "description": desc}


def _array(desc: str, item_type: str = "string") -> dict:
    return {"type": "array", "description": desc, "items": {"type": item_type}}


# --------------------------------------------------------------------- research


@tool(
    "parallel_search",
    "T0 recon. Run keyword web searches and get back cited excerpts. Cheap and wide "
    "— use it first, and use it to check someone else's answer independently.",
    {
        "type": "object",
        "properties": {
            "objective": _string("What you are trying to establish, in one sentence"),
            "search_queries": _array("3-6 word keyword queries, up to 8"),
            "max_results": {"type": "integer", "description": "Default 8"},
        },
        "required": ["objective", "search_queries"],
    },
)
async def parallel_search(
    ctx: RunContext, objective: str, search_queries: list[str], max_results: int = 8
) -> dict:
    from clearframe_adapter import pricing
    from clearframe_adapter import search as search_api
    from clearframe_ledger import records

    from .budget import guard

    await guard(ctx.project_id, cost_usd=pricing.SEARCH_COST_USD, tier=0)
    payload = await search_api.search(objective, search_queries, max_results=max_results)
    ctx.spend_usd += pricing.SEARCH_COST_USD
    await records.record_cost(
        ctx.project_id, ctx.pass_id, ctx.item_id, 0, pricing.SEARCH_COST_USD, "search"
    )
    results = payload.get("results", [])
    return {
        "search_id": payload.get("search_id"),
        "results": [
            {
                "url": r.get("url"),
                "title": r.get("title"),
                "publish_date": r.get("publish_date"),
                "excerpts": (r.get("excerpts") or [])[:3],
            }
            for r in results
        ],
    }


@tool(
    "parallel_extract",
    "Fetch the full text of specific pages you have already found, as clean markdown. "
    "Use it on the two most authoritative results, not on everything.",
    {
        "type": "object",
        "properties": {
            "urls": _array("Up to 20 URLs"),
            "objective": _string("What you are looking for in these pages"),
        },
        "required": ["urls"],
    },
)
async def parallel_extract(ctx: RunContext, urls: list[str], objective: str | None = None) -> dict:
    from clearframe_adapter import pricing
    from clearframe_adapter import search as search_api
    from clearframe_ledger import records

    from .budget import guard

    cost = pricing.EXTRACT_COST_USD * max(1, len(urls))
    await guard(ctx.project_id, cost_usd=cost, tier=0)
    payload = await search_api.extract(urls, objective=objective)
    ctx.spend_usd += cost
    await records.record_cost(ctx.project_id, ctx.pass_id, ctx.item_id, 0, cost, "extract")
    return {
        "results": [
            {
                "url": r.get("url"),
                "title": r.get("title"),
                "publish_date": r.get("publish_date"),
                "excerpts": (r.get("excerpts") or [])[:5],
            }
            for r in payload.get("results", [])
        ],
        "errors": payload.get("errors", []),
    }


@tool(
    "parallel_task",
    "Run one structured research task against your specialist's output schema. This is "
    "where facts come from: the result is schema-shaped, citation-backed, and is the "
    "only thing that can become a finding. Name the entity and the specific fact sought "
    "in the objective — a vague objective returns uncited prose.",
    {
        "type": "object",
        "properties": {
            "objective": _string(
                "The research task. Name the work, the entities found in recon, and the "
                "exact question — e.g. 'Establish the current controller of the "
                "composition and the owner of the master for X as used in Y'"
            ),
            "schema_name": _string("music_rights | trademark | likeness | footage"),
        },
        "required": ["objective", "schema_name"],
    },
)
async def parallel_task(ctx: RunContext, objective: str, schema_name: str) -> dict:
    """The tier — and therefore the processor and the price — is the 1st AD's call,
    carried on the context. An agent cannot escalate its own spending."""
    from clearframe_adapter import deep_research, normalize, pricing, snapshots
    from clearframe_adapter.task import run_task
    from clearframe_ledger import records

    from .budget import guard

    tier = max(1, ctx.tier)
    cost = pricing.cost_for_tier(tier)
    await guard(ctx.project_id, cost_usd=cost, tier=tier)

    schema = load_schema(schema_name)
    objective_text = objective
    if ctx.objection:
        objective_text = (
            f"{objective}\n\nA reviewer challenged the previous answer on these grounds: "
            f"{ctx.objection}\nAddress that objection specifically, with sources that "
            "post-date or outrank the ones previously relied on."
        )

    if tier >= 3:
        raw = await deep_research.run_dossier(
            objective_text,
            schema,
            prev_interaction_id=ctx.prev_interaction_id,
            metadata={"item_id": ctx.item_id or "", "pass_id": ctx.pass_id},
        )
    else:
        raw = await run_task(
            objective_text,
            schema,
            processor=pricing.processor_for_tier(tier),
            prev_interaction_id=ctx.prev_interaction_id,
            metadata={"item_id": ctx.item_id or "", "pass_id": ctx.pass_id},
        )

    ctx.spend_usd += cost
    await records.record_cost(
        ctx.project_id, ctx.pass_id, ctx.item_id, tier, cost, f"task:{pricing.TIER_PROCESSOR[tier]}"
    )

    finding = normalize.to_finding(
        raw,
        item_id=ctx.item_id or "",
        project_id=ctx.project_id,
        pass_id=ctx.pass_id,
        agent=ctx.agent,
        tier=tier,
        cost_usd=cost,
        prev_interaction_id=ctx.prev_interaction_id,
    )
    if finding.citations:
        finding = finding.model_copy(
            update={
                "citations": await snapshots.snapshot_citations(finding.citations, ctx.project_id)
            }
        )
    ctx.drafts[finding.finding_id] = finding

    return {
        "draft_finding_id": finding.finding_id,
        "content": finding.claim,
        "confidence": finding.confidence,
        "citation_count": len(finding.citations),
        "citations": [
            {
                "url": c.url,
                "title": c.title,
                "authority": c.authority.value,
                "published_date": c.published_date,
            }
            for c in finding.citations[:12]
        ],
        "interaction_id": finding.interaction_id,
        "admissible": finding.is_admissible(),
        "inadmissible_reason": finding.inadmissible_reason(),
    }


@tool(
    "submit_finding",
    "Commit a draft produced by parallel_task to the ledger. A draft with no citations "
    "cannot be committed. Say in `note` what the draft establishes and what it does not.",
    {
        "type": "object",
        "properties": {
            "draft_finding_id": _string("The id returned by parallel_task"),
            "note": _string("What this finding establishes, and what remains open"),
        },
        "required": ["draft_finding_id"],
    },
)
async def submit_finding(ctx: RunContext, draft_finding_id: str, note: str = "") -> dict:
    from clearframe_ledger import records

    finding = ctx.drafts.get(draft_finding_id)
    if finding is None:
        return {"ok": False, "error": f"unknown draft {draft_finding_id}"}
    reason = finding.inadmissible_reason()
    if reason:
        return {"ok": False, "error": f"inadmissible: {reason}"}

    if note:
        finding = finding.model_copy(update={"claim": {**finding.claim, "_note": note}})
    stored = await records.record_finding(finding)
    ctx.findings.append(stored)
    log_event(
        log,
        "finding submitted",
        item_id=stored.item_id,
        agent=ctx.agent,
        confidence=stored.confidence,
    )
    return {"ok": True, "finding_id": stored.finding_id}


@tool(
    "get_item_context",
    "Read the item under investigation and everything already established about it, "
    "including prior findings and any challenges filed against them.",
    {
        "type": "object",
        "properties": {"item_id": _string("Defaults to the item you were dispatched to")},
    },
)
async def get_item_context(ctx: RunContext, item_id: str | None = None) -> dict:
    store = get_store()
    target = item_id or ctx.item_id
    if not target:
        return {"error": "no item in scope"}
    item = await store.get_item(target)
    if item is None:
        return {"error": f"item {target} not found"}
    findings = await store.list_findings(item_id=target, live_only=True)
    challenges = await store.list_challenges(item_id=target)
    return {
        "item": {
            "item_id": item.item_id,
            "type": item.type.value,
            "title": item.title,
            "description": item.description,
            "prominence": item.prominence.value,
            "scene": item.timecode.scene,
            "timecode_in": item.timecode.tc_in,
            "status": item.status.value,
            "attrs": item.attrs,
        },
        "prior_findings": [
            {
                "finding_id": f.finding_id,
                "agent": f.agent,
                "claim": f.claim,
                "confidence": f.confidence,
                "citations": [
                    {
                        "url": c.url,
                        "authority": c.authority.value,
                        "published_date": c.published_date,
                    }
                    for c in f.citations
                ],
            }
            for f in findings
        ],
        "challenges": [
            {"finding_id": c.finding_id, "grounds": c.grounds.value, "rationale": c.rationale}
            for c in challenges
        ],
    }


# ------------------------------------------------------------------ verification


@tool(
    "verify_pass",
    "Pass a finding through to risk scoring. Use it when the claim is supported by "
    "current, authoritative, internally consistent sources.",
    {
        "type": "object",
        "properties": {
            "finding_id": _string("The finding you examined"),
            "rationale": _string("Why it survives: which source carries the claim"),
        },
        "required": ["finding_id", "rationale"],
    },
)
async def verify_pass(ctx: RunContext, finding_id: str, rationale: str) -> dict:
    ctx.verdicts.append({"action": "verify_pass", "finding_id": finding_id, "rationale": rationale})
    return {"ok": True, "action": "verify_pass"}


@tool(
    "file_challenge",
    "Reject a finding and send it back for re-research. A challenge must cite the "
    "ground: a source that is stale, weaker than the claim needs, or contradicts it. "
    "You may not reject on suspicion alone — if you cannot cite the doubt, pass it.",
    {
        "type": "object",
        "properties": {
            "finding_id": _string("The finding you are challenging"),
            "grounds": {
                "type": "string",
                "enum": [
                    "stale",
                    "authority",
                    "independence",
                    "inconsistent",
                    "conflict_unresolved",
                ],
                "description": "Which test the finding failed",
            },
            "rationale": _string("The specific defect, naming the offending source"),
            "citation_urls": _array("URLs that evidence the ground; at least one"),
        },
        "required": ["finding_id", "grounds", "rationale", "citation_urls"],
    },
)
async def file_challenge(
    ctx: RunContext, finding_id: str, grounds: str, rationale: str, citation_urls: list[str]
) -> dict:
    if ctx.verdicts:
        return {"ok": False, "error": "a verdict has already been returned for this finding"}

    from clearframe_adapter.normalize import classify_authority
    from clearframe_runtime.ids import citation_id as new_citation_id

    citations = [
        Citation(
            citation_id=new_citation_id(),
            url=url,
            authority=classify_authority(url),
            fetched_ts=utcnow(),
        )
        for url in citation_urls
        if url
    ]
    challenge = Challenge(
        challenge_id=challenge_id(),
        finding_id=finding_id,
        item_id=ctx.item_id or "",
        project_id=ctx.project_id,
        grounds=ChallengeGround(grounds),
        rationale=rationale,
        citations=citations,
        agent=ctx.agent,
    )
    if not challenge.is_valid():
        return {"ok": False, "error": "a challenge without a cited ground is invalid; pass instead"}

    ctx.challenges.append(challenge)
    ctx.verdicts.append(
        {
            "action": "file_challenge",
            "finding_id": finding_id,
            "grounds": grounds,
            "rationale": rationale,
            "challenge_id": challenge.challenge_id,
        }
    )
    return {"ok": True, "action": "file_challenge", "challenge_id": challenge.challenge_id}


# ------------------------------------------------------------------ risk counsel


@tool(
    "search_clearance_guidance",
    "Retrieve passages from the grounding corpora — E&O underwriting guidance and "
    "network clearance handbooks. Every risk judgement must rest on a retrieved "
    "passage, quoted by its reference.",
    {
        "type": "object",
        "properties": {
            "query": _string("What guidance you need, e.g. 'background artwork de minimis'"),
            "corpus": _string("eo-underwriting | clearance-handbooks | all"),
        },
        "required": ["query"],
    },
)
async def search_clearance_guidance(ctx: RunContext, query: str, corpus: str = "all") -> dict:
    from .grounding import search_corpora

    passages = await search_corpora(query, corpus)
    return {"passages": passages, "count": len(passages)}


@tool(
    "submit_assessment",
    "Record the risk state for the item, with mitigations. GREEN needs no mitigation; "
    "AMBER and RED need two or three, each with a cost delta and a production impact. "
    "Every output is research and drafting for a human, never a legal conclusion.",
    {
        "type": "object",
        "properties": {
            "risk_state": {"type": "string", "enum": ["green", "amber", "red"]},
            "rationale": _string("Why this state, referencing the findings and the guidance"),
            "grounding_refs": _array("References to the handbook passages you relied on"),
            "mitigations": {
                "type": "array",
                "description": "2-3 for amber and red",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": [
                                "license",
                                "replace",
                                "alter",
                                "remove",
                                "fair_use_memo",
                                "no_action",
                            ],
                        },
                        "summary": {"type": "string"},
                        "cost_delta_usd": {"type": "number"},
                        "production_impact": {"type": "string"},
                        "recommended": {"type": "boolean"},
                    },
                    "required": ["kind", "summary"],
                },
            },
        },
        "required": ["risk_state", "rationale"],
    },
)
async def submit_assessment(
    ctx: RunContext,
    risk_state: str,
    rationale: str,
    grounding_refs: list[str] | None = None,
    mitigations: list[dict] | None = None,
) -> dict:
    """The one hard rule is enforced here, not in the prompt: any litigation signal on
    a live finding is RED, whatever the model concluded."""
    from clearframe_adapter.normalize import has_litigation
    from clearframe_ledger import records

    store = get_store()
    state = RiskState(risk_state)
    findings = await store.list_findings(item_id=ctx.item_id or "", live_only=True)
    forced = any(has_litigation(f.claim) for f in findings)
    if forced and state is not RiskState.RED:
        state = RiskState.RED
        rationale = (
            "Forced to RED: a verified finding carries a litigation signal, which is "
            "blocking exposure regardless of other factors.\n\n" + rationale
        )

    parsed = [
        Mitigation(
            mitigation_id=mitigation_id(),
            kind=MitigationKind(m.get("kind", "no_action")),
            summary=m.get("summary", ""),
            cost_delta_usd=float(m.get("cost_delta_usd", 0.0) or 0.0),
            production_impact=m.get("production_impact", ""),
            recommended=bool(m.get("recommended", False)),
        )
        for m in (mitigations or [])
    ]
    citations = [c for f in findings for c in f.citations]
    assessment = RiskAssessment(
        assessment_id=assessment_id(),
        item_id=ctx.item_id or "",
        project_id=ctx.project_id,
        pass_id=ctx.pass_id,
        risk_state=state,
        rationale=rationale,
        grounding_refs=grounding_refs or [],
        citations=citations,
        mitigations=parsed,
        agent=ctx.agent,
    )
    assessment = assessment.model_copy(update={"requires_approval": assessment.gate_required()})
    stored = await records.record_assessment(assessment)
    ctx.assessments.append(stored)
    return {
        "ok": True,
        "assessment_id": stored.assessment_id,
        "risk_state": stored.risk_state.value,
        "forced_red_by_litigation": forced,
        "requires_approval": stored.requires_approval,
    }


# ---------------------------------------------------------------------- outreach


@tool(
    "findall_rights_holders",
    "Discover the entities that actually control a catalog or collection and how their "
    "licensing desk is reached. Give explicit match conditions — vague objectives "
    "return plausible companies rather than the right ones.",
    {
        "type": "object",
        "properties": {
            "objective": _string("e.g. 'Find licensing entities controlling the X catalog'"),
            "match_conditions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}, "description": {"type": "string"}},
                    "required": ["name", "description"],
                },
            },
            "match_limit": {"type": "integer", "description": "5-25 is sensible"},
        },
        "required": ["objective", "match_conditions"],
    },
)
async def findall_rights_holders(
    ctx: RunContext, objective: str, match_conditions: list[dict], match_limit: int = 10
) -> dict:
    from clearframe_adapter import findall as findall_api
    from clearframe_adapter import pricing
    from clearframe_ledger import records

    from .budget import guard

    await guard(ctx.project_id, cost_usd=pricing.FINDALL_COST_USD, tier=2)
    result = await findall_api.find_rights_holders(
        objective, match_conditions, match_limit=match_limit
    )
    ctx.spend_usd += pricing.FINDALL_COST_USD
    await records.record_cost(
        ctx.project_id, ctx.pass_id, ctx.item_id, 2, pricing.FINDALL_COST_USD, "findall"
    )

    matches = findall_api.extract_matches(result)
    from .enrichment import ingest_findall_matches

    holders = await ingest_findall_matches(matches)
    return {
        "findall_id": result.get("findall_id"),
        "matches": len(matches),
        "holders": [
            {
                "holder_id": h.holder_id,
                "name": h.name,
                "kind": h.kind.value,
                "contacts": [c.model_dump(mode="json") for c in h.contacts],
            }
            for h in holders
        ],
    }


@tool(
    "draft_outreach",
    "Draft a licence inquiry for counsel to approve. Drafting is all you can do: there "
    "is no send capability in this system, only a queue behind the counsel gate.",
    {
        "type": "object",
        "properties": {
            "holder_name": _string("Rights holder the inquiry is addressed to"),
            "to_name": _string("Named contact, if one was discovered"),
            "to_email": _string("Contact email, only if it came from a cited source"),
            "contact_source_url": _string("Where the contact detail was found"),
            "subject": _string("Subject line"),
            "body": _string("The inquiry: what is used, where, for how long, and the ask"),
        },
        "required": ["holder_name", "subject", "body"],
    },
)
async def draft_outreach(
    ctx: RunContext,
    holder_name: str,
    subject: str,
    body: str,
    to_name: str = "",
    to_email: str | None = None,
    contact_source_url: str | None = None,
) -> dict:
    store = get_store()
    holder = await store.find_holder_by_name(holder_name)
    draft = OutreachDraft(
        outreach_id=outreach_id(),
        project_id=ctx.project_id,
        item_id=ctx.item_id or "",
        holder_id=holder.holder_id if holder else None,
        to_name=to_name or holder_name,
        to_email=to_email,
        contact_source_url=contact_source_url,
        subject=subject,
        body=body,
        status=OutreachStatus.PENDING_APPROVAL,
    )
    await store.put_outreach(draft)
    ctx.outreach.append(draft)
    log_event(log, "outreach drafted", item_id=ctx.item_id, holder=holder_name)
    return {
        "ok": True,
        "outreach_id": draft.outreach_id,
        "status": draft.status.value,
        "note": "queued for counsel approval; nothing is sent by this system",
    }


# ------------------------------------------------------------------- extraction


@tool(
    "record_items",
    "Emit the clearable elements you extracted. Extraction only — no rights "
    "conclusions, no ownership guesses, no risk language.",
    {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": [
                                "music_cue",
                                "lyric_quote",
                                "brand",
                                "artwork",
                                "likeness",
                                "footage",
                                "location",
                                "font",
                            ],
                        },
                        "title": {"type": "string"},
                        "description": {"type": "string"},
                        "scene": {"type": "string"},
                        "page": {"type": "integer"},
                        "frame_in": {"type": "integer"},
                        "frame_out": {"type": "integer"},
                        "prominence": {
                            "type": "string",
                            "enum": ["background", "featured", "hero"],
                        },
                        "attrs": {"type": "object"},
                    },
                    "required": ["type", "title", "description", "prominence"],
                },
            },
            "notes": {"type": "string"},
        },
        "required": ["items"],
    },
)
async def record_items(ctx: RunContext, items: list[dict], notes: str = "") -> dict:
    """Held on the context; the Breakdown caller persists them against a cut."""
    if notes:
        ctx.notes.append(notes)
    ctx.extracted.extend(items)
    return {"ok": True, "count": len(items)}


def extracted_items(ctx: RunContext) -> list[dict]:
    return list(ctx.extracted)


async def execute(ctx: RunContext, name: str, args: dict) -> dict:
    """Invoke one tool by name. Errors are returned to the model, never raised at it,
    so a bad call becomes a correction rather than a dead pass."""
    tool_def = REGISTRY.get(name)
    if tool_def is None:
        return {"ok": False, "error": f"no such tool: {name}"}
    try:
        return await tool_def.impl(ctx, **args)
    except TypeError as exc:
        return {"ok": False, "error": f"bad arguments for {name}: {exc}"}
    except Exception as exc:  # noqa: BLE001 — surfaced to the model and the feed
        log_event(log, "tool failed", tool=name, error=repr(exc), item_id=ctx.item_id)
        return {"ok": False, "error": f"{name} failed: {exc}"}


__all__ = [
    "REGISTRY",
    "RunContext",
    "Tool",
    "declarations_for",
    "execute",
    "extracted_items",
    "tool",
]
