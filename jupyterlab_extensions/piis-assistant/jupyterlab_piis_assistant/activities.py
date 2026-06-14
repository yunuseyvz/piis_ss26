"""FlowQuest between-cell activities — a registry of LLM-driven mini-tasks.

Each *activity* is an intelligent, generated task that FlowQuest injects below a
real notebook cell. Every kind is produced by the configured LLM from the cell
(and its neighbours) so the content is always specific to the user's notebook,
never canned.

Two response shapes are supported:

* ``choice`` — a multiple-choice question. Graded on the client by comparing the
  selected index with ``correctIndex`` (the same proven flow as the original
  quiz). Used by :data:`KIND_QUIZ` and :data:`KIND_PREDICT`.
* ``open``   — a free-text answer the learner writes. Graded by the LLM against a
  short rubric, returning a pass/score/feedback verdict. Used by
  :data:`KIND_TEACHBACK`.

Adding a new activity is one entry in :data:`ACTIVITY_SPECS` plus a system
prompt. The analyzer decides *where* each kind is offered (see
``analyzer._compute_injection_points``); this module decides *what* each one
contains and how it's graded.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ai_backend import (
    AssistantClient,
    _clip_text,
    _difficulty_profile,
    _difficulty_suffix,
    _normalize_quiz,
    _safe_json_object,
)

KIND_QUIZ = "quiz"
KIND_PREDICT = "predict"
KIND_TEACHBACK = "teachback"

# Response shapes.
RESPONSE_CHOICE = "choice"
RESPONSE_OPEN = "open"


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

ACTIVITY_SPECS: dict[str, dict[str, Any]] = {
    KIND_QUIZ: {
        "kind": KIND_QUIZ,
        "label": "Understanding check",
        "icon": "🎯",
        "response": RESPONSE_CHOICE,
        # XP category this activity rewards (overrides region mapping).
        "category": "understanding",
        # Regions whose cell-runs may offer this activity.
        "regions": ("load", "clean", "explore", "visualize", "model"),
        "topic": "what this cell does and why",
    },
    KIND_PREDICT: {
        "kind": KIND_PREDICT,
        "label": "Predict the result",
        "icon": "🔮",
        "response": RESPONSE_CHOICE,
        "category": "understanding",
        # Predicting an output is most meaningful where a cell computes or shows
        # something concrete.
        "regions": ("explore", "visualize", "model", "clean"),
        "topic": "what this cell will produce when it runs",
    },
    KIND_TEACHBACK: {
        "kind": KIND_TEACHBACK,
        "label": "Teach it back",
        "icon": "🗣️",
        "response": RESPONSE_OPEN,
        "category": "reflection",
        "regions": ("load", "clean", "explore", "visualize", "model"),
        "topic": "explain this part of the workflow in your own words",
    },
}


def activity_spec(kind: str) -> dict[str, Any]:
    return ACTIVITY_SPECS.get(kind) or ACTIVITY_SPECS[KIND_QUIZ]


def is_open(kind: str) -> bool:
    return activity_spec(kind)["response"] == RESPONSE_OPEN


def category_for(kind: str) -> str:
    return str(activity_spec(kind)["category"])


def public_registry() -> list[dict[str, Any]]:
    """Lightweight registry the frontend can use to label activities."""
    return [
        {
            "kind": spec["kind"],
            "label": spec["label"],
            "icon": spec["icon"],
            "response": spec["response"],
            "category": spec["category"],
        }
        for spec in ACTIVITY_SPECS.values()
    ]


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

_CHOICE_SHAPE = (
    '{"question": "<one sentence>", '
    '"options": ["<A>", "<B>", "<C>", "<D>"], '
    '"correctIndex": <0-3 integer>, '
    '"explanation": "<1-2 sentences on why that option is correct>"}'
)

_SYSTEM_PROMPTS: dict[str, str] = {
    KIND_QUIZ: (
        "You are FlowQuest's quiz master. Given a cell from a Jupyter notebook, "
        "generate exactly one multiple-choice question that tests whether a reader "
        "understands that cell in context. Output MUST be valid JSON in this exact "
        "shape, no prose, no markdown fences:\n" + _CHOICE_SHAPE + "\n"
        "Rules:\n"
        "- exactly four options, roughly the same length\n"
        "- plausible distractors, not obviously wrong\n"
        "- answerable from the provided cell and context\n"
        "- keep every field under 220 characters\n"
    ),
    KIND_PREDICT: (
        "You are FlowQuest's prediction coach. Given a cell from a Jupyter "
        "notebook (its OUTPUT is hidden from the learner), generate exactly one "
        "multiple-choice question asking what the cell will produce or what the "
        "result will look like when it runs. Output MUST be valid JSON in this "
        "exact shape, no prose, no markdown fences:\n" + _CHOICE_SHAPE + "\n"
        "Rules:\n"
        "- the question asks the learner to PREDICT the outcome/output/effect\n"
        "- exactly four options, each a plausible result\n"
        "- the correct option must follow logically from the code\n"
        "- distractors should reflect common misconceptions\n"
        "- keep every field under 220 characters\n"
    ),
    KIND_TEACHBACK: (
        "You are FlowQuest's learning coach. Given a cell from a Jupyter notebook, "
        "write a short open-ended prompt asking the learner to explain, in their "
        "own words, what this part of the workflow does and why it matters. Also "
        "produce a tiny grading rubric: 2-4 short key points a good answer should "
        "mention. Output MUST be valid JSON in this exact shape, no prose, no "
        "markdown fences:\n"
        '{"prompt": "<one or two sentence ask>", '
        '"rubric": ["<key point>", "<key point>"], '
        '"hint": "<one short nudge to help a stuck learner>"}\n'
        "Rules:\n"
        "- the prompt invites explanation, not a yes/no answer\n"
        "- rubric points are concrete and checkable\n"
        "- keep every field under 220 characters\n"
    ),
}

_GRADE_SYSTEM = (
    "You are FlowQuest's fair grader. A learner was asked to explain a notebook "
    "cell in their own words. Judge whether their explanation demonstrates "
    "understanding of the key points. Be encouraging but honest. Output MUST be "
    "valid JSON in this exact shape, no prose, no markdown fences:\n"
    '{"passed": <true|false>, "score": <0-100 integer>, '
    '"feedback": "<1-2 sentences: what was good, what was missing>"}\n'
    "Rules:\n"
    "- pass if the answer captures the main idea, even if informal\n"
    "- do not require exact terminology\n"
    "- a blank, off-topic, or copy-pasted-code answer fails\n"
    "- keep feedback under 240 characters\n"
)


def _find_cell(cells: list[dict[str, Any]], cid: str) -> dict[str, Any] | None:
    for cell in cells:
        if str(cell.get("cellId")) == cid:
            return cell
    return None


def _context_blocks(cells: list[dict[str, Any]], context_ids: list[str]) -> str:
    blocks: list[str] = []
    for cid in context_ids:
        cell = _find_cell(cells, cid)
        if cell is None:
            continue
        source = _clip_text(str(cell.get("sourcePreview") or ""), 600)
        if not source:
            continue
        idx = cell.get("index")
        tag = f"Cell {idx + 1 if isinstance(idx, int) else '?'} ({cell.get('region')})"
        blocks.append(f"{tag}:\n{source}")
    return "\n".join(blocks) or "[none]"


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


def generate_activity(
    kind: str,
    slot: dict[str, Any],
    cells: list[dict[str, Any]],
    start_path: str | Path | None = None,
    difficulty: str = "medium",
) -> dict[str, Any]:
    """Generate one activity payload for the given slot.

    For ``choice`` activities the result is quiz-shaped
    (``question``/``options``/``correctIndex``/``explanation``); for ``open``
    activities it's prompt-shaped (``prompt``/``rubric``/``hint``). Both carry
    ``kind`` and ``response`` so the frontend can pick the right renderer.
    """
    spec = activity_spec(kind)
    kind = spec["kind"]

    client = AssistantClient.from_env(start_path=start_path)
    if client is None:
        raise RuntimeError("Missing endpoint configuration.")

    region = str(slot.get("region") or "other")
    topic = str(slot.get("topic") or spec.get("topic") or "this cell")
    anchor_id = str(slot.get("anchorCellId") or "")
    context_ids = [str(cid) for cid in (slot.get("contextCellIds") or []) if cid]

    anchor_cell = _find_cell(cells, anchor_id)
    if anchor_cell is None:
        raise ValueError("Anchor cell for activity slot was not found.")

    focus_source = _clip_text(str(anchor_cell.get("sourcePreview") or ""), 1600) or "[empty cell]"
    context = _context_blocks(cells, context_ids)

    profile = _difficulty_profile(difficulty)
    # Reuse the closest difficulty note (quiz tone for choice, reflect for open).
    suffix_key = "reflect" if spec["response"] == RESPONSE_OPEN else "quiz"
    system_prompt = _SYSTEM_PROMPTS[kind] + _difficulty_suffix(profile, suffix_key)

    user_prompt = (
        f"Region: {region}. Topic: {topic}.\n\n"
        f"Surrounding cells:\n{context}\n\n"
        f"Focus cell (write the activity about this one):\n{focus_source}\n\n"
        'Return the JSON object only. Start with "{" and end with "}". No prose.'
    )

    raw = _generate_json(client, system_prompt, user_prompt)

    if spec["response"] == RESPONSE_CHOICE:
        payload = _build_choice(raw, region)
    else:
        payload = _build_open(raw)

    payload["kind"] = kind
    payload["response"] = spec["response"]
    payload.setdefault("model", client.model)
    return payload


def _generate_json(
    client: AssistantClient, system_prompt: str, user_prompt: str
) -> dict[str, Any]:
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            raw_response = client.chat(
                messages=messages,
                temperature=0.1 if attempt else 0.35,
                max_tokens=520,
                response_format={"type": "json_object"} if attempt == 0 else None,
            )
            return _safe_json_object(raw_response)
        except (ValueError, json.JSONDecodeError) as exc:
            last_error = exc
            messages = [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": (
                        user_prompt
                        + "\n\nReminder: reply with one valid JSON object only. "
                        "No markdown, no comments. Your previous reply could not be parsed."
                    ),
                },
            ]
    detail = str(last_error) if last_error else "unknown parse error"
    raise ValueError(f"The model returned content that could not be parsed after 3 attempts. {detail}")


def _build_choice(raw: dict[str, Any] | None, region: str) -> dict[str, Any]:
    if raw is None:
        raise ValueError("Activity generation failed: no response from the model.")
    return _normalize_quiz(raw)


def _build_open(raw: dict[str, Any] | None) -> dict[str, Any]:
    if raw is None:
        raise ValueError("Activity generation failed: no response from the model.")
    prompt = _clip_text(str(raw.get("prompt") or "").strip(), 400)
    if not prompt:
        raise ValueError("The model returned an activity without a prompt field.")
    rubric_raw = raw.get("rubric")
    rubric: list[str] = []
    if isinstance(rubric_raw, list):
        rubric = [_clip_text(str(point).strip(), 220) for point in rubric_raw if str(point).strip()]
    if not rubric:
        raise ValueError("The model returned an activity without a valid rubric.")
    hint = _clip_text(str(raw.get("hint") or "").strip(), 240)
    return {"prompt": prompt, "rubric": rubric, "hint": hint}


# ---------------------------------------------------------------------------
# Grading (open activities)
# ---------------------------------------------------------------------------


def grade_open_activity(
    prompt: str,
    rubric: list[str],
    answer: str,
    cell_source: str = "",
    start_path: str | Path | None = None,
    difficulty: str = "medium",
) -> dict[str, Any]:
    """LLM-grade a free-text answer. Returns ``{passed, score, feedback, model}``.

    Requires a configured model endpoint. Raises ``RuntimeError`` if the endpoint
    is not configured, or ``ValueError`` if the model response cannot be parsed.
    """
    answer = (answer or "").strip()
    if not answer:
        return {"passed": False, "score": 0, "feedback": "Write a sentence or two to earn XP.", "model": "none"}

    client = AssistantClient.from_env(start_path=start_path)
    if client is None:
        raise RuntimeError(
            "Missing endpoint configuration. "
            "Open FlowQuest → Settings and provide a model, base URL, and API key."
        )

    rubric_text = "\n".join(f"- {point}" for point in (rubric or [])) or "- Shows understanding of the cell"
    profile = _difficulty_profile(difficulty)
    system_prompt = _GRADE_SYSTEM + _difficulty_suffix(profile, "baseline")
    user_prompt = (
        f"The learner was asked:\n{prompt}\n\n"
        f"Key points a good answer should cover:\n{rubric_text}\n\n"
        f"The cell being explained:\n{_clip_text(cell_source, 1200) or '[not provided]'}\n\n"
        f"The learner's answer:\n{_clip_text(answer, 1200)}\n\n"
        'Return the JSON verdict only. Start with "{" and end with "}".'
    )
    raw = _generate_json(client, system_prompt, user_prompt)
    try:
        passed = bool(raw.get("passed"))
        score = int(raw.get("score"))
    except (TypeError, ValueError):
        raise ValueError("Grading failed: the model's verdict could not be parsed.")
    score = max(0, min(100, score))
    feedback = _clip_text(str(raw.get("feedback") or "").strip(), 280) or (
        "Nice explanation." if passed else "Try to mention the key points."
    )
    return {"passed": passed, "score": score, "feedback": feedback, "model": client.model}


# ---------------------------------------------------------------------------
# Spontaneous quiz — Flowy's "I'll quiz you on that paste" challenge.
# ---------------------------------------------------------------------------

_SPONTANEOUS_SYSTEM = (
    "You are Flowy, FlowQuest's playful notebook companion. The learner just "
    "pasted a chunk of code into their notebook. Generate exactly one "
    "multiple-choice question that checks whether they actually understand what "
    "that pasted code does. Output MUST be valid JSON in this exact shape, no "
    "prose, no markdown fences:\n" + _CHOICE_SHAPE + "\n"
    "Rules:\n"
    "- the question is about the pasted code's behaviour or intent\n"
    "- exactly four options, roughly the same length\n"
    "- plausible distractors that catch someone who pasted without reading\n"
    "- answerable from the pasted code alone\n"
    "- keep every field under 220 characters\n"
)


def spontaneous_quiz_payload(
    code: str,
    context: str = "",
    start_path: str | Path | None = None,
    difficulty: str = "medium",
) -> dict[str, Any]:
    """Generate a quiz about an arbitrary snippet (e.g. freshly pasted code).

    Unlike :func:`generate_activity`, this isn't anchored to an analyzed cell —
    Flowy fires it on demand from the sidebar when the learner pastes a big
    block of code.
    """
    snippet = _clip_text(code or "", 2000)
    if not snippet:
        raise ValueError("No code provided to quiz on.")

    client = AssistantClient.from_env(start_path=start_path)
    if client is None:
        raise RuntimeError("Missing endpoint configuration.")

    profile = _difficulty_profile(difficulty)
    system_prompt = _SPONTANEOUS_SYSTEM + _difficulty_suffix(profile, "quiz")
    user_prompt = (
        f"Pasted code:\n{snippet}\n\n"
        f"Surrounding notebook context:\n{_clip_text(context, 800) or '[none]'}\n\n"
        'Return the JSON object only. Start with "{" and end with "}". No prose.'
    )
    raw = _generate_json(client, system_prompt, user_prompt)
    payload = _build_choice(raw, "explore")
    payload["kind"] = KIND_QUIZ
    payload["response"] = RESPONSE_CHOICE
    payload.setdefault("model", client.model)
    return payload


__all__ = [
    "KIND_QUIZ",
    "KIND_PREDICT",
    "KIND_TEACHBACK",
    "ACTIVITY_SPECS",
    "activity_spec",
    "is_open",
    "category_for",
    "public_registry",
    "generate_activity",
    "grade_open_activity",
    "spontaneous_quiz_payload",
]
