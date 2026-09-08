"""Running a playbook.

One loop: give the model its charter and its toolbelt, let it call tools, feed
the results back, stop when it stops asking. Every tool call is streamed to the
crew feed as it happens, which is what makes the war room a live picture of an
investigation rather than a progress bar.
"""

from __future__ import annotations

import json
import time
from typing import Any

from clearframe_runtime import get_logger, get_store, log_event, settings

from . import toolbelt
from .models import MediaPart, Message, ModelClient, ToolCall, get_model
from .playbooks import Playbook, load_playbook
from .toolbelt import RunContext

log = get_logger("clearframe.agents")

#: Feed lines the UI colour-codes by role.
FEED_ROLE_COLOURS = {
    "breakdown": "slate",
    "1st_ad": "amber",
    "music_rights": "violet",
    "marks_brands": "violet",
    "likeness": "violet",
    "footage_artwork": "violet",
    "verifier": "teal",
    "risk_counsel": "rose",
    "outreach": "sky",
    "sentinel": "teal",
    "ledger": "slate",
}


class AgentRun:
    """The record of one playbook execution — what it did, what it cost, what it said."""

    def __init__(self, playbook: Playbook, ctx: RunContext) -> None:
        self.playbook = playbook
        self.ctx = ctx
        self.turns: list[Message] = []
        self.tool_calls: list[dict] = []
        self.final_text: str = ""
        self.started = time.time()

    @property
    def duration_s(self) -> float:
        return round(time.time() - self.started, 2)

    def summary(self) -> dict[str, Any]:
        return {
            "playbook": self.playbook.name,
            "agent": self.ctx.agent,
            "item_id": self.ctx.item_id,
            "tool_calls": [c["name"] for c in self.tool_calls],
            "findings": [f.finding_id for f in self.ctx.findings],
            "challenges": [c.challenge_id for c in self.ctx.challenges],
            "assessments": [a.assessment_id for a in self.ctx.assessments],
            "outreach": [o.outreach_id for o in self.ctx.outreach],
            "verdicts": self.ctx.verdicts,
            "extracted": len(self.ctx.extracted),
            "spend_usd": round(self.ctx.spend_usd, 4),
            "duration_s": self.duration_s,
            "text": self.final_text,
        }


async def push_feed(ctx: RunContext, kind: str, message: str, **detail: Any) -> None:
    await get_store().push_feed(
        ctx.pass_id,
        {
            "kind": kind,
            "agent": ctx.agent,
            "colour": FEED_ROLE_COLOURS.get(ctx.agent, "slate"),
            "item_id": ctx.item_id,
            "message": message,
            "detail": detail,
        },
    )


def _brief(payload: dict, limit: int = 900) -> str:
    text = json.dumps(payload, default=str)
    return text if len(text) <= limit else text[:limit] + "…[truncated]"


async def invoke(
    playbook_name: str,
    ctx: RunContext,
    task: str,
    *,
    model_client: ModelClient | None = None,
    extra_tools: list[str] | None = None,
    media: list[MediaPart] | None = None,
) -> AgentRun:
    """Run one playbook to completion."""
    playbook = load_playbook(playbook_name)
    run = AgentRun(playbook, ctx)
    client = model_client or get_model()
    tool_names = playbook.tools + (extra_tools or [])
    declarations = toolbelt.declarations_for(tool_names)

    history: list[Message] = [Message(role="user", text=task, media=media or [])]
    await push_feed(
        ctx,
        "agent.started",
        f"{playbook.display_name or playbook.name} started",
        playbook=playbook.name,
    )

    for _turn in range(playbook.max_turns):
        turn = await client.turn(
            system=playbook.system_instruction(),
            history=history,
            tools=declarations,
            model=playbook.resolved_model(),
        )
        history.append(Message(role="model", text=turn.text, tool_calls=turn.tool_calls))

        if not turn.wants_tools:
            run.final_text = turn.text
            break

        for call in turn.tool_calls:
            result = await _run_tool(ctx, call, run)
            history.append(Message(role="tool", tool_name=call.name, tool_response=result))
    else:
        run.final_text = f"stopped after {playbook.max_turns} turns without a final answer"
        log_event(log, "playbook hit turn cap", playbook=playbook.name, item_id=ctx.item_id)

    run.turns = history
    await push_feed(
        ctx,
        "agent.finished",
        run.final_text[:280] or f"{playbook.name} finished",
        spend_usd=round(ctx.spend_usd, 4),
        duration_s=run.duration_s,
    )
    log_event(log, "playbook complete", **run.summary())
    return run


async def _run_tool(ctx: RunContext, call: ToolCall, run: AgentRun) -> dict:
    await push_feed(
        ctx, "tool.call", _tool_line(ctx, call), tool=call.name, args=_brief(call.args, 400)
    )
    result = await toolbelt.execute(ctx, call.name, call.args)
    run.tool_calls.append({"name": call.name, "args": call.args, "result": result})
    if not result.get("ok", True):
        await push_feed(ctx, "tool.error", f"{call.name}: {result.get('error')}", tool=call.name)
    return result


def _tool_line(ctx: RunContext, call: ToolCall) -> str:
    """The one-line version a human reads in the feed."""
    args = call.args
    if call.name == "parallel_search":
        queries = ", ".join(args.get("search_queries", [])[:3])
        return f"recon — searching: {queries}"
    if call.name == "parallel_extract":
        return f"reading {len(args.get('urls', []))} source page(s)"
    if call.name == "parallel_task":
        return f"structured run (T{ctx.tier}) — {args.get('objective', '')[:120]}"
    if call.name == "submit_finding":
        return "finding submitted to the ledger"
    if call.name == "file_challenge":
        return f"challenge filed — {args.get('grounds')}: {args.get('rationale', '')[:120]}"
    if call.name == "verify_pass":
        return f"verified — {args.get('rationale', '')[:120]}"
    if call.name == "submit_assessment":
        return f"risk scored {str(args.get('risk_state', '')).upper()}"
    if call.name == "draft_outreach":
        return f"licence inquiry drafted for {args.get('holder_name')}"
    if call.name == "findall_rights_holders":
        return f"tracing entities — {args.get('objective', '')[:100]}"
    if call.name == "search_clearance_guidance":
        return f"consulting the handbooks — {args.get('query', '')[:100]}"
    if call.name == "record_items":
        return f"{len(args.get('items', []))} clearable elements extracted"
    return call.name


def model_available() -> bool:
    """Whether a reasoning backend is configured. The API reports this rather than
    letting a pass fail halfway with a credentials error."""
    cfg = settings()
    if not cfg.vertex_configured:
        return False
    try:
        import google.genai  # noqa: F401
    except ImportError:
        return False
    return True
