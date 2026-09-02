"""Task API — structured deep research with citations.

Create returns immediately with a run_id and an interaction_id; the result call
long-polls. `previous_interaction_id` is what makes a challenge re-run answer
the objection instead of starting over, and what chains a Monitor reopen to
everything ever learned about the item.
"""

from __future__ import annotations

from typing import Any

from clearframe_runtime import get_logger, log_event

from .client import TASK_RESULT, TASK_RUN, TASK_RUNS, ParallelClient, get_client

log = get_logger("clearframe.adapter.task")

TERMINAL_STATES = {"completed", "failed", "cancelled", "action_required"}


def build_task_spec(output_schema: dict) -> dict:
    """Wrap a JSON Schema in the shape the Task API expects."""
    return {"output_schema": {"type": "json", "json_schema": output_schema}}


async def create_run(
    objective: str,
    output_schema: dict,
    *,
    processor: str = "core",
    prev_interaction_id: str | None = None,
    metadata: dict[str, str] | None = None,
    source_policy: dict | None = None,
    webhook_url: str | None = None,
    client: ParallelClient | None = None,
) -> dict:
    """POST /v1/tasks/runs. Returns the run envelope (run_id, interaction_id, status)."""
    body: dict[str, Any] = {
        "input": objective,
        "processor": processor,
        "task_spec": build_task_spec(output_schema),
    }
    if prev_interaction_id:
        # provenance chaining: the follow-up inherits the full prior context
        body["previous_interaction_id"] = prev_interaction_id
    if metadata:
        # Parallel caps metadata keys at 16 chars and values at 512
        body["metadata"] = {k[:16]: str(v)[:512] for k, v in metadata.items()}
    if source_policy:
        body["source_policy"] = source_policy
    if webhook_url:
        body["webhook"] = {"url": webhook_url}

    run = await (client or get_client()).post(TASK_RUNS, body)
    log_event(
        log,
        "task run created",
        run_id=run.get("run_id"),
        processor=processor,
        chained=bool(prev_interaction_id),
    )
    return run


async def get_result(
    run_id: str, *, timeout_s: int = 600, client: ParallelClient | None = None
) -> dict:
    """GET /v1/tasks/runs/{run_id}/result — long-polls until the run finishes."""
    return await (client or get_client()).get(
        TASK_RESULT.format(run_id=run_id),
        params={"timeout": timeout_s},
        timeout=timeout_s + 60,
    )


async def get_run(run_id: str, *, client: ParallelClient | None = None) -> dict:
    return await (client or get_client()).get(TASK_RUN.format(run_id=run_id))


async def run_task(
    objective: str,
    output_schema: dict,
    *,
    processor: str = "core",
    prev_interaction_id: str | None = None,
    metadata: dict[str, str] | None = None,
    source_policy: dict | None = None,
    timeout_s: int = 600,
    client: ParallelClient | None = None,
) -> dict:
    """Create and await one structured run.

    Returns a merged payload: the run envelope plus `output`, which is what
    `normalize.to_finding` consumes.
    """
    client = client or get_client()
    run = await create_run(
        objective,
        output_schema,
        processor=processor,
        prev_interaction_id=prev_interaction_id,
        metadata=metadata,
        source_policy=source_policy,
        client=client,
    )
    run_id = run.get("run_id")
    if not run_id:
        raise ValueError(f"task run carried no run_id: {run}")

    result = await get_result(run_id, timeout_s=timeout_s, client=client)
    merged = dict(result.get("run") or run)
    merged["output"] = result.get("output", {})
    merged.setdefault("run_id", run_id)
    merged.setdefault("interaction_id", run.get("interaction_id", run_id))
    return merged
