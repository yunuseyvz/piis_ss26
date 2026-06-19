from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from openai import OpenAI

from .profile_store import resolve_endpoint


_DIFFICULTY_PROFILES: dict[str, dict[str, Any]] = {
    "easy": {
        "label": "easy",
        "explain": "Aim the explanation at a complete beginner. Keep sentences short and use plain language. Define one technical term inline if you must use it.",
        "reflect": "Ask a gentle, low-stakes question that invites the learner to explain the cell in their own words.",
        "next_steps": "Suggest small, very concrete next steps a beginner can act on without prior context.",
        "quiz": "Make the question approachable. Distractors should be obviously distinguishable from the correct option.",
        "baseline": "Be generous in your scoring. When unsure, prefer the higher score.",
    },
    "medium": {
        "label": "medium",
        "explain": "Aim the explanation at a working data-science practitioner. Keep replies under 180 words.",
        "reflect": "Ask a focused question about a design decision or tradeoff in this cell.",
        "next_steps": "Suggest pragmatic next steps that move the analysis forward.",
        "quiz": "Distractors should be plausible. The question should test understanding, not just recall.",
        "baseline": "Be even-handed. Reward clarity, penalize hidden state and unexplained choices.",
    },
    "hard": {
        "label": "hard",
        "explain": "Aim the explanation at a senior practitioner reviewing the notebook. Be terse, mention failure modes and edge cases.",
        "reflect": "Ask a sharp, probing question about a non-obvious risk, assumption, or tradeoff in this cell.",
        "next_steps": "Suggest opinionated next steps a senior reviewer would push back on. Mention robustness and reproducibility checks.",
        "quiz": "Distractors should be tempting and require careful reading. Test deep understanding.",
        "baseline": "Be strict. Reward only when criteria are clearly met; otherwise score conservatively.",
    },
}


def _difficulty_profile(level: Any) -> dict[str, Any]:
    if isinstance(level, str) and level.lower() in _DIFFICULTY_PROFILES:
        return _DIFFICULTY_PROFILES[level.lower()]
    return _DIFFICULTY_PROFILES["medium"]


def _difficulty_suffix(profile: dict[str, Any], key: str) -> str:
    note = profile.get(key) or ""
    label = profile.get("label", "medium")
    if not note:
        return ""
    return f"\n\nDifficulty: {label}. {note}"


class AssistantClient:
    def __init__(self, base_url: str, model: str, api_key: str, timeout: float = 45.0):
        self.base_url = base_url
        self.model = model
        self.api_key = api_key
        # Slightly shorter default timeout than the SDK's 600s — long calls
        # are usually a stuck endpoint. The retry layer adds resilience.
        self.client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout)
        self._timeout = timeout

    @classmethod
    def from_env(cls, start_path: str | Path | None = None) -> "AssistantClient | None":
        resolved = resolve_endpoint(start_path)
        base_url = resolved.get("base_url")
        model = resolved.get("model")
        api_key = resolved.get("api_key")
        if not all((base_url, model, api_key)):
            return None
        return cls(base_url=base_url or "", model=model or "", api_key=api_key or "")

    def chat(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.2,
        max_tokens: int | None = None,
        response_format: dict[str, str] | None = None,
        max_attempts: int = 3,
        backoff_seconds: float = 1.5,
    ) -> str:
        """Call the chat completion endpoint with bounded retries.

        Retries on transient errors (timeout, rate-limit, network). Fails
        fast on 4xx that won't change on retry (auth, bad request).
        """
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if response_format is not None:
            kwargs["response_format"] = response_format

        last_exc: BaseException | None = None
        used_response_format_fallback = False
        
        print("\n" + "="*50)
        print(f"LLM REQUEST -> {self.model}")
        print("="*50)
        for msg in messages:
            print(f"[{msg['role'].upper()}]:\n{msg['content']}\n")
        print("="*50 + "\n")
        
        for attempt in range(1, max_attempts + 1):
            try:
                response = self.client.chat.completions.create(**kwargs)
                content = (response.choices[0].message.content or "").strip()
                
                print("\n" + "="*50)
                print(f"LLM RESPONSE (Attempt {attempt})")
                print("="*50)
                print(content)
                print("="*50 + "\n")
                
                if "</think>" in content:
                    content = content.split("</think>")[-1].strip()
                return content
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                kind, message = _classify_openai_error(exc)
                # Some backends reject `response_format`; drop it and retry once
                # without bumping the attempt counter so we still get our full budget.
                if (
                    response_format is not None
                    and not used_response_format_fallback
                    and ("response_format" in str(exc).lower() or kind == "other")
                ):
                    kwargs.pop("response_format", None)
                    used_response_format_fallback = True
                    continue

                # Don't retry hard failures.
                if kind in {"auth"}:
                    raise AssistantBackendError(message, kind=kind, original=exc) from exc

                if attempt >= max_attempts:
                    raise AssistantBackendError(message, kind=kind, original=exc) from exc

                # Exponential-ish backoff capped at ~6s so we don't sit forever.
                delay = min(6.0, backoff_seconds * (2 ** (attempt - 1)))
                time.sleep(delay)

        # Defensive: should never get here.
        raise AssistantBackendError(
            "The model endpoint did not respond after several attempts.",
            kind="timeout",
            original=last_exc,
        )


