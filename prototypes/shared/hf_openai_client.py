from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from openai import OpenAI


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


def _read_setting(name: str) -> str | None:
    for alias in _ENV_ALIASES[name]:
        value = os.getenv(alias)
        if value:
            return value
    return None


def _mask_secret(secret: str | None) -> str:
    if not secret:
        return "missing"
    if len(secret) <= 8:
        return "configured"
    return f"{secret[:4]}...{secret[-4:]}"


def _strip_code_fences(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z0-9_+-]*\n", "", cleaned)
        cleaned = re.sub(r"\n```$", "", cleaned)
    return cleaned.strip()


def _extract_json_object(text: str) -> dict[str, Any]:
    cleaned = _strip_code_fences(text)
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if not match:
        raise ValueError("No JSON object found in model response.")
    parsed = json.loads(match.group(0))
    if not isinstance(parsed, dict):
        raise ValueError("Model response JSON was not an object.")
    return parsed


@dataclass
class EndpointSettings:
    base_url: str
    model: str
    api_key: str
    env_file: str | None = None

    @classmethod
    def from_env(cls, start_path: str | Path | None = None) -> "EndpointSettings | None":
        env_file = _find_env_file(start_path)
        if env_file is not None:
            load_dotenv(env_file, override=False)

        values = {key: _read_setting(key) for key in _ENV_ALIASES}
        if not all(values.values()):
            return None

        return cls(
            base_url=values["base_url"] or "",
            model=values["model"] or "",
            api_key=values["api_key"] or "",
            env_file=str(env_file) if env_file is not None else None,
        )

    def to_rows(self) -> list[dict[str, str]]:
        return [
            {"field": "base_url", "value": self.base_url},
            {"field": "model", "value": self.model},
            {"field": "api_key", "value": _mask_secret(self.api_key)},
            {"field": "env_file", "value": self.env_file or "not found"},
        ]


class HuggingFaceOpenAIClient:
    def __init__(self, settings: EndpointSettings, timeout: float = 60.0):
        self.settings = settings
        self.client = OpenAI(
            api_key=settings.api_key,
            base_url=settings.base_url,
            timeout=timeout,
        )

    @classmethod
    def from_env(
        cls,
        start_path: str | Path | None = None,
    ) -> "HuggingFaceOpenAIClient | None":
        settings = EndpointSettings.from_env(start_path=start_path)
        if settings is None:
            return None
        return cls(settings)

    def chat(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.2,
        max_tokens: int = 900,
    ) -> str:
        response = self.client.chat.completions.create(
            model=self.settings.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        content = response.choices[0].message.content or ""
        return content.strip()

    def chat_json(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.2,
        max_tokens: int = 900,
    ) -> dict[str, Any]:
        response = self.chat(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return _extract_json_object(response)

    def ping(self) -> str:
        system_prompt = "You are a connectivity check. Reply with a short plain-text status."
        user_prompt = "Reply with exactly: endpoint ok"
        return self.chat(system_prompt=system_prompt, user_prompt=user_prompt, temperature=0.0, max_tokens=20)


def endpoint_status_rows(
    start_path: str | Path | None = None,
    validate_connection: bool = False,
) -> list[dict[str, str]]:
    settings = EndpointSettings.from_env(start_path=start_path)
    if settings is None:
        env_file = _find_env_file(start_path)
        return [
            {"field": "status", "value": "missing configuration"},
            {
                "field": "expected_vars",
                "value": ", ".join(
                    _ENV_ALIASES["base_url"][:1]
                    + _ENV_ALIASES["model"][:1]
                    + _ENV_ALIASES["api_key"][:1]
                ),
            },
            {"field": "env_file", "value": str(env_file) if env_file is not None else "not found"},
        ]

    rows = [{"field": "status", "value": "configured"}, *settings.to_rows()]
    if not validate_connection:
        return rows

    try:
        client = HuggingFaceOpenAIClient(settings)
        ping_text = client.ping()
        rows.append({"field": "connection", "value": ping_text})
    except Exception as exc:
        rows.append({"field": "connection", "value": f"failed: {type(exc).__name__}: {exc}"})
    return rows