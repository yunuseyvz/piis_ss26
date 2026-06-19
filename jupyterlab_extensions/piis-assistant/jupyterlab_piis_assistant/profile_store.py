"""Single, user-scoped FlowQuest **profile** persisted as JSON.

The profile is the canonical global state for one user: their model
preferences **and** their XP/level progression. It lives in a single file at
``~/.flowquest/profile.json`` (mode 0600) and is the source of truth for
every FlowQuest surface across all notebooks on this machine.

Per-notebook data (difficulty, generated quizzes, chat transcripts) does
**not** live here — that travels with each ``.ipynb``'s metadata so it
stays portable. See :mod:`questStore` for the notebook-metadata side.

The API key is treated as a secret. It prefers the OS keychain when
available (Linux libsecret, macOS Keychain, Windows Credential Vault);
otherwise it falls back to a ``apiKey`` field inside ``profile.json`` with
mode 0600, and the UI is told which storage is in use.

A ``lastSyncedAt`` timestamp is bumped on every successful mutation so the
client can show an "auto-saved" indicator and so stale client caches can
be detected via :func:`profile_changed_since`.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable

from dotenv import load_dotenv

from . import gamification

_log = logging.getLogger(__name__)

_LOCK = threading.RLock()

_KEYRING_SERVICE = "flowquest"
_KEYRING_USERNAME = "api_key"

# The current on-disk schema. Bump when the file shape changes.
SCHEMA_VERSION = 2

_ENV_PROFILE_DIR = "FLOWQUEST_PROFILE_DIR"
_ENV_LEGACY_SETTINGS_DIR = "FLOWQUEST_SETTINGS_DIR"
_ENV_LEGACY_PROGRESS_FILE = "FLOWQUEST_PROGRESS_FILE"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def _profile_dir() -> Path:
    override = os.environ.get(_ENV_PROFILE_DIR)
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / ".flowquest"


def profile_path() -> Path:
    return _profile_dir() / "profile.json"


def _legacy_settings_path() -> Path:
    override = os.environ.get(_ENV_LEGACY_SETTINGS_DIR)
    base = Path(override).expanduser().resolve() if override else Path.home() / ".flowquest"
    return base / "settings.json"


def _legacy_progress_path() -> Path:
    override = os.environ.get(_ENV_LEGACY_PROGRESS_FILE)
    if override:
        return Path(override).expanduser()
    return Path.home() / ".flowquest" / "progress.json"


# ---------------------------------------------------------------------------
# Keychain helpers
# ---------------------------------------------------------------------------


def _keyring_module():  # type: ignore[no-untyped-def]
    try:
        import keyring  # type: ignore[import-not-found]
        from keyring.backends import fail  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        return None
    try:
        backend = keyring.get_keyring()
    except Exception:  # noqa: BLE001
        return None
    if isinstance(backend, fail.Keyring):
        return None
    return keyring


def _read_keychain_key() -> str | None:
    keyring = _keyring_module()
    if keyring is None:
        return None
    try:
        value = keyring.get_password(_KEYRING_SERVICE, _KEYRING_USERNAME)
    except Exception as exc:  # noqa: BLE001
        _log.warning("FlowQuest: keychain read failed: %s", exc)
        return None
    return value or None


def _write_keychain_key(value: str | None) -> bool:
    keyring = _keyring_module()
    if keyring is None:
        return False
    try:
        if value is None or value == "":
            keyring.delete_password(_KEYRING_SERVICE, _KEYRING_USERNAME)
        else:
            keyring.set_password(_KEYRING_SERVICE, _KEYRING_USERNAME, value)
    except Exception as exc:  # noqa: BLE001
        _log.warning("FlowQuest: keychain write failed: %s", exc)
        return False
    return True


def keychain_available() -> bool:
    return _keyring_module() is not None


# ---------------------------------------------------------------------------
# Env / .env resolution (used for the resolved endpoint view)
# ---------------------------------------------------------------------------


_ENV_ALIASES = {
    "base_url": ("HF_OPENAI_BASE_URL", "OPENAI_BASE_URL", "BASE_URL"),
    "model": ("HF_OPENAI_MODEL", "OPENAI_MODEL", "MODEL"),
    "api_key": ("HF_OPENAI_API_KEY", "OPENAI_API_KEY", "API_KEY"),
}


def _find_env_file(start_path: str | Path | None = None) -> Path | None:
    current = Path(start_path or Path.cwd()).resolve()
    if current.is_file():
        current = current.parent
    for directory in (current, *current.parents):
        candidate = directory / ".env"
        if candidate.exists():
            return candidate
    return None


def _read_env(name: str) -> str | None:
    for alias in _ENV_ALIASES[name]:
        value = os.getenv(alias)
        if value:
            return value
    return None


# ---------------------------------------------------------------------------
# Profile shape
# ---------------------------------------------------------------------------


def _empty_profile() -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "lastSyncedAt": 0.0,
        "settings": {
            "baseUrl": None,
            "model": None,
            "favoriteModels": [],
            "apiKey": None,
            "difficulty": "medium",
        },
        "progress": gamification.normalize_state(None),
    }


def _normalize_profile(raw: Any) -> dict[str, Any]:
    base = _empty_profile()
    if isinstance(raw, dict):
        # Settings.
        settings = raw.get("settings")
        if isinstance(settings, dict):
            for key in ("baseUrl", "model", "difficulty"):
                if key in settings and settings[key] is not None:
                    base["settings"][key] = settings[key]
            favorites = settings.get("favoriteModels")
            if isinstance(favorites, list):
                base["settings"]["favoriteModels"] = [str(m) for m in favorites if m][:20]
            if "apiKey" in settings and settings["apiKey"]:
                base["settings"]["apiKey"] = str(settings["apiKey"])
        # Progress.
        base["progress"] = gamification.normalize_state(raw.get("progress"))
        # Sync metadata.
        if "lastSyncedAt" in raw:
            try:
                base["lastSyncedAt"] = float(raw["lastSyncedAt"] or 0)
            except (TypeError, ValueError):
                pass
    return base


# ---------------------------------------------------------------------------
# Load / save
# ---------------------------------------------------------------------------


def _migrate_legacy_files(profile: dict[str, Any]) -> dict[str, Any]:
    """One-time migration from the old settings.json + progress.json pair."""
    changed = False
    settings_path = _legacy_settings_path()
    if settings_path.exists():
        try:
            legacy = json.loads(settings_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            legacy = None
        if isinstance(legacy, dict):
            for key in ("baseUrl", "model", "base_url", "model_id"):
                if key in legacy and profile["settings"].get(translate_key(key)) is None:
                    profile["settings"][translate_key(key)] = legacy[key]
            favorites = legacy.get("favoriteModels") or legacy.get("favorite_models")
            if isinstance(favorites, list) and not profile["settings"]["favoriteModels"]:
                profile["settings"]["favoriteModels"] = [str(m) for m in favorites if m][:20]
            if "apiKey" not in profile["settings"] or not profile["settings"]["apiKey"]:
                if legacy.get("apiKey") or legacy.get("api_key"):
                    profile["settings"]["apiKey"] = str(legacy.get("apiKey") or legacy.get("api_key"))
        changed = True

    progress_path = _legacy_progress_path()
    if progress_path.exists():
        try:
            legacy_progress = json.loads(progress_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            legacy_progress = None
        if isinstance(legacy_progress, dict):
            # Only adopt if the new profile's progress is empty.
            if (profile["progress"].get("xpTotal") or 0) == 0 and (legacy_progress.get("xpTotal") or 0) > 0:
                profile["progress"] = gamification.normalize_state(legacy_progress)
        changed = True

    if changed:
        try:
            if settings_path.exists():
                settings_path.unlink()
        except OSError:
            pass
        try:
            if progress_path.exists():
                progress_path.unlink()
        except OSError:
            pass
    return profile


def translate_key(key: str) -> str:
    return {
        "base_url": "baseUrl",
        "model_id": "model",
    }.get(key, key)


def load() -> dict[str, Any]:
    """Read, migrate, and normalise the profile blob (empty if absent)."""
    path = profile_path()
    raw: Any = None
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            raw = None
    profile = _normalize_profile(raw)
    profile = _migrate_legacy_files(profile)
    return profile


def save(profile: dict[str, Any]) -> dict[str, Any]:
    """Persist the profile atomically with restrictive permissions."""
    normalized = _normalize_profile(profile)
    normalized["lastSyncedAt"] = time.time()
    path = profile_path()
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
    """Run ``fn(profile) -> (new_profile, outcome)`` under the lock and persist.

    Returns the new normalised profile and the outcome. Use for any
    award/record operation so the global file stays consistent across
    concurrently open notebooks.
    """
    with _LOCK:
        profile = load()
        new_profile, outcome = fn(profile)
        return save(new_profile), outcome


def profile_changed_since(since_ts: float) -> bool:
    """True if the profile on disk has a ``lastSyncedAt`` newer than ``since_ts``."""
    try:
        profile = load()
    except Exception:  # noqa: BLE001
        return False
    return float(profile.get("lastSyncedAt") or 0.0) > float(since_ts)


# ---------------------------------------------------------------------------
# Settings mutations (model, baseUrl, apiKey, favoriteModels, difficulty)
# ---------------------------------------------------------------------------


def get_settings(profile: dict[str, Any]) -> dict[str, Any]:
    return dict(profile.get("settings") or {})


def update_settings(profile: dict[str, Any], updates: dict[str, Any]) -> dict[str, Any]:
    settings = dict(profile.get("settings") or {})

    for key in ("baseUrl", "model"):
        if key in updates:
            value = updates[key]
            if value is None:
                settings.pop(key, None)
            else:
                settings[key] = str(value).strip()

    if "favoriteModels" in updates and isinstance(updates["favoriteModels"], list):
        settings["favoriteModels"] = [str(m).strip() for m in updates["favoriteModels"] if m][:20]

    if "difficulty" in updates and updates["difficulty"] in ("easy", "medium", "hard"):
        settings["difficulty"] = updates["difficulty"]

    if "apiKey" in updates:
        new_value = updates["apiKey"]
        new_value = None if new_value in (None, "") else str(new_value).strip()
        wrote_to_keychain = _write_keychain_key(new_value)
        if wrote_to_keychain:
            settings.pop("apiKey", None)
        elif new_value is None:
            settings.pop("apiKey", None)
        else:
            settings["apiKey"] = new_value

    profile["settings"] = settings
    return profile


# ---------------------------------------------------------------------------
# Progress mutations (XP, levels, reflections, quizzes, etc.)
# ---------------------------------------------------------------------------


def get_progress(profile: dict[str, Any]) -> dict[str, Any]:
    return dict(profile.get("progress") or {})


def update_progress(profile: dict[str, Any], progress: dict[str, Any]) -> dict[str, Any]:
    profile["progress"] = gamification.normalize_state(progress)
    return profile


def reset_progress(profile: dict[str, Any]) -> dict[str, Any]:
    profile["progress"] = gamification.empty_state()
    return profile


def forget_notebook_in_profile(profile: dict[str, Any], notebook_key: str) -> dict[str, Any]:
    """Remove a single notebook's idempotency keys so its checkpoints can be re-earned."""
    prefix = f"{notebook_key}::"
    progress = dict(profile.get("progress") or {})
    progress["completedAwardKeys"] = [
        k for k in progress.get("completedAwardKeys", []) if not k.startswith(prefix)
    ]
    progress["exploredCellHashes"] = [
        h for h in progress.get("exploredCellHashes", []) if not h.startswith(prefix)
    ]
    profile["progress"] = gamification.normalize_state(progress)
    return profile


# ---------------------------------------------------------------------------
# Public view (for the UI) — never returns the raw API key
# ---------------------------------------------------------------------------


def _mask(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "•" * len(value)
    return f"{value[:4]}…{value[-4:]}"


def resolve_endpoint(start_path: str | Path | None = None) -> dict[str, str | None]:
    """Resolve the active model / baseUrl / apiKey, in priority order:

    1. API key from OS keychain when available, otherwise from profile.json.
    2. Other fields from profile.json.
    3. Environment variables / .env file at the workspace root.
    """
    profile = load()
    settings = profile.get("settings") or {}
    base_url = settings.get("baseUrl")
    model = settings.get("model")
    api_key = _read_keychain_key()

    legacy_key = settings.get("apiKey")
    if legacy_key and not api_key and keychain_available():
        if _write_keychain_key(str(legacy_key)):
            api_key = str(legacy_key)
            settings.pop("apiKey", None)
            with _LOCK:
                save(profile)

    if not api_key:
        api_key = legacy_key

    env_file = _find_env_file(start_path)
    if env_file is not None:
        load_dotenv(env_file, override=False)

    if base_url is None:
        base_url = _read_env("base_url")
    if model is None:
        model = _read_env("model")
    if api_key is None:
        api_key = _read_env("api_key")

    return {
        "base_url": base_url,
        "model": model,
        "api_key": api_key,
        "env_file": str(env_file) if env_file else None,
        "settings_file": str(profile_path()) if profile_path().exists() else None,
    }


def public_settings(start_path: str | Path | None = None) -> dict[str, Any]:
    """User-facing dump for the settings UI. Never returns the API key."""
    resolved = resolve_endpoint(start_path)
    api_key = resolved.get("api_key") or ""
    storage: str
    if _read_keychain_key():
        storage = "keychain"
    elif (load().get("settings") or {}).get("apiKey"):
        storage = "file"
    elif api_key:
        storage = "env"
    else:
        storage = "none"
    settings = load().get("settings") or {}
    return {
        "model": resolved.get("model") or "",
        "baseUrl": resolved.get("base_url") or "",
        "apiKeySet": bool(api_key),
        "apiKeyPreview": _mask(api_key),
        "apiKeyStorage": storage,
        "keychainAvailable": keychain_available(),
        "settingsFile": resolved.get("settings_file"),
        "envFile": resolved.get("env_file"),
        "favoriteModels": settings.get("favoriteModels") or [],
    }


# ---------------------------------------------------------------------------
# Re-export gamification helpers used by handlers
# ---------------------------------------------------------------------------


def public_view(profile: dict[str, Any]) -> dict[str, Any]:
    """Public (derived) view of the progress section."""
    return gamification.public_view(profile.get("progress") or {})


__all__ = [
    "SCHEMA_VERSION",
    "profile_path",
    "load",
    "save",
    "mutate",
    "profile_changed_since",
    "get_settings",
    "update_settings",
    "get_progress",
    "update_progress",
    "reset_progress",
    "forget_notebook_in_profile",
    "public_view",
    "public_settings",
    "resolve_endpoint",
    "keychain_available",
]
