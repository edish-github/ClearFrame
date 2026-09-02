"""Projects, cuts, and passes — the cross-item state the orchestrator owns."""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field

from .findings import utcnow


class PassMode(str, Enum):
    FULL = "full"
    DELTA = "delta"
    REOPEN = "reopen"


class PassStatus(str, Enum):
    PLANNED = "planned"
    RUNNING = "running"
    PAUSED = "paused"  # budget cap or kill switch; state is durable, resume exact
    COMPLETED = "completed"
    FAILED = "failed"


class Project(BaseModel):
    project_id: str
    title: str
    org_id: str = "default"
    budget_cap_usd: float = 60.0
    spent_usd: float = 0.0
    created_ts: datetime = Field(default_factory=utcnow)


class Cut(BaseModel):
    cut_id: str
    project_id: str
    label: str = "cut-01"
    gcs_uri: str = ""
    kind: str = "script"  # script | cut
    cut_hash: str = ""
    duration_frames: int = 0
    fps: float = 24.0
    created_ts: datetime = Field(default_factory=utcnow)


class BudgetState(BaseModel):
    cap_usd: float
    spent_usd: float = 0.0
    by_tier: dict[str, float] = Field(default_factory=dict)
    calls_by_tier: dict[str, int] = Field(default_factory=dict)

    @property
    def pct(self) -> float:
        return 0.0 if self.cap_usd <= 0 else min(1.0, self.spent_usd / self.cap_usd)

    @property
    def warn(self) -> bool:
        return self.pct >= 0.8


class Pass(BaseModel):
    pass_id: str
    project_id: str
    cut_id: str
    mode: PassMode = PassMode.FULL
    status: PassStatus = PassStatus.PLANNED
    total_items: int = 0
    completed_items: int = 0
    open_items: int = 0
    cleared_items: int = 0
    challenges: int = 0
    budget: BudgetState = BudgetState(cap_usd=60.0)
    delta: dict = Field(default_factory=dict)  # added/removed/inherited counts
    started_ts: datetime = Field(default_factory=utcnow)
    completed_ts: datetime | None = None
