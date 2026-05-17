from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from openai import OpenAI

from . import criteria
from .settings import resolve_endpoint


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
        max_tokens: int = 700,
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
            "max_tokens": max_tokens,
        }
        if response_format is not None:
            kwargs["response_format"] = response_format

        last_exc: BaseException | None = None
        used_response_format_fallback = False
        for attempt in range(1, max_attempts + 1):
            try:
                response = self.client.chat.completions.create(**kwargs)
                content = (response.choices[0].message.content or "").strip()
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

    return {
        "configured": True,
        "model": client.model,
        "baseUrl": client.base_url,
        "envFile": str(env_file) if env_file is not None else "not found",
        "settingsFile": settings_file,
        "message": "Assistant endpoint is configured.",
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
                "You are FlowQuest Assistant inside JupyterLab. Be concise, direct, and useful. "
                "The latest user message may include an automatically appended notebook-context section. Use that appended context as primary grounding. "
                "If the user asks about a cell or output, ground the answer in that context. "
                "If important notebook context is missing, say so plainly."
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
        max_tokens=400,
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
        max_tokens=120,
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
    health = analysis.get("health")
    issue_lines = "\n".join(
        f"- cell {i['cell_index']} [{i['severity']}] {i['kind']}: {i['message']}" for i in issues[:20]
    )
    region_line = ", ".join(f"{k}:{v}" for k, v in region_counts.items() if v)

    user_prompt = (
        f"Notebook health: {health}/100\n"
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
        max_tokens=250,
    )
    return {"suggestions": response, "model": client.model}


# ---------------------------------------------------------------------------
# Quiz generation
# ---------------------------------------------------------------------------


_QUIZ_SYSTEM = (
    "You are FlowQuest's quiz master. Given a cell from a Jupyter notebook, "
    "generate exactly one multiple-choice question that tests whether a reader "
    "understands that cell in context. Output MUST be valid JSON with this "
    "exact shape, no prose, no markdown fences:\n"
    '{"question": "<one sentence question>", '
    '"options": ["<A>", "<B>", "<C>", "<D>"], '
    '"correctIndex": <0-3 integer>, '
    '"explanation": "<1-2 sentence explanation of why that choice is correct>"}\n'
    "Rules:\n"
    "- exactly four options, roughly the same length\n"
    "- plausible distractors, not obviously wrong\n"
    "- the question must be answerable from the provided cell and context\n"
    "- keep everything under 220 characters per field\n"
)


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


_FALLBACK_QUIZZES: dict[str, dict[str, Any]] = {
    "load": {
        "question": "What is the main purpose of this cell?",
        "options": [
            "It ingests data from an external source into the notebook.",
            "It trains a machine-learning model on preprocessed data.",
            "It generates a plot summarizing model performance.",
            "It refactors helper functions into a module.",
        ],
        "correctIndex": 0,
        "explanation": "Load cells ingest data so later cells can work with it.",
    },
    "clean": {
        "question": "Why does this cell matter in the workflow?",
        "options": [
            "It reshapes or filters data so later analysis is correct.",
            "It evaluates a trained model on a held-out set.",
            "It prints a summary of the notebook configuration.",
            "It imports project dependencies.",
        ],
        "correctIndex": 0,
        "explanation": "Clean cells reshape or filter data so later analysis is correct.",
    },
    "explore": {
        "question": "What does this cell mainly help you understand?",
        "options": [
            "The structure or distribution of the data.",
            "How to deploy a model to production.",
            "Which third-party libraries to install.",
            "The schema of the output dashboard.",
        ],
        "correctIndex": 0,
        "explanation": "Explore cells reveal structure, summaries, or distributions of the data.",
    },
    "visualize": {
        "question": "What is the primary goal of this visualization cell?",
        "options": [
            "To make a pattern or comparison in the data visible.",
            "To serialize a dataframe to disk.",
            "To benchmark the Python runtime.",
            "To install plotting libraries.",
        ],
        "correctIndex": 0,
        "explanation": "Visualization cells make patterns or comparisons in the data visible.",
    },
    "model": {
        "question": "What does this modeling cell commit to?",
        "options": [
            "A specific algorithm and the features it will learn from.",
            "The exact colors of the downstream plots.",
            "The directory where output files are written.",
            "The list of packages to pin in requirements.txt.",
        ],
        "correctIndex": 0,
        "explanation": "Modeling cells commit to an algorithm and a feature set for learning.",
    },
}


def _fallback_quiz(region: str) -> dict[str, Any]:
    template = _FALLBACK_QUIZZES.get(region) or _FALLBACK_QUIZZES["explore"]
    # Return a shallow copy so callers can mutate safely.
    return {
        "question": template["question"],
        "options": list(template["options"]),
        "correctIndex": int(template["correctIndex"]),
        "explanation": template["explanation"],
    }


def quiz_payload(
    slot: dict[str, Any],
    cells: list[dict[str, Any]],
    start_path: str | Path | None = None,
    difficulty: str = "medium",
) -> dict[str, Any]:
    client = AssistantClient.from_env(start_path=start_path)
    if client is None:
        raise RuntimeError("Missing endpoint configuration.")

    topic = str(slot.get("topic") or "this cell")
    region = str(slot.get("region") or "other")
    anchor_id = str(slot.get("anchorCellId") or "")
    context_ids = [str(cid) for cid in (slot.get("contextCellIds") or []) if cid]

    def _find(cid: str) -> dict[str, Any] | None:
        for cell in cells:
            if str(cell.get("cellId")) == cid:
                return cell
        return None

    anchor_cell = _find(anchor_id)
    if anchor_cell is None:
        raise ValueError("Anchor cell for quiz slot was not found.")

    context_blocks: list[str] = []
    for cid in context_ids:
        cell = _find(cid)
        if cell is None:
            continue
        source = _clip_text(str(cell.get("sourcePreview") or ""), 600)
        if not source:
            continue
        tag = f"Cell {cell.get('index') + 1 if isinstance(cell.get('index'), int) else '?'} ({cell.get('region')})"
        context_blocks.append(f"{tag}:\n{source}")

    focus_source = _clip_text(str(anchor_cell.get("sourcePreview") or ""), 1600) or "[empty cell]"

    user_prompt = (
        f"Region: {region}. Topic: {topic}.\n\n"
        f"Surrounding cells:\n{chr(10).join(context_blocks) or '[none]'}\n\n"
        f"Focus cell (write the question about this one):\n{focus_source}\n\n"
        'Return the JSON object only. Start the reply with "{" and end with "}". No prose.\n'
        'Example shape: {"question":"...","options":["A","B","C","D"],'
        '"correctIndex":0,"explanation":"..."}'
    )

    profile = _difficulty_profile(difficulty)
    system_prompt = _QUIZ_SYSTEM + _difficulty_suffix(profile, "quiz")

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    last_error: Exception | None = None
    raw: dict[str, Any] | None = None
    raw_response = ""
    for attempt in range(3):
        try:
            raw_response = client.chat(
                messages=messages,
                temperature=0.1 if attempt else 0.35,
                max_tokens=500,
                response_format={"type": "json_object"} if attempt == 0 else None,
            )
            raw = _safe_json_object(raw_response)
            break
        except (ValueError, json.JSONDecodeError) as exc:
            last_error = exc
            messages = [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": (
                        user_prompt
                        + "\n\nReminder: reply with a single valid JSON object only. "
                        "Do not include any markdown, comments, or explanations outside the JSON. "
                        "Your previous reply could not be parsed."
                    ),
                },
            ]

    if raw is None:
        # Last resort: deterministic template so the UI always has something.
        fallback = _fallback_quiz(region)
        fallback["model"] = f"{client.model} (fallback)"
        fallback["fallbackReason"] = (
            f"Could not parse quiz JSON from model after 3 attempts: {last_error}"
        )
        return fallback

    try:
        normalized = _normalize_quiz(raw)
    except ValueError:
        normalized = _fallback_quiz(region)
        normalized["model"] = f"{client.model} (fallback)"
        return normalized

    normalized["model"] = client.model
    return normalized


