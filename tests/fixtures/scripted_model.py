"""A scripted stand-in for Gemini.

The orchestration under test is the routing, the gating, the budget, the state
machine, and the provenance chain — none of which should depend on a model's
mood. Each playbook gets a deterministic script keyed off its display name; the
tool calls it makes are the real ones, executed against the real toolbelt.
"""

from __future__ import annotations

from collections.abc import Callable

from clearframe_orch.models import Message, ModelTurn, ToolCall

Script = Callable[[list[Message]], ModelTurn]


class ScriptedModelClient:
    """Two modes, and the difference matters once anything runs concurrently.

    * ``script`` pops a fixed sequence — exact and readable, correct when one
      invocation of an agent runs at a time.
    * ``reactive`` answers from the conversation itself, so many invocations of
      the same agent can interleave without stealing each other's turns. A fan-out
      over a register needs this, because that is what the real fan-out does.
    """

    def __init__(self) -> None:
        self._scripts: dict[str, list[Script]] = {}
        self._reactive: dict[str, Script] = {}
        self.calls: list[tuple[str, int]] = []

    def script(self, agent_key: str, turns: list[Script]) -> None:
        self._scripts[agent_key] = list(turns)
        self._reactive.pop(agent_key, None)

    def reactive(self, agent_key: str, responder: Script) -> None:
        self._reactive[agent_key] = responder
        self._scripts.pop(agent_key, None)

    def _key_for(self, system: str) -> str:
        for key in (*self._reactive, *self._scripts):
            if key.lower() in system.lower():
                return key
        raise AssertionError(f"no script registered for system prompt: {system[:120]}")

    async def turn(
        self,
        *,
        system: str,
        history: list[Message],
        tools: list[dict],
        model: str | None = None,
        response_schema: dict | None = None,
    ) -> ModelTurn:
        key = self._key_for(system)
        self.calls.append((key, len(history)))

        responder = self._reactive.get(key)
        if responder is not None:
            return responder(history)

        queue = self._scripts[key]
        if not queue:
            return ModelTurn(text=f"{key}: nothing further")
        return queue.pop(0)(history)


def say(text: str) -> Script:
    return lambda _history: ModelTurn(text=text)


def call(name: str, **args) -> Script:
    return lambda _history: ModelTurn(tool_calls=[ToolCall(name=name, args=args)])


def call_dynamic(name: str, args_fn: Callable[[list[Message]], dict]) -> Script:
    return lambda history: ModelTurn(tool_calls=[ToolCall(name=name, args=args_fn(history))])


def tools_called(history: list[Message]) -> list[str]:
    """Which tools this conversation has already run, in order."""
    return [m.tool_name for m in history if m.role == "tool" and m.tool_name]


def response_of(history: list[Message], tool_name: str) -> dict | None:
    """The most recent response from one tool in this conversation."""
    for message in reversed(history):
        if message.role == "tool" and message.tool_name == tool_name:
            return message.tool_response or {}
    return None


def task_text(history: list[Message]) -> str:
    return " ".join(m.text for m in history if m.role == "user")


def last_tool_response(history: list[Message]) -> dict:
    for message in reversed(history):
        if message.role == "tool" and message.tool_response is not None:
            return message.tool_response
    return {}
