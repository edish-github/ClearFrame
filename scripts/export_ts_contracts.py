"""Generate the TypeScript contracts from the Python ones.

`packages/contracts` is dual-published: the services write these shapes and the
web app renders them. Generating one from the other is what stops the two drifting
in a five-week build.

    uv run python scripts/export_ts_contracts.py
"""

from __future__ import annotations

import datetime as dt
import enum
import types
import typing
from pathlib import Path

from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "packages" / "contracts" / "ts" / "src" / "index.ts"
#: The web app imports the same shapes; copying beats a cross-package import that
#: needs bundler configuration to work at all.
WEB_OUT = ROOT / "web" / "src" / "lib" / "contracts.ts"

PRIMITIVES = {
    str: "string",
    int: "number",
    float: "number",
    bool: "boolean",
    dt.datetime: "string",
    dt.date: "string",
    bytes: "string",
    type(None): "null",
}


def ts_type(annotation: typing.Any) -> str:
    if annotation in PRIMITIVES:
        return PRIMITIVES[annotation]
    if annotation is typing.Any or annotation is None:
        return "unknown"

    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)

    if origin in (types.UnionType, typing.Union):
        parts = [ts_type(a) for a in args]
        return " | ".join(dict.fromkeys(parts))
    if origin in (list, set, tuple, frozenset):
        return f"{ts_type(args[0])}[]" if args else "unknown[]"
    if origin is dict:
        key = "string" if not args else ts_type(args[0])
        value = "unknown" if len(args) < 2 else ts_type(args[1])
        return f"Record<{key}, {value}>"
    if isinstance(annotation, type):
        if issubclass(annotation, enum.Enum):
            return annotation.__name__
        if issubclass(annotation, BaseModel):
            return annotation.__name__
    return "unknown"


def render_enum(cls: type[enum.Enum]) -> str:
    values = " | ".join(f'"{member.value}"' for member in cls)
    return f"export type {cls.__name__} = {values};"


def render_model(cls: type[BaseModel]) -> str:
    """A field is optional in TypeScript only if it can actually be absent.

    A field with a default is always present in a serialised response — marking it
    optional would force every reader to null-check something the API guarantees.
    Nullability is carried by the union type instead.
    """
    lines = [f"export interface {cls.__name__} {{"]
    for name, field in cls.model_fields.items():
        rendered = ts_type(field.annotation)
        nullable = " | null" in rendered
        lines.append(f"  {name}{'?' if nullable else ''}: {rendered};")
    lines.append("}")
    return "\n".join(lines)


def main() -> None:
    import clearframe_contracts as contracts

    enums: list[type[enum.Enum]] = []
    models: list[type[BaseModel]] = []
    for name in contracts.__all__:
        obj = getattr(contracts, name)
        if isinstance(obj, type) and issubclass(obj, enum.Enum):
            enums.append(obj)
        elif isinstance(obj, type) and issubclass(obj, BaseModel):
            models.append(obj)

    body = [
        "// Generated from packages/contracts/src/clearframe_contracts by",
        "// scripts/export_ts_contracts.py. Do not edit by hand: change the Python",
        "// contracts and regenerate, so the services and the war room cannot drift.",
        "",
        "// ---------------------------------------------------------------- enums",
        "",
        *[render_enum(e) for e in sorted(enums, key=lambda c: c.__name__)],
        "",
        "// --------------------------------------------------------------- models",
        "",
        *[render_model(m) + "\n" for m in sorted(models, key=lambda c: c.__name__)],
        "// ------------------------------------------------------ API projections",
        "",
        HAND_WRITTEN,
    ]

    rendered = "\n".join(body)
    for target in (OUT, WEB_OUT):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(rendered)
        print(f"wrote {target.relative_to(ROOT)}  ({len(enums)} enums, {len(models)} interfaces)")


#: Shapes the API composes that have no single Python model behind them.
HAND_WRITTEN = """export interface HeatStripRegion {
  item_id: string;
  title: string;
  type: ItemType;
  start_pct: number;
  width_pct: number;
  risk: RiskState | "unknown";
  status: ItemStatus;
  scene?: string | null;
  tc_in: string;
  frame_in: number;
}

export interface HeatStrip {
  cut_id: string;
  duration_frames: number;
  fps: number;
  regions: HeatStripRegion[];
}

export interface FeedEntry {
  event_id?: string;
  kind: string;
  agent: string;
  colour: string;
  item_id?: string | null;
  message: string;
  detail: Record<string, unknown>;
  ts: string;
  pass_id: string;
}

export interface ProvenanceNode {
  id: string;
  label: string;
  kind: "item" | "chain" | "holder" | "litigation";
  [key: string]: unknown;
}

export interface ProvenanceEdge {
  from: string;
  to: string;
  kind: "has_chain" | "controlled_by" | "transferred" | "party_to" | "encumbers";
  sources: string[];
  [key: string]: unknown;
}

export interface ProvenanceGraph {
  item_id: string;
  title: string;
  type: ItemType;
  risk_state: RiskState | "unknown";
  chains: string[];
  nodes: ProvenanceNode[];
  edges: ProvenanceEdge[];
  open_questions: string[];
  resolved: Record<string, boolean>;
}

export interface BudgetMeter extends BudgetState {
  pct: number;
  warn: boolean;
  pricing_note: string;
}

export interface RiskBoard {
  columns: Record<"red" | "amber" | "green" | "unknown", Item[]>;
  counts: Record<string, number>;
}

export interface ApprovalQueue {
  items: Array<{
    item: Item;
    assessment: RiskAssessment | null;
    findings: Finding[];
  }>;
  outreach: OutreachDraft[];
  counts: { items: number; outreach: number };
}

export interface ChainVerification {
  valid: boolean;
  reason: string;
  events: number;
  checked: number;
  head_hash?: string;
}

export interface DeltaPreview {
  added: string[];
  removed: string[];
  inherited: number;
  re_researched: string[];
}

export interface Readiness {
  backend: "local" | "gcp";
  model_available: boolean;
  parallel_key_available: boolean;
  parallel_detail: string;
  webhook_url_configured: boolean;
  agent_builder_app: boolean;
  datastores: boolean;
}
"""


if __name__ == "__main__":
    main()
