"""Global, user-scoped FlowQuest progression storage.

XP and levels are **not** per-notebook — they belong to the user and accumulate
across every notebook they touch. This module owns the single source of truth,
persisted at ``~/.flowquest/progress.json`` (mode 0600, like the settings file).

Why server-owned (and not in notebook metadata like difficulty/quizzes):

* A level should reflect your whole journey, not reset per file.
* The frontend can't be trusted to compute or hold the canonical XP total; the
  server reads the file, applies a pure mutation from :mod:`gamification`, writes
  it back, and returns the public view.

Idempotency keys (``completedAwardKeys`` / ``exploredCellHashes``) are namespaced
per notebook by the handlers (``"<notebook path>::<raw key>"``) so the same
mission or quiz can be earned once *per notebook* while XP pools globally.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Callable

from . import gamification

# Serialises the read-modify-write cycle. Multiple open notebooks share one
# progress file; without this, concurrent awards could clobber each other.
_LOCK = threading.RLock()

_ENV_OVERRIDE = "FLOWQUEST_PROGRESS_FILE"


def progress_path() -> Path:
    override = os.environ.get(_ENV_OVERRIDE)
    if override:
        return Path(override).expanduser()
    return Path.home() / ".flowquest" / "progress.json"


def load() -> dict[str, Any]:
    """Read and normalise the global progress blob (empty state if absent)."""
    path = progress_path()
    raw: Any = None
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            raw = None
    return gamification.normalize_state(raw)


def save(state: dict[str, Any]) -> dict[str, Any]:
    """Persist a normalised state atomically with restrictive permissions."""
    normalized = gamification.normalize_state(state)
    path = progress_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(normalized, indent=2), encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    tmp.replace(path)
    return normalized


def mutate(
    fn: Callable[[dict[str, Any]], tuple[dict[str, Any], Any]],
) -> tuple[dict[str, Any], Any]:
    """Run ``fn(state) -> (new_state, outcome)`` under the lock and persist.

    Returns ``(new_state, outcome)``. Use for any award/record operation so the
    global file stays consistent across concurrently open notebooks.
    """
    with _LOCK:
        state = load()
        new_state, outcome = fn(state)
        save(new_state)
        return new_state, outcome


def view() -> dict[str, Any]:
    """Public (derived) view of the current global progression."""
    with _LOCK:
        return gamification.public_view(load())


def reset() -> dict[str, Any]:
    """Wipe all global progression back to an empty state."""
    with _LOCK:
        return save(gamification.empty_state())


def forget_notebook(notebook_key: str) -> dict[str, Any]:
    """Remove a single notebook's idempotency keys so its checkpoints can be
    re-earned. XP already pooled into the global total is intentionally kept —
    levels represent your overall journey and don't regress when you clear one
    notebook's local progress.
    """
    prefix = f"{notebook_key}::"
    with _LOCK:
        state = load()
        state["completedAwardKeys"] = [
            k for k in state.get("completedAwardKeys", []) if not k.startswith(prefix)
        ]
        state["exploredCellHashes"] = [
            h for h in state.get("exploredCellHashes", []) if not h.startswith(prefix)
        ]
        return save(state)


__all__ = [
    "progress_path",
    "load",
    "save",
    "mutate",
    "view",
    "reset",
    "forget_notebook",
]
