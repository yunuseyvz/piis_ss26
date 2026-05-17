# FlowQuest architecture

This page is the "mental model" of the project. Read it once and the rest of the docs make sense.

## One-paragraph version

FlowQuest is a JupyterLab extension. The frontend (TypeScript) draws three surfaces — a sidebar, an in-notebook banner, and per-cell chips/panels — and inserts virtual quiz cells between real cells. Every UI action that wants to mutate progress sends the current per-notebook state to the Python server extension; the server applies the mutation and returns the new state, which the frontend writes back into the notebook's `metadata.flowquest`. There's no shared server database. Global settings (model, base URL, API key) live in `~/.flowquest/settings.json` instead.

## Picture

```
┌───────────────────────────────────────────────────────────┐
│                     JupyterLab frontend                   │
│                                                           │
│  ┌──────────────┐   ┌──────────────────┐   ┌──────────┐   │
│  │   Sidebar    │   │  In-notebook     │   │ Per-cell │   │
│  │  Quest /     │   │  banner (HUD,    │   │ chip +   │   │
│  │  Workflow /  │   │  health bar,     │   │ panel    │   │
│  │  Chat        │   │  difficulty,     │   │          │   │
│  └──────────────┘   │  ⚙️ settings)     │   └────┬─────┘   │
│         │           └────────┬─────────┘        │         │
│         │                    │                  │         │
│         │     Virtual quiz cells injected ──────┘         │
│         │                    │                            │
│         └────────────┬───────┴──────────────┐             │
│                      │                      │             │
│                      ▼                      ▼             │
│             ┌───────────────────┐   ┌────────────────┐    │
│             │ QuestMetadataStore│◄──┤ Settings panel │    │
│             │ (reads/writes     │   └────────────────┘    │
│             │  metadata.flowquest)                        │
│             └─────────┬─────────┘                         │
└───────────────────────┼───────────────────────────────────┘
                        │ HTTP (auth = Jupyter)
                        ▼
┌───────────────────────────────────────────────────────────┐
│                  Jupyter server extension                 │
│                                                           │
│   handlers.py    ── Tornado routes /piis-assistant/...    │
│   analyzer.py    ── AST-based regions, issues, missions   │
│   gamification.py── pure state-in / state-out mutations   │
│   criteria.py    ── seven Notebook Health criteria        │
│   ai_backend.py  ── LLM client + all prompt flows         │
│   settings.py    ── ~/.flowquest/settings.json            │
└───────────────────────────────────────────────────────────┘
```

## Two storage locations

| Where | What's there | Lifetime |
| --- | --- | --- |
| `notebook.metadata.flowquest` | Health baseline, earned points per criterion, completed mission keys, reflections, quiz records, difficulty | Per notebook. Travels with the `.ipynb`. |
| `~/.flowquest/settings.json` | Model, base URL, API key, favorite models | Per JupyterLab user, across all notebooks. |

Nothing else is persisted server-side. Restart the container, the volume, the kernel, or the browser tab — state survives because it's in those two files.

## Data flow for a typical action

Take "claim a mission":

1. User clicks **Claim +6** on a mission card in the sidebar.
2. `sidebar.ts` calls `apiRequest('/piis-assistant/mission/claim', { state, missionId, criterionId, points })`.
3. `MissionClaimHandler` runs `gamification.award_health(state, ...)`. The mutation:
   - rejects duplicates (the award key is in `completedAwardKeys`),
   - caps to the criterion's `point_budget`,
   - logs the award,
   - bumps `wonAt` if health crossed 100.
4. The handler returns `{ state: gamification.public_view(new_state), outcome }`.
5. `sidebar.ts` receives the new state and calls the shared `applyState(state)` callback.
6. `applyState` writes the state into `metadata.flowquest` via `QuestMetadataStore`, marks the notebook dirty (debounced save), and notifies all surfaces (banner, sidebar, decorator, quest cells) so they re-render with the new health bar / completion mark.

Every other mutation follows the same shape: state in, state out, idempotent on a unique award key.

## Notebook health, from baseline to 100

```
            user clicks "🚀 Initialize"
                       │
            LLM scores 7 criteria 0–10
                       │
            Weighted sum → baselineHealth (0–90, hard-capped)
                       │
            User claims missions  +N pts
            User answers quizzes  +5 pts (correct)
            User reflects on cells +4 pts
            Auto-checks fire when issues clear
                       │
                       ▼
            healthScore = baselineHealth + sum(earned per criterion)
            criterion earnings capped at criterion.point_budget
                       │
            healthScore ≥ 100 → state.wonAt = now
```

Sum of all `point_budget` values is ~135, so the user always has a clear path to 100 regardless of where the LLM placed the baseline.

## Where to change behavior

| Want to change... | Edit |
| --- | --- |
| Health criteria, weights, point budgets | `jupyterlab_piis_assistant/criteria.py` |
| What counts as an "issue" | `analyzer.py` (`_REGION_KEYWORDS`, issue detection blocks) |
| Available difficulty levels and prompt suffixes | `ai_backend.py::_DIFFICULTY_PROFILES` |
| Auto-check rules that grant health when issues clear | `handlers.py::_auto_check_rules` |
| Mission generation logic | `analyzer.py::generate_missions` |
| Quiz fallback text | `ai_backend.py::_FALLBACK_QUIZZES` |
| Sidebar layout | `src/sidebar.ts` |
| In-notebook banner | `src/notebookBanner.ts` |
| Per-cell chip + panel | `src/cellDecorations.ts` |
| Quiz cell rendering | `src/questCells.ts` |
| Visual style | `style/index.css` |
