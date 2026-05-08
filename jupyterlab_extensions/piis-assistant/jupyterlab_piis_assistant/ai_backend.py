from __future__ import annotations

import os
from pathlib import Path

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


class AssistantClient:
    def __init__(self, base_url: str, model: str, api_key: str, timeout: float = 60.0):
        self.base_url = base_url
        self.model = model
        self.api_key = api_key
        self.client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout)

    @classmethod
    def from_env(cls, start_path: str | Path | None = None) -> "AssistantClient | None":
        env_file = _find_env_file(start_path)
        if env_file is not None:
            load_dotenv(env_file, override=False)

        base_url = _read_setting("base_url")
        model = _read_setting("model")
        api_key = _read_setting("api_key")
        if not all((base_url, model, api_key)):
            return None

        return cls(base_url=base_url or "", model=model or "", api_key=api_key or "")

    def chat(self, prompt: str) -> str:
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are PIIS Assistant inside JupyterLab. "
                        "Be concise, direct, and useful."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            max_tokens=700,
        )
        return (response.choices[0].message.content or "").strip()


def status_payload(start_path: str | Path | None = None) -> dict[str, str | bool]:
    env_file = _find_env_file(start_path)
    client = AssistantClient.from_env(start_path=start_path)
    if client is None:
        return {
            "configured": False,
            "model": "Missing",
            "baseUrl": "Missing",
            "envFile": str(env_file) if env_file is not None else "not found",
            "message": "Missing HF_OPENAI_BASE_URL, HF_OPENAI_MODEL, or HF_OPENAI_API_KEY.",
        }

    return {
        "configured": True,
        "model": client.model,
        "baseUrl": client.base_url,
        "envFile": str(env_file) if env_file is not None else "not found",
        "message": "Assistant endpoint is configured.",
    }


def chat_payload(prompt: str, start_path: str | Path | None = None) -> dict[str, str]:
    prompt = prompt.strip()
    if not prompt:
        raise ValueError("Prompt must not be empty.")

    client = AssistantClient.from_env(start_path=start_path)
    if client is None:
        raise RuntimeError(
            "Missing endpoint configuration. Add HF_OPENAI_BASE_URL, HF_OPENAI_MODEL, and HF_OPENAI_API_KEY to the root .env file."
        )

    return {
        "title": "Assistant response",
        "response": client.chat(prompt),
        "model": client.model,
    }