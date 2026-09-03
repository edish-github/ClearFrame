"""Where the permanent past is written.

BigQuery in the cloud, newline-delimited JSON on disk locally. Both are
append-only by construction: the interface has no update and no delete.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from clearframe_runtime import settings

LEDGER_EVENTS = "ledger_events"
FINDINGS = "findings"
CITATIONS = "citations"
RIGHTS_HOLDERS = "rights_holders"
DECISIONS = "decisions"
ASSESSMENTS = "assessments"
COST_EVENTS = "cost_events"

TABLES = (LEDGER_EVENTS, FINDINGS, CITATIONS, RIGHTS_HOLDERS, DECISIONS, ASSESSMENTS, COST_EVENTS)


class LedgerSink(ABC):
    @abstractmethod
    def insert(self, table: str, rows: list[dict]) -> None: ...

    @abstractmethod
    def read(self, table: str, **equals: Any) -> list[dict]: ...


class LocalLedgerSink(LedgerSink):
    """JSONL files. Same append-only semantics, no cloud required."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root or settings().local_root) / "ledger"
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, table: str) -> Path:
        return self.root / f"{table}.jsonl"

    def insert(self, table: str, rows: list[dict]) -> None:
        if not rows:
            return
        with self._path(table).open("a") as fh:
            for row in rows:
                fh.write(json.dumps(row, default=str) + "\n")

    def read(self, table: str, **equals: Any) -> list[dict]:
        path = self._path(table)
        if not path.exists():
            return []
        out = []
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if all(row.get(k) == v for k, v in equals.items()):
                out.append(row)
        return out


class BigQueryLedgerSink(LedgerSink):
    def __init__(self, dataset: str | None = None) -> None:
        from google.cloud import bigquery

        self._bq = bigquery.Client(project=settings().project_id)
        self._dataset = dataset or settings().bq_dataset

    def _table(self, table: str) -> str:
        return f"{settings().project_id}.{self._dataset}.{table}"

    def insert(self, table: str, rows: list[dict]) -> None:
        if not rows:
            return
        errors = self._bq.insert_rows_json(self._table(table), rows)
        if errors:
            raise RuntimeError(f"bigquery insert into {table} failed: {errors}")

    def read(self, table: str, **equals: Any) -> list[dict]:
        from google.cloud import bigquery

        where = " AND ".join(f"{k} = @{k}" for k in equals) or "TRUE"
        job_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter(k, "STRING", str(v)) for k, v in equals.items()
            ]
        )
        query = f"SELECT * FROM `{self._table(table)}` WHERE {where} ORDER BY 1"
        return [dict(row) for row in self._bq.query(query, job_config=job_config).result()]


_SINK: LedgerSink | None = None


def get_sink() -> LedgerSink:
    global _SINK
    if _SINK is None:
        _SINK = LocalLedgerSink() if settings().is_local else BigQueryLedgerSink()
    return _SINK


def set_sink(sink: LedgerSink | None) -> None:
    global _SINK
    _SINK = sink
