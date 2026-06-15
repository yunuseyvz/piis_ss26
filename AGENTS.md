# AGENTS.md — FlowQuest

Operational guide for AI agents working in this repository. Read this before
making changes. It describes what the project actually is, how the pieces fit,
where to change behaviour, how to build and verify, and the known traps.

> **Accuracy note.** This file was last reconciled with the source code after the
> React frontend migration and the profile-store unification (June 2025). If
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
│       ├── src/                  React/TS frontend (see §5)
│       │   ├── state/            Store, hooks, context (see §5.1)
│       │   ├── components/       React components (see §5.2)
│       │   └── ...               Lumino wrappers and utilities
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

FlowQuest is a JupyterLab extension with a **React + TypeScript frontend** and a
**Python (Tornado) server extension**. The frontend uses **React 18** with
`useSyncExternalStore` for tear-free state reading, wrapped inside JupyterLab's
Lumino widget system. It talks to the backend over HTTP under
`/piis-assistant/...` (authenticated with Jupyter's normal auth).

### Frontend surfaces

- **Sidebar** (`sidebar.tsx` → `SidebarApp.tsx`) — three tabs: **Quest** (XP,
  missions, next-steps), **Flowy** (spontaneous quizzes about pasted/active
  code), **Chat** (notebook-aware LLM chat).
- **In-notebook banner** (`notebookBanner.tsx` → `NotebookBanner.tsx`) — HUD at
  the top of each notebook: level meter, XP, mission count, difficulty,
  settings/rescan.
- **Per-cell chip + inline panel** (`cellDecorations.tsx` → `CellPanel.tsx`) —
  region label, mission star; expands to Explain / Reflect / claim missions.
- **Virtual "quest cells"** (`questCells.tsx` + `components/ChoiceActivity.tsx`,
  `components/OpenActivity.tsx`) — LLM-generated between-cell activities
  (quiz / predict / teach-back) injected below real cells, anchored to a stable
  nbformat cell id.
- **Flowy avatar** (`components/AvatarAssistant.tsx` + `flowySprite.ts`) —
  floating character that reacts to state and catches large pastes.
- **Settings modal** (`components/SettingsModal.tsx`) — global endpoint config + fresh start +
  per-notebook difficulty/wipe.

### Architecture: Lumino ↔ React bridge

Each surface is a **Lumino widget** that creates a `ReactDOM.createRoot` and
renders its React component tree inside it. The `FlowQuestStore` singleton is
passed via `<StoreProvider>` (React context), so any descendant component can
call `useFlowQuestStore()` to subscribe to state.

```
index.ts (plugin activation)
  ├── commands.ts (JupyterLab commands & palette)
  ├── sidebar.tsx (Lumino widget → <StoreProvider><SidebarApp/></StoreProvider>)
  ├── settingsPanel.tsx (Lumino widget → <StoreProvider><SettingsModal/></StoreProvider>)
  └── notebookWiring.ts (central lifecycle manager)
        └── per-NotebookPanel UI widgets
              ├── notebookBanner.tsx (Lumino widget → <StoreProvider><NotebookBanner/></StoreProvider>)
              ├── cellDecorations.tsx (Lumino per-cell → <StoreProvider><CellPanel/></StoreProvider>)
              ├── questCells.tsx (Lumino injector → React activity components)
              └── avatarAssistant.tsx (Lumino widget → <StoreProvider><AvatarAssistant/></StoreProvider>)
```

### Single storage location — `~/.flowquest/profile.json`

This is the single most important architectural fact:

| Where | What lives there | Scope / lifetime | Owner |
| --- | --- | --- | --- |
| `~/.flowquest/profile.json` | **All XP, levels, award log, reflections, quiz tallies, idempotency keys, model/baseUrl/apiKey, favourite models** | **GLOBAL — per user, across every notebook** | **Server** (`profile_store.py`) |
| `notebook.metadata.flowquest` | `difficulty` + generated `quizzes` + per-notebook `chat` transcript | Per notebook, travels with the `.ipynb` | Frontend (`questStore.ts`) |

Both settings and progress are stored in a **single unified profile file**. The
API key prefers the OS keychain (via `keyring`) when available; otherwise it
falls back to a plaintext field inside `profile.json` with mode `0600`.

XP and levels are **global and server-owned**. The frontend keeps a single
in-memory mirror (`FlowQuestStore.globalState`) hydrated from the server and
fanned out to every open notebook via `useSyncExternalStore`. The only genuinely
per-notebook data the frontend persists into the `.ipynb` is the difficulty
preference, generated quiz content/answers, and chat transcript.

Idempotency keys are **namespaced per notebook by the handlers**
(`"<notebookPath>::<raw key>"`) so a given mission/quiz/reflection can be earned
**once per notebook** while XP pools into one global total. See `_notebook_ns`
in `handlers.py`.

### Data flow for a typical mutation ("claim a mission")

1. User clicks **Claim +N** on a mission card (sidebar or cell panel).
2. React component calls `store.claimMission({ notebookPath, missionId, ... })`.
3. Store fires `apiRequest('piis-assistant/mission/claim', ...)` to the backend.
4. `MissionClaimHandler` runs `_mutate_progress(lambda s: gamification.award_xp(...))` with award key `"<path>::mission:<id>"`. The mutation is pure, idempotent on the award key, and serialised under a process lock.
5. Handler returns `{ state: gamification.public_view(new_state), outcome }`.
6. Store calls `adoptGlobalState(response.state)` → emits to all subscribers → every React surface re-renders via `useSyncExternalStore`.

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
| `handlers.py` | Tornado route handlers + registration | `setup_handlers`, `_run_llm`, `_notebook_ns`, `_auto_check_rules`, `_mutate_progress`, all `*Handler` classes |
| `analyzer.py` | AST-based notebook analysis: region classification, dependency graph, issue detection, mission generation, quiz injection points | `analyze_notebook`, `result_to_dict`, `generate_missions`, `_compute_injection_points`, `_REGION_KEYWORDS` |
| `gamification.py` | Pure XP/level state mutations | `empty_state`, `normalize_state`, `public_view`, `award_xp`, `award_explore`, `record_reflection`, `record_quiz_attempt`, `apply_auto_checks` |
| `profile_store.py` | **Single unified profile** persistence (`~/.flowquest/profile.json`), settings + progress in one file, locking, atomic writes, keychain integration, legacy migration | `load`, `save`, `mutate`, `get_settings`, `update_settings`, `get_progress`, `update_progress`, `resolve_endpoint`, `public_settings`, `public_view` |
| `activities.py` | Registry of between-cell activity kinds + LLM generation/grading | `ACTIVITY_SPECS`, `KIND_QUIZ/PREDICT/TEACHBACK`, `generate_activity`, `grade_open_activity`, `spontaneous_quiz_payload` |
| `ai_backend.py` | OpenAI-compatible LLM client, prompts, error classification, JSON repair | `AssistantClient`, `AssistantBackendError`, `chat_payload`, `explain_cell_payload`, `reflect_prompt_payload`, `next_steps_payload`, `_DIFFICULTY_PROFILES`, `_safe_json_object`, `_FALLBACK_QUIZZES` |

> **Note**: The old `settings.py` and `progress_store.py` backward-compatibility
> shims have been removed. All code now imports from `profile_store` directly.

### Server routes (as registered in `handlers.py::setup_handlers`)

All under `/piis-assistant/`, all `@web.authenticated`.

| Route | Method | Handler | Notes |
| --- | --- | --- | --- |
| `status` | GET | `AssistantStatusHandler` | Endpoint config check |
| `chat` | POST | `AssistantChatHandler` | Notebook-aware chat |
| `analyze` | POST | `AnalyzeHandler` | Run analysis, apply auto-checks, return global state |
| `quest/init` | GET/POST | `QuestInitHandler` | Returns full profile (settings + progress) |
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
| `profile/reset` | POST | `ProfileResetHandler` | Wipe entire profile (settings + progress) for a fresh start |

### "Where do I change X?" (backend)

| Want to change… | Edit |
| --- | --- |
| Level thresholds, rank titles, XP categories | `gamification.py` (`_LEVEL_THRESHOLDS`, `_RANK_TITLES`, `XP_CATEGORIES`) |
| What counts as an "issue" | `analyzer.py` issue-detection blocks in `analyze_notebook` |
| Region classification keywords | `analyzer.py` `_REGION_KEYWORDS`, `REGION_ICONS`, `REGION_ORDER` |
| Mission generation | `ai_backend.py::generate_missions_payload` + `handlers.py::MissionGenerateHandler` |
| Difficulty prompt suffixes | `ai_backend.py::_DIFFICULTY_PROFILES` |
| Quiz fallback text | `ai_backend.py::_FALLBACK_QUIZZES` |
| Add a new between-cell activity kind | `activities.py` (`ACTIVITY_SPECS` + system prompt), analyzer injection logic, and a frontend React component in `src/components/` |
| LLM timeouts / retries / error mapping | `ai_backend.py` (`AssistantClient.chat`, `_classify_openai_error`) and `handlers.py::_LLM_DEADLINE_SECONDS` |
| Settings persistence / keychain | `profile_store.py` (`update_settings`, `_write_keychain_key`, `resolve_endpoint`) |

---

## 5. Frontend modules (`src/`)

### 5.1 State layer (`src/state/`)

| File | Responsibility |
| --- | --- |
| `store.ts` | `FlowQuestStore` — singleton state container with subscriber lists, API methods, and state adoption logic. Owns `globalState` (QuestState), `notebookSlices` (per-notebook), and `syncStatus`. |
| `hooks.ts` | `useGlobalState`, `useNotebookState`, `useSyncStatus` — all built on `useSyncExternalStore` for tear-free reads with stable subscribe/snapshot functions. |
| `StoreContext.tsx` | `StoreProvider` + `useFlowQuestStore()` — React context so components don't need the store prop-drilled. |
| `index.ts` | Barrel re-export of all state layer symbols. |

### 5.2 React components (`src/components/`)

| File | Responsibility |
| --- | --- |
| `SidebarApp.tsx` | Main sidebar: Quest/Flowy/Chat tabs, mission claiming, chat composer, Flowy quiz generation |
| `sidebar/QuestTab.tsx` | Quest tab: missions list, next-steps, region summary |
| `sidebar/FlowyTab.tsx` | Flowy tab: spontaneous quiz UI |
| `sidebar/ChatTab.tsx` | Chat tab: message list, prompt input, starters |
| `NotebookBanner.tsx` | In-notebook HUD: level meter, XP, missions, difficulty, generate |
| `CellPanel.tsx` | Per-cell inline panel: explain, reflect, claim missions |
| `AvatarAssistant.tsx` | Floating Flowy avatar: moods, bubbles, XP pops, paste detection |
| `SettingsModal.tsx` | Settings dialog: endpoint config, difficulty, wipe, fresh start |
| `ChoiceActivity.tsx` | MCQ/predict between-cell activity renderer |
| `OpenActivity.tsx` | Free-text (teach-back) between-cell activity renderer |
| `shared/` | Reusable atoms: `Icon`, `Spinner`, `AnimatedNumber`, `XpMeter`, `CategoryChart`, `MissionCard`, `ErrorBlock` |

### 5.3 Lumino wrappers and utilities

| File | Responsibility |
| --- | --- |
| `index.ts` | Plugin entry point. Owns the `FlowQuestStore` singleton, instantiates `NotebookWiring`, and registers commands. |
| `commands.ts` | Command and palette item registrations. |
| `notebookWiring.ts` | Central manager for notebook lifecycle, debounced analysis scheduling, and instantiation of per-notebook Lumino widgets. |
| `ReactWidget.ts` | Base class for React-backed Lumino widgets, unifying React mounting/unmounting. |
| `sidebar.tsx` | `AssistantSidebar` — Lumino widget wrapping `<StoreProvider><SidebarApp/></StoreProvider>` |
| `notebookBanner.tsx` | Lumino widget wrapping `<StoreProvider><NotebookBanner/></StoreProvider>` |
| `cellDecorations.tsx` | Lumino per-cell injector wrapping `<StoreProvider><CellPanel/></StoreProvider>` |
| `questCells.tsx` | `QuestCellRenderer` — manages virtual between-cell activity slots |
| `settingsPanel.tsx` | Lumino widget wrapping `<StoreProvider><SettingsModal/></StoreProvider>` |
| `avatarAssistant.tsx` | Lumino widget wrapping `<StoreProvider><AvatarAssistant/></StoreProvider>` |
| `api.ts` | `apiRequest` wrapper, `FlowquestApiError`, `escapeHtml`, `clipText`, client-side hash |
| `types.ts` | All shared TS interfaces; mirrors backend JSON. **`QuestState` mirrors `gamification.public_view()`** |
| `questState.ts` | `EMPTY_QUEST_STATE` constant |
| `questStore.ts` | `QuestMetadataStore` — reads/writes `metadata.flowquest` (difficulty + quizzes + per-notebook chat transcript), debounced save |
| `notebookContext.ts` | `describeNotebook` (chat context) + `buildAnalysisPayload` (analyze payload) |
| `flowySprite.ts` | SVG sprite renderer for Flowy moods |
| `markdown.ts` | Tiny, escape-first Markdown→HTML renderer for chat replies |
| `uiFeedback.ts` | Shared error/spinner/thinking HTML + `toFriendlyError` |
| `utils.ts` | Shared utilities: `formatRelative`, `stopKeyboardPropagation`, `containEvent` |
| `icons.ts` | Lucide SVG icon registry and helpers |

### Frontend conventions

- **React 18 with `useSyncExternalStore`**. UI components are standard React
  function components. State flows through `FlowQuestStore` → `useSyncExternalStore`
  hooks. Do not introduce class components or other state libraries.
- **Lumino wrappers bridge JupyterLab ↔ React**. Each surface is a Lumino widget
  that `createRoot`s a React tree inside `<StoreProvider>`. New surfaces should
  follow the same pattern.
- **Always HTML-escape interpolated values** with `escapeHtml` (from `api.ts`).
  Untrusted text (LLM output, cell source, user input) must be escaped, or
  rendered through `renderMarkdown` (which escapes first).
- **Injected DOM lives inside the notebook**, where JupyterLab intercepts
  mouse/keyboard events. Any new injected input must `stopPropagation()` on
  `mousedown/keydown/...` or it won't receive focus/keystrokes. Use the
  `containEvent` helper from `utils.ts`.
- **Virtual cells anchor by stable nbformat cell id**, never by index, so they
  survive insertions/deletions/moves.
- State changes flow one way: a mutating API call returns the new global state →
  `store.adoptGlobalState()` → `useSyncExternalStore` re-renders all surfaces.
- **No hooks-as-props**. Components import hooks directly from `state/hooks.ts`
  or use `useFlowQuestStore()` from context. Do not pass hooks as props.

### "Where do I change X?" (frontend)

| Want to change… | Edit |
| --- | --- |
| Global state shape / API methods | `state/store.ts` |
| How components subscribe to state | `state/hooks.ts` (useSyncExternalStore-based) |
| How the store is provided to components | `state/StoreContext.tsx` |
| Sidebar UI / tabs | `components/SidebarApp.tsx` + `components/sidebar/*.tsx` |
| In-notebook banner | `notebookBanner.tsx` (wrapper) + `components/NotebookBanner.tsx` |
| Cell inline panels | `cellDecorations.tsx` (wrapper) + `components/CellPanel.tsx` |
| Between-cell activities | `questCells.tsx` + `components/ChoiceActivity.tsx` / `OpenActivity.tsx` |
| Flowy avatar | `components/AvatarAssistant.tsx` + `flowySprite.ts` |
| Settings modal | `components/SettingsModal.tsx` |
| Shared icons | `icons.ts` |
| Shared error/spinner components | `components/shared/*.tsx` |

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
    Python, etc.) rather than inventing an ad-hoc harness.
