"""Test harness: every backend swapped to the local implementations, per test."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest
from clearframe_runtime import (
    InProcessBus,
    LocalBlobStore,
    LocalStateStore,
    reset_settings_cache,
    set_blobs,
    set_bus,
    set_store,
)


@pytest.fixture
def workspace(monkeypatch) -> Path:
    root = Path(tempfile.mkdtemp(prefix="clearframe-test-"))
    monkeypatch.setenv("CLEARFRAME_BACKEND", "local")
    monkeypatch.setenv("CLEARFRAME_LOCAL_ROOT", str(root))
    monkeypatch.setenv("PARALLEL_API_KEY", "test-key-not-a-real-secret")
    monkeypatch.setenv("PARALLEL_WEBHOOK_SECRET", "whsec_dGVzdHNlY3JldHRlc3RzZWNyZXQ=")
    reset_settings_cache()

    set_store(LocalStateStore(root))
    set_blobs(LocalBlobStore(root))
    bus = InProcessBus()
    set_bus(bus)

    from clearframe_ledger.sink import LocalLedgerSink, set_sink

    set_sink(LocalLedgerSink(root))

    yield root

    set_store(None)
    set_blobs(None)
    set_bus(None)
    set_sink(None)
    reset_settings_cache()
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def parallel(workspace):
    """Route every Parallel call through the transport double."""
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).parent))
    from clearframe_adapter.client import ParallelClient, set_client
    from fixtures.parallel_stub import ParallelStub

    stub = ParallelStub()
    set_client(ParallelClient(api_key="test-key", transport=stub.transport(), max_attempts=1))
    yield stub
    set_client(None)


@pytest.fixture
def model(workspace):
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).parent))
    from clearframe_orch.models import set_model
    from fixtures.scripted_model import ScriptedModelClient

    client = ScriptedModelClient()
    set_model(client)
    yield client
    set_model(None)