class AssistantBackendError(RuntimeError):
    """Raised when the LLM call cannot be completed.

    Carries a ``user_message`` field meant to be safe to surface in the UI
    (no stack traces, no API keys), and an ``error_kind`` we can branch on
    in the frontend (``timeout``, ``rate_limit``, ``auth``, ``network``,
    ``other``).
    """

    def __init__(self, user_message: str, *, kind: str = "other", original: BaseException | None = None) -> None:
        super().__init__(user_message)
        self.user_message = user_message
        self.error_kind = kind
        self.original = original


def _classify_openai_error(exc: BaseException) -> tuple[str, str]:
    """Map an OpenAI client exception to (kind, friendly_message)."""
    name = exc.__class__.__name__
    text = str(exc).lower()
    # The OpenAI SDK exposes specific subclasses but we avoid hard imports so
    # this stays compatible across SDK versions.
    if name in {"APITimeoutError", "Timeout"} or "timed out" in text or "timeout" in text:
        return (
            "timeout",
            "The model took too long to respond. Please try again — the endpoint may be warming up.",
        )
    if name in {"RateLimitError"} or "rate limit" in text or "429" in text:
        return (
            "rate_limit",
            "The endpoint is rate-limiting us. Wait a moment and retry.",
        )
    if name in {"AuthenticationError", "PermissionDeniedError"} or "401" in text or "403" in text:
        return (
            "auth",
            "The API key was rejected. Open FlowQuest → Settings and re-enter your key.",
        )
    if name in {"APIConnectionError"} or "connection" in text or "connect" in text:
        return (
            "network",
            "Could not reach the model endpoint. Check your network or the base URL in Settings.",
        )
    if name in {"BadRequestError", "UnprocessableEntityError"}:
        return ("other", "The endpoint rejected the request. Try a different model.")
    return ("other", f"The model endpoint returned an error: {exc.__class__.__name__}.")


def _clip_text(value: str, limit: int = 1400) -> str:
    stripped = value.strip()
    if len(stripped) <= limit:
        return stripped
    return f"{stripped[: limit - 1]}…"