- The LLM features need a configured endpoint (env/.env or in-app Settings).
  Without one, routes that call the model return a structured 503 and the UI
  shows friendly errors; analysis/XP still work offline.

---

## 7. LLM configuration

Resolution order (`profile_store.py::resolve_endpoint`):

1. **API key**: OS keychain (`keyring`, service `flowquest`) if a real backend
   exists; otherwise the plaintext fallback in `~/.flowquest/profile.json`
   (mode `0600`).
2. **Model / base URL**: `~/.flowquest/profile.json`.
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
- **File writes**: the profile file is written atomically (`.tmp` →
  `replace`) with `chmod 0600`.
- **Concurrency**: `profile_store.mutate` serialises read-modify-write under an
  `RLock`; use it (or the helper `_mutate_progress` in `handlers.py`) for any
  new award/record operation rather than touching the file directly.
- **Auth**: every handler is `@web.authenticated`. Public deployments
  (`JUPYTER_PUBLIC=1`) deliberately remove auth — flag this when touching
  deployment config.

---

## 9. Known issues & doc drift

Items 1–10 below were found and **fixed**. They're kept as a short changelog;
items 11–12 remain open.

1. **Documentation rewritten (done).** `docs/architecture.md`,
   `docs/extension.md`, the extension `README.md`, the top-level `README.md`, and
   `examples/README.md` now describe the actual XP/level model.

