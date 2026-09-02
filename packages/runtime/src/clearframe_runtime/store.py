"""The state plane.

Firestore holds the living present; the same interface backed by a directory on
disk lets the whole system run on a laptop or in CI. Domain helpers are written
once against four primitives, so a new backend only implements the primitives.
"""

from __future__ import annotations

import asyncio
import json
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from clearframe_contracts import (
    BudgetState,
    Cut,
    Item,
    ItemStatus,
    OutreachDraft,
    Pass,
    Project,
    RightsHolder,
    RiskAssessment,
    Watch,
    can_transition,
    utcnow,
)
from clearframe_contracts.findings import Challenge, Finding

from .config import settings


class TransitionError(RuntimeError):
    """An item was pushed into a state the machine does not allow."""


class StateStore(ABC):
    """Four primitives; everything else is built on them."""

    @abstractmethod
    async def get(self, collection: str, doc_id: str) -> dict | None: ...

    @abstractmethod
    async def put(self, collection: str, doc_id: str, data: dict) -> None: ...

    @abstractmethod
    async def query(self, collection: str, **equals: Any) -> list[dict]: ...

    @abstractmethod
    async def mutate(self, collection: str, doc_id: str, fn) -> dict:
        """Read-modify-write under a lock/transaction. `fn(doc) -> doc`."""

    async def append(self, collection: str, doc_id: str, data: dict) -> None:
        """Append to an ordered sub-stream (the UI feed). Default: a doc per event."""
        await self.put(collection, doc_id, data)

    # ---------------------------------------------------------------- projects

    async def create_project(self, project: Project) -> Project:
        await self.put("projects", project.project_id, project.model_dump(mode="json"))
        return project

    async def get_project(self, project_id: str) -> Project | None:
        doc = await self.get("projects", project_id)
        return Project(**doc) if doc else None

    async def list_projects(self) -> list[Project]:
        return [Project(**d) for d in await self.query("projects")]

    async def increment_spend(self, project_id: str, tier: int, cost_usd: float) -> BudgetState:
        """Atomic. The budget meter reads exactly this."""

        def _apply(doc: dict) -> dict:
            doc["spent_usd"] = round(float(doc.get("spent_usd", 0.0)) + cost_usd, 6)
            by_tier = doc.setdefault("by_tier", {})
            calls = doc.setdefault("calls_by_tier", {})
            key = f"T{tier}"
            by_tier[key] = round(float(by_tier.get(key, 0.0)) + cost_usd, 6)
            calls[key] = int(calls.get(key, 0)) + 1
            return doc

        doc = await self.mutate("projects", project_id, _apply)
        return BudgetState(
            cap_usd=float(doc.get("budget_cap_usd", 0.0)),
            spent_usd=float(doc.get("spent_usd", 0.0)),
            by_tier=doc.get("by_tier", {}),
            calls_by_tier=doc.get("calls_by_tier", {}),
        )

    async def budget(self, project_id: str) -> BudgetState:
        doc = await self.get("projects", project_id) or {}
        return BudgetState(
            cap_usd=float(doc.get("budget_cap_usd", 0.0)),
            spent_usd=float(doc.get("spent_usd", 0.0)),
            by_tier=doc.get("by_tier", {}),
            calls_by_tier=doc.get("calls_by_tier", {}),
        )

    async def raise_budget(self, project_id: str, new_cap_usd: float) -> BudgetState:
        def _apply(doc: dict) -> dict:
            doc["budget_cap_usd"] = float(new_cap_usd)
            return doc

        await self.mutate("projects", project_id, _apply)
        return await self.budget(project_id)

    # -------------------------------------------------------------------- cuts

    async def put_cut(self, cut: Cut) -> Cut:
        await self.put("cuts", cut.cut_id, cut.model_dump(mode="json"))
        return cut

    async def get_cut(self, cut_id: str) -> Cut | None:
        doc = await self.get("cuts", cut_id)
        return Cut(**doc) if doc else None

    async def list_cuts(self, project_id: str) -> list[Cut]:
        cuts = [Cut(**d) for d in await self.query("cuts", project_id=project_id)]
        return sorted(cuts, key=lambda c: c.created_ts)

    # ------------------------------------------------------------------- items

    async def put_item(self, item: Item) -> Item:
        await self.put("items", item.item_id, item.model_dump(mode="json"))
        return item

    async def get_item(self, item_id: str) -> Item | None:
        doc = await self.get("items", item_id)
        return Item(**doc) if doc else None

    async def list_items(
        self, *, cut_id: str | None = None, project_id: str | None = None
    ) -> list[Item]:
        criteria = {k: v for k, v in (("cut_id", cut_id), ("project_id", project_id)) if v}
        return [Item(**d) for d in await self.query("items", **criteria)]

    async def set_status(self, item_id: str, status: ItemStatus, *, force: bool = False) -> Item:
        """State machine enforcement lives here, so no caller can skip it."""

        def _apply(doc: dict) -> dict:
            current = ItemStatus(doc.get("status", ItemStatus.EXTRACTED))
            if current == status:
                return doc
            if not force and not can_transition(current, status):
                raise TransitionError(f"{item_id}: {current.value} -> {status.value} is illegal")
            doc["status"] = status.value
            return doc

        return Item(**await self.mutate("items", item_id, _apply))

    async def update_item(self, item_id: str, **fields: Any) -> Item:
        def _apply(doc: dict) -> dict:
            doc.update(fields)
            return doc

        return Item(**await self.mutate("items", item_id, _apply))

    async def increment_challenges(self, item_id: str) -> int:
        def _apply(doc: dict) -> dict:
            doc["challenge_count"] = int(doc.get("challenge_count", 0)) + 1
            return doc

        return int((await self.mutate("items", item_id, _apply))["challenge_count"])

    async def challenge_count(self, item_id: str) -> int:
        doc = await self.get("items", item_id) or {}
        return int(doc.get("challenge_count", 0))

    # ------------------------------------------------------------------ passes

    async def create_pass(self, p: Pass) -> Pass:
        await self.put("passes", p.pass_id, p.model_dump(mode="json"))
        return p

    async def get_pass(self, pass_id: str) -> Pass | None:
        doc = await self.get("passes", pass_id)
        return Pass(**doc) if doc else None

    async def list_passes(self, project_id: str) -> list[Pass]:
        passes = [Pass(**d) for d in await self.query("passes", project_id=project_id)]
        return sorted(passes, key=lambda p: p.started_ts, reverse=True)

    async def update_pass(self, pass_id: str, **fields: Any) -> Pass:
        def _apply(doc: dict) -> dict:
            doc.update(fields)
            return doc

        return Pass(**await self.mutate("passes", pass_id, _apply))

    async def bump_pass_counter(self, pass_id: str, field: str, by: int = 1) -> Pass:
        def _apply(doc: dict) -> dict:
            doc[field] = int(doc.get(field, 0)) + by
            return doc

        return Pass(**await self.mutate("passes", pass_id, _apply))

    # ---------------------------------------------------------------- findings

    async def put_finding(self, finding: Finding) -> Finding:
        await self.put("findings", finding.finding_id, finding.model_dump(mode="json"))
        return finding

    async def get_finding(self, finding_id: str) -> Finding | None:
        doc = await self.get("findings", finding_id)
        return Finding(**doc) if doc else None

    async def list_findings(
        self, *, item_id: str | None = None, project_id: str | None = None, live_only: bool = False
    ) -> list[Finding]:
        criteria = {k: v for k, v in (("item_id", item_id), ("project_id", project_id)) if v}
        found = [Finding(**d) for d in await self.query("findings", **criteria)]
        if live_only:
            found = [f for f in found if not f.superseded_by]
        return sorted(found, key=lambda f: f.ts)

    async def supersede_finding(self, finding_id: str, by_finding_id: str) -> None:
        def _apply(doc: dict) -> dict:
            doc["superseded_by"] = by_finding_id
            return doc

        await self.mutate("findings", finding_id, _apply)

    async def put_challenge(self, challenge: Challenge) -> Challenge:
        await self.put("challenges", challenge.challenge_id, challenge.model_dump(mode="json"))
        return challenge

    async def list_challenges(
        self, *, item_id: str | None = None, project_id: str | None = None
    ) -> list[Challenge]:
        criteria = {k: v for k, v in (("item_id", item_id), ("project_id", project_id)) if v}
        return [Challenge(**d) for d in await self.query("challenges", **criteria)]

    # --------------------------------------------------------------- decisions

    async def put_assessment(self, a: RiskAssessment) -> RiskAssessment:
        await self.put("assessments", a.assessment_id, a.model_dump(mode="json"))
        return a

    async def list_assessments(
        self, *, item_id: str | None = None, project_id: str | None = None
    ) -> list[RiskAssessment]:
        criteria = {k: v for k, v in (("item_id", item_id), ("project_id", project_id)) if v}
        out = [RiskAssessment(**d) for d in await self.query("assessments", **criteria)]
        return sorted(out, key=lambda a: a.ts)

    async def latest_assessment(self, item_id: str) -> RiskAssessment | None:
        out = await self.list_assessments(item_id=item_id)
        return out[-1] if out else None

    # ---------------------------------------------------------------- outreach

    async def put_outreach(self, draft: OutreachDraft) -> OutreachDraft:
        await self.put("outreach", draft.outreach_id, draft.model_dump(mode="json"))
        return draft

    async def get_outreach(self, outreach_id: str) -> OutreachDraft | None:
        doc = await self.get("outreach", outreach_id)
        return OutreachDraft(**doc) if doc else None

    async def list_outreach(self, project_id: str) -> list[OutreachDraft]:
        return [OutreachDraft(**d) for d in await self.query("outreach", project_id=project_id)]

    async def update_outreach(self, outreach_id: str, **fields: Any) -> OutreachDraft:
        def _apply(doc: dict) -> dict:
            doc.update(fields)
            return doc

        return OutreachDraft(**await self.mutate("outreach", outreach_id, _apply))

    # ---------------------------------------------------------- rights holders

    async def put_holder(self, holder: RightsHolder) -> RightsHolder:
        await self.put("rights_holders", holder.holder_id, holder.model_dump(mode="json"))
        return holder

    async def get_holder(self, holder_id: str) -> RightsHolder | None:
        doc = await self.get("rights_holders", holder_id)
        return RightsHolder(**doc) if doc else None

    async def list_holders(self) -> list[RightsHolder]:
        return [RightsHolder(**d) for d in await self.query("rights_holders")]

    async def find_holder_by_name(self, name: str) -> RightsHolder | None:
        target = name.strip().lower()
        for holder in await self.list_holders():
            if holder.name.strip().lower() == target:
                return holder
            if any(a.strip().lower() == target for a in holder.aliases):
                return holder
        return None

    # ----------------------------------------------------------------- watches

    async def put_watch(self, watch: Watch) -> Watch:
        await self.put("watches", watch.watch_id, watch.model_dump(mode="json"))
        return watch

    async def get_watch(self, watch_id: str) -> Watch | None:
        doc = await self.get("watches", watch_id)
        return Watch(**doc) if doc else None

    async def list_watches(self, project_id: str | None = None) -> list[Watch]:
        criteria = {"project_id": project_id} if project_id else {}
        return [Watch(**d) for d in await self.query("watches", **criteria)]

    async def update_watch(self, watch_id: str, **fields: Any) -> Watch:
        def _apply(doc: dict) -> dict:
            doc.update(fields)
            return doc

        return Watch(**await self.mutate("watches", watch_id, _apply))

    # -------------------------------------------------------------- live feed

    async def push_feed(self, pass_id: str, entry: dict) -> None:
        """The crew feed the war room streams. Capped by the reader, not the writer."""
        entry = {**entry, "pass_id": pass_id, "ts": entry.get("ts") or utcnow().isoformat()}
        doc_id = entry.get("event_id") or f"{pass_id}-{utcnow().timestamp()}"
        await self.append("feed", doc_id, entry)

    async def list_feed(self, pass_id: str, limit: int = 200) -> list[dict]:
        entries = await self.query("feed", pass_id=pass_id)
        entries.sort(key=lambda e: e.get("ts", ""), reverse=True)
        return entries[:limit]


class LocalStateStore(StateStore):
    """JSON-on-disk. Same semantics as Firestore for everything ClearFrame uses."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root or settings().local_root) / "state"
        self.root.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, asyncio.Lock] = {}

    def _path(self, collection: str, doc_id: str) -> Path:
        d = self.root / collection
        d.mkdir(parents=True, exist_ok=True)
        return d / f"{doc_id}.json"

    def _lock(self, key: str) -> asyncio.Lock:
        return self._locks.setdefault(key, asyncio.Lock())

    async def get(self, collection: str, doc_id: str) -> dict | None:
        path = self._path(collection, doc_id)
        if not path.exists():
            return None
        return json.loads(path.read_text())

    async def put(self, collection: str, doc_id: str, data: dict) -> None:
        path = self._path(collection, doc_id)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, default=str, indent=2))
        tmp.replace(path)

    async def query(self, collection: str, **equals: Any) -> list[dict]:
        d = self.root / collection
        if not d.exists():
            return []
        out: list[dict] = []
        for path in d.glob("*.json"):
            try:
                doc = json.loads(path.read_text())
            except json.JSONDecodeError:
                continue
            if all(doc.get(k) == v for k, v in equals.items()):
                out.append(doc)
        return out

    async def mutate(self, collection: str, doc_id: str, fn) -> dict:
        async with self._lock(f"{collection}/{doc_id}"):
            doc = await self.get(collection, doc_id)
            if doc is None:
                raise KeyError(f"{collection}/{doc_id} not found")
            updated = fn(dict(doc))
            await self.put(collection, doc_id, updated)
            return updated


class FirestoreStateStore(StateStore):
    """Firestore in native mode. Live state only — the permanent past is BigQuery."""

    def __init__(self, project_id: str | None = None) -> None:
        from google.cloud import firestore

        self._db = firestore.AsyncClient(project=project_id or settings().project_id)
        self._firestore = firestore

    async def get(self, collection: str, doc_id: str) -> dict | None:
        snap = await self._db.collection(collection).document(doc_id).get()
        return snap.to_dict() if snap.exists else None

    async def put(self, collection: str, doc_id: str, data: dict) -> None:
        await self._db.collection(collection).document(doc_id).set(data)

    async def query(self, collection: str, **equals: Any) -> list[dict]:
        ref = self._db.collection(collection)
        for key, value in equals.items():
            ref = ref.where(filter=self._firestore.FieldFilter(key, "==", value))
        return [doc.to_dict() async for doc in ref.stream()]

    async def mutate(self, collection: str, doc_id: str, fn) -> dict:
        ref = self._db.collection(collection).document(doc_id)
        transaction = self._db.transaction()

        @self._firestore.async_transactional
        async def _txn(txn) -> dict:
            snap = await ref.get(transaction=txn)
            if not snap.exists:
                raise KeyError(f"{collection}/{doc_id} not found")
            updated = fn(dict(snap.to_dict()))
            txn.set(ref, updated)
            return updated

        return await _txn(transaction)


_STORE: StateStore | None = None


def get_store() -> StateStore:
    global _STORE
    if _STORE is None:
        cfg = settings()
        _STORE = LocalStateStore() if cfg.is_local else FirestoreStateStore(cfg.project_id)
    return _STORE


def set_store(store: StateStore | None) -> None:
    """Tests and the local runner swap the backend here — nothing else does."""
    global _STORE
    _STORE = store
