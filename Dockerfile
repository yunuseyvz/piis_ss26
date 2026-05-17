# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# FlowQuest — JupyterLab + piis-assistant extension, container image.
# -----------------------------------------------------------------------------
# Stage 1 builds the TypeScript lab extension (needs Node and Python).
# Stage 2 is the runtime: a slim Python image with JupyterLab, the extension,
# and the notebook data-science stack.
# -----------------------------------------------------------------------------

# =============================================================================
# Stage 1: build the JupyterLab extension (TS -> lib + labextension bundle)
# =============================================================================
FROM node:20-bookworm-slim AS extension-builder

# `jupyter labextension build` is a Python command registered by jupyterlab.
# We install it in a venv to stay compatible with PEP 668 on Debian bookworm.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/build-venv \
 && /opt/build-venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/build-venv/bin/pip install --no-cache-dir "jupyterlab>=4.5.0,<5"

ENV PATH="/opt/build-venv/bin:${PATH}"

WORKDIR /build

# Install npm deps first so the layer caches well.
COPY jupyterlab_extensions/piis-assistant/package.json \
     jupyterlab_extensions/piis-assistant/package-lock.json \
     ./jupyterlab_extensions/piis-assistant/
RUN cd jupyterlab_extensions/piis-assistant && npm ci --no-audit --no-fund

# Copy the extension source and build the production bundle.
COPY jupyterlab_extensions/piis-assistant ./jupyterlab_extensions/piis-assistant
RUN cd jupyterlab_extensions/piis-assistant && npm run build


# =============================================================================
# Stage 2: runtime image
# =============================================================================
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    JUPYTER_CONFIG_DIR=/home/flowquest/.jupyter \
    JUPYTER_DATA_DIR=/home/flowquest/.local/share/jupyter \
    JUPYTER_RUNTIME_DIR=/home/flowquest/.local/share/jupyter/runtime \
    WORKSPACE_DIR=/workspace

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Non-root user with predictable UID/GID so the mounted volume is writable.
ARG UID=1000
ARG GID=1000
RUN groupadd --gid "${GID}" flowquest \
 && useradd  --uid "${UID}" --gid "${GID}" --create-home --shell /bin/bash flowquest

WORKDIR /app

# Install the notebook stack first (good cache layer).
COPY deploy/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy the built extension from stage 1 and install it.
# setup.py will pick up the prebuilt labextension/ directory and place its
# assets under <prefix>/share/jupyter/labextensions/jupyterlab-piis-assistant/,
# and the server extension config under <prefix>/etc/jupyter/jupyter_server_config.d/.
COPY --from=extension-builder /build/jupyterlab_extensions/piis-assistant /app/extension
RUN pip install --no-cache-dir /app/extension

# Runtime config + entrypoint
COPY deploy/jupyter_server_config.py /app/jupyter_server_config.py
COPY deploy/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Seed notebooks — copied into an empty workspace on first boot.
COPY examples /app/seed-notebooks

RUN mkdir -p "${WORKSPACE_DIR}" "${JUPYTER_CONFIG_DIR}" "${JUPYTER_DATA_DIR}" \
 && chown -R flowquest:flowquest /app "${WORKSPACE_DIR}" /home/flowquest

USER flowquest
WORKDIR ${WORKSPACE_DIR}

EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:8888${JUPYTER_BASE_URL:-/}api/status" || exit 1

# tini reaps zombies and propagates signals cleanly (important for kernel shutdown).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD []
