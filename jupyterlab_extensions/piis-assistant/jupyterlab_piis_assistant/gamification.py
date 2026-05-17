"""FlowQuest gamification — Health-based progression.

The single primary resource is **Notebook Health** (0+). The user wins a
notebook by pushing Health to >= 100.

Flow:

1. The user clicks "Initialize" in the banner. The backend asks the LLM to
   score each criterion from ``criteria.HEALTH_CRITERIA`` and turns that
   into a baseline Health (0..100 range, but capped below 100 so there is
   something left to earn back).
2. From then on, activities award *health points* that attach to specific
   criteria:
      - claiming a mission
      - answering a quiz correctly (smaller points on attempt)
      - writing a reflection
      - auto-completions when the analyzer sees an issue resolved
3. Awards are idempotent — each ``award_key`` (e.g. ``mission:stab-dedupe``)
   can only grant points once.
4. Progress per-criterion is capped at ``point_budget`` so a single criterion
   cannot push the user across the finish line.

This module is pure: all mutations take the current state, apply a change,
and return a new state. Persistence is the frontend's job (it stores the
blob in ``notebook.metadata.flowquest``).
"""

from __future__ import annotations

import copy
import time
from typing import Any

from . import criteria

SCHEMA_VERSION = 2
HEALTH_TARGET = 100

_RANK_TITLES = [
    "Notebook Novice",
    "Flow Seeker",
    "Flow Tracer",
    "Flow Keeper",
    "Flow Architect",
    "Flow Sage",
    "Quest Master",
    "FlowQuest Legend",
]


def empty_state() -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "initialized": False,
        "baselineHealth": 0,
        "baselineBreakdown": {},
        "baselineNotes": "",
        "healthPoints": {c.id: 0 for c in criteria.HEALTH_CRITERIA},
        "completedAwardKeys": [],
        "awardLog": [],
        "reflections": [],
        "quizAttempts": 0,
        "quizCorrect": 0,
        "streakDays": 0,
        "lastActiveTs": 0.0,
        "wonAt": 0.0,
        "difficulty": "medium",
    }


def normalize_state(raw: Any) -> dict[str, Any]:
    base = empty_state()
    if not isinstance(raw, dict):
        return base
    # Back-compat: older schemas used xpTotal / xpByCategory; we ignore them
    # when migrating to the health model.
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        base["schemaVersion"] = SCHEMA_VERSION
    # Carry over fields that still exist.
    base["initialized"] = bool(raw.get("initialized") or False)
    try:
        base["baselineHealth"] = max(0, min(100, int(raw.get("baselineHealth") or 0)))
    except (TypeError, ValueError):
        base["baselineHealth"] = 0
    breakdown = raw.get("baselineBreakdown") or {}
    if isinstance(breakdown, dict):
        for criterion in criteria.HEALTH_CRITERIA:
            value = breakdown.get(criterion.id)
            try:
                base["baselineBreakdown"][criterion.id] = (
                    max(0, min(10, int(value))) if value is not None else None
                )
            except (TypeError, ValueError):
                base["baselineBreakdown"][criterion.id] = None
    base["baselineNotes"] = str(raw.get("baselineNotes") or "")[:800]
    points = raw.get("healthPoints") or {}
    if isinstance(points, dict):
        for criterion in criteria.HEALTH_CRITERIA:
            try:
                base["healthPoints"][criterion.id] = max(
                    0, min(criterion.point_budget, int(points.get(criterion.id) or 0))
                )
            except (TypeError, ValueError):
                base["healthPoints"][criterion.id] = 0
    if isinstance(raw.get("completedAwardKeys"), list):
        base["completedAwardKeys"] = [str(x) for x in raw["completedAwardKeys"]][:800]
    if isinstance(raw.get("awardLog"), list):
        cleaned_log: list[dict[str, Any]] = []
        for item in raw["awardLog"][-200:]:
            if not isinstance(item, dict):
                continue
            try:
                cleaned_log.append(
                    {
                        "key": str(item.get("key") or ""),
                        "criterion": str(item.get("criterion") or ""),
                        "points": int(item.get("points") or 0),
                        "label": str(item.get("label") or "")[:160],
                        "ts": float(item.get("ts") or 0.0),
                    }
                )
            except (TypeError, ValueError):
                continue
        base["awardLog"] = cleaned_log
    if isinstance(raw.get("reflections"), list):
        cleaned_reflections: list[dict[str, Any]] = []
        for item in raw["reflections"][-100:]:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "")[:1000]
            if not text:
                continue
            try:
                cleaned_reflections.append(
                    {
                        "cellIndex": int(item.get("cellIndex") or 0),
                        "text": text,
                        "ts": float(item.get("ts") or 0.0),
                    }
                )
            except (TypeError, ValueError):
                continue
        base["reflections"] = cleaned_reflections
    try:
        base["quizAttempts"] = max(0, int(raw.get("quizAttempts") or 0))
    except (TypeError, ValueError):
        base["quizAttempts"] = 0
    try:
        base["quizCorrect"] = max(0, int(raw.get("quizCorrect") or 0))
    except (TypeError, ValueError):
        base["quizCorrect"] = 0
    try:
        base["streakDays"] = max(0, int(raw.get("streakDays") or 0))
    except (TypeError, ValueError):
        base["streakDays"] = 0
    try:
        base["lastActiveTs"] = float(raw.get("lastActiveTs") or 0.0)
    except (TypeError, ValueError):
        base["lastActiveTs"] = 0.0
    try:
        base["wonAt"] = float(raw.get("wonAt") or 0.0)
    except (TypeError, ValueError):
        base["wonAt"] = 0.0
    raw_difficulty = raw.get("difficulty")
    if isinstance(raw_difficulty, str) and raw_difficulty.lower() in {"easy", "medium", "hard"}:
        base["difficulty"] = raw_difficulty.lower()
    else:
        base["difficulty"] = "medium"
    return base


