# AGENTS.md — FlowQuest

Operational guide for AI agents working in this repository. Read this before
making changes. It describes what the project actually is, how the pieces fit,
where to change behaviour, how to build and verify, and the known traps.

> **Accuracy note.** This file and the prose docs under `docs/` + the two
> `README.md` files were reconciled with the **source code** (the old "Notebook
> Health" design was removed and the docs rewritten to the XP/level model). If
> code and docs ever diverge again, trust the code, then update both. See
> "Known issues & doc drift" below for the change history.

---

## 1. What FlowQuest is

FlowQuest is a **gamified, context-aware companion for JupyterLab**. It analyses
the open notebook and turns the act of working through it — exploring,
understanding, stabilising, reflecting — into a quest with **XP, levels, ranks,
missions, between-cell activities (quizzes), per-cell hints, and a notebook-aware
LLM chat**. It rewards engagement and workflow understanding, not final code
correctness.

It is built for the course *Practical Intelligent Interactive Systems for
Software Developers*. The design goal is an assistant that supports notebook
authoring without being a generic chatbot.

### Naming (important for searching)

Three names refer to the same thing:

- **FlowQuest** — the product / brand name shown in the UI.
- **`piis-assistant`** — the extension directory name.
- **`jupyterlab_piis_assistant`** / **`jupyterlab-piis-assistant`** — the Python
  package and the JupyterLab labextension name.

"Flowy" is the in-notebook floating avatar character, a sub-feature of FlowQuest.

---

## 2. Repository layout

```
.
├── AGENTS.md                     This file
├── Dockerfile                    Multi-stage production image (Node build → Python runtime)
├── docker-compose.yml            Coolify-friendly compose definition
├── deploy/
│   ├── entrypoint.sh             Container boot: seed notebooks, write .env, set auth, exec jupyter
│   ├── jupyter_server_config.py  Runtime Jupyter config
│   └── requirements.txt          Runtime Python deps for the image
├── docs/                         Prose docs (reconciled with code)
│   ├── architecture.md
│   ├── deployment.md
│   └── extension.md
├── examples/                     Three notebooks that exercise FlowQuest
│   ├── 01_explore.ipynb
│   ├── 02_model.ipynb
│   └── 03_messy_on_purpose.ipynb
├── scripts/
│   ├── build_examples.py         Regenerates the example notebooks
│   └── setup.sh                  Local bootstrap: build + install the extension into .venv
├── jupyterlab_extensions/
│   └── piis-assistant/           THE EXTENSION (frontend + server backend)
│       ├── jupyterlab_piis_assistant/   Python server extension (see §4)
│       ├── src/                  TypeScript frontend (see §5)
│       ├── style/index.css       All styling (JupyterLab theme vars)
│       ├── package.json          Frontend build scripts + JupyterLab config
│       ├── setup.py              Packages the built labextension/ assets
│       ├── pyproject.toml        Build-system shim (setuptools)
│       └── tsconfig.json         TypeScript options
├── pyproject.toml                Workspace deps (managed with uv)
└── .env / .env.example           LLM endpoint config (fallback source)
```

Build artifacts are git-ignored and may exist locally: `src/` compiles to `lib/`
(via `tsc`), and `jupyterlab labextension build` emits
`jupyterlab_piis_assistant/labextension/`. The `*.egg-info/`, `build/`,
`node_modules/`, and `lib/` directories are generated — **never edit them by
hand**; edit `src/` and the Python package, then rebuild.

---

## 3. The mental model (how it actually works)

FlowQuest is a JupyterLab extension with a **TypeScript frontend** and a
**Python (Tornado) server extension**. The frontend draws four surfaces and
talks to the backend over HTTP under `/piis-assistant/...` (authenticated with
Jupyter's normal auth).

Frontend surfaces:

- **Sidebar** (`sidebar.ts`) — three tabs: **Quest** (XP, missions, next-steps),
  **Flowy** (spontaneous quizzes about pasted/active code), **Chat**
  (notebook-aware LLM chat).
- **In-notebook banner** (`notebookBanner.ts`) — HUD at the top of each notebook:
  level meter, XP, mission count, difficulty, settings/rescan.
- **Per-cell chip + inline panel** (`cellDecorations.ts`) — region label, health
  dot, mission star; expands to Explain / Reflect / claim missions.
- **Virtual "quest cells"** (`questCells.ts` + `cellModules/`) — LLM-generated
  between-cell activities (quiz / predict / teach-back) injected below real
  cells, anchored to a stable nbformat cell id.
- **Flowy avatar** (`avatarAssistant.ts` + `flowySprite.ts`) — floating character
  that reacts to state and catches large pastes.

### Two storage locations — read this carefully

This is the single most important architectural fact:

| Where | What lives there | Scope / lifetime | Owner |
| --- | --- | --- | --- |
| `~/.flowquest/progress.json` | **All XP, levels, award log, reflections, quiz tallies, idempotency keys** | **GLOBAL — per user, across every notebook** | **Server** (`progress_store.py`) |
| `~/.flowquest/settings.json` (+ OS keychain) | Model, base URL, API key, favourite models | Per user | Server (`settings.py`) |
| `notebook.metadata.flowquest` | **Only `difficulty` + generated `quizzes`** | Per notebook, travels with the `.ipynb` | Frontend (`questStore.ts`) |

XP and levels are **global and server-owned**. The frontend keeps a single
in-memory mirror (`globalState` in `index.ts`) hydrated from the server and
fanned out to every open notebook. The only genuinely per-notebook data the
frontend persists into the `.ipynb` is the difficulty preference and the
generated quiz content/answers.

Idempotency keys are **namespaced per notebook by the handlers**
(`"<notebookPath>::<raw key>"`) so a given mission/quiz/reflection can be earned
**once per notebook** while XP pools into one global total. See `_notebook_ns`
in `handlers.py`.

### Data flow for a typical mutation ("claim a mission")

1. User clicks **Claim +N** on a mission card (sidebar or cell panel).
2. Frontend calls `apiRequest('piis-assistant/mission/claim', { state, missionId, category, xp, label, notebookPath })`.
3. `MissionClaimHandler` runs `progress_store.mutate(lambda s: gamification.award_xp(...))` with award key `"<path>::mission:<id>"`. The mutation is pure, idempotent on the award key, and serialised under a process lock.
4. Handler returns `{ state: gamification.public_view(new_state), outcome }`.
5. Frontend `commitGlobalState(state)` replaces the in-memory mirror and re-renders **every** open notebook's surfaces.

Every mutating route follows the same shape: **state in → pure mutation → new
state out**, idempotent on a unique award key. The server is the source of truth
for the XP total; the frontend never computes the score.

### XP → Level model (`gamification.py`)

- XP only grows. Four categories: `exploration`, `understanding`,
  `stabilization`, `reflection`.
- Level is derived from total XP via `_LEVEL_THRESHOLDS`; each level maps to a
  rank title in `_RANK_TITLES`. Beyond the table, levels cost a flat 400 XP.
- `public_view()` returns the persisted fields plus derived ones (`level`,
  `rankTitle`, `levelProgress`, `xpToNextLevel`, …). There is **no** health
  score, baseline, or win condition anymore.

---

## 4. Backend modules (`jupyterlab_piis_assistant/`)

| File | Responsibility | Key symbols |
| --- | --- | --- |
| `__init__.py` | Extension entry points for Jupyter | `load_jupyter_server_extension`, `_jupyter_labextension_paths` |
| `handlers.py` | Tornado route handlers + registration | `setup_handlers`, `_run_llm`, `_notebook_ns`, `_auto_check_rules`, all `*Handler` classes |
| `analyzer.py` | AST-based notebook analysis: region classification, dependency graph, issue detection, mission generation, quiz injection points | `analyze_notebook`, `result_to_dict`, `generate_missions`, `_compute_injection_points`, `_REGION_KEYWORDS` |
| `gamification.py` | Pure XP/level state mutations | `empty_state`, `normalize_state`, `public_view`, `award_xp`, `award_explore`, `record_reflection`, `record_quiz_attempt`, `apply_auto_checks` |
| `progress_store.py` | Global progress persistence (`~/.flowquest/progress.json`), locking, atomic writes | `mutate`, `view`, `load`, `save`, `reset`, `forget_notebook` |
| `activities.py` | Registry of between-cell activity kinds + LLM generation/grading | `ACTIVITY_SPECS`, `KIND_QUIZ/PREDICT/TEACHBACK`, `generate_activity`, `grade_open_activity`, `spontaneous_quiz_payload` |
| `ai_backend.py` | OpenAI-compatible LLM client, prompts, error classification, JSON repair | `AssistantClient`, `AssistantBackendError`, `chat_payload`, `explain_cell_payload`, `reflect_prompt_payload`, `next_steps_payload`, `_DIFFICULTY_PROFILES`, `_safe_json_object`, `_FALLBACK_QUIZZES` |
| `settings.py` | Global model/API-key resolution (keychain → file → env/.env) | `resolve_endpoint`, `load_global_settings`, `save_global_settings`, `public_settings` |

### Server routes (as registered in `handlers.py::setup_handlers`)

All under `/piis-assistant/`, all `@web.authenticated`.

| Route | Method | Handler | Notes |
| --- | --- | --- | --- |
| `status` | GET | `AssistantStatusHandler` | Endpoint config check |
| `chat` | POST | `AssistantChatHandler` | Notebook-aware chat |
| `analyze` | POST | `AnalyzeHandler` | Run analysis, apply auto-checks, return global state |
| `quest/init` | GET/POST | `QuestInitHandler` | Current global progression view |
| `mission/claim`, `quest/claim` | POST | `MissionClaimHandler` | Idempotent XP award per (notebook, missionId) |
| `explain-cell` | POST | `ExplainCellHandler` | LLM explanation + explore XP |
| `reflect/prompt` | POST | `ReflectPromptHandler` | LLM reflective question |
| `reflect/answer` | POST | `ReflectAnswerHandler` | Persist reflection + XP |
| `next-steps` | POST | `NextStepsHandler` | LLM three next steps |
| `quiz/generate`, `activity/generate` | POST | `QuizGenerateHandler` | Generate a between-cell activity |
| `quiz/answer`, `activity/answer` | POST | `QuizAnswerHandler` | Record MCQ attempt + XP |
| `activity/grade` | POST | `ActivityGradeHandler` | LLM-grade an open (teach-back) answer + XP |
| `activities` | GET | `ActivityRegistryHandler` | Public list of activity kinds |
| `flowy/quiz` | POST | `FlowyQuizHandler` | Spontaneous quiz about a snippet |
| `flowy/quiz/answer` | POST | `FlowyQuizAnswerHandler` | XP for a Flowy quiz answer |
| `settings` | GET | `SettingsGetHandler` | Settings without the API key |
| `settings/save` | POST | `SettingsSaveHandler` | Persist model/baseUrl/apiKey/favourites |
| `state/wipe` | POST | `StateWipeHandler` | Reset (scope `notebook` clears keys; `global` resets all) |

> There is **no** `/initialize`, `/criteria`, or `/state/difficulty` route. The
> old docs list them; they don't exist. Difficulty is frontend-only, stored in
> notebook metadata.

### "Where do I change X?" (backend)

| Want to change… | Edit |
| --- | --- |
| Level thresholds, rank titles, XP categories | `gamification.py` (`_LEVEL_THRESHOLDS`, `_RANK_TITLES`, `XP_CATEGORIES`) |
| What counts as an "issue" | `analyzer.py` issue-detection blocks in `analyze_notebook` |
| Region classification keywords | `analyzer.py` `_REGION_KEYWORDS`, `REGION_ICONS`, `REGION_ORDER` |
| Mission generation | `analyzer.py::generate_missions` |
| Auto-checks that grant XP on analyze | `handlers.py::_auto_check_rules` |
| Difficulty prompt suffixes | `ai_backend.py::_DIFFICULTY_PROFILES` |
| Quiz fallback text | `ai_backend.py::_FALLBACK_QUIZZES` |
| Add a new between-cell activity kind | `activities.py` (`ACTIVITY_SPECS` + system prompt), analyzer injection logic, and a frontend `CellModule` in `src/cellModules/` |
| LLM timeouts / retries / error mapping | `ai_backend.py` (`AssistantClient.chat`, `_classify_openai_error`) and `handlers.py::_LLM_DEADLINE_SECONDS` |

---

## 5. Frontend modules (`src/`)

| File | Responsibility |
| --- | --- |
| `index.ts` | Plugin entry point. Owns per-`NotebookPanel` `PanelBundle`s, the shared global state mirror, analyze scheduling, commands, palette items |
| `api.ts` | `apiRequest` wrapper, `FlowquestApiError`, `escapeHtml`, `clipText`, client-side hash |
| `types.ts` | All shared TS interfaces; mirrors backend JSON. **`QuestState` mirrors `gamification.public_view()`** |
| `questState.ts` | `EMPTY_QUEST_STATE` constant |
| `questStore.ts` | `QuestMetadataStore` — reads/writes `metadata.flowquest` (difficulty + quizzes only), debounced save |
| `notebookContext.ts` | `describeNotebook` (chat context) + `buildAnalysisPayload` (analyze payload) |
| `notebookBanner.ts` | In-notebook HUD banner |
| `cellDecorations.ts` | Per-cell chip + inline Explain/Reflect/missions panel |
| `questCells.ts` | Generic between-cell activity injector (anchoring, persistence, network) |
| `cellModules/` | Per-activity-kind renderers: `choiceModule.ts` (quiz/predict), `openModule.ts` (teach-back), `index.ts` registry, `types.ts` interfaces |
| `sidebar.ts` | The Quest/Flowy/Chat sidebar widget (largest file, ~1000 lines) |
| `settingsPanel.ts` | Modal: global endpoint settings + per-notebook difficulty + wipe |
| `avatarAssistant.ts` | Flowy avatar: moods, bubbles, XP celebration, paste detection |
| `flowySprite.ts` | SVG sprite renderer for Flowy moods |
| `markdown.ts` | Tiny, escape-first Markdown→HTML renderer for chat replies |
| `uiFeedback.ts` | Shared error/spinner/thinking HTML + `toFriendlyError` |

### Frontend conventions

- **No framework.** Everything is hand-rolled DOM via `innerHTML` string
  templates + `querySelectorAll('[data-action]')` click binding. Match this
  style; do not introduce React/Lumino widgets for new surfaces.
- **Always HTML-escape interpolated values** with `escapeHtml` (from `api.ts`).
  Untrusted text (LLM output, cell source, user input) must be escaped, or
  rendered through `renderMarkdown` (which escapes first).
- **Injected DOM lives inside the notebook**, where JupyterLab intercepts
  mouse/keyboard events. Any new injected input must `stopPropagation()` on
  `mousedown/keydown/...` or it won't receive focus/keystrokes. See the `contain`
  handlers in `cellDecorations.ts` and `questCells.ts`.
- **Virtual cells anchor by stable nbformat cell id**, never by index, so they
  survive insertions/deletions/moves.
- State changes flow one way: a mutating API call returns the new global state →
  `applyState`/`commitGlobalState` → re-render all surfaces.

---

## 6. Build, run, verify

Requirements: **Python 3.12+**, **Node 20+**, and **`uv`**.

### Local development

```bash
# 1. Workspace deps + JupyterLab into .venv
uv sync

# 2. Build the TS bundle and install the extension into the venv
bash scripts/setup.sh

# 3. Launch against the example notebooks
uv run jupyter lab examples
```

Re-run `bash scripts/setup.sh` after **any** `uv sync` or extension code change —
`uv sync` only manages declared deps and can drop the locally built extension.

Verify the extension is installed:

```bash
uv run jupyter labextension list | grep piis
# jupyterlab-piis-assistant v0.1.0 enabled OK (python, jupyterlab-piis-assistant)
```

### Frontend-only iteration

```bash
cd jupyterlab_extensions/piis-assistant
npm run watch        # continuous tsc compile (long-running; run in your own terminal)
# in another terminal, after backend/asset changes:
PATH="../../.venv/bin:$PATH" npm run build
uv pip install --python ../../.venv/bin/python .
```

Refresh the JupyterLab browser tab for frontend changes; **restart the Jupyter
server** for backend (Python) changes.

### npm scripts (`package.json`)

- `npm run clean` — remove `lib/`, `labextension/`, build caches.
- `npm run build` — `clean && tsc && jupyter labextension build .`.
- `npm run watch` — `tsc -w`.

> `npm run build` requires `jupyter labextension build` (a Python command) on
> `PATH`, i.e. the venv must be active or prepended to `PATH` as shown above.

### Docker

```bash
docker compose up --build   # JupyterLab on http://localhost:8888
```

See `docs/deployment.md` (still accurate) for Coolify and public/token-less
deployment. Key env vars: `HF_OPENAI_BASE_URL`, `HF_OPENAI_MODEL`,
`HF_OPENAI_API_KEY`, `JUPYTER_PUBLIC`, `JUPYTER_TOKEN`, `JUPYTER_ALLOW_ORIGIN`.

### Verification expectations

- **There is no automated test suite** and **no configured linter/formatter**
  for either the TS or Python code. After changes:
  - Run `npm run build` (TypeScript is `strict`; a clean compile is the main
    gate for the frontend).
  - For backend changes, restart Jupyter and exercise the affected route, or use
    `getDiagnostics` on the edited files.
  - If you add tests, set up the standard tooling for the ecosystem (pytest for
    Python, Jest is already present in `node_modules` for TS) rather than
    inventing an ad-hoc harness.
- The LLM features need a configured endpoint (env/.env or in-app Settings).
  Without one, routes that call the model return a structured 503 and the UI
  shows friendly errors; analysis/XP still work offline.

---

## 7. LLM configuration

Resolution order (`settings.py::resolve_endpoint`):

1. **API key**: OS keychain (`keyring`, service `flowquest`) if a real backend
   exists; otherwise the plaintext fallback in `~/.flowquest/settings.json`
   (mode `0600`).
2. **Model / base URL**: `~/.flowquest/settings.json`.
3. **Fallback**: env vars (`HF_OPENAI_BASE_URL/MODEL/API_KEY`, plus `OPENAI_*`
   and bare `BASE_URL/MODEL/API_KEY` aliases) and a workspace `.env`.

The client is the OpenAI SDK pointed at any OpenAI-compatible endpoint. Calls run
in a worker thread with a hard deadline (`_LLM_DEADLINE_SECONDS = 75s`) and
bounded retries with backoff. `response_format=json_object` is attempted first
and dropped on backends that reject it.

---

## 8. Security notes (preserve these)

- **HTML escaping**: all user/LLM/cell text is escaped before insertion;
  `markdown.ts` escapes before transforming and only allows `http(s)`/`mailto`
  links. Keep this invariant for any new rendering.
- **API key handling**: never log or return the API key. `public_settings`
  returns only a masked preview and a storage indicator.
- **File writes**: settings and progress are written atomically (`.tmp` →
  `replace`) with `chmod 0600`.
- **Concurrency**: `progress_store.mutate` serialises read-modify-write under an
  `RLock`; use it for any new award/record operation rather than touching the
  file directly.
- **Auth**: every handler is `@web.authenticated`. Public deployments
  (`JUPYTER_PUBLIC=1`) deliberately remove auth — flag this when touching
  deployment config.

---

## 9. Known issues & doc drift

Items 1–7 below were found and **fixed** (docs rewritten to the XP/level model,
namespacing corrected, dead code removed). They're kept as a short changelog;
items 8–9 remain open.

1. **Documentation rewritten (done).** `docs/architecture.md`,
   `docs/extension.md`, the extension `README.md`, the top-level `README.md`, and
   `examples/README.md` now describe the actual XP/level model. The removed
   "Notebook Health" system (`criteria.py`, `HealthCriterion`, `baselineHealth`,
   `healthScore`, `wonAt`, `award_health`, routes `/initialize`, `/criteria`,
   `/state/difficulty`) is gone from the prose. The `metadata.flowquest` schema
   is documented correctly (difficulty + quizzes only; XP is global/server-side),
   and the sidebar is "Quest / Flowy / Chat".

2. **Mission namespacing (done).** The frontend now sends `notebookPath` on the
   mutating calls (`mission/claim`, `explain-cell`, `reflect/answer`) and uses a
   shared `api.notebookAwardPrefix(notebookPath)` helper to namespace the
   "already claimed" / "explored" checks in `sidebar.ts`, `notebookBanner.ts`,
   and `cellDecorations.ts`, matching the backend's `_notebook_ns`. Missions are
   now correctly earnable once **per notebook** while XP pools globally.

3. **Dead code in `ai_backend.py::_clip_text` (done).** Unreachable duplicate
   block removed.

4. **Orphaned `quiz_payload` (done).** Removed from `ai_backend.py`, along with
   the now-unused `_QUIZ_SYSTEM` constant. The shared helpers (`_safe_json_object`,
   `_normalize_quiz`, `_fallback_quiz`, `_FALLBACK_QUIZZES`) remain — `activities.py`
   still uses them.

5. **`next_steps_payload` "health" leftover (done).** The `analysis.get("health")`
   read and the `"Notebook health: …/100"` prompt line were removed.

6. **Unused parameter (done).** `avatarAssistant.ts::celebrateXp` no longer takes
   `category`; both call sites in `index.ts` updated.

7. **Boolean precedence (done).** `analyzer.py::_classify_region` now parenthesises
   `startswith("print(") or (endswith(")") and len < 80)`.

8. **Large files (open).** `sidebar.ts` (~1010 lines) and `analyzer.py` (~950
   lines) are doing a lot. Well-sectioned, but consider extracting tab-render
   helpers (`sidebar.ts`) or the mission/issue detection passes (`analyzer.py`)
   if you're already editing them.

9. **No license clarity (open).** `package.json` says `"UNLICENSED"`; root README
   says "no license declared". Align these if licensing is decided.

When you fix items 8 or 9, update this section.

---

## 10. Conventions & etiquette for agents

- **Edit source, not generated output.** Touch `src/*.ts` and
  `jupyterlab_piis_assistant/*.py`; never `lib/`, `labextension/`, `build/`, or
  `*.egg-info/`.
- **Match the existing style**: hand-rolled DOM templates on the frontend, pure
  state-in/state-out mutations on the backend, full type hints, section-header
  comments (`# ---- ... ----`), and docstrings that explain *why*.
- **Keep mutations idempotent** and routed through `progress_store.mutate`.
- **Keep the frontend honest**: never compute the XP/score client-side; render
  what the server returns.
- **Preserve security invariants** (§8).
- **Don't add a test framework or linter silently** — there is none today;
  introduce one deliberately and consistently if asked.
- **The `.ipynb` is user data.** Changes to `metadata.flowquest` shape must stay
  backward-compatible or normalise older blobs (`gamification.normalize_state`
  and `questStore` already tolerate missing/legacy fields — keep that property).