# ---------------------------------------------------------------------------
# Baseline Notebook Health scoring
# ---------------------------------------------------------------------------


_BASELINE_SYSTEM = (
    "You are FlowQuest's notebook auditor. You will be given a notebook "
    "summary and a list of criteria. Rate the notebook on each criterion "
    "from 0 (absent) to 10 (excellent) and write one short sentence of notes. "
    "Reply with a single JSON object only — no prose, no markdown fences. "
    "Shape: "
    '{"scores": {"<criterion_id>": <int 0-10>, ...}, "notes": "<=400 chars"}. '
    "Every criterion id must be present."
)


def _build_notebook_summary(analysis: dict[str, Any]) -> str:
    """Produce a compact outline for the baseline scorer."""
    cells = analysis.get("cells") or []
    lines: list[str] = []
    lines.append(
        f"Cells: {len(cells)} total, {analysis.get('summary', {}).get('code_cells', 0)} code, "
        f"{analysis.get('summary', {}).get('markdown_cells', 0)} markdown."
    )
    region_counts = analysis.get("regionCounts") or {}
    region_line = ", ".join(f"{k}={v}" for k, v in region_counts.items() if v)
    if region_line:
        lines.append(f"Regions: {region_line}")
    issues = analysis.get("issues") or []
    if issues:
        issue_counts: dict[str, int] = {}
        for issue in issues:
            issue_counts[issue.get("kind", "unknown")] = (
                issue_counts.get(issue.get("kind", "unknown"), 0) + 1
            )
        lines.append(
            "Issues: "
            + ", ".join(f"{kind}={count}" for kind, count in sorted(issue_counts.items()))
        )
    else:
        lines.append("Issues: none detected.")

    lines.append("")
    lines.append("Outline (index | region | one-line summary):")
    for cell in cells[:60]:
        lines.append(
            f"{cell.get('index')} | {cell.get('region')} | {_clip_text(str(cell.get('summary') or ''), 100)}"
        )
    return "\n".join(lines)


def baseline_health_payload(
    analysis: dict[str, Any],
    start_path: str | Path | None = None,
    difficulty: str = "medium",
) -> dict[str, Any]:
    client = AssistantClient.from_env(start_path=start_path)
    if client is None:
        raise RuntimeError("Missing endpoint configuration.")

    profile = _difficulty_profile(difficulty)
    system_prompt = _BASELINE_SYSTEM + _difficulty_suffix(profile, "baseline")

    criterion_lines: list[str] = []
    for criterion in criteria.HEALTH_CRITERIA:
        criterion_lines.append(
            f"- id={criterion.id} | weight={criterion.weight} | {criterion.label}: "
            f"{criterion.description}"
        )

    user_prompt = (
        f"Notebook summary:\n{_build_notebook_summary(analysis)}\n\n"
        f"Criteria to rate (0-10 each):\n" + "\n".join(criterion_lines)
        + "\n\nReturn JSON only."
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    raw: dict[str, Any] | None = None
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            text = client.chat(
                messages=messages,
                temperature=0.1 if attempt else 0.2,
                max_tokens=500,
                response_format={"type": "json_object"} if attempt == 0 else None,
            )
            raw = _safe_json_object(text)
            break
        except (ValueError, json.JSONDecodeError) as exc:
            last_error = exc
            messages = [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": user_prompt
                    + "\n\nReminder: reply with a single valid JSON object. "
                    'Example: {"scores":{"workflow_clarity":6,"execution_consistency":7,...},'
                    '"notes":"short summary"}',
                },
            ]

    scores_raw: dict[str, Any] = {}
    notes = ""
    if raw is not None:
        incoming_scores = raw.get("scores")
        if isinstance(incoming_scores, dict):
            scores_raw = incoming_scores
        notes = str(raw.get("notes") or "")[:800]

    # Normalise scores and compute weighted baseline.
    cleaned_breakdown: dict[str, int | None] = {}
    total_score = 0
    total_weight_used = 0
    for criterion in criteria.HEALTH_CRITERIA:
        value = scores_raw.get(criterion.id)
        try:
            clamped: int | None = max(0, min(10, int(value))) if value is not None else None
        except (TypeError, ValueError):
            clamped = None
        if clamped is None:
            # If the LLM omitted a criterion, fall back to 4 (mildly below neutral).
            clamped = 4
        cleaned_breakdown[criterion.id] = clamped
        total_score += clamped * criterion.weight
        total_weight_used += criterion.weight

    weighted = total_score / max(1, total_weight_used)  # 0..10
    baseline_health = int(round(weighted * 10))  # 0..100

    if not notes:
        notes = "LLM baseline scoring fell back to heuristic defaults."

    return {
        "baselineHealth": baseline_health,
        "breakdown": cleaned_breakdown,
        "notes": notes,
        "model": client.model,
        "fallback": raw is None,
        "fallbackError": str(last_error) if (raw is None and last_error is not None) else "",
    }
