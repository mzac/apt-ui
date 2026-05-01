# apt-ui — local CI runner
#
# `make ci` runs the same checks GitHub Actions does (TypeScript build,
# Python syntax, import resolution) so you can catch failures before pushing.
#
# `make help` lists all targets.

.PHONY: help ci backend-syntax backend-imports frontend-build frontend-typecheck docker-build venv clean

# Auto-detect a venv at ./venv or ./.venv; fall back to system python3.
PYTHON ?= $(shell test -x venv/bin/python && echo venv/bin/python || (test -x .venv/bin/python && echo .venv/bin/python) || echo python3)

help:  ## Show this help
	@echo "Usage: make <target>"
	@echo ""
	@echo "Targets:"
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?##/ {printf "  %-22s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

ci: backend-syntax backend-imports frontend-build  ## Run all CI checks (mirrors what runs on push)
	@echo ""
	@echo "✓ All CI checks passed"

backend-syntax:  ## Compile-check every Python file in backend/
	@echo "→ Python syntax check"
	@find backend -name '*.py' -print0 | xargs -0 $(PYTHON) -m py_compile
	@echo "  ✓ all Python files parse"

backend-imports:  ## Import backend.main to verify the app starts cleanly (needs deps)
	@echo "→ Python import check (using $(PYTHON))"
	@if ! $(PYTHON) -c "import fastapi" 2>/dev/null; then \
		echo "  ⚠ fastapi not installed in $(PYTHON)"; \
		echo "  → run 'make venv' to create a venv with the required deps,"; \
		echo "    or set PYTHON=/path/to/python with deps already installed."; \
		echo "  ⊘ skipping import check"; \
	else \
		PYTHONPATH=$(CURDIR) $(PYTHON) -c "import backend.main; import backend.cli" && \
		echo "  ✓ backend.main + backend.cli import cleanly"; \
	fi

frontend-typecheck:  ## TypeScript type-check only (no emit)
	@echo "→ TypeScript type-check"
	@cd frontend && npx tsc --noEmit

frontend-build:  ## Frontend build — tsc + vite (matches `npm run build`)
	@echo "→ Frontend build"
	@cd frontend && npm run build

docker-build:  ## Build the Docker image locally (slow, multi-stage)
	@echo "→ Docker build (linux/amd64)"
	@docker build -t apt-ui:ci .

venv:  ## Create ./venv and install backend/requirements.txt
	@if [ ! -d venv ]; then \
		echo "→ Creating venv at ./venv"; \
		python3 -m venv venv; \
	fi
	@echo "→ Installing Python dependencies"
	@venv/bin/pip install --quiet --upgrade pip
	@venv/bin/pip install --quiet -r backend/requirements.txt
	@echo "  ✓ venv ready (activate: source venv/bin/activate)"

clean:  ## Remove build artefacts and Python caches
	@echo "→ Cleaning"
	@rm -rf frontend/dist
	@find . -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
	@find . -name '*.pyc' -delete 2>/dev/null || true
	@echo "  ✓ cleaned"