def _sanitize_history(history: Any) -> list[dict[str, str]]:
    if not isinstance(history, list):
        return []

    sanitized: list[dict[str, str]] = []
    for item in history[-10:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role not in {"user", "assistant"} or not isinstance(content, str):
            continue
        cleaned = _clip_text(content)
        if not cleaned:
            continue
        sanitized.append({"role": role, "content": cleaned})
    return sanitized


def _sanitize_notebook_context(notebook: Any) -> dict[str, Any]:
    if not isinstance(notebook, dict):
        return {}

    allowed = {
        "notebookName",
        "path",
        "cellCount",
        "activeCellIndex",
        "activeCellType",
        "activeCellSource",
        "activeOutput",
        "selectedOutput",
        "kernelName",
        "kernelStatus",
        "hasNotebook",
        "contextMode",
        "attachmentLabel",
        "attachmentPreview",
        "attachedPromptContext",
    }
    cleaned: dict[str, Any] = {}
    for key in allowed:
        value = notebook.get(key)
        if isinstance(value, str):
            limit = 12000 if key == "attachedPromptContext" else 1800 if key == "attachmentPreview" else 1400
            cleaned[key] = _clip_text(value, limit)
        elif isinstance(value, bool | int):
            cleaned[key] = value
    return cleaned


def status_payload(start_path: str | Path | None = None) -> dict[str, str | bool]:
    resolved = resolve_endpoint(start_path)
    client = AssistantClient.from_env(start_path=start_path)
    env_file = resolved.get("env_file") or "not found"
    settings_file = resolved.get("settings_file") or ""
    if client is None:
        return {
            "configured": False,
            "model": "Missing",
            "baseUrl": "Missing",
            "envFile": str(env_file) if env_file is not None else "not found",
            "settingsFile": settings_file,
            "message": "Missing model / base URL / API key. Open FlowQuest settings to configure them.",
        }

    try:
        client.chat([{"role": "user", "content": "ping"}], max_tokens=2, max_attempts=1)
    except AssistantBackendError as exc:
        return {
            "configured": False,
            "model": client.model,
            "baseUrl": client.base_url,
            "envFile": str(env_file) if env_file is not None else "not found",
            "settingsFile": settings_file,
            "message": f"Endpoint reachable but failed: {exc.user_message}",
        }
    except Exception as exc:
        return {
            "configured": False,
            "model": client.model,
            "baseUrl": client.base_url,
            "envFile": str(env_file) if env_file is not None else "not found",
            "settingsFile": settings_file,
            "message": f"Could not verify endpoint: {str(exc)}",
        }

    return {
        "configured": True,
        "model": client.model,
        "baseUrl": client.base_url,
        "envFile": str(env_file) if env_file is not None else "not found",
        "settingsFile": settings_file,
        "message": "Assistant endpoint is configured and reachable.",
    }


def chat_payload(
    prompt: str,
    history: Any = None,
    notebook: Any = None,
    start_path: str | Path | None = None,
) -> dict[str, str]:
    prompt = prompt.strip()
    if not prompt:
        raise ValueError("Prompt must not be empty.")

    client = AssistantClient.from_env(start_path=start_path)
    if client is None:
        raise RuntimeError(
            "Missing endpoint configuration. Add HF_OPENAI_BASE_URL, HF_OPENAI_MODEL, and HF_OPENAI_API_KEY to the root .env file."
        )

    notebook_context = _sanitize_notebook_context(notebook)
    recent_history = _sanitize_history(history)
    messages = [
        {
            "role": "system",
            "content": (
                "You are Flowy, FlowQuest's friendly notebook companion inside JupyterLab. "
                "Be concise, direct, and useful. "
                "The latest user message includes an automatically appended context section "
                "containing the user's ENTIRE notebook (every cell, in order, with the "
                "currently active cell marked) plus the active cell's source and output. "
                "Treat this as your full picture of what the user is working on and ground "
                "every answer in it. When the user says 'this cell' or 'here', they mean the "
                "cell marked as active. If something genuinely isn't in the context, say so plainly."
            ),
        }
    ]

    messages.extend(recent_history)

    attached_context = str(notebook_context.get("attachedPromptContext") or "").strip()
    user_content = _clip_text(prompt, 3000)
    if attached_context:
        user_content = f"{user_content}\n\nAttached notebook context:\n{attached_context}"

    messages.append({"role": "user", "content": _clip_text(user_content, 16000)})

    return {
        "title": notebook_context.get("notebookName", "Assistant response"),
        "response": client.chat(messages),
        "model": client.model,
    }


# ---------------------------------------------------------------------------
# FlowQuest-specific LLM flows
# ---------------------------------------------------------------------------


_EXPLAIN_SYSTEM = (
    "You are FlowQuest, a playful but knowledgeable tutor inside a Jupyter notebook. "
    "Given one cell and its workflow context, explain what the cell does, "
    "why it matters in the surrounding workflow, and one concrete thing the reader "
    "should double-check. Keep replies under 180 words. Use short paragraphs."
)


_REFLECT_SYSTEM = (
    "You are FlowQuest's reflection coach. Ask exactly one short, pointed, "
    "open-ended question about the attached cell that makes the learner reason "
    "about a design choice, risk, or tradeoff. Return only the question."
)


_NEXT_STEP_SYSTEM = (
    "You are FlowQuest's workflow planner. Given a notebook summary and its open "
    "issues, suggest exactly three concrete next-step ideas as a bullet list. "
    "Each idea: start with a strong verb, mention the cell index when relevant, "
    "keep it under 20 words. No preamble."
)


def explain_cell_payload(
    cell: dict[str, Any],
    analysis: dict[str, Any] | None,
    start_path: str | Path | None = None,
    difficulty: str = "medium",
) -> dict[str, str]:
    client = AssistantClient.from_env(start_path=start_path)
    if client is None:
        raise RuntimeError("Missing endpoint configuration.")

    profile = _difficulty_profile(difficulty)
    system_prompt = _EXPLAIN_SYSTEM + _difficulty_suffix(profile, "explain")

    source = _clip_text(str(cell.get("source") or ""), 3000) or "[empty cell]"
    cell_index = cell.get("index")
    region = cell.get("region") or "other"
    workflow_outline = ""
    if analysis is not None:
        cells = analysis.get("cells") or []
        outline_parts: list[str] = []
        for c in cells:
            icon = c.get("regionIcon") or ""
            idx = c.get("index")
            summary = c.get("summary") or ""
            outline_parts.append(f"{idx}: {icon} {c.get('region')} — {summary}")
        workflow_outline = "\n".join(outline_parts[:60])

    user_prompt = (
        f"Notebook outline (index: region — summary):\n{workflow_outline}\n\n"
        f"Focus cell index: {cell_index}\n"
        f"Focus cell region: {region}\n"
        f"Focus cell source:\n{source}\n\n"
        "Explain this cell in context and point out one thing worth double-checking."
    )

    response = client.chat(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.2,
    )
    return {"explanation": response, "model": client.model}


def reflect_prompt_payload(
    cell: dict[str, Any],
    start_path: str | Path | None = None,
    difficulty: str = "medium",
) -> dict[str, str]:
    client = AssistantClient.from_env(start_path=start_path)
    if client is None:
        raise RuntimeError("Missing endpoint configuration.")

    profile = _difficulty_profile(difficulty)
    system_prompt = _REFLECT_SYSTEM + _difficulty_suffix(profile, "reflect")

    source = _clip_text(str(cell.get("source") or ""), 2500) or "[empty cell]"
    cell_index = cell.get("index")
    region = cell.get("region") or "other"
    user_prompt = (
        f"Cell index: {cell_index}\n"
        f"Region: {region}\n"
        f"Source:\n{source}\n\n"
        "Produce one reflective question."
    )
    response = client.chat(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.4,
    )
    return {"question": response, "model": client.model}


def next_steps_payload(
    analysis: dict[str, Any],
    start_path: str | Path | None = None,
    difficulty: str = "medium",
) -> dict[str, Any]:
    client = AssistantClient.from_env(start_path=start_path)
    if client is None:
        raise RuntimeError("Missing endpoint configuration.")

    profile = _difficulty_profile(difficulty)
    system_prompt = _NEXT_STEP_SYSTEM + _difficulty_suffix(profile, "next_steps")

    region_counts = analysis.get("regionCounts") or {}
    issues = analysis.get("issues") or []
    issue_lines = "\n".join(
        f"- cell {i['cell_index']} [{i['severity']}] {i['kind']}: {i['message']}" for i in issues[:20]
    )
    region_line = ", ".join(f"{k}:{v}" for k, v in region_counts.items() if v)

    user_prompt = (
        f"Region distribution: {region_line or 'unknown'}\n"
        f"Open issues:\n{issue_lines or '- none'}\n\n"
        "Suggest three next steps."
    )

    response = client.chat(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.3,
    )
    return {"suggestions": response, "model": client.model}


# ---------------------------------------------------------------------------
# Quiz JSON helpers + fallbacks (shared with activities.py)
# ---------------------------------------------------------------------------


def _safe_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z0-9_+-]*\n", "", cleaned)
        cleaned = re.sub(r"\n```$", "", cleaned)
    cleaned = cleaned.strip()

    def _try_parse(candidate: str) -> dict[str, Any] | None:
        for variant in (candidate, _repair_json(candidate)):
            if not variant:
                continue
            try:
                parsed = json.loads(variant)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed
            if isinstance(parsed, list):
                for item in parsed:
                    if isinstance(item, dict):
                        return item
        return None

    direct = _try_parse(cleaned)
    if direct is not None:
        return direct

    # Find every balanced {...} window and try to parse each.
    start_indices = [i for i, ch in enumerate(cleaned) if ch == "{"]
    for start in start_indices:
        depth = 0
        for idx in range(start, len(cleaned)):
            ch = cleaned[idx]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidate = cleaned[start : idx + 1]
                    parsed = _try_parse(candidate)
                    if parsed is not None:
                        return parsed
                    break
    raise ValueError("Quiz model did not return JSON.")


