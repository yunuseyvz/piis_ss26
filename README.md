# FlowQuest

A gamified, context-aware companion for JupyterLab. FlowQuest analyses your notebook, gives it a health score, and turns the journey from messy draft to clean artifact into a quest with missions, quizzes, and per-cell hints.

This repository contains:

- `jupyterlab_extensions/piis-assistant/` — the FlowQuest JupyterLab extension (TypeScript frontend + Python server backend).
- `examples/` — three short example notebooks designed to exercise the extension.
- `deploy/` and the root `Dockerfile` / `docker-compose.yml` — a self-contained deployment image suitable for Coolify, Render, fly.io, or plain Docker.
- `docs/` — architecture and deployment documentation.

> **Course context.** Built for the course **Practical Intelligent Interactive Systems for Software Developers**. The goal is to explore how an AI assistant can support notebook authoring without becoming a generic chatbot.

## Quickstart (local)

Requirements: Python 3.12+, Node 20+, and [`uv`](https://docs.astral.sh/uv/) for environment management.

```bash
# 1. Project deps + JupyterLab
uv sync

# 2. Build and install the FlowQuest extension into the venv
bash scripts/setup.sh

# 3. Open the example notebooks
uv run jupyter lab examples
```

> Re-run `bash scripts/setup.sh` any time you call `uv sync` or change extension code. `uv sync` only manages declared dependencies, so it can't reinstall the locally built extension on its own.

You can sanity-check the install with:

```bash
uv run jupyter labextension list | grep piis
# jupyterlab-piis-assistant v0.1.0 enabled OK (python, jupyterlab-piis-assistant)
```

Once JupyterLab is open:

1. Click the 🗺️ FlowQuest tab in the left sidebar (or the ⚙️ icon in any notebook's banner).
2. Open the **Settings → Global** tab and enter your model, base URL, and API key. They're saved under `~/.flowquest/settings.json`.
3. Open `examples/03_messy_on_purpose.ipynb` and press **🚀 Initialize FlowQuest** in the in-notebook banner. Mission cards appear in the sidebar; quiz cells appear below the data-loading region.

A `.env.example` is included if you'd rather configure the LLM endpoint that way; it's read as a fallback.

## What FlowQuest does

| Surface | What it shows |
| --- | --- |
| **In-notebook banner** | Notebook Health bar, level, mission count, region distribution, difficulty selector, settings shortcut. |
| **Per-cell chip** | Region label (load / clean / model / …), health dot, mission star, expand button. |
| **Inline cell panel** | Issues, dependencies, Explain / Reflect buttons, mission claims for that cell. |
| **Virtual quiz cells** | Auto-generated multiple-choice questions inserted between real cells, anchored to a stable cell id. |
| **Sidebar** | Three tabs: Quest (health, missions, criteria), Workflow (region map, cell list, issue feed), Chat (notebook-aware LLM chat). |
| **Settings modal** | Global model + API key, per-notebook difficulty, "wipe data" button. |

The whole quest state lives inside `metadata.flowquest` in the `.ipynb` itself, so progress travels with the file.

## Documentation map

- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit together; module-by-module map.
- [`docs/extension.md`](docs/extension.md) — what the extension exposes, the API surface, the persistence model.
- [`docs/deployment.md`](docs/deployment.md) — deploy a public, token-less FlowQuest server with Coolify or plain Docker.
- [`examples/README.md`](examples/README.md) — what each example notebook is meant to show.

## Repository layout

```
.
├── Dockerfile                    Production image (multi-stage build)
├── docker-compose.yml            Coolify-friendly compose definition
├── deploy/                       Runtime config + entrypoint + python deps
├── docs/                         Markdown documentation (start here)
├── examples/                     Three small notebooks exercising FlowQuest
├── jupyterlab_extensions/
│   └── piis-assistant/           The FlowQuest JupyterLab extension
│       ├── jupyterlab_piis_assistant/   Python server backend
│       ├── src/                  TypeScript frontend
│       ├── style/                CSS (sharp-edged, JupyterLab-themed)
│       ├── package.json          Frontend build
│       └── setup.py              Python packaging
├── scripts/
│   └── build_examples.py         Regenerates the example notebooks
├── pyproject.toml                Workspace deps (managed with uv)
└── README.md                     This file
```

## License

Course project. No license declared yet — treat as "all rights reserved" until that changes.
