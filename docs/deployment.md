# Deploying FlowQuest

Two options:

1. **Local Docker** — works on any machine with Docker installed.
2. **Coolify** — point Coolify at this repo, attach a domain, done.

Both produce the same image: a slim Python container with JupyterLab, the FlowQuest extension, and the data-science stack. `tini` is PID 1 so kernels shut down cleanly.

## Public, token-less deployment

By default the container is locked down. To make a deployment **public** (no token, no password — anyone with the URL can use the server), set `JUPYTER_PUBLIC=1`. The entrypoint will:

- empty the Jupyter token,
- empty the password hash,
- enable `Application.allow_unauthenticated_access`.

Combine that with a sensible CORS allow-origin (typically the public domain Coolify gave you) and you're done.

> **Warning.** Public mode means anyone who finds the URL can run code on your server. Pair it with resource limits and remember the `/workspace` volume is shared.

## Option 1 — local Docker

Requirements: Docker 24+ and Docker Compose v2.

```bash
git clone <your-fork-or-repo-url>
cd piis

# Configure the LLM endpoint (FlowQuest needs these to run)
export HF_OPENAI_BASE_URL=https://router.huggingface.co/v1
export HF_OPENAI_MODEL=meta-llama/Llama-3.1-8B-Instruct
export HF_OPENAI_API_KEY=hf_...

# OPTIONAL: make it public, no auth (handy for demos)
export JUPYTER_PUBLIC=1

docker compose up --build
```

JupyterLab is now on http://localhost:8888 with the example notebooks pre-seeded into the workspace volume.

## Option 2 — Coolify

The repo ships a `docker-compose.yml` Coolify auto-detects. Steps:

1. **Push this repo somewhere Coolify can read.** GitHub, GitLab, Gitea — any of them.
2. In Coolify, **New Resource → Docker Compose**, point it at the repo. Coolify uses `docker-compose.yml` at the root.
3. Set environment variables (Coolify → *Environment Variables*):

   | Variable | Value | Notes |
   | --- | --- | --- |
   | `HF_OPENAI_BASE_URL` | OpenAI-compatible endpoint | mark as secret |
   | `HF_OPENAI_MODEL` | model id | secret |
   | `HF_OPENAI_API_KEY` | API key | secret |
   | `JUPYTER_PUBLIC` | `1` | makes the server public |
   | `JUPYTER_ALLOW_ORIGIN` | `https://flowquest.example.com` | the domain Coolify assigns |

   The `HF_*` vars are also written into `${WORKSPACE_DIR}/.env` on each boot so the FlowQuest backend reads them the same way it does locally. Users can also paste a different model and key via the in-app **Settings → Global** panel; that overrides these and is stored under `~/.flowquest/settings.json` inside the container.

4. **Storage** — confirm the `flowquest-workspace` named volume mounts at `/workspace`. ~5 GiB is plenty. This is where every notebook (and every notebook's FlowQuest progress) lives, so make sure to back it up.
5. **Service** — port `8888`, attach your domain, enable Coolify's Traefik route, let Let's Encrypt handle TLS.
6. **Deploy**. First build is ~5 minutes (Node compile + pip install). Later deploys are fast thanks to layer caching.
7. Open `https://<your-domain>/`. With `JUPYTER_PUBLIC=1` it lands directly in JupyterLab — no token prompt.

## What the container does on boot

`deploy/entrypoint.sh`:

1. Creates `/workspace` if missing.
2. **Seeds notebooks.** If the workspace is empty, copies `examples/*.ipynb` from the image so first-time users have something to open.
3. **Writes `.env`.** If `HF_OPENAI_BASE_URL/MODEL/API_KEY` are present in the environment, it writes them to `${WORKSPACE_DIR}/.env` (mode `0600`). The FlowQuest backend reads this file on every request.
4. **Auth mode.** If `JUPYTER_PUBLIC=1`, it disables the token and password and enables `Application.allow_unauthenticated_access`. Otherwise it uses `JUPYTER_TOKEN` / `JUPYTER_PASSWORD_HASH` and generates a random token if neither is set.
5. Execs `jupyter lab` via `tini`.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `HF_OPENAI_BASE_URL` | — | OpenAI-compatible endpoint URL. |
| `HF_OPENAI_MODEL` | — | Model id used by every assistant feature. |
| `HF_OPENAI_API_KEY` | — | API key for the endpoint above. |
| `JUPYTER_PUBLIC` | `0` | `1` opens the server with no auth. |
| `JUPYTER_TOKEN` | (random) | Token used when `JUPYTER_PUBLIC` is not set. |
| `JUPYTER_PASSWORD_HASH` | — | Pre-hashed password (`jupyter-server password`). |
| `JUPYTER_BASE_URL` | `/` | Subpath if the proxy serves under one. Keep the trailing slash. |
| `JUPYTER_ALLOW_ORIGIN` | `*` | CORS allow-list. Set to your domain in production. |
| `JUPYTER_PORT` | `8888` | Container listening port. |

## Updating

Push to the branch Coolify watches. The Node stage rebuilds the TS bundle, the Python stage reinstalls the package. The `/workspace` volume is left alone, so notebooks and their FlowQuest progress survive.

## Backups

Snapshot the `flowquest-workspace` volume on whatever schedule fits. That's the only state that matters; everything else is rebuildable from the image.

## Hardening notes

- Public deployments are convenient but anyone with the URL can run code in the container. Pair with resource limits and a domain you don't mind being indexed.
- For private deployments, set `JUPYTER_TOKEN` (it's the simplest path) and remove `JUPYTER_PUBLIC` from the environment.
- Restrict CORS by setting `JUPYTER_ALLOW_ORIGIN` to your single domain.
- The container runs as a non-root user (`flowquest`, UID 1000). Make sure your bind mounts are writable by that UID, or stick to the named volume in `docker-compose.yml`.