def _repair_json(text: str) -> str:
    """Best-effort repairs for common LLM JSON mistakes."""
    repaired = text
    # If the string is Python-dict-style (single quotes and no double quotes
    # around strings), swap quoting wholesale. We only do this when there are
    # no double-quoted strings to avoid clobbering mixed-quote valid JSON.
    single_quotes = repaired.count("'")
    double_quoted_strings = re.findall(r'"[^"\\]*(?:\\.[^"\\]*)*"', repaired)
    if single_quotes >= 2 and not double_quoted_strings:
        repaired = repaired.replace('"', r"\"").replace("'", '"')
    # Remove trailing commas before } or ].
    repaired = re.sub(r",\s*([}\]])", r"\1", repaired)
    # Python literals
    repaired = re.sub(r"\bTrue\b", "true", repaired)
    repaired = re.sub(r"\bFalse\b", "false", repaired)
    repaired = re.sub(r"\bNone\b", "null", repaired)
    return repaired


def _normalize_quiz(raw: dict[str, Any]) -> dict[str, Any]:
    question = str(raw.get("question") or "").strip()
    if not question:
        raise ValueError("Quiz is missing a question.")
    options_raw = raw.get("options") or []
    if not isinstance(options_raw, list):
        raise ValueError("Quiz options must be a list.")
    options = [str(option).strip() for option in options_raw if str(option).strip()]
    if len(options) < 2:
        raise ValueError("Quiz needs at least two options.")
    options = options[:4]
    while len(options) < 4:
        options.append(f"None of the above ({len(options) + 1})")
    try:
        correct_index = int(raw.get("correctIndex"))
    except (TypeError, ValueError):
        correct_index = 0
    if correct_index < 0 or correct_index >= len(options):
        correct_index = 0
    explanation = str(raw.get("explanation") or "").strip()
    return {
        "question": _clip_text(question, 400),
        "options": [_clip_text(option, 220) for option in options],
        "correctIndex": correct_index,
        "explanation": _clip_text(explanation, 400),
    }