2. **Mission namespacing (done).** The frontend sends `notebookPath` on all
   mutating calls. Missions are earnable once **per notebook** while XP pools
   globally.

3. **Dead code in `ai_backend.py::_clip_text` (done).** Removed.

4. **Orphaned `quiz_payload` (done).** Removed from `ai_backend.py`.

5. **`next_steps_payload` "health" leftover (done).** Removed.

6. **Unused parameter (done).** `celebrateXp` no longer takes `category`.

7. **Boolean precedence (done).** `analyzer.py::_classify_region` parenthesised.

8. **Sidebar extracted (done).** The old monolithic `sidebar.ts` (~1010 lines
   of hand-rolled DOM) was replaced with a React component tree:
   `SidebarApp.tsx` + `QuestTab.tsx` + `FlowyTab.tsx` + `ChatTab.tsx`. Each
   component is under 250 lines.

9. **Settings/progress stores unified (done).** The old three-file split
   (`settings.py`, `progress_store.py`, `profile_store.py`) is now a single
   `profile_store.py` that stores everything in `~/.flowquest/profile.json`.
   The backward-compat shims (`settings.py`, `progress_store.py`) were deleted.
   All handlers import from `profile_store` directly.

10. **Settings key translation bug fixed (done).** `SettingsSaveHandler` was
    translating `baseUrl` → `base_url` (snake_case), but `profile_store` expects
    camelCase. This caused settings to silently fail to persist and fall back to
    env-var defaults (HF URLs). Fixed by removing the translation.

