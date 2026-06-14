"""FlowQuest gamification — XP + Levels.

The single progression resource is **XP**, which only ever grows. A level is
derived from total XP, with a rank title and a progress value toward the next
level. There is no health score, no win condition, and no LLM baseline.

XP is **global** — it belongs to the user and accumulates across every notebook
they work in. The canonical state lives server-side in
``~/.flowquest/profile.json`` (see :mod:`profile_store`). Idempotency keys are
namespaced per notebook by the handlers so the same mission/quiz can be earned
once *per notebook* while XP pools into one global total.

XP is split across four categories (mirroring the project concept):

    exploration    — discovering workflow, tracing dependencies, reading cells
    understanding  — explaining, answering quizzes, evaluating models
    stabilization  — improving notebook structure (dedupe, fix exec order, …)
    reflection     — writing reflections, reasoning about choices

This module is pure: every mutation takes the current state, applies a change,
and returns the new state. Persistence is the frontend's job (it stores the
blob in ``notebook.metadata.flowquest``).
"""

from __future__ import annotations

import copy
import time
from typing import Any

SCHEMA_VERSION = 4

XP_CATEGORIES = ("exploration", "understanding", "stabilization", "reflection")

# Cumulative XP required to *reach* each level. Index 0 is unused so that
# level numbers read naturally (level 1 starts at 0 XP).
_LEVEL_THRESHOLDS = [
    0,      # L1
    0,      # L1 (reach)
    40,     # L2
    100,    # L3
    180,    # L4
    290,    # L5
    430,    # L6
    600,    # L7
    800,    # L8
    1040,   # L9
    1320,   # L10
    1640,   # L11
    2000,   # L12
]

_RANK_TITLES = [
    "Notebook Novice",   # L1
    "Notebook Novice",
    "Flow Seeker",       # L2
    "Flow Tracer",       # L3
    "Flow Keeper",       # L4
    "Flow Architect",    # L5
    "Flow Sage",         # L6
    "Quest Adept",       # L7
    "Quest Master",      # L8
    "Workflow Guardian", # L9
    "Grand Cartographer",# L10
    "FlowQuest Legend",  # L11
    "FlowQuest Legend",  # L12+
]


def empty_state() -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "xpTotal": 0,
        "xpByCategory": {c: 0 for c in XP_CATEGORIES},
        "completedAwardKeys": [],
        "awardLog": [],
        "reflections": [],
        "exploredCellHashes": [],
        "quizAttempts": 0,
        "quizCorrect": 0,
        "streakDays": 0,
        "lastActiveTs": 0.0,
    }


def normalize_state(raw: Any) -> dict[str, Any]:
    """Accept any shape (including older schemas) and produce a valid state."""
    base = empty_state()
    if not isinstance(raw, dict):
        return base

    try:
        base["xpTotal"] = max(0, int(raw.get("xpTotal") or 0))
    except (TypeError, ValueError):
        base["xpTotal"] = 0

    xp_by_cat = raw.get("xpByCategory") or {}
    if isinstance(xp_by_cat, dict):
        for cat in XP_CATEGORIES:
            try:
                base["xpByCategory"][cat] = max(0, int(xp_by_cat.get(cat) or 0))
            except (TypeError, ValueError):
                base["xpByCategory"][cat] = 0

    if isinstance(raw.get("completedAwardKeys"), list):
        base["completedAwardKeys"] = [str(x) for x in raw["completedAwardKeys"]][:800]
    if isinstance(raw.get("exploredCellHashes"), list):
        base["exploredCellHashes"] = [str(x) for x in raw["exploredCellHashes"]][:400]

    if isinstance(raw.get("awardLog"), list):
        cleaned_log: list[dict[str, Any]] = []
        for item in raw["awardLog"][-200:]:
            if not isinstance(item, dict):
                continue
            try:
                cleaned_log.append(
                    {
                        "key": str(item.get("key") or ""),
                        "category": str(item.get("category") or "exploration"),
                        "xp": int(item.get("xp") or 0),
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

    for key in ("quizAttempts", "quizCorrect", "streakDays"):
        try:
            base[key] = max(0, int(raw.get(key) or 0))
        except (TypeError, ValueError):
            base[key] = 0
    try:
        base["lastActiveTs"] = float(raw.get("lastActiveTs") or 0.0)
    except (TypeError, ValueError):
        base["lastActiveTs"] = 0.0

    return base


def _level_for(xp: int) -> tuple[int, int, int]:
    """Return (level, xp_at_level_start, xp_at_next_level)."""
    level = 1
    for lvl in range(2, len(_LEVEL_THRESHOLDS)):
        if xp >= _LEVEL_THRESHOLDS[lvl]:
            level = lvl
        else:
            break
    current_start = _LEVEL_THRESHOLDS[level] if level < len(_LEVEL_THRESHOLDS) else _LEVEL_THRESHOLDS[-1]
    if level + 1 < len(_LEVEL_THRESHOLDS):
        next_at = _LEVEL_THRESHOLDS[level + 1]
    else:
        # Beyond the table: each further level costs a flat 400 XP.
        next_at = current_start + 400
    return level, current_start, next_at


def public_view(state: dict[str, Any]) -> dict[str, Any]:
    state = normalize_state(state)
    xp = state["xpTotal"]
    level, current_start, next_at = _level_for(xp)
    rank = _RANK_TITLES[min(level, len(_RANK_TITLES) - 1)]
    span = max(1, next_at - current_start)
    into = max(0, xp - current_start)
    progress = max(0.0, min(1.0, into / span))
    total_earned = sum(state["xpByCategory"].values())
    return {
        "schemaVersion": state["schemaVersion"],
        "xpTotal": xp,
        "xpByCategory": dict(state["xpByCategory"]),
        "completedAwardKeys": list(state["completedAwardKeys"]),
        "exploredCellHashes": list(state["exploredCellHashes"]),
        "awardLog": state["awardLog"][-40:],
        "reflections": state["reflections"][-20:],
        "quizAttempts": state["quizAttempts"],
        "quizCorrect": state["quizCorrect"],
        "streakDays": state["streakDays"],
        "lastActiveTs": state["lastActiveTs"],
        # Derived
        "level": level,
        "rankTitle": rank,
        "xpIntoLevel": into,
        "xpForNextLevel": next_at - current_start,
        "xpToNextLevel": max(0, next_at - xp),
        "levelProgress": progress,
        "categoryTotal": total_earned,
    }


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


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------


def award_xp(
    state: Any,
    category: str,
    amount: int,
    award_key: str,
    label: str = "",
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Add XP in a category. Idempotent per ``award_key``."""
    new_state = copy.deepcopy(normalize_state(state))
    if category not in XP_CATEGORIES:
        category = "exploration"
    amount = max(0, int(amount))

    if award_key and award_key in new_state["completedAwardKeys"]:
        return new_state, {"granted": False, "reason": "already_completed", "xpAwarded": 0}

    if award_key:
        new_state["completedAwardKeys"].append(award_key)
    new_state["xpTotal"] += amount
    new_state["xpByCategory"][category] = new_state["xpByCategory"].get(category, 0) + amount
    new_state["awardLog"].append(
        {
            "key": award_key,
            "category": category,
            "xp": amount,
            "label": (label or award_key)[:160],
            "ts": time.time(),
        }
    )
    _touch_streak(new_state)
    return new_state, {"granted": True, "xpAwarded": amount, "category": category}


def award_explore(
    state: Any,
    cell_hash: str,
    amount: int = 3,
    label: str = "Read a cell",
    key_ns: str = "",
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Award exploration XP for engaging with a unique cell (idempotent).

    ``key_ns`` is prepended to both the dedup token and the award key so the
    same cell can be explored once *per notebook* while XP pools globally.
    """
    new_state = copy.deepcopy(normalize_state(state))
    token = f"{key_ns}{cell_hash}"
    if token in new_state["exploredCellHashes"]:
        return new_state, {"granted": False, "reason": "already_explored", "xpAwarded": 0}
    new_state["exploredCellHashes"].append(token)
    return award_xp(
        new_state,
        "exploration",
        amount,
        award_key=f"{key_ns}explore:{cell_hash}",
        label=label,
    )


def record_reflection(
    state: Any,
    cell_index: int,
    text: str,
    amount: int = 6,
    key_ns: str = "",
) -> tuple[dict[str, Any], dict[str, Any]]:
    new_state = copy.deepcopy(normalize_state(state))
    cleaned = (text or "").strip()
    if not cleaned:
        return new_state, {"granted": False, "xpAwarded": 0, "reason": "empty"}
    new_state["reflections"].append(
        {"cellIndex": int(cell_index), "text": cleaned[:1000], "ts": time.time()}
    )
    interim, outcome = award_xp(
        new_state,
        "reflection",
        amount,
        award_key=f"{key_ns}reflection:cell-{cell_index}",
        label=f"Reflected on cell {cell_index + 1}",
    )
    # award_xp deep-copies; carry the reflection list forward.
    interim["reflections"] = list(new_state["reflections"])
    return interim, outcome


def record_quiz_attempt(
    state: Any,
    slot_id: str,
    correct: bool,
    category: str = "understanding",
    key_ns: str = "",
) -> tuple[dict[str, Any], dict[str, Any]]:
    new_state = copy.deepcopy(normalize_state(state))
    new_state["quizAttempts"] = int(new_state.get("quizAttempts") or 0) + 1
    if correct:
        new_state["quizCorrect"] = int(new_state.get("quizCorrect") or 0) + 1
        return award_xp(
            new_state,
            category,
            5,
            award_key=f"{key_ns}quiz-correct:{slot_id}",
            label=f"Quiz mastered · {slot_id}",
        )
    return award_xp(
        new_state,
        category,
        2,
        award_key=f"{key_ns}quiz-attempt:{slot_id}",
        label=f"Quiz attempted · {slot_id}",
    )


def apply_auto_checks(
    state: Any,
    checks: list[tuple[str, str, int, str]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Award XP for analyzer-driven auto-checks.

    Each entry is ``(award_key, category, xp, label)``. Idempotent per key.
    """
    new_state = copy.deepcopy(normalize_state(state))
    applied: list[dict[str, Any]] = []
    for key, category, xp, label in checks:
        new_state, outcome = award_xp(new_state, category, xp, award_key=key, label=label)
        if outcome.get("granted"):
            applied.append({"awardKey": key, "category": category, "xp": outcome["xpAwarded"], "label": label})
    return new_state, applied


def wipe_state(state: Any) -> dict[str, Any]:
    """Reset all per-notebook FlowQuest progress."""
    return empty_state()


__all__ = [
    "SCHEMA_VERSION",
    "XP_CATEGORIES",
    "empty_state",
    "normalize_state",
    "public_view",
    "award_xp",
    "award_explore",
    "record_reflection",
    "record_quiz_attempt",
    "apply_auto_checks",
    "wipe_state",
]