# ---------------------------------------------------------------------------
# Mission generation & verification
# ---------------------------------------------------------------------------


_MISSIONS_SYSTEM = (
    "You are FlowQuest's mission architect for Jupyter notebooks. Given a notebook "
    "analysis (cell regions, issues, source previews, dependencies), generate exactly "
    "3 missions that guide the learner through understanding and improving THIS "
    "specific notebook.\n\n"
    "Rules:\n"
    "- Each mission must reference specific cell numbers and explain what to do there\n"
    "- Distribute missions across categories: exploration, understanding, stabilization, reflection\n"
    "- Titles must be creative, specific to this notebook's content — never generic\n"
    "- Descriptions must be concrete and actionable (what exactly to change/add/investigate)\n"
    "- XP values: 5–12 (harder/more work = more XP)\n"
    "- completion_criteria: a clear, verifiable condition you can later check by reading "
    "the updated notebook cells (e.g. 'Cell 4 should contain a .describe() call on the "
    "main DataFrame' or 'A new cell after cell 7 should evaluate the model with a "
    "classification_report')\n\n"
    "Return a JSON object with this exact structure:\n"
    '{ "missions": [ { "id": "<unique-slug>", "kind": "<exploration|understanding|stabilization|reflection>", '
    '"title": "<creative title>", "description": "<actionable description>", "xp": <5-12>, '
    '"cell_indices": [<cell numbers>], "completion_hint": "<short user-facing hint>", '
    '"completion_criteria": "<verifiable condition>" } ] }'
)


