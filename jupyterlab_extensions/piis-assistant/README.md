# JupyterLab PIIS Assistant Extension

This folder contains a minimal JupyterLab extension that adds one assistant sidebar and one server-side chat endpoint.

## What It Does

- adds an `Assistant` sidebar on the left side of JupyterLab
- reads prompts from the sidebar UI
- sends them to a server-side route at `/piis-assistant/chat`
- uses the repository root `.env` file for the HF OpenAI-compatible endpoint configuration

The extension currently stays intentionally simple. It does not inspect the notebook, cell selection, or outputs yet.

## Required Environment Variables

The server-side route expects these values in the repository root `.env` file:

- `HF_OPENAI_BASE_URL`
- `HF_OPENAI_MODEL`
- `HF_OPENAI_API_KEY`

## Install For Local Development

From the repository root:

```bash
uv sync
cd jupyterlab_extensions/piis-assistant
npm install
npm run build
uv pip install --python ../../.venv/bin/python .
cd ../..
uv run jupyter lab
```

After JupyterLab opens in the browser:

- look for the `Assistant` sidebar on the left
- or open the command palette and run `PIIS: Focus Assistant Sidebar`

## Iterating On The Extension

Use one terminal for TypeScript compilation:

```bash
source .venv/bin/activate
cd jupyterlab_extensions/piis-assistant
npm run watch
```

Use a second terminal to rebuild and reinstall the extension when needed:

```bash
source .venv/bin/activate
cd jupyterlab_extensions/piis-assistant
npm run build
uv pip install --python ../../.venv/bin/python .
```

Refresh the JupyterLab browser tab after each rebuild.

## VS Code Note

This extension targets the JupyterLab frontend plugin API. It will not show up inside the VS Code notebook editor.