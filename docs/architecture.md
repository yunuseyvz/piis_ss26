# FlowQuest architecture

This page is the "mental model" of the project. Read it once and the rest of the docs make sense.

## One-paragraph version

FlowQuest is a JupyterLab extension. The frontend (**React 18 + TypeScript**) draws several surfaces — a sidebar, an in-notebook banner, per-cell chips/panels, and a floating avatar (Flowy) — and inserts virtual activity cells between real cells. UI components subscribe to a central `FlowQuestStore` via `useSyncExternalStore` hooks; each surface is a Lumino widget wrapping a React sub-tree in a `<StoreProvider>`. Every UI action that earns progress calls the Python server extension; the server applies a pure mutation to the user's **global XP/level state** and returns the new state, which the store mirrors across every open notebook. Progression (XP, levels, the award log) and settings (model, base URL, API key) are **global and server-owned**, stored in a single file at `~/.flowquest/profile.json` managed by `profile_store.py`. The only per-notebook data is the difficulty preference, generated quiz content, and chat transcript, which travel inside the notebook's `metadata.flowquest`.

## Picture

```
┌───────────────────────────────────────────────────────────┐
│                     JupyterLab frontend                   │
│               (React 18 + useSyncExternalStore)           │
│                                                           │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────┐     │
│  │  Sidebar     │  │  In-notebook     │  │ Per-cell │     │
│  │  SidebarApp  │  │  banner          │  │ CellPanel│     │
│  │  .tsx        │  │  NotebookBanner  │  │ .tsx     │     │
│  └──────┬───────┘  └────────┬─────────┘  └────┬─────┘     │
│         │                   │                 │           │
│         │   Virtual activity cells ───────────┤           │
│         │   AvatarAssistant.tsx ──────────────┤           │
│         │                   │                 │           │
│         └─────────┬─────────┴─────────────────┘           │
│                   │                                       │
│                   ▼                                       │
│     FlowQuestStore (singleton, state/store.ts)            │
│     + StoreProvider (React context, state/StoreContext)   │
│     + QuestMetadataStore (difficulty + quizzes only)      │
└───────────────────┼───────────────────────────────────────┘
                    │ HTTP (auth = Jupyter)
                    ▼
┌───────────────────────────────────────────────────────────┐
│                  Jupyter server extension                 │
│                                                           │
│   handlers.py       ── Tornado routes /piis-assistant/... │
│   analyzer.py       ── AST regions, issues, missions      │
│   gamification.py   ── pure XP/level state mutations      │
│   profile_store.py  ── ~/.flowquest/profile.json (unified)│
│   activities.py     ── between-cell activity generation   │
│   ai_backend.py     ── LLM client + all prompt flows      │
└───────────────────────────────────────────────────────────┘
```

## Single unified storage

| Where | What's there | Scope / lifetime | Owner |
| --- | --- | --- | --- |
| `~/.flowquest/profile.json` | XP total, XP by category, level (derived), award log, reflections, explored-cell hashes, quiz tallies, idempotency keys, model, base URL, API key (or OS keychain), favorite models | **Global** — per user, across every notebook | Server (`profile_store.py`) |
| `notebook.metadata.flowquest` | `difficulty` + generated `quizzes` + per-notebook `chat` transcript | Per notebook. Travels with the `.ipynb`. | Frontend (`questStore.ts`) |

XP and levels are **global and server-owned**: a level reflects your whole journey, not one file, and the frontend never computes the score. Idempotency keys are namespaced per notebook by the handlers (`"<notebookPath>::<raw key>"`) so the same mission/quiz/reflection can be earned **once per notebook** while XP pools into one global total.

Restart the container, the volume, the kernel, or the browser tab — progression survives because it's in `profile.json`; difficulty and quizzes survive because they're in the `.ipynb`.

## Data flow for a typical action

Take "claim a mission":

1. User clicks **Claim +N** on a mission card in the sidebar (or the in-cell panel).
2. The React component calls `store.claimMission({ notebookPath, missionId, ... })`.
3. Store fires `apiRequest('piis-assistant/mission/claim', { state, notebookPath, missionId, category, xp, label })` to the backend.
4. `MissionClaimHandler` runs `_mutate_progress(lambda s: gamification.award_xp(...))` with award key `"<notebookPath>::mission:<id>"`. The mutation:
   - rejects duplicates (the award key is already in `completedAwardKeys`),
   - adds the XP to the total and to the category bucket,
   - appends to the award log,
   - touches the activity streak.
5. The handler returns `{ state: gamification.public_view(new_state), outcome }`.
6. `FlowQuestStore.adoptGlobalState()` replaces the in-memory mirror and emits to all `useSyncExternalStore` subscribers.
7. Every React surface (banner, sidebar, cell panels, avatar) re-renders with the new XP/level.

Every mutation follows the same shape: **state in → pure mutation → new state out**, idempotent on a unique award key, serialised under a process lock in `profile_store.mutate`.

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

### XP categories — what feeds which bucket

XP is split across four named buckets (`gamification.XP_CATEGORIES`):
`exploration`, `understanding`, `stabilization`, `reflection`. They mirror the
project's pedagogy. Mechanically they are **purely additive labels**: every
award adds its amount to **both** `xpTotal` *and* one `xpByCategory[...]` bucket
via `gamification.award_xp`. The **level depends only on `xpTotal`** — the
per-category split is informational (it drives the header donut chart), nothing
reads it back.

The category for an award is decided one of three ways:

1. **Hardcoded at the handler** for fixed actions.
2. **From the activity spec** (`activities.ACTIVITY_SPECS[kind]["category"]`).
3. **By the anchor cell's region** for inline between-cell quizzes
   (`handlers._QUIZ_CATEGORY_BY_REGION`).

| Action | Category | XP | Decided by |
| --- | --- | --- | --- |
| Explain a cell (first time per cell) | `exploration` | 3 | hardcoded (`award_explore`) |
| Submit a reflection | `reflection` | 6 | hardcoded (`record_reflection`) |
| Claim a mission | the mission's `kind` | mission's `xp` | mission (`analyzer.generate_missions`) |
| Answer a between-cell quiz / predict | by anchor region† | 5 correct · 2 attempt | `_QUIZ_CATEGORY_BY_REGION` |
| Pass a teach-back | activity spec (`reflection`) | 8 | `activities.category_for` |
| Answer a Flowy paste-quiz | `understanding` | 6 correct · 2 attempt | hardcoded |
| Auto-checks on analyze | per rule‡ | varies | `handlers._auto_check_rules` |

† `load → exploration`, `clean → stabilization`, `explore → exploration`,
`visualize → exploration`, `model → understanding`, default `understanding`.

‡ no-unused-vars / clean-execution / no-duplicates → `stabilization`;
has-visualization → `exploration`; model-evaluated → `understanding`;
has-markdown → `reflection`.

`award_xp` clamps the amount to `>= 0` and falls back to `exploration` for an
unknown category, and every award is idempotent on its (notebook-namespaced)
award key — so the split reflects distinct accomplishments, not repeated clicks.

To change a mapping: rename/add categories in `gamification.XP_CATEGORIES`;
change a region's bucket in `handlers._QUIZ_CATEGORY_BY_REGION`; change an
activity kind's bucket in `activities.ACTIVITY_SPECS`; change a mission's bucket
via its `kind` in `analyzer.generate_missions`.

## What is LLM-based and what isn't

A core design principle (and the course goal: *support notebook authoring
without becoming a generic chatbot*): the **structural / scoring half is
deterministic**, and the LLM is reserved for **open-ended, context-specific
language**.

| LLM-based (open-ended language) | Deterministic / heuristic (no LLM) |
| --- | --- |
| Chat (`/chat`) | Notebook analysis: regions, AST deps, issues, missions, injection points (`analyzer.py`) |
| Explain a cell (`/explain-cell`) | XP, levels, ranks, streak, award log (`gamification.py`) |
| Reflect prompt (`/reflect/prompt`) | MCQ grading — `selectedIndex === correctIndex`, client-side (`questCells.ts`) |
| Next steps (`/next-steps`) | Reflection recording (`/reflect/answer`) — stored + XP, not graded |
| Activity / quiz generation (`/quiz/generate`, `/activity/generate`, `/flowy/quiz`) | Auto-checks (`handlers._auto_check_rules`) — XP for good structure |
| Teach-back grading (`/activity/grade`) — free text vs rubric | Status / settings / wipe / quest-init / activity registry — plumbing |

All LLM calls route through `ai_backend.AssistantClient` via `handlers._run_llm`
(worker thread, 75s deadline, bounded retries).

Why the split is drawn here:

- **The skeleton is deterministic so it's trustworthy, instant, and free.**
  Where cells sit, what depends on what, which cells have issues, what missions
  exist, and your XP/level must be identical on every scan, must work with no
  API key, and must be cheap — `/analyze` re-runs on every debounced edit. The
  backend is the source of truth for XP precisely *because* it is computed, not
  generated; a level should never change because the model was moody.
- **The LLM is reserved for the genuinely open-ended** — explanations,
  reflective questions, quiz content, and free-text judgment have no closed-form
  answer and their whole value is tailored, context-aware prose.
- **Grading stays deterministic where it can.** Multiple-choice activities are
  graded by index comparison (instant, can't be wrong). The only LLM-graded
  surface is teach-back, where the answer is free text — and even there it
  degrades to a lenient length heuristic (`activities._heuristic_grade`) if the
  model can't be reached, so a flaky endpoint never blocks the learner.
- **Graceful degradation.** Because the structural half is LLM-free, the
  extension stays useful with no model configured: regions, issues, missions,
  XP, and auto-checks all still work; only the generative features return a
  friendly 503. Generated activity content also has a deterministic template
  fallback (`ai_backend._FALLBACK_QUIZZES`) so unparseable model output never
  yields a broken cell.

## How cells are classified and surfaces are placed

Everything the user sees in a notebook is derived from one backend call. The
frontend serialises the notebook and POSTs it to `/piis-assistant/analyze`;
`analyzer.py` returns a per-cell analysis plus a list of injection points, and
the frontend renders five surfaces from that result. This section explains how
each "where does what appear" decision is made.

### The five surfaces and what places them

| Surface | Placement rule | Source |
| --- | --- | --- |
| **In-notebook banner** | One per open notebook, pinned to the top of the scroll area. Always present. | `notebookBanner.tsx` → `NotebookBanner.tsx` |
| **Per-cell chip** | One per real cell, mounted at the top of the cell. Always present. | `cellDecorations.tsx` → `CellPanel.tsx` |
| **Inline cell panel** | Inserted directly below a cell's input when its chip is clicked; tied 1:1 to that cell. | `cellDecorations.tsx` → `CellPanel.tsx` |
| **Virtual activity cell** | One per *injection point*, placed after its anchor cell. | `questCells.tsx` + `components/ChoiceActivity.tsx`, `OpenActivity.tsx` |
| **Sidebar (Quest / Flowy / Chat)** | Single shared left-rail widget; fixed tabs. Reflects the current notebook's analysis + global XP. | `sidebar.tsx` → `SidebarApp.tsx` + tab components |

### Region classification — `analyzer._classify_region`

Each cell is tagged with a *region* (the `⚙️ Setup` / `📦 Load` / … label on the
chip). This is the core "which section is this cell" decision:

1. Markdown → `narrative`; raw/empty → `other`.
2. Otherwise the source is **keyword-scored** against `_REGION_KEYWORDS`. Each
   region has a keyword list, e.g. `load` → `read_csv`, `pd.DataFrame(`, …;
   `model` → `.fit(`, `LogisticRegression`, `accuracy_score`, …; `setup` →
   `import `, `np.random.seed`, …
3. The region with the **highest hit count** wins (`max(score)`).
4. No matches: a short print/expression cell → `output`; otherwise → `other`.

It's heuristic and best-effort — it can misclassify. `_REGION_KEYWORDS` is the
single place to tune it; `REGION_ORDER` / `REGION_ICONS` control ordering + icons.

### The chip badges — AST analysis (`_NameCollector`)

Each code cell is parsed to an AST to populate the facts shown on the chip and
in the panel's fact row:

- **`defines`** — names the cell binds (assignments, `def`, `class`, imports).
- **`uses`** — names the cell reads (minus Python builtins).
- **`exec #N`** — the cell's execution count (or a `not executed` badge).
- **Dependency arrows** — for each used name, the earliest cell that defined it
  becomes a `depends_on` edge (rendered `← cell N`); the reverse edges become
  `dependents` (rendered `→ cell N`). This is the notebook's data-flow graph.

The chip's coloured **dot** shows the worst-severity issue on the cell, and a
**★ N** star appears when N missions target it.

### Injection points — `analyzer._compute_injection_points`

This decides where virtual activity cells (quiz / predict / teach-back) appear:

1. Walk cells and group **consecutive code cells of the same region** into
   "runs". Markdown or a non-activity region ends a run.
2. Only these regions qualify (`_ACTIVITY_REGIONS`): `load`, `clean`, `explore`,
   `visualize`, `model`. `setup` / `output` / `narrative` runs are skipped.
3. Each qualifying run gets **one** injection point, anchored to the **last cell
   of the run** by its stable nbformat cell id (not index — so it survives
   inserts, deletes, and moves).
4. The activity **kind** is deterministic, not random: `_activity_kind_for`
   picks among the kinds eligible for that region and rotates by run index, so
   the same notebook yields stable, varied activities across re-scans.

### Missions — `analyzer.generate_missions`

Missions are generated from detected issues + notebook shape, and each declares
the `cell_indices` it targets — that's what drives the chip ★ star and the
panel's Missions section. Examples: unused variables → "Revive the dead code";
out-of-order/not-executed → "Fix the flow"; a `model` region with no evaluation
call → "Put the model on trial"; a fallback "Take the grand tour" if nothing
else fires.

### End-to-end

```
edit/run notebook → (debounced) POST /piis-assistant/analyze
  analyzer.py:
    classify region        (keyword scoring)      → chip label
    AST defines/uses/deps                          → chip badges + arrows
    detect issues                                  → chip dot colour
    generate missions (cell_indices)               → chip ★ + panel Missions
    compute injection points (runs → last cell)    → virtual activity cells
  → { cells[], issues[], missions[], injectionPoints[], questState }
frontend renders chips/panels (per cell), activity cells (per injection point),
banner + sidebar (from questState + analysis).
```

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
| Sidebar layout | `src/components/SidebarApp.tsx` + `src/components/sidebar/*.tsx` |
| In-notebook banner | `src/notebookBanner.tsx` + `src/components/NotebookBanner.tsx` |
| Per-cell chip + panel | `src/cellDecorations.tsx` + `src/components/CellPanel.tsx` |
| Activity cell rendering | `src/questCells.tsx` + `src/components/ChoiceActivity.tsx`, `OpenActivity.tsx` |
| Flowy avatar behaviour | `src/components/AvatarAssistant.tsx` + `src/flowySprite.ts` |
| State management / hooks | `src/state/store.ts`, `src/state/hooks.ts`, `src/state/StoreContext.tsx` |
| Visual style | `style/index.css` |