_VERIFY_SYSTEM = (
    "You are an expert, strict code reviewer evaluating a Jupyter Notebook coding mission.\n"
    "Given the mission's completion criteria, the original (BEFORE) source code of the relevant cells, "
    "and the current (AFTER) source code, you must rigorously determine whether the mission has been fulfilled.\n\n"
    "CRITICAL RULES:\n"
    "1. Read the criteria carefully. Identify the exact logic, variables, or changes required.\n"
    "2. Scrutinize the BEFORE and AFTER code. You must explicitly compare them.\n"
    "3. Do NOT assume the user made changes. The required logic MUST be explicitly present in the AFTER code, and it MUST be a meaningful fix compared to the BEFORE code.\n"
    "4. If the AFTER code still contains the original bug, is completely unmodified, or lacks the requested fix, you MUST fail the user.\n"
    "5. Be strict about correctness.\n\n"
    "Return a JSON object:\n"
    "{\n"
    '  "reasoning": "<Step-by-step evaluation comparing the BEFORE and AFTER cell code against the criteria>",\n'
    '  "passed": <true|false>,\n'
    '  "feedback": "<1-2 sentences. Congratulatory if passed, constructive hint if not>"\n'
    "}"
)


def _build_analysis_summary(analysis: dict[str, Any]) -> str:
    """Build a compact text summary of the analysis for the mission prompt."""
    parts: list[str] = []

    region_counts = analysis.get("regionCounts") or {}
    region_line = ", ".join(f"{k}: {v}" for k, v in region_counts.items() if v)
    if region_line:
        parts.append(f"Region distribution: {region_line}")

    issues = analysis.get("issues") or []
    if issues:
        issue_lines = "\n".join(
            f"  - cell {i['cell_index']} [{i['severity']}] {i['kind']}: {i['message']}"
            for i in issues[:15]
        )
        parts.append(f"Issues:\n{issue_lines}")

    cells = analysis.get("cells") or []
    cell_lines: list[str] = []
    for c in cells[:40]:
        idx = c.get("index", "?")
        region = c.get("region", "?")
        icon = c.get("regionIcon", "")
        summary = c.get("summary") or ""
        preview = _clip_text(c.get("sourcePreview") or "", 320)
        deps = c.get("dependsOn") or []
        dep_str = f" [depends on: {', '.join(str(d) for d in deps)}]" if deps else ""
        cell_lines.append(f"  Cell {idx} ({icon}{region}){dep_str}: {summary}\n    {preview}")
    if cell_lines:
        parts.append("Cells:\n" + "\n".join(cell_lines))

    return "\n\n".join(parts)


