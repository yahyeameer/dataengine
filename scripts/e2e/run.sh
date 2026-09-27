#!/usr/bin/env bash
#
# Run the pipeline end-to-end test with whichever interpreter has its deps.
#
# The agent's dependencies (polars, duckdb, psycopg) live in the worker's own
# virtualenv, because that is where the agent is developed and where CI installs
# them. Falling back to a bare `python3` is deliberate: on a box that installed
# them globally this still works, and on one that did not, `run.py` says which
# package is missing rather than dying on an ImportError.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/../../services/hermes/.venv/bin/python"
if [ -x "$VENV" ]; then exec "$VENV" "$HERE/run.py" "$@"; fi
exec python3 "$HERE/run.py" "$@"
