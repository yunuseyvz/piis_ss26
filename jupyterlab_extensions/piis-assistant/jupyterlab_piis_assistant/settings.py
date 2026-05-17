"""Global FlowQuest settings stored in ``~/.flowquest/settings.json``.

Settings here apply across all notebooks (model, base URL, API key). Per-notebook
preferences (difficulty etc.) live in ``metadata.flowquest`` instead.

The store falls back to environment variables / .env if the JSON file is missing,
so existing deployments keep working without any change.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

_ENV_ALIASES = {
    "base_url": ("HF_OPENAI_BASE_URL", "OPENAI_BASE_URL", "BASE_URL"),
    "model": ("HF_OPENAI_MODEL", "OPENAI_MODEL", "MODEL"),
    "api_key": ("HF_OPENAI_API_KEY", "OPENAI_API_KEY", "API_KEY"),
}


def _settings_dir() -> Path:
    override = os.environ.get("FLOWQUEST_SETTINGS_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / ".flowquest"


def _settings_path() -> Path:
    return _settings_dir() / "settings.json"


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


def load_global_settings() -> dict[str, Any]:
    path = _settings_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def save_global_settings(updates: dict[str, Any]) -> dict[str, Any]:
    """Merge ``updates`` into the persisted settings, return the new state."""
    directory = _settings_dir()
    directory.mkdir(parents=True, exist_ok=True)
    current = load_global_settings()
    cleaned: dict[str, Any] = dict(current)
    for key in ("base_url", "model", "api_key"):
        if key in updates:
            value = updates[key]
            if value is None or value == "":
                cleaned.pop(key, None)
            else:
                cleaned[key] = str(value).strip()
    if "favorite_models" in updates and isinstance(updates["favorite_models"], list):
        cleaned["favorite_models"] = [str(m).strip() for m in updates["favorite_models"] if m][:20]
    path = _settings_path()
    path.write_text(json.dumps(cleaned, indent=2), encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return cleaned


def resolve_endpoint(start_path: str | Path | None = None) -> dict[str, str | None]:
    """Resolve the active model/baseUrl/apiKey, in priority order:

    1. ``~/.flowquest/settings.json`` (set via the settings panel)
    2. environment variables / .env file at the workspace root
    """
    settings = load_global_settings()
    base_url = settings.get("base_url")
    model = settings.get("model")
    api_key = settings.get("api_key")

    env_file = _find_env_file(start_path)
    if env_file is not None:
        load_dotenv(env_file, override=False)

    if not base_url:
        base_url = _read_env("base_url")
    if not model:
        model = _read_env("model")
    if not api_key:
        api_key = _read_env("api_key")

    return {
        "base_url": base_url,
        "model": model,
        "api_key": api_key,
        "env_file": str(env_file) if env_file else None,
        "settings_file": str(_settings_path()) if _settings_path().exists() else None,
    }


def public_settings(start_path: str | Path | None = None) -> dict[str, Any]:
    """User-facing dump for the settings UI. Never returns the API key."""
    resolved = resolve_endpoint(start_path)
    api_key = resolved.get("api_key") or ""
    return {
        "model": resolved.get("model") or "",
        "baseUrl": resolved.get("base_url") or "",
        "apiKeySet": bool(api_key),
        "apiKeyPreview": _mask(api_key),
        "settingsFile": resolved.get("settings_file"),
        "envFile": resolved.get("env_file"),
        "favoriteModels": load_global_settings().get("favorite_models") or [],
    }


def _mask(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "•" * len(value)
    return f"{value[:4]}…{value[-4:]}"


__all__ = [
    "load_global_settings",
    "save_global_settings",
    "resolve_endpoint",
    "public_settings",
]