def _normalize_mission(raw: dict[str, Any], index: int, cells: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Validate and normalize a single LLM-generated mission."""
    mission_id = str(raw.get("id") or f"llm-mission-{index}")[:60]
    kind = str(raw.get("kind") or "exploration").lower()
    if kind not in ("exploration", "understanding", "stabilization", "reflection"):
        kind = "exploration"
    title = _clip_text(str(raw.get("title") or "Mission"), 120)
    description = _clip_text(str(raw.get("description") or ""), 800)
    completion_hint = _clip_text(str(raw.get("completion_hint") or raw.get("completionHint") or ""), 400)
    completion_criteria = _clip_text(str(raw.get("completion_criteria") or raw.get("completionCriteria") or ""), 400)
    try:
        xp = int(raw.get("xp") or 8)
    except (TypeError, ValueError):
        xp = 8
    xp = max(3, min(15, xp))

    cell_indices_raw = raw.get("cell_indices") or raw.get("cellIndices") or []
    if not isinstance(cell_indices_raw, list):
        cell_indices_raw = []
    cell_indices: list[int] = []
    for ci in cell_indices_raw:
        try:
            cell_indices.append(int(ci))
        except (TypeError, ValueError):
            continue

    original_sources = {}
    if cells:
        for ci in cell_indices:
            for cell in cells:
                if cell.get("index") == ci:
                    original_sources[str(ci)] = cell.get("source") or ""
                    break

    return {
        "id": mission_id,
        "kind": kind,
        "title": title,
        "description": description,
        "xp": xp,
        "cell_indices": cell_indices,
        "completion_hint": completion_hint,
        "completion_criteria": completion_criteria,
        "original_sources": original_sources,
    }


def generate_missions_payload(
    analysis: dict[str, Any],
    start_path: str | Path | None = None,
    difficulty: str = "medium",
    cells: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Generate 3 contextual missions from a notebook analysis."""
    client = AssistantClient.from_env(start_path=start_path)
    if client is None:
        raise AssistantBackendError(
            "Missing endpoint configuration.", kind="auth"
        )

    profile = _difficulty_profile(difficulty)
    missions_note = {
        "easy": "Generate approachable missions a beginner can complete in minutes. Focus on exploration and basic understanding.",
        "medium": "Generate missions that test practical data science workflow knowledge.",
        "hard": "Generate missions that probe edge cases, data leakage, reproducibility, and robustness.",
    }.get(profile.get("label", "medium"), "")

    system_prompt = _MISSIONS_SYSTEM
    if missions_note:
        system_prompt += f"\n\nDifficulty: {profile.get('label', 'medium')}. {missions_note}"

    summary = _build_analysis_summary(analysis)
    user_prompt = f"Notebook analysis:\n{summary}\n\nGenerate exactly 3 missions."

    response = client.chat(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": _clip_text(user_prompt, 12000)},
        ],
        temperature=0.4,
        response_format={"type": "json_object"},
    )

    try:
        parsed = _safe_json_object(response)
    except ValueError:
        return {"missions": [], "model": client.model}

    raw_missions = parsed.get("missions") or []
    if not isinstance(raw_missions, list):
        raw_missions = [parsed] if parsed.get("title") else []

    missions = []
    for i, raw in enumerate(raw_missions[:3]):
        if not isinstance(raw, dict):
            continue
        try:
            missions.append(_normalize_mission(raw, i, cells))
        except (TypeError, ValueError):
            continue

    return {"missions": missions, "model": client.model}


def verify_mission_payload(
    mission: dict[str, Any],
    cells: list[dict[str, Any]],
    start_path: str | Path | None = None,
    difficulty: str = "medium",
) -> dict[str, Any]:
    """Check whether a mission is fulfilled given current cell sources."""
    client = AssistantClient.from_env(start_path=start_path)
    if client is None:
        raise AssistantBackendError(
            "Missing endpoint configuration.", kind="auth"
        )

    profile = _difficulty_profile(difficulty)
    system_prompt = _VERIFY_SYSTEM
    baseline_note = profile.get("baseline") or ""
    if baseline_note:
        system_prompt += f"\n\nDifficulty: {profile.get('label', 'medium')}. {baseline_note}"

    title = str(mission.get("title") or "")
    description = str(mission.get("description") or "")
    criteria = str(mission.get("completion_criteria") or mission.get("completionCriteria") or "")
    original_sources = mission.get("original_sources") or {}

    before_parts: list[str] = []
    for idx, src in original_sources.items():
        src_clipped = _clip_text(str(src), 8000)
        before_parts.append(f"Cell {idx}:\n{src_clipped}")
    before_text = "\n\n".join(before_parts) if before_parts else "[No before state available. Verify based on AFTER code.]"

    cell_parts: list[str] = []
    for cell in cells[:50]:
        idx = cell.get("index", "?")
        source = _clip_text(str(cell.get("source") or ""), 8000)
        cell_parts.append(f"Cell {idx}:\n{source}")
    cells_text = "\n\n".join(cell_parts) if cell_parts else "[no cells provided]"

    user_prompt = (
        f"Mission: {title}\n"
        f"Description: {description}\n"
        f"Completion criteria: {criteria}\n\n"
        f"--- BEFORE (Original State) ---\n{before_text}\n\n"
        f"--- AFTER (Current State) ---\n{cells_text}\n\n"
        "Has the mission been fulfilled?"
    )

    response = client.chat(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": _clip_text(user_prompt, 64000)},
        ],
        temperature=0.1,
        response_format={"type": "json_object"},
    )

    try:
        parsed = _safe_json_object(response)
    except ValueError:
        return {"passed": False, "feedback": "Could not parse the verification response. Try again."}

    passed = bool(parsed.get("passed"))
    feedback = _clip_text(str(parsed.get("feedback") or ""), 300)

    return {"passed": passed, "feedback": feedback, "model": client.model}