11. **No license clarity (open).** `package.json` says `"UNLICENSED"`; root
    README says "no license declared". Align these if licensing is decided.

12. **`analyzer.py` is still large (open).** ~950 lines. Well-sectioned, but
    consider extracting the mission/issue detection passes if you're already
    editing it.

13. **Auto-check rules and AST missions removed (done).** Hardcoded auto-checks and `analyzer.py::generate_missions` were removed in favor of strict LLM-based mission generation and verification (`ai_backend.py::_VERIFY_SYSTEM`).

14. **Mission generation and verification overhaul (done).** Missions are now generated strictly via LLM and are cached along with their `original_sources` (the code state of the targeted cells at the time of generation). The `MissionCheckHandler` passes both the `BEFORE` (cached) and `AFTER` (current) code to the LLM for strict verification, preventing hallucinated success without actual code changes.
    
15. **Mission UI polish (done).** Mission cards now expand smoothly on hover. The "Rescan" button was renamed to "Generate", and missions are no longer aggressively regenerated when reloading the page.

When you fix items 11 or 12, update this section.

---

## 10. Conventions & etiquette for agents

- **Edit source, not generated output.** Touch `src/*.ts`, `src/*.tsx`, and
  `jupyterlab_piis_assistant/*.py`; never `lib/`, `labextension/`, `build/`, or
  `*.egg-info/`.
- **Match the existing style**: React function components on the frontend, pure
  state-in/state-out mutations on the backend, full type hints, section-header
  comments (`# ---- ... ----`), and docstrings that explain *why*.
- **Use the Store pattern**: state flows through `FlowQuestStore` →
  `useSyncExternalStore` hooks. Do not compute XP/score client-side.
- **Use `<StoreProvider>`**: when creating a new React root in a Lumino wrapper,
  always wrap in `<StoreProvider store={store}>`. Components import hooks
  directly — never pass hook functions as props.
- **Keep mutations idempotent** and routed through `profile_store.mutate` (or
  `_mutate_progress` in `handlers.py`).
- **Preserve security invariants** (§8).
- **Don't add a test framework or linter silently** — there is none today;
  introduce one deliberately and consistently if asked.
- **The `.ipynb` is user data.** Changes to `metadata.flowquest` shape must stay
  backward-compatible or normalise older blobs (`gamification.normalize_state`
  and `questStore` already tolerate missing/legacy fields — keep that property).
