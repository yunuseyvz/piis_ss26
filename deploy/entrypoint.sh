#!/usr/bin/env bash
# FlowQuest container entrypoint.
#
# Responsibilities:
#   1. Make sure the persistent workspace exists and has starter notebooks.
#   2. Build a .env at the workspace root so the FlowQuest backend can read
#      HF_OPENAI_* credentials without baking them into the image.
#   3. Resolve auth mode:
#        JUPYTER_PUBLIC=1        -> token-less, no password (open to the world)
#        JUPYTER_PASSWORD_HASH   -> password-protected
#        JUPYTER_TOKEN (or auto) -> token-protected
#   4. Exec JupyterLab via the generated config.

set -Eeuo pipefail

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
SEED_DIR="${SEED_NOTEBOOKS_DIR:-/app/seed-notebooks}"
CONFIG_FILE="${CONFIG_FILE:-/app/jupyter_server_config.py}"

mkdir -p "${WORKSPACE_DIR}"

# ---------------------------------------------------------------------------
# Seed notebooks the first time this volume is used.
# ---------------------------------------------------------------------------
if [[ -d "${SEED_DIR}" ]]; then
  if [[ -z "$(ls -A "${WORKSPACE_DIR}" 2>/dev/null | grep -v '^\.' || true)" ]]; then
    echo "[flowquest] Seeding workspace from ${SEED_DIR}" >&2
    cp -r "${SEED_DIR}/." "${WORKSPACE_DIR}/" || true
  fi
fi

# ---------------------------------------------------------------------------
# Write the workspace .env that the FlowQuest backend reads.
# ---------------------------------------------------------------------------
ENV_FILE="${WORKSPACE_DIR}/.env"
if [[ -n "${HF_OPENAI_BASE_URL:-}" && -n "${HF_OPENAI_MODEL:-}" && -n "${HF_OPENAI_API_KEY:-}" ]]; then
  {
    echo "HF_OPENAI_BASE_URL=${HF_OPENAI_BASE_URL}"
    echo "HF_OPENAI_MODEL=${HF_OPENAI_MODEL}"
    echo "HF_OPENAI_API_KEY=${HF_OPENAI_API_KEY}"
  } > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}" || true
else
  echo "[flowquest] WARNING: HF_OPENAI_* environment variables are not all set." >&2
  echo "[flowquest]          Users can configure them via FlowQuest -> Settings -> Global." >&2
fi

# ---------------------------------------------------------------------------
# Auth mode.
# ---------------------------------------------------------------------------
case "${JUPYTER_PUBLIC:-0}" in
  1|true|TRUE|yes|YES)
    export JUPYTER_PUBLIC_MODE=1
    export JUPYTER_TOKEN=""
    export JUPYTER_PASSWORD_HASH=""
    echo "[flowquest] PUBLIC MODE: server will run without auth." >&2
    echo "[flowquest] Anyone with the URL can run code on this container." >&2
    ;;
  *)
    export JUPYTER_PUBLIC_MODE=0
    if [[ -z "${JUPYTER_TOKEN:-}" && -z "${JUPYTER_PASSWORD_HASH:-}" ]]; then
      GENERATED="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
      export JUPYTER_GENERATED_TOKEN="${GENERATED}"
      echo "[flowquest] No JUPYTER_TOKEN set. Generated one for this run:" >&2
      echo "[flowquest]   ${GENERATED}" >&2
      echo "[flowquest] Set JUPYTER_TOKEN to pin it across restarts, or set JUPYTER_PUBLIC=1 for an open server." >&2
    fi
    ;;
esac

cd "${WORKSPACE_DIR}"

exec jupyter lab \
  --config="${CONFIG_FILE}" \
  --no-browser \
  "$@"
