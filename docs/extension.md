# FlowQuest extension reference

A practical reference for the extension's API surface, persistence model, and the few rules you need in your head.

## Persistence model

### Unified profile (server-owned)

XP, levels, settings, and progression belong to the **user**, not the notebook. They live server-side in a single file at `~/.flowquest/profile.json` (mode `0600`), owned by `profile_store.py`. The file contains both settings (model, base URL, favourite models) and progression (XP, awards). Shape (after normalisation by `gamification.normalize_state`):

```json
{
  "schemaVersion": 4,
  "settings": {
    "model": "meta-llama/Llama-3.1-8B-Instruct",
    "baseUrl": "https://router.huggingface.co/v1",
    "favoriteModels": ["meta-llama/Llama-3.1-8B-Instruct"]
  },
  "xpTotal": 128,
  "xpByCategory": {
    "exploration": 40,
    "understanding": 53,
    "stabilization": 27,
    "reflection": 8
  },
  "completedAwardKeys": [
    "notebooks/03_messy.ipynb::mission:stab-rerun-clean",
    "notebooks/03_messy.ipynb::explain:abc123",
    "notebooks/03_messy.ipynb::reflection:cell-4"
  ],
  "exploredCellHashes": ["notebooks/03_messy.ipynb::abc123"],
  "awardLog": [
    { "key": "...::mission:stab-rerun-clean", "category": "stabilization", "xp": 8, "label": "Fix the flow", "ts": 1.7e9 }
  ],
  "reflections": [
    { "cellIndex": 4, "text": "Stratified split because classes are imbalanced.", "ts": 1.7e9 }
  ],
  "quizAttempts": 3,
  "quizCorrect": 2,
  "streakDays": 1,
  "lastActiveTs": 1.7e9
}
```

`public_view()` returns these fields **plus derived ones** the UI renders: `level`, `rankTitle`, `xpIntoLevel`, `xpForNextLevel`, `xpToNextLevel`, `levelProgress`, `categoryTotal`. The frontend never computes the score; it renders what `public_view()` returns.

The **API key** prefers the OS keychain (`keyring`, service `flowquest`) when a real backend is present, falling back to plaintext inside `profile.json` otherwise. If nothing is configured there, the resolver falls back to environment variables (`HF_OPENAI_BASE_URL`, `HF_OPENAI_MODEL`, `HF_OPENAI_API_KEY`, plus `OPENAI_*` / bare aliases) and the workspace `.env`. See `profile_store.resolve_endpoint`.

Rules:

- Every award key in `completedAwardKeys` is unique. The same award can't be granted twice.
- Award keys are **namespaced per notebook** by the handlers: `"<notebookPath>::<raw key>"` (see `handlers._notebook_ns`). So a mission/quiz/reflection is earnable once *per notebook*, while XP pools into one global total. The frontend must use the same prefix when checking "already claimed" — see `api.notebookAwardPrefix`.
- `level` is derived from `xpTotal` via `gamification._LEVEL_THRESHOLDS`; the matching title comes from `_RANK_TITLES`. Beyond the table each level costs a flat 400 XP.
- There is no health score, baseline, or win condition.

### Per-notebook metadata (frontend-owned)

Stored at `metadata.flowquest` inside the `.ipynb` by `questStore.ts`. **Three things live here** — the data that is genuinely per-notebook:

```json
{
  "difficulty": "medium",
  "quizzes": {
    "<anchorCellId>::quiz:clean": {
      "slotId": "...",
      "anchorCellId": "...",
      "region": "clean",
      "activityKind": "quiz",
      "quiz": { "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0, "explanation": "..." },
      "selectedIndex": 0,
      "answeredCorrectly": true,
      "attempts": 1,
      "awardedXp": 5,
      "generatedAt": 1.7e9
    }
  },
  "chat": [
    { "role": "user", "content": "Explain the active cell", "meta": "...", "includeInHistory": true },
    { "role": "assistant", "content": "...", "meta": "Model: ...", "includeInHistory": true }
  ]
}
```

- **`difficulty`** — the per-notebook difficulty preference; read/written via `questStore.readDifficulty()` / `writeDifficulty()` and merged into the global state view per notebook.
- **`quizzes`** — generated activity content + answers, anchored to cells. Open ("teach-back") activities additionally store `open` (prompt + rubric + hint), `openAnswer`, and `openVerdict`.
- **`chat`** — the Flowy chat transcript for this notebook (last 50 turns). The sidebar swaps the visible thread when the active notebook changes and persists after each exchange via `questStore.writeChat()`.

All three are inherently tied to a notebook, so they travel with the `.ipynb`. Progression does not.

## Server routes

All routes live under `/piis-assistant/` and use Jupyter's authentication (`@web.authenticated`). Source of truth: `handlers.py::setup_handlers`.

| Route | Method | Body | Returns |
| --- | --- | --- | --- |
| `status` | GET | — | `{ configured, model, baseUrl, envFile, settingsFile, message }` |
| `chat` | POST | `{ prompt, history?, notebook }` | `{ response, model, title }` |
| `analyze` | POST | `{ notebookPath, cells }` | Analyzer output + `{ questState, autoCompleted }` |
| `quest/init` | GET/POST | — | `{ state, settings }` (full profile view) |
| `mission/claim` (alias `quest/claim`) | POST | `{ state, notebookPath, missionId, category, xp, label }` | `{ state, outcome }` |
| `explain-cell` | POST | `{ state, notebookPath, cell, analysis }` | `{ explanation, model, outcome, state }` |
| `reflect/prompt` | POST | `{ cell, difficulty? }` | `{ question, model }` |
| `reflect/answer` | POST | `{ state, notebookPath, cellIndex, text }` | `{ state, outcome }` |
| `next-steps` | POST | `{ analysis, difficulty? }` | `{ suggestions, model }` |
| `quiz/generate` (alias `activity/generate`) | POST | `{ slot, kind?, cells, difficulty? }` | activity payload (`choice` or `open` shaped) |
| `quiz/answer` (alias `activity/answer`) | POST | `{ state, notebookPath, slotId, region, correct }` | `{ state, outcome, correct }` |
| `activity/grade` | POST | `{ slotId, kind, prompt, rubric, answer, cellSource, notebookPath, difficulty? }` | `{ verdict, outcome, state }` |
| `activities` | GET | — | `{ activities }` (kind registry) |
| `flowy/quiz` | POST | `{ code, context?, difficulty? }` | quiz payload |
| `flowy/quiz/answer` | POST | `{ challengeId, correct, notebookPath }` | `{ state, outcome, correct }` |
| `settings` | GET | — | `{ model, baseUrl, apiKeySet, apiKeyPreview, apiKeyStorage, keychainAvailable, ... }` |
| `settings/save` | POST | `{ model?, baseUrl?, apiKey?, favoriteModels? }` | Same as GET above |
| `state/wipe` | POST | `{ scope, notebookPath? }` | `{ state }` |
| `profile/reset` | POST | — | `{ state, settings }` (fresh profile) |

`state/wipe` takes a `scope`: `"global"` resets all XP/levels (`profile_store.reset_progress`); anything else clears just this notebook's idempotency keys so its checkpoints can be re-earned, leaving the global XP total intact (`profile_store.forget_notebook`).

`profile/reset` wipes the entire profile (settings + progress) for a complete fresh start.

Every difficulty-aware LLM endpoint reads `state.difficulty` (or an explicit `difficulty` field) and prepends a profile-specific suffix to the system prompt. Profiles live in `ai_backend.py::_DIFFICULTY_PROFILES`.

## Issue kinds the analyzer can produce

| Kind | Severity | Trigger |
| --- | --- | --- |
| `empty_cell` | info | A code cell with no source. |
| `not_executed` | warn | Code cell with source but no execution count. |
| `out_of_order` | warn | Execution number lower than an earlier cell's. |
| `undefined_reference` | warn | Uses a name not defined in any earlier cell or import. |
| `duplicated` | info | Identical source in another cell. |
| `disconnected` | info | Code cell with no incoming or outgoing dependency. |
| `unused_variable` | info | Defines a name no later cell reads. |

Mission generation in `analyzer.generate_missions` keys off these kinds.

## Between-cell activities

The analyzer emits **injection points** (`analyzer._compute_injection_points`) — anchored to a stable nbformat cell id — and `activities.py` decides what each one contains. Three kinds today:

| Kind | Response shape | Graded by | XP |
| --- | --- | --- | --- |
| `quiz` | `choice` (MCQ) | client compares selected index with `correctIndex` | +5 correct |
| `predict` | `choice` (MCQ) | same | +5 correct |
| `teachback` | `open` (free text) | LLM against a short rubric (`activity/grade`) | +8 on pass |

Adding a kind: one entry in `activities.ACTIVITY_SPECS` + a system prompt, teach the analyzer to emit it, and add a React component in `src/components/`.

## Difficulty profiles

`difficulty` ∈ `easy | medium | hard`. Each profile contributes a one-liner to the system prompt of every LLM endpoint:

| Profile | Explain | Quiz | Grading |
| --- | --- | --- | --- |
| `easy` | Beginner-friendly, simple language. | Distinct distractors. | Generous. |
| `medium` | Practitioner depth, < 180 words. | Plausible distractors, tests understanding. | Balanced. |
| `hard` | Senior reviewer mode, terse, edge cases. | Tempting distractors, careful reading. | Strict. |

Edit `_DIFFICULTY_PROFILES` to tune wording or add new tiers. Difficulty is per notebook (stored in `metadata.flowquest`) and only affects LLM tone — it does not change XP amounts.

## Frontend life-cycle

For each open `NotebookPanel`, `index.ts` builds a `PanelBundle`:

```ts
{
  decorator,    // CellDecorator      — chips + inline panels (React)
  questCells,   // QuestCellRenderer  — virtual activity cells (React)
  banner,       // NotebookBanner     — HUD at top of notebook (React)
  avatar,       // AvatarAssistant    — Flowy (React)
  analysis,     // last AnalysisResponse from /analyze
  state,        // merged QuestState (global mirror + this notebook's difficulty)
  store,        // QuestMetadataStore — reads/writes metadata.flowquest
  analyzeTimer  // debounced re-analysis
}
```

### State management

All UI state flows through `FlowQuestStore` (a singleton defined in `state/store.ts`). It owns:

- **`globalState`** — the `QuestState` as returned by the server's `gamification.public_view()`.
- **`notebookSlices`** — a per-notebook `Map` of `{ analysis, analyzing, state, chat }`.
- **`syncStatus`** — `{ status, lastSyncedAt, error }` for showing save indicators.

React components access state via three hooks (`state/hooks.ts`), all built on `useSyncExternalStore`:

- `useGlobalState(store)` — subscribes to global XP/level changes.
- `useNotebookState(store, path)` — subscribes to a specific notebook's slice.
- `useSyncStatus(store)` — subscribes to save/sync state.

The store is injected via `<StoreProvider store={store}>` (from `state/StoreContext.tsx`). Each Lumino wrapper creates a React root and wraps its subtree in a `StoreProvider`. Components can also call `useFlowQuestStore()` to get the store instance from context.

### Lifecycle

Notebook panel close → all surfaces dispose, metadata is flushed via `store.ensureSaved()`, and the bundle is dropped. The `FlowQuestStore` singleton persists as long as the JupyterLab session is alive.
