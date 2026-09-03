"""The reasoning plane.

Playbooks run on Gemini. The console (Gemini Enterprise Agent Builder) and this
runner read the same YAML, so what judges see in the repo is what executes: a
playbook is a charter, a toolbelt, and guardrails, and this module is the loop
that lets a model use them.

The `ModelClient` seam exists so the orchestration logic can be exercised
without a model in the loop — tests drive a scripted client. Research results
are never scripted: those always come from the live Parallel API.
"""

from __future__ import annotations

import json
from typing import Any, Protocol

from clearframe_runtime import get_logger, log_event, settings
from pydantic import BaseModel, Field

log = get_logger("clearframe.models")


class ToolCall(BaseModel):
    name: str
    args: dict = Field(default_factory=dict)


class ModelTurn(BaseModel):
    text: str = ""
    tool_calls: list[ToolCall] = Field(default_factory=list)

    @property
    def wants_tools(self) -> bool:
        return bool(self.tool_calls)


class MediaPart(BaseModel):
    """A frame, a page image, or a PDF handed to a multimodal turn."""

    mime_type: str
    data: bytes | None = None
    uri: str | None = None  # gs:// for assets already in Cloud Storage
    label: str = ""


class Message(BaseModel):
    role: str  # "user" | "model" | "tool"
    text: str = ""
    media: list[MediaPart] = Field(default_factory=list)
    tool_name: str | None = None
    tool_response: dict | None = None
    tool_calls: list[ToolCall] = Field(default_factory=list)


class ModelClient(Protocol):
    async def turn(
        self,
        *,
        system: str,
        history: list[Message],
        tools: list[dict],
        model: str | None = None,
        response_schema: dict | None = None,
    ) -> ModelTurn: ...


class ModelUnavailable(RuntimeError):
    """Raised when no reasoning backend is configured. Never silently substituted."""


class GeminiModelClient:
    """Vertex AI Gemini with function calling, driven manually.

    Automatic function calling is deliberately disabled: the orchestrator has to
    see every tool call to meter cost, enforce the budget cap, and stream the
    crew feed.
    """

    def __init__(
        self,
        project: str | None = None,
        location: str | None = None,
        default_model: str | None = None,
    ) -> None:
        cfg = settings()
        try:
            from google import genai
        except ImportError as exc:  # pragma: no cover - depends on optional extra
            raise ModelUnavailable(
                "google-genai is not installed; install the 'gemini' extra"
            ) from exc

        self._genai = genai
        from google.genai import types

        self._types = types
        self._client = genai.Client(
            vertexai=True,
            project=project or cfg.vertex_project or cfg.project_id,
            location=location or cfg.vertex_location,
        )
        self._default_model = default_model or cfg.model_pro

    def _to_contents(self, history: list[Message]) -> list[Any]:
        types = self._types
        contents: list[Any] = []
        for message in history:
            if message.role == "tool":
                contents.append(
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_function_response(
                                name=message.tool_name or "tool",
                                response=message.tool_response or {},
                            )
                        ],
                    )
                )
            elif message.role == "model":
                parts: list[Any] = []
                if message.text:
                    parts.append(types.Part.from_text(text=message.text))
                for call in message.tool_calls:
                    parts.append(
                        types.Part(function_call=types.FunctionCall(name=call.name, args=call.args))
                    )
                contents.append(
                    types.Content(role="model", parts=parts or [types.Part.from_text(text="")])
                )
            else:
                parts = [types.Part.from_text(text=message.text)]
                for media in message.media:
                    if media.uri:
                        parts.append(
                            types.Part.from_uri(file_uri=media.uri, mime_type=media.mime_type)
                        )
                    elif media.data:
                        parts.append(
                            types.Part.from_bytes(data=media.data, mime_type=media.mime_type)
                        )
                contents.append(types.Content(role="user", parts=parts))
        return contents

    async def turn(
        self,
        *,
        system: str,
        history: list[Message],
        tools: list[dict],
        model: str | None = None,
        response_schema: dict | None = None,
    ) -> ModelTurn:
        types = self._types
        config_kwargs: dict[str, Any] = {
            "system_instruction": system,
            "automatic_function_calling": types.AutomaticFunctionCallingConfig(disable=True),
            "temperature": 0.2,
        }
        if tools:
            config_kwargs["tools"] = [
                types.Tool(
                    function_declarations=[
                        types.FunctionDeclaration(**declaration) for declaration in tools
                    ]
                )
            ]
        if response_schema:
            config_kwargs["response_mime_type"] = "application/json"
            config_kwargs["response_schema"] = response_schema

        response = await self._client.aio.models.generate_content(
            model=model or self._default_model,
            contents=self._to_contents(history),
            config=types.GenerateContentConfig(**config_kwargs),
        )

        text_parts: list[str] = []
        calls: list[ToolCall] = []
        for candidate in response.candidates or []:
            for part in (candidate.content.parts if candidate.content else []) or []:
                if getattr(part, "function_call", None):
                    calls.append(
                        ToolCall(
                            name=part.function_call.name,
                            args=dict(part.function_call.args or {}),
                        )
                    )
                elif getattr(part, "text", None):
                    text_parts.append(part.text)

        turn = ModelTurn(text="\n".join(text_parts).strip(), tool_calls=calls)
        log_event(
            log,
            "model turn",
            model=model or self._default_model,
            tool_calls=[c.name for c in calls],
        )
        return turn


class AgentBuilderClient:
    """Invoke a playbook that lives in Gemini Enterprise Agent Builder.

    Used when `AGENT_APP_ID` is set: the same playbook YAML is imported into the
    console, and the orchestrator drives the hosted session instead of the local
    loop. The tool contract is identical, which is what makes the two paths
    interchangeable.
    """

    def __init__(self, app_id: str | None = None) -> None:
        cfg = settings()
        self.app_id = app_id or cfg.agent_app_id
        if not self.app_id:
            raise ModelUnavailable("AGENT_APP_ID is not configured")
        self._cfg = cfg

    async def invoke(self, playbook: str, payload: dict) -> dict:
        import httpx
        from google.auth import default
        from google.auth.transport.requests import Request

        credentials, _ = default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        credentials.refresh(Request())
        url = (
            f"https://discoveryengine.googleapis.com/v1alpha/projects/"
            f"{self._cfg.project_id}/locations/global/collections/default_collection/"
            f"engines/{self.app_id}/servingConfigs/default_search:answer"
        )
        async with httpx.AsyncClient(timeout=600) as client:
            response = await client.post(
                url,
                headers={"Authorization": f"Bearer {credentials.token}"},
                json={"query": {"text": json.dumps({"playbook": playbook, **payload})}},
            )
            response.raise_for_status()
            return response.json()


_MODEL: ModelClient | None = None


def get_model() -> ModelClient:
    global _MODEL
    if _MODEL is None:
        _MODEL = GeminiModelClient()
    return _MODEL


def set_model(client: ModelClient | None) -> None:
    global _MODEL
    _MODEL = client
