# ClearFrame — one-word entry points.
.DEFAULT_GOAL := help
SHELL := /bin/bash

PY := uv run

.PHONY: help
help:  ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install:  ## Sync the Python workspace
	uv sync

.PHONY: test
test:  ## Run the test suite
	$(PY) pytest -q

.PHONY: lint
lint:  ## Ruff check + format check
	$(PY) ruff check .
	$(PY) ruff format --check .

.PHONY: fmt
fmt:  ## Format
	$(PY) ruff format .
	$(PY) ruff check --fix .

.PHONY: dev
dev:  ## Run the whole stack locally: five services + the war room
	@echo "orchestrator :8080  ledger :8082  webhook :8083  renderer :8084  war room :3000"
	@trap 'kill 0' EXIT; \
	CLEARFRAME_SERVICE=orchestrator $(PY) uvicorn clearframe_orch.main:app --port 8080 & \
	CLEARFRAME_SERVICE=adapter      $(PY) uvicorn clearframe_adapter.main:app --port 8081 & \
	CLEARFRAME_SERVICE=ledger       $(PY) uvicorn clearframe_ledger.main:app --port 8082 & \
	CLEARFRAME_SERVICE=webhook      $(PY) uvicorn clearframe_webhook.main:app --port 8083 & \
	CLEARFRAME_SERVICE=renderer     $(PY) uvicorn clearframe_renderer.main:app --port 8084 & \
	(cd web && pnpm dev) & \
	wait

.PHONY: dev-api
dev-api:  ## Run only the orchestrator, with reload
	CLEARFRAME_SERVICE=orchestrator $(PY) uvicorn clearframe_orch.main:app --reload --port 8080

.PHONY: fixture
fixture:  ## Populate local state so the war room has something to render (dev only)
	$(PY) python scripts/dev_fixture.py --root .local

.PHONY: pass
pass:  ## Run a real pass end to end: make pass FILE=demo/film/cut-01/script.fountain
	$(PY) python scripts/run_local_pass.py --file "$(FILE)" --title "$(or $(TITLE),Demo picture)"

.PHONY: smoke-parallel
smoke-parallel:  ## Prove the Parallel key works against the live API
	$(PY) python scripts/smoke_parallel.py

.PHONY: evals
evals:  ## Golden-item regression over the extraction and research prompts
	$(PY) python agents/evals/run_evals.py

.PHONY: verify-chain
verify-chain:  ## Audit the ledger hash chain: make verify-chain PROJECT=prj_xxx
	$(PY) python -c "from clearframe_ledger.chain import verify_chain; import json,sys; print(json.dumps(verify_chain('$(PROJECT)'), indent=2))"

.PHONY: tools
tools:  ## Regenerate agents/tools/*.json from the code
	$(PY) python scripts/export_agent_tools.py

.PHONY: bootstrap
bootstrap:  ## Create every Google Cloud resource (idempotent)
	./infra/scripts/bootstrap.sh

.PHONY: deploy
deploy:  ## Build and deploy all services to Cloud Run
	./infra/scripts/deploy.sh

.PHONY: seed
seed:  ## Load the public demo project
	./infra/scripts/seed_demo.sh

.PHONY: clean
clean:  ## Remove local state (never touches the cloud)
	rm -rf .local .pytest_cache .ruff_cache