def compute_health(state: dict[str, Any]) -> int:
    """Baseline + sum of earned health points, capped at 200 for safety."""
    earned = sum(
        min(criterion.point_budget, int(state["healthPoints"].get(criterion.id, 0) or 0))
        for criterion in criteria.HEALTH_CRITERIA
    )
    total = int(state.get("baselineHealth") or 0) + earned
    return max(0, min(200, total))


def public_view(state: dict[str, Any]) -> dict[str, Any]:
    state = normalize_state(state)
    health = compute_health(state)
    remaining = max(0, HEALTH_TARGET - health)
    progress = min(1.0, health / HEALTH_TARGET if HEALTH_TARGET else 0.0)
    label = _health_label(health)
    rank = _RANK_TITLES[min(len(_RANK_TITLES) - 1, health // 20)]
    total_budget = criteria.total_point_budget()
    total_earned = sum(state["healthPoints"].values())
    criterion_progress = [
        {
            "id": c.id,
            "label": c.label,
            "icon": c.icon,
            "weight": c.weight,
            "budget": c.point_budget,
            "baselineScore": state["baselineBreakdown"].get(c.id),
            "earned": state["healthPoints"].get(c.id, 0),
            "description": c.description,
        }
        for c in criteria.HEALTH_CRITERIA
    ]
    return {
        "schemaVersion": state["schemaVersion"],
        "initialized": state["initialized"],
        "baselineHealth": state["baselineHealth"],
        "baselineBreakdown": state["baselineBreakdown"],
        "baselineNotes": state["baselineNotes"],
        "healthPoints": state["healthPoints"],
        "completedAwardKeys": state["completedAwardKeys"],
        "awardLog": state["awardLog"][-40:],
        "reflections": state["reflections"][-20:],
        "quizAttempts": state["quizAttempts"],
        "quizCorrect": state["quizCorrect"],
        "streakDays": state["streakDays"],
        "lastActiveTs": state["lastActiveTs"],
        "wonAt": state["wonAt"],
        "difficulty": state["difficulty"],
        # Derived fields
        "healthScore": health,
        "healthTarget": HEALTH_TARGET,
        "healthRemaining": remaining,
        "healthProgress": progress,
        "healthLabel": label,
        "rankTitle": rank,
        "pointsEarned": total_earned,
        "pointsAvailable": total_budget,
        "won": bool(state.get("wonAt")),
        "criteria": criterion_progress,
    }


def _health_label(health: int) -> str:
    if health >= HEALTH_TARGET:
        return "Complete"
    if health >= 80:
        return "Thriving"
    if health >= 55:
        return "Stable"
    if health >= 30:
        return "Fragile"
    return "Critical"


def _touch_streak(state: dict[str, Any]) -> None:
    now = time.time()
    one_day = 86400
    if state["lastActiveTs"] == 0:
        state["streakDays"] = 1
    else:
        delta = now - state["lastActiveTs"]
        if delta < one_day:
            pass
        elif delta < 2 * one_day:
            state["streakDays"] = int(state["streakDays"]) + 1
        else:
            state["streakDays"] = 1
    state["lastActiveTs"] = now


def _mark_win_if_needed(state: dict[str, Any]) -> None:
    if state.get("wonAt"):
        return
    if compute_health(state) >= HEALTH_TARGET:
        state["wonAt"] = time.time()


# ---------------------------------------------------------------------------
# Public mutation helpers
# ---------------------------------------------------------------------------


def initialize_state(
    state: Any,
    baseline_health: int,
    breakdown: dict[str, int | None],
    notes: str,
) -> dict[str, Any]:
    """Apply an LLM baseline score to the state, without clearing progress."""
    new_state = copy.deepcopy(normalize_state(state))
    # Clamp baseline below the win threshold so the user always has something
    # left to earn. Players should never arrive at a "free win".
    capped_baseline = max(0, min(HEALTH_TARGET - 10, int(baseline_health)))
    new_state["baselineHealth"] = capped_baseline
    cleaned_breakdown: dict[str, int | None] = {}
    for criterion in criteria.HEALTH_CRITERIA:
        raw = breakdown.get(criterion.id) if isinstance(breakdown, dict) else None
        if raw is None:
            cleaned_breakdown[criterion.id] = None
            continue
        try:
            cleaned_breakdown[criterion.id] = max(0, min(10, int(raw)))
        except (TypeError, ValueError):
            cleaned_breakdown[criterion.id] = None
    new_state["baselineBreakdown"] = cleaned_breakdown
    new_state["baselineNotes"] = (notes or "").strip()[:800]
    new_state["initialized"] = True
    _touch_streak(new_state)
    _mark_win_if_needed(new_state)
    return new_state


def award_health(
    state: Any,
    criterion_id: str,
    points: int,
    award_key: str,
    label: str = "",
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Add health points to a criterion. Idempotent per ``award_key``."""
    new_state = copy.deepcopy(normalize_state(state))
    if not new_state.get("initialized"):
        return new_state, {
            "granted": False,
            "reason": "not_initialized",
            "pointsAwarded": 0,
        }
    criterion = criteria.by_id(criterion_id)
    if criterion is None:
        # Fall through to the first criterion as a last resort so the user
        # doesn't lose a reward due to a typo in the backend.
        criterion = criteria.HEALTH_CRITERIA[0]

    if award_key in new_state["completedAwardKeys"]:
        return new_state, {
            "granted": False,
            "reason": "already_completed",
            "pointsAwarded": 0,
        }
    already_earned = new_state["healthPoints"].get(criterion.id, 0)
    remaining_budget = max(0, criterion.point_budget - already_earned)
    awarded = max(0, min(int(points), remaining_budget))
    if awarded <= 0:
        # Still record the award key so we don't keep pestering.
        new_state["completedAwardKeys"].append(award_key)
        return new_state, {
            "granted": False,
            "reason": "budget_full",
            "pointsAwarded": 0,
        }

    new_state["healthPoints"][criterion.id] = already_earned + awarded
    new_state["completedAwardKeys"].append(award_key)
    new_state["awardLog"].append(
        {
            "key": award_key,
            "criterion": criterion.id,
            "points": awarded,
            "label": (label or award_key)[:160],
            "ts": time.time(),
        }
    )
    _touch_streak(new_state)
    _mark_win_if_needed(new_state)
    return new_state, {"granted": True, "pointsAwarded": awarded, "criterion": criterion.id}


def record_reflection(
    state: Any,
    cell_index: int,
    text: str,
    award_key: str | None = None,
    criterion_id: str = "reader_understanding",
    points: int = 4,
) -> tuple[dict[str, Any], dict[str, Any]]:
    new_state = copy.deepcopy(normalize_state(state))
    cleaned = (text or "").strip()
    if not cleaned:
        return new_state, {"granted": False, "pointsAwarded": 0, "reason": "empty"}
    new_state["reflections"].append(
        {"cellIndex": int(cell_index), "text": cleaned[:1000], "ts": time.time()}
    )
    key = award_key or f"reflection:cell-{cell_index}"
    # Save the reflection list first, then award through the common path.
    interim = new_state
    interim, outcome = award_health(
        interim,
        criterion_id=criterion_id,
        points=points,
        award_key=key,
        label=f"Reflection on cell {cell_index + 1}",
    )
    # award_health does a deepcopy; merge the reflection list back.
    if new_state["reflections"] and (
        not interim["reflections"] or interim["reflections"][-1] != new_state["reflections"][-1]
    ):
        interim["reflections"] = list(new_state["reflections"])
    return interim, outcome


def record_quiz_attempt(
    state: Any,
    slot_id: str,
    correct: bool,
    criterion_id: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    new_state = copy.deepcopy(normalize_state(state))
    new_state["quizAttempts"] = int(new_state.get("quizAttempts") or 0) + 1
    if correct:
        new_state["quizCorrect"] = int(new_state.get("quizCorrect") or 0) + 1
    # Award key differs for attempt vs correct so a wrong->right sequence can
    # earn both tiers.
    if correct:
        return award_health(
            new_state,
            criterion_id=criterion_id,
            points=5,
            award_key=f"quiz-correct:{slot_id}",
            label=f"Quiz mastered · {slot_id}",
        )
    return award_health(
        new_state,
        criterion_id=criterion_id,
        points=2,
        award_key=f"quiz-attempt:{slot_id}",
        label=f"Quiz attempted · {slot_id}",
    )


def apply_auto_checks(
    state: Any,
    checks: list[tuple[str, str, int, str]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Award health for analyzer-driven auto-checks.

    Each entry is ``(award_key, criterion_id, points, label)``.
    """
    new_state = copy.deepcopy(normalize_state(state))
    applied: list[dict[str, Any]] = []
    if not new_state.get("initialized"):
        return new_state, applied
    for key, criterion_id, points, label in checks:
        new_state, outcome = award_health(
            new_state,
            criterion_id=criterion_id,
            points=points,
            award_key=key,
            label=label,
        )
        if outcome.get("granted"):
            applied.append(
                {
                    "awardKey": key,
                    "criterion": criterion_id,
                    "points": outcome.get("pointsAwarded", 0),
                    "label": label,
                }
            )
    return new_state, applied


__all__ = [
    "SCHEMA_VERSION",
    "HEALTH_TARGET",
    "empty_state",
    "normalize_state",
    "public_view",
    "compute_health",
    "initialize_state",
    "award_health",
    "record_reflection",
    "record_quiz_attempt",
    "apply_auto_checks",
    "set_difficulty",
    "wipe_state",
]


def set_difficulty(state: Any, difficulty: str) -> dict[str, Any]:
    """Update only the per-notebook difficulty knob."""
    new_state = copy.deepcopy(normalize_state(state))
    desired = (difficulty or "medium").lower()
    if desired not in {"easy", "medium", "hard"}:
        desired = "medium"
    new_state["difficulty"] = desired
    _touch_streak(new_state)
    return new_state


def wipe_state(state: Any, keep_difficulty: bool = True) -> dict[str, Any]:
    """Reset all per-notebook FlowQuest progress.

    By default we preserve the difficulty preference because that's a user
    choice, not progress. Pass ``keep_difficulty=False`` for a full wipe.
    """
    previous = normalize_state(state)
    fresh = empty_state()
    if keep_difficulty:
        fresh["difficulty"] = previous.get("difficulty") or "medium"
    return fresh
