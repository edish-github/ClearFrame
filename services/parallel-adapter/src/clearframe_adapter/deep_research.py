"""Deep Research — the T3 ultra dossier.

Same Task surface, deepest processor, and a longer patience. Reserved for red
flags and anything counsel escalates; the tier policy is what keeps it rare.
"""

from __future__ import annotations

from clearframe_runtime import get_logger, log_event

from .client import ParallelClient
from .task import run_task

log = get_logger("clearframe.adapter.deep_research")

ULTRA_TIMEOUT_S = 3600


async def run_dossier(
    objective: str,
    output_schema: dict,
    *,
    prev_interaction_id: str | None = None,
    metadata: dict[str, str] | None = None,
    client: ParallelClient | None = None,
) -> dict:
    log_event(log, "ultra dossier requested", chained=bool(prev_interaction_id))
    return await run_task(
        objective,
        output_schema,
        processor="ultra",
        prev_interaction_id=prev_interaction_id,
        metadata=metadata,
        timeout_s=ULTRA_TIMEOUT_S,
        client=client,
    )


def dossier_objective(item_title: str, item_description: str, question: str) -> str:
    """Full chain-of-title framing — the objective phrasing that gets citations back."""
    return (
        f"Produce a complete chain-of-title dossier for: {item_title}. "
        f"Context: {item_description}. "
        f"Specific question to resolve: {question} "
        "Trace every ownership hop from origin to today, naming each transferring and "
        "receiving entity with a dated source. Identify any litigation, estate dispute, "
        "or unresolved claim touching the chain. Where sources disagree, report each "
        "position separately with its source rather than choosing between them."
    )
