# FlowQuest architecture

This page is the "mental model" of the project. Read it once and the rest of the docs make sense.

## One-paragraph version

FlowQuest is a JupyterLab extension. The frontend (TypeScript) draws several surfaces — a sidebar, an in-notebook banner, per-cell chips/panels, and a floating avatar (Flowy) — and inserts virtual activity cells between real cells. Every UI action that earns progress calls the Python server extension; the server applies a pure mutation to the user's **global XP/level state** and returns the new state, which the frontend mirrors across every open notebook. Progression (XP, levels, the award log) is **global and server-owned**, stored at `~/.flowquest/progress.json`. Global settings (model, base URL, API key) live in `~/.flowquest/settings.json`. The only per-notebook data is the difficulty preference and generated quiz content, which travel inside the notebook's `metadata.flowquest`.

## Picture

```
┌───────────────────────────────────────────────────────────┐
│                     JupyterLab frontend                   │
│                                                           │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────┐     │
│  │   Sidebar    │  │  In-notebook     │  │ Per-cell │     │
│  │  Quest /     │  │  banner (HUD:    │  │ chip +   │     │
│  │  Flowy /     │  │  level, XP,      │  │ panel    │     │
│  │  Chat        │  │  missions, diff) │  │          │     │
│  └──────┬───────┘  └────────┬─────────┘  └────┬─────┘     │
│         │                   │                 │           │
│         │   Virtual activity cells ───────────┤           │
│         │   Flowy avatar (paste-aware) ───────┤           │
│         │                   │                 │           │
│         └─────────┬─────────┴─────────────────┘           │
│                   │                                       │
│                   ▼                                       │
│        in-memory global state mirror (index.ts)           │
│        + QuestMetadataStore (difficulty + quizzes only)   │
└───────────────────┼───────────────────────────────────────┘
                    │ HTTP (auth = Jupyter)
                    ▼
┌───────────────────────────────────────────────────────────┐
│                  Jupyter server extension                 │
│                                                           │
│   handlers.py       ── Tornado routes /piis-assistant/... │
│   analyzer.py       ── AST regions, issues, missions      │
│   gamification.py   ── pure XP/level state mutations      │
│   progress_store.py ── ~/.flowquest/progress.json (global)│
│   activities.py     ── between-cell activity generation   │
│   ai_backend.py     ── LLM client + all prompt flows      │
│   settings.py       ── ~/.flowquest/settings.json         │
└───────────────────────────────────────────────────────────┘
```

## Three storage locations

| Where | What's there | Scope / lifetime | Owner |
| --- | --- | --- | --- |
| `~/.flowquest/progress.json` | XP total, XP by category, level (derived), award log, reflections, explored-cell hashes, quiz tallies, idempotency keys | **Global** — per user, across every notebook | Server (`progress_store.py`) |
| `~/.flowquest/settings.json` (+ OS keychain) | Model, base URL, API key, favorite models | Per user | Server (`settings.py`) |
| `notebook.metadata.flowquest` | `difficulty` + generated `quizzes` | Per notebook. Travels with the `.ipynb`. | Frontend (`questStore.ts`) |

XP and levels are **global and server-owned**: a level reflects your whole journey, not one file, and the frontend never computes the score. Idempotency keys are namespaced per notebook by the handlers (`"<notebookPath>::<raw key>"`) so the same mission/quiz/reflection can be earned **once per notebook** while XP pools into one global total.

Restart the container, the volume, the kernel, or the browser tab — progression survives because it's in `progress.json`; difficulty and quizzes survive because they're in the `.ipynb`.

## Data flow for a typical action

Take "claim a mission":

1. User clicks **Claim +N** on a mission card in the sidebar (or the in-cell panel).
2. `sidebar.ts` calls `apiRequest('piis-assistant/mission/claim', { state, notebookPath, missionId, category, xp, label })`.
3. `MissionClaimHandler` runs `progress_store.mutate(lambda s: gamification.award_xp(...))` with award key `"<notebookPath>::mission:<id>"`. The mutation:
   - rejects duplicates (the award key is already in `completedAwardKeys`),
   - adds the XP to the total and to the category bucket,
   - appends to the award log,
   - touches the activity streak.
4. The handler returns `{ state: gamification.public_view(new_state), outcome }`.
5. `sidebar.ts` receives the new state and calls the shared `applyState(state)` callback.
6. `applyState` replaces the in-memory global mirror and re-renders **every** open notebook's surfaces (banner, sidebar, decorator, quest cells, avatar) so they show the new XP/level.

Every mutation follows the same shape: **state in → pure mutation → new state out**, idempotent on a unique award key, serialised under a process lock in `progress_store.mutate`.

## XP, levels, and ranks

```
            user earns XP from:
              · claiming missions
              · answering quizzes / predictions / teach-backs
              · reflecting on cells
              · explaining cells (first time per cell)
              · analyzer auto-checks (good structure)
                       │
                       ▼
            xpTotal grows (never shrinks)
            split across four categories:
              exploration · understanding · stabilization · reflection
                       │
                       ▼
            level = highest threshold ≤ xpTotal  (_LEVEL_THRESHOLDS)
            rank  = _RANK_TITLES[level]
            beyond the table, each level costs a flat 400 XP
```

There is no health score, no baseline, and no win condition. Levels only go up.

## Where to change behavior

| Want to change... | Edit |
| --- | --- |
| Level thresholds, rank titles, XP categories | `jupyterlab_piis_assistant/gamification.py` (`_LEVEL_THRESHOLDS`, `_RANK_TITLES`, `XP_CATEGORIES`) |
| What counts as an "issue" | `analyzer.py` (`_REGION_KEYWORDS`, issue detection blocks) |
| Region classification | `analyzer.py` (`_REGION_KEYWORDS`, `REGION_ICONS`, `REGION_ORDER`) |
| Mission generation logic | `analyzer.py::generate_missions` |
| Auto-checks that grant XP on analyze | `handlers.py::_auto_check_rules` |
| Available difficulty levels and prompt suffixes | `ai_backend.py::_DIFFICULTY_PROFILES` |
| Between-cell activity kinds | `activities.py::ACTIVITY_SPECS` (+ a frontend `CellModule` in `src/cellModules/`) |
| Quiz fallback text | `ai_backend.py::_FALLBACK_QUIZZES` |
| Sidebar layout | `src/sidebar.ts` |
| In-notebook banner | `src/notebookBanner.ts` |
| Per-cell chip + panel | `src/cellDecorations.ts` |
| Activity cell rendering | `src/questCells.ts` + `src/cellModules/` |
| Flowy avatar behaviour | `src/avatarAssistant.ts` + `src/flowySprite.ts` |
| Visual style | `style/index.css` |
