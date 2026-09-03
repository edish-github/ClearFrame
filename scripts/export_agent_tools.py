"""Generate the Agent Builder tool declarations from the code that implements them.

Hand-maintained tool JSON drifts from the functions it describes within a week.
This writes `agents/tools/*.json` from the live registry and the services' own
OpenAPI documents, so a mismatch is impossible rather than merely discouraged.

    uv run python scripts/export_agent_tools.py
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "agents" / "tools"


def write(name: str, payload: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote agents/tools/{name}")


def main() -> None:
    from clearframe_adapter.main import app as adapter_app
    from clearframe_ledger.main import app as ledger_app
    from clearframe_orch.main import app as orch_app
    from clearframe_orch.playbooks import all_playbooks
    from clearframe_orch.toolbelt import REGISTRY
    from clearframe_runtime import settings

    cfg = settings()

    write(
        "crew-functions.json",
        {
            "description": (
                "Function declarations for the ClearFrame crew playbooks. Import these "
                "into Agent Builder; each playbook's `tools:` list names the subset it "
                "may call."
            ),
            "generated_from": "orchestrator/src/clearframe_orch/toolbelt.py",
            "function_declarations": [t.declaration() for t in REGISTRY.values()],
            "playbook_toolbelts": {p.name: p.tools for p in all_playbooks()},
        },
    )

    write(
        "parallel-mcp.json",
        {
            "description": (
                "Parallel's managed MCP server, registered directly as an Agent Builder "
                "tool. Search and Extract reach the crews through this path; Task, Deep "
                "Research, FindAll and Monitor go through the Cloud Run adapter, which "
                "holds the API key."
            ),
            "type": "mcp",
            "server": {
                "url": cfg.parallel_mcp_url,
                "transport": "streamable_http",
                "auth": {
                    "type": "api_key_header",
                    "header": "x-api-key",
                    "secret_ref": f"projects/{cfg.project_id}/secrets/"
                    f"{cfg.parallel_api_key_secret}/versions/latest",
                },
            },
            "tools": ["web_search_preview", "extract"],
        },
    )

    write("parallel-adapter.json", adapter_app.openapi())
    write("ledger-api.json", ledger_app.openapi())
    write("dispatch.json", orch_app.openapi())


if __name__ == "__main__":
    main()
