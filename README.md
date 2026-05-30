# FlowQuest

A gamified, context-aware companion for JupyterLab. FlowQuest analyses your notebook and turns the learning process — exploring, understanding, stabilizing, and reflecting on your work — into a quest with XP, levels, ranks, missions, quizzes, and per-cell hints. It rewards engagement and workflow understanding, not final code correctness.

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
3. Open `examples/03_messy_on_purpose.ipynb` and press **🔄 Re-scan** in the in-notebook banner (FlowQuest also scans automatically as you edit). Mission cards appear in the sidebar's Quest tab; activity cells appear between the real cells.

A `.env.example` is included if you'd rather configure the LLM endpoint that way; it's read as a fallback.

## What FlowQuest does

| Surface | What it shows |
| --- | --- |
| **In-notebook banner** | Level + XP meter, rank, open-mission count, difficulty selector, settings/re-scan shortcuts. |
| **Per-cell chip** | Region label (load / clean / model / …), issue dot, mission star, expand button. |
| **Inline cell panel** | Issues, dependencies, Explain / Reflect buttons, mission claims for that cell. |
| **Virtual activity cells** | Auto-generated quizzes, predictions, and teach-backs inserted between real cells, anchored to a stable cell id. |
| **Sidebar** | Three tabs: Quest (XP by category, missions, next-steps), Flowy (spontaneous quizzes on pasted/active code), Chat (notebook-aware LLM chat). |
| **Flowy avatar** | Floating companion that reacts to your progress and offers to quiz you on big pastes. |
| **Settings modal** | Global model + API key, per-notebook difficulty, reset-progress buttons. |

XP and levels are **global** to you (server-side, at `~/.flowquest/progress.json`) and accumulate across every notebook. The only per-notebook state is the difficulty preference and generated quizzes, which live in `metadata.flowquest` and travel with the `.ipynb`.

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
│   ├── build_examples.py         Regenerates the example notebooks
│   └── setup.sh                  Local bootstrap: build + install the extension into .venv
├── pyproject.toml                Workspace deps (managed with uv)
└── README.md                     This file
```

## License

Course project. No license declared yet — treat as "all rights reserved" until that changes.
