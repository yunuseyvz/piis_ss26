# PIIS AI-Enhanced Notebook Demo

This repository contains a small `uv`-managed Python project for the course **Practical Intelligent Interactive Systems for Software Developers**.

The main artifact is a mock Jupyter notebook that acts as a realistic computational essay for exploring **AI-enhanced literate programming** ideas. It uses a synthetic SaaS customer-health dataset, combines narrative and code, and includes multiple visualizations plus a lightweight predictive modeling section.

## What Is In This Repo

- `notebooks/ai_enhanced_literate_programming_demo.ipynb`: the example notebook used as a baseline for later AI experiments.
- `pyproject.toml`: the `uv` project configuration and Python dependencies.
- `ideas.md`: a collection of course ideas for enhancing notebook-style literate programming with AI and LLM systems.
- `jupyterlab_extensions/piis-assistant`: a minimal JupyterLab extension that adds a live AI assistant sidebar.

## What The Notebook Covers

The notebook is intentionally rich enough to support later experimentation. It includes:

- synthetic dataset generation
- exploratory analysis
- feature engineering
- multiple static and interactive visualizations
- a compact modeling section with baseline churn prediction

This gives you a practical artifact for trying ideas such as narrative-code drift detection, provenance summaries, critique agents, or reader-adaptive explanations.

## Prerequisites

- Python 3.12+
- `uv` installed locally

If `uv` is not installed yet, see: <https://docs.astral.sh/uv/>

## Run With uv

From the repository root:

```bash
uv sync
```

This creates `.venv` and installs the dependencies from `pyproject.toml`.

To start JupyterLab with the project environment:

```bash
uv run jupyter lab
```

Then open:

- `notebooks/ai_enhanced_literate_programming_demo.ipynb`

## JupyterLab Assistant Extension

The repo now includes a minimal JupyterLab extension that adds a simple assistant sidebar.

The sidebar sends prompts to a server-side Jupyter route, which reads the repository root `.env` file and expects:

- `HF_OPENAI_BASE_URL`
- `HF_OPENAI_MODEL`
- `HF_OPENAI_API_KEY`

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

- the `Assistant` sidebar should appear on the left automatically
- you can also use the command palette entry `PIIS: Focus Assistant Sidebar`
- type a prompt, send it, and the reply will appear in the sidebar

More extension details live in `jupyterlab_extensions/piis-assistant/README.md`.

## VS Code Note

This is a JupyterLab extension, so it works in browser-based JupyterLab and does **not** render inside the VS Code notebook editor.

## Optional Commands

Execute the notebook from the command line to verify it runs end to end:

```bash
uv run jupyter nbconvert --to notebook --execute notebooks/ai_enhanced_literate_programming_demo.ipynb --output executed.ipynb
```

If you want to work inside the environment directly:

```bash
source .venv/bin/activate
```

## Intended Use

This repo is a starting point for course work on questions such as:

- how AI systems can support notebook authoring and reading
- how to keep notebook prose and code aligned over time
- how to make notebook reasoning more reproducible and inspectable
- how to move from a single assistant toward mixed-initiative or multi-agent notebook workflows

See `ideas.md` for the broader concept list.