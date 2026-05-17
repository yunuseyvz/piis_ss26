"""Global FlowQuest settings stored in ``~/.flowquest/settings.json``.

The model id and base URL are non-secret and are persisted as JSON in
``settings.json``. The **API key** is treated as a secret:

1. If the OS keychain is available (``keyring`` plus a real backend such as
   libsecret on Linux, macOS Keychain, or Windows Credential Vault), the key
   is stored there under service ``flowquest`` / username ``api_key``.
2. Otherwise we fall back to writing the key into ``settings.json`` with
   mode ``0600`` and surface a warning through the public settings view
   so the UI can flag it. This keeps headless / container deployments
   working but makes the trade-off visible.

In both cases environment variables (``HF_OPENAI_API_KEY`` etc.) and a
workspace ``.env`` are still honoured as a last-resort fallback so existing
installations keep working without configuration churn.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

_KEYRING_SERVICE = "flowquest"
_KEYRING_USERNAME = "api_key"

_log = logging.getLogger(__name__)

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


# ---------------------------------------------------------------------------
# Keychain helpers — the only entry points that touch the API key.
# ---------------------------------------------------------------------------


def _keyring_module():  # type: ignore[no-untyped-def]
    """Return the ``keyring`` module if it's installed *and* a real backend
    is available. The default ``fail.Keyring`` backend is treated as no-op
    because we want the file fallback in that case rather than silent loss.
    """
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


def _keychain_available() -> bool:
    return _keyring_module() is not None


# ---------------------------------------------------------------------------
# Settings file (model + base URL only, plus a possible plaintext fallback).
# ---------------------------------------------------------------------------


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
    """Merge updates into the persisted settings.

    The API key is written to the OS keychain when available; otherwise it
    falls back to ``settings.json`` (mode 0600). The returned dict is the
    contents of ``settings.json`` after the write, so the API key is *not*
    included unless the fallback was used.
    """
    directory = _settings_dir()
    directory.mkdir(parents=True, exist_ok=True)
    current = load_global_settings()
    cleaned: dict[str, Any] = dict(current)

    # Non-secret fields go straight into JSON.
    for key in ("base_url", "model"):
        if key in updates:
            value = updates[key]
            if value is None or value == "":
                cleaned.pop(key, None)
            else:
                cleaned[key] = str(value).strip()

    if "favorite_models" in updates and isinstance(updates["favorite_models"], list):
        cleaned["favorite_models"] = [str(m).strip() for m in updates["favorite_models"] if m][:20]

    # API key: prefer keychain. If it succeeds, scrub any existing plaintext.
    if "api_key" in updates:
        new_value = updates["api_key"]
        new_value = None if new_value in (None, "") else str(new_value).strip()
        wrote_to_keychain = _write_keychain_key(new_value)
        if wrote_to_keychain:
            cleaned.pop("api_key", None)
        else:
            # Fallback: persist into settings.json with mode 0600 so the file
            # at least isn't world-readable. Surface this through the UI via
            # public_settings().
            if new_value is None:
                cleaned.pop("api_key", None)
            else:
                cleaned["api_key"] = new_value

    path = _settings_path()
    path.write_text(json.dumps(cleaned, indent=2), encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return cleaned


def resolve_endpoint(start_path: str | Path | None = None) -> dict[str, str | None]:
    """Resolve the active model / baseUrl / apiKey, in priority order:

    1. API key from OS keychain when available, otherwise from settings.json.
    2. Other fields from settings.json.
    3. Environment variables / .env file at the workspace root.
    """
    settings = load_global_settings()
    base_url = settings.get("base_url")
    model = settings.get("model")
    api_key = _read_keychain_key()

    # One-time migration: if there's a plaintext api_key in settings.json AND
    # the keychain is available, move it.
    legacy_key = settings.get("api_key")
    if legacy_key and not api_key and _keychain_available():
        if _write_keychain_key(str(legacy_key)):
            api_key = str(legacy_key)
            settings.pop("api_key", None)
            try:
                _settings_path().write_text(
                    json.dumps(settings, indent=2), encoding="utf-8"
                )
                _settings_path().chmod(0o600)
                _log.info("FlowQuest: migrated plaintext API key from settings.json to OS keychain.")
            except OSError as exc:
                _log.warning("FlowQuest: keychain migration succeeded but file write failed: %s", exc)

    if not api_key:
        api_key = legacy_key

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
    raw_settings = load_global_settings()
    storage: str
    if _read_keychain_key():
        storage = "keychain"
    elif raw_settings.get("api_key"):
        storage = "file"
    elif api_key:
        storage = "env"
    else:
        storage = "none"
    return {
        "model": resolved.get("model") or "",
        "baseUrl": resolved.get("base_url") or "",
        "apiKeySet": bool(api_key),
        "apiKeyPreview": _mask(api_key),
        "apiKeyStorage": storage,
        "keychainAvailable": _keychain_available(),
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
