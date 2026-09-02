"""Loader for the Parallel Task output schemas — one schema per specialist."""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path

from .items import ItemType

SCHEMA_DIR = Path(__file__).parent / "schemas"

#: Which output schema each item type is researched against.
SCHEMA_FOR_TYPE: dict[ItemType, str] = {
    ItemType.MUSIC_CUE: "music_rights",
    ItemType.LYRIC_QUOTE: "music_rights",
    ItemType.BRAND: "trademark",
    ItemType.LOCATION: "trademark",
    ItemType.LIKENESS: "likeness",
    ItemType.ARTWORK: "footage",
    ItemType.FOOTAGE: "footage",
    ItemType.FONT: "footage",
}


@cache
def load_schema(name: str) -> dict:
    path = SCHEMA_DIR / f"{name}.json"
    if not path.exists():
        raise KeyError(f"unknown output schema: {name}")
    return json.loads(path.read_text())


def schema_name_for(item_type: ItemType) -> str:
    return SCHEMA_FOR_TYPE[item_type]


def schema_for(item_type: ItemType) -> dict:
    return load_schema(schema_name_for(item_type))


def all_schema_names() -> list[str]:
    return sorted(p.stem for p in SCHEMA_DIR.glob("*.json"))
