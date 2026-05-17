#!/usr/bin/env bash
# FlowQuest local setup.
#
# Builds the JupyterLab extension and installs it into the local venv.
# Re-run this any time you:
#   - clone the repo for the first time,
#   - run `uv sync` (which can drop the extension wheel),
#   - change Python or TypeScript code in the extension.
#
# Usage:
#   bash scripts/setup.sh

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${ROOT}/.venv"
EXTENSION="${ROOT}/jupyterlab_extensions/piis-assistant"

if [[ ! -d "${VENV}" ]]; then
  echo "[flowquest] No virtualenv at ${VENV}." >&2
  echo "[flowquest] Create one first with: uv sync" >&2
  exit 1
fi

# 1. Project deps (idempotent — uv only updates if needed).
echo "[flowquest] uv sync"
( cd "${ROOT}" && uv sync )

# 2. Frontend deps.
if [[ ! -d "${EXTENSION}/node_modules" ]]; then
  echo "[flowquest] npm install"
  ( cd "${EXTENSION}" && npm install --no-audit --no-fund )
fi

# 3. Build the lab extension bundle. Needs `jupyter labextension build` from
# the venv on PATH.
echo "[flowquest] npm run build"
( cd "${EXTENSION}" && PATH="${VENV}/bin:${PATH}" npm run build )

# 4. Install the extension wheel into the venv. setup.py picks up the prebuilt
# labextension/ directory.
echo "[flowquest] installing wheel into ${VENV}"
( cd "${EXTENSION}" && uv pip install --python "${VENV}/bin/python" . )

echo
echo "[flowquest] Done. Verify with:"
echo "    ${VENV}/bin/jupyter labextension list | grep piis"
echo
echo "Then start JupyterLab:"
echo "    uv run jupyter lab examples"
