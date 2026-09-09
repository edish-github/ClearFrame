# ClearFrame — common tasks.
.DEFAULT_GOAL := help
.PHONY: help install build dev up down migrate test smoke typecheck clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install every workspace
	npm install

build: ## Build shared, api and web in dependency order
	npm run build

dev: ## Run api, worker and web together
	npm run dev

up: ## Bring up Postgres, the API and the worker in Docker
	docker compose up --build -d
	@echo "waiting for the API…" && sleep 6
	docker compose exec -T api node dist/scripts/migrate.js || true
	@echo "ClearFrame is on http://localhost:8080"

down: ## Stop everything
	docker compose down

migrate: ## Apply the database schema
	npm run migrate

test: ## Integration checks against a real database
	npm run test

smoke: ## One live call to each provider
	npm run smoke

typecheck: ## Type check every workspace
	npm run typecheck

clean: ## Remove build output and dependencies
	rm -rf node_modules */*/node_modules */*/dist .data
