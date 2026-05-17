"""JupyterLab server config for the FlowQuest container.

Values are either hard-coded to safe defaults for a container deployment or
read from environment variables the operator sets in Coolify (or locally).
"""

from __future__ import annotations

import os

c = get_config()  # type: ignore[name-defined]  # noqa: F821


def _truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


# Bind to the container interface; the reverse proxy terminates TLS for us.
c.ServerApp.ip = "0.0.0.0"
c.ServerApp.port = int(os.environ.get("JUPYTER_PORT", "8888"))
c.ServerApp.open_browser = False
c.ServerApp.allow_root = False

# Workspace directory is the persistent volume mounted by Coolify / Docker.
c.ServerApp.root_dir = os.environ.get("WORKSPACE_DIR", "/workspace")

c.ServerApp.trust_xheaders = True
c.ServerApp.allow_remote_access = True

# Optional subpath (e.g. "/flowquest/").
base_url = os.environ.get("JUPYTER_BASE_URL", "").strip()
if base_url:
    if not base_url.startswith("/"):
        base_url = "/" + base_url
    if not base_url.endswith("/"):
        base_url = base_url + "/"
    c.ServerApp.base_url = base_url

# ---------------------------------------------------------------------------
# Auth mode. The entrypoint sets JUPYTER_PUBLIC_MODE / JUPYTER_TOKEN /
# JUPYTER_PASSWORD_HASH; we just read them here.
# ---------------------------------------------------------------------------
public_mode = _truthy(os.environ.get("JUPYTER_PUBLIC_MODE"))
password = os.environ.get("JUPYTER_PASSWORD_HASH")
token = os.environ.get("JUPYTER_TOKEN")
generated = os.environ.get("JUPYTER_GENERATED_TOKEN")

if public_mode:
    c.ServerApp.token = ""
    c.ServerApp.password = ""
    # Lab 4 / Server 2.x: the older flag was IdentityProvider.token. In
    # public mode we additionally allow unauthenticated access so requests
    # without a token are accepted.
    try:
        c.ServerApp.password_required = False
    except Exception:
        pass
    try:
        c.ServerApp.disable_check_xsrf = True
    except Exception:
        pass
    try:
        c.IdentityProvider.token = ""
    except Exception:
        pass
    try:
        c.ServerApp.allow_unauthenticated_access = True
    except Exception:
        pass
elif password:
    c.ServerApp.password = password
    c.ServerApp.token = ""
elif token:
    c.ServerApp.token = token
    c.ServerApp.password = ""
elif generated:
    c.ServerApp.token = generated
    c.ServerApp.password = ""
else:
    c.ServerApp.token = ""
    c.ServerApp.password = ""

# ---------------------------------------------------------------------------
# CORS. Defaults to "*" because the reverse proxy fronts a single hostname.
# Set JUPYTER_ALLOW_ORIGIN=https://your-domain.tld to lock it down.
# ---------------------------------------------------------------------------
origin = os.environ.get("JUPYTER_ALLOW_ORIGIN", "").strip()
if origin:
    c.ServerApp.allow_origin = origin
else:
    c.ServerApp.allow_origin = "*"

# Quality of life
c.ServerApp.tornado_settings = {"headers": {"X-Frame-Options": "SAMEORIGIN"}}
c.ServerApp.iopub_data_rate_limit = 10_000_000  # bytes/sec, useful for plots
c.FileContentsManager.delete_to_trash = False

# Ensure the FlowQuest server extension is loaded.
c.ServerApp.jpserver_extensions = {"jupyterlab_piis_assistant": True}
