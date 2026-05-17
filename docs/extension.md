# FlowQuest extension reference

A practical reference for the extension's API surface, persistence model, and the few rules you need in your head.

## Persistence model

### Per-notebook state

Stored at `metadata.flowquest` inside the `.ipynb`. Shape (after normalisation):

```json
{
  "schemaVersion": 2,
  "initialized": true,
  "baselineHealth": 64,
  "baselineBreakdown": {
    "workflow_clarity": 7,
    "execution_consistency": 6,
    "data_hygiene": 6,
    "reproducibility": 5,
    "analysis_depth": 7,
    "model_rigor": 5,
    "reader_understanding": 6
  },
  "baselineNotes": "Clear narrative; no random_state; missing model evaluation.",
  "healthPoints": {
    "workflow_clarity": 0,
    "execution_consistency": 8,
    "data_hygiene": 0,
    "reproducibility": 0,
    "analysis_depth": 0,
    "model_rigor": 10,
    "reader_understanding": 4
  },
  "completedAwardKeys": [
    "mission:stab-rerun-clean",
    "mission:und-evaluate-model",
    "explain:abc123",
    "reflection:cell-4"
  ],
  "awardLog": [
    { "key": "mission:stab-rerun-clean", "criterion": "execution_consistency", "points": 8, "label": "Fix the flow", "ts": 1.7e9 }
  ],
  "reflections": [
    { "cellIndex": 4, "text": "Stratified split because classes are imbalanced.", "ts": 1.7e9 }
  ],
  "quizzes": {
    "<anchorCellId>::quiz:clean": {
      "slotId": "...",
      "anchorCellId": "...",
      "region": "clean",
      "quiz": { "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0, "explanation": "..." },
      "selectedIndex": 0,
      "answeredCorrectly": true,
      "attempts": 1,
      "awardedXp": 5,
      "generatedAt": 1.7e9
    }
  },
  "quizAttempts": 3,
  "quizCorrect": 2,
  "streakDays": 1,
  "lastActiveTs": 1.7e9,
  "wonAt": 0.0,
  "difficulty": "medium"
}
```

Rules:

- Every award key in `completedAwardKeys` is unique. The same mission cannot be claimed twice.
- Each criterion's `healthPoints[id]` is capped at its `point_budget` (see `criteria.py`).
- `healthScore` (derived) = `baselineHealth + Σ healthPoints[id]`. The frontend never trusts a client-side score; the backend computes it from the state blob on every `public_view`.
- Wiping (`/state/wipe`) replaces the blob with `empty_state()`. Difficulty is preserved by default.

### Global settings

Stored at `~/.flowquest/settings.json`:

```json
{
  "model": "meta-llama/Llama-3.1-8B-Instruct",
  "base_url": "https://router.huggingface.co/v1",
  "api_key": "hf_xxxxxx...",
  "favorite_models": ["meta-llama/Llama-3.1-8B-Instruct"]
}
```

If the file is absent, the resolver falls back to environment variables (`HF_OPENAI_BASE_URL`, `HF_OPENAI_MODEL`, `HF_OPENAI_API_KEY`) and to the workspace `.env`. The first time the user saves something via the **Settings → Global** panel, the file is created with mode `0600`.

## Server routes

All routes live under `/piis-assistant/` and use Jupyter's authentication.

| Route | Method | Body | Returns |
| --- | --- | --- | --- |
| `status` | GET | — | `{ configured, model, baseUrl, envFile, settingsFile, message }` |
| `chat` | POST | `{ prompt, history?, notebook }` | `{ response, model, title }` |
| `analyze` | POST | `{ notebookPath, cells, state? }` | Analyzer output + `{ questState, autoCompleted }` |
| `initialize` | POST | `{ analysis, state, notebookPath }` | `{ state, baseline, notebookPath }` |
| `quest/init` | POST | `{ state }` | `{ state }` (normalised public view) |
| `mission/claim` | POST | `{ state, missionId, criterionId, points, label }` | `{ state, outcome }` |
| `explain-cell` | POST | `{ state, cell, analysis }` | `{ explanation, model, outcome, state }` |
| `reflect/prompt` | POST | `{ cell }` | `{ question, model }` |
| `reflect/answer` | POST | `{ state, cellIndex, text }` | `{ state, outcome }` |
| `next-steps` | POST | `{ analysis }` | `{ suggestions, model }` |
| `quiz/generate` | POST | `{ slot, cells }` | `{ question, options, correctIndex, explanation, model }` |
| `quiz/answer` | POST | `{ state, slotId, region, correct }` | `{ state, outcome, correct }` |
| `criteria` | GET | — | `{ criteria, healthTarget }` |
| `settings` | GET | — | `{ model, baseUrl, apiKeySet, apiKeyPreview, ... }` |
| `settings/save` | POST | `{ model?, baseUrl?, apiKey?, favoriteModels? }` | Same as GET above |
| `state/difficulty` | POST | `{ state, difficulty }` | `{ state }` |
| `state/wipe` | POST | `{ state, keepDifficulty? }` | `{ state }` |

Every difficulty-aware LLM endpoint reads `state.difficulty` (or an explicit `difficulty` field) and prepends a profile-specific suffix to the system prompt. Profiles live in `ai_backend.py::_DIFFICULTY_PROFILES`.

## Health criteria — the file you'll edit most often

`jupyterlab_piis_assistant/criteria.py` declares seven `HealthCriterion` records:

```python
HealthCriterion(
    id="execution_consistency",
    label="Execution consistency",
    description="…handed to the LLM verbatim during initialise…",
    weight=15,            # weight in the baseline scoring
    point_budget=20,      # cap on points the user can earn for this criterion
    icon="⚙️",
)
```

When you edit:

- **Add or remove a criterion.** Existing notebooks store whatever was current at save time. Removed ids will simply read as `0` earned, no migration required.
- **Change weights.** Affects only future baseline scorings. Already-initialised notebooks keep their stored `baselineHealth` until they re-initialise.
- **Change `point_budget`.** New caps apply immediately to future awards and to existing values via clamping.

Sum of `point_budget` ≈ 135. Keep it ≥ 110 so the user can always reach 100 regardless of baseline.

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

Mission generation in `generate_missions` keys off these kinds.

## Difficulty profiles

`difficulty` ∈ `easy | medium | hard`. Each profile contributes a one-liner to the system prompt of every LLM endpoint:

| Profile | Explain | Quiz | Baseline scoring |
| --- | --- | --- | --- |
| `easy` | Beginner-friendly, simple language. | Distinct distractors. | Generous; prefer the higher score. |
| `medium` | Practitioner depth, < 180 words. | Plausible distractors, tests understanding. | Balanced; rewards clarity. |
| `hard` | Senior reviewer mode, terse, edge cases. | Tempting distractors, careful reading. | Strict; penalises hidden state. |

Edit `_DIFFICULTY_PROFILES` to tune wording or add new tiers.

## Frontend life-cycle

For each open `NotebookPanel`, `index.ts` builds a `PanelBundle`:

```ts
{
  decorator,    // CellDecorator    — chips + inline panels
  questCells,   // QuestCellRenderer — virtual quiz cells
  banner,       // NotebookBanner    — HUD at top of notebook
  analysis,     // last AnalysisResponse from /analyze
  state,        // last QuestState (mirrored to metadata.flowquest)
  store,        // QuestMetadataStore — reads/writes the metadata blob
  analyzeTimer  // debounced re-analysis
}
```

Notebook panel close → all four surfaces dispose, the metadata is flushed via `store.ensureSaved()`, and the bundle is dropped.
