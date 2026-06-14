from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any

from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
from tornado import web

from . import (
    activities,
    gamification,
    profile_store,
)
from .ai_backend import (
    AssistantBackendError,
    chat_payload,
    explain_cell_payload,
    next_steps_payload,
    reflect_prompt_payload,
    status_payload,
)
from .analyzer import analyze_notebook, result_to_dict


# Per-LLM-route wall-clock budget. The AssistantClient already retries with
# backoff; this is the absolute ceiling so a stuck request doesn't block the
# Tornado worker forever.
_LLM_DEADLINE_SECONDS = 75.0


def _root_dir(handler: APIHandler) -> Path:
    contents_manager = handler.settings.get("contents_manager")
    root_dir = getattr(contents_manager, "root_dir", None)
    if isinstance(root_dir, str) and root_dir:
        return Path(root_dir)
    server_root = handler.settings.get("server_root_dir")
    if isinstance(server_root, str) and server_root:
        return Path(server_root)
    return Path.cwd()


def _difficulty_from_body(body: dict[str, Any]) -> str:
    state = body.get("state")
    if isinstance(state, dict):
        diff = state.get("difficulty")
        if isinstance(diff, str) and diff.lower() in {"easy", "medium", "hard"}:
            return diff.lower()
    explicit = body.get("difficulty")
    if isinstance(explicit, str) and explicit.lower() in {"easy", "medium", "hard"}:
        return explicit.lower()
    return "medium"


def _notebook_ns(body: dict[str, Any]) -> str:
    """Per-notebook namespace for idempotency keys.

    XP pools globally, but a mission / quiz / reflection should be earnable once
    *per notebook*. Prefixing award keys with the notebook path keeps the same
    raw key (e.g. ``stab-dedupe``) distinct across notebooks.
    """
    path = body.get("notebookPath") or body.get("notebookKey") or ""
    path = str(path).strip()
    return f"{path}::" if path else ""


# ---------------------------------------------------------------------------
# Helpers: profile-aware progress mutations
# ---------------------------------------------------------------------------


def _mutate_progress(
    fn,
) -> tuple[dict[str, Any], Any]:
    """Run ``fn(progress) -> (new_progress, outcome)`` inside the profile lock.

    Reads the progress section out of the profile, applies *fn*, writes the
    updated progress back, and returns ``(new_progress, outcome)``.
    """
    def _inner(profile: dict[str, Any]) -> tuple[dict[str, Any], Any]:
        progress = profile_store.get_progress(profile)
        new_progress, outcome = fn(progress)
        profile = profile_store.update_progress(profile, new_progress)
        return profile, outcome

    new_profile, outcome = profile_store.mutate(_inner)
    return profile_store.get_progress(new_profile), outcome


def _view_progress() -> dict[str, Any]:
    """Public (derived) view of the current progress."""
    return profile_store.public_view(profile_store.load())


async def _run_llm(handler: APIHandler, fn, **kwargs):
    """Run a blocking LLM call in a worker thread with a hard deadline.

    Translates :class:`AssistantBackendError` into a structured 503 carrying
    a friendly ``message`` and an ``errorKind`` discriminator.
    """
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(fn, **kwargs),
            timeout=_LLM_DEADLINE_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        _finish_llm_error(
            handler,
            status=503,
            kind="timeout",
            message=(
                f"The model didn't respond within {int(_LLM_DEADLINE_SECONDS)} seconds. "
                "Try again — the endpoint may be warming up."
            ),
        )
        raise web.Finish() from exc
    except AssistantBackendError as exc:
        _finish_llm_error(handler, status=503, kind=exc.error_kind, message=exc.user_message)
        raise web.Finish() from exc


def _finish_llm_error(handler: APIHandler, *, status: int, kind: str, message: str) -> None:
    handler.set_status(status)
    handler.set_header("Content-Type", "application/json")
    handler.finish(json.dumps({"errorKind": kind, "message": message, "reason": message}))


class AssistantStatusHandler(APIHandler):
    @web.authenticated
    def get(self) -> None:
        payload = status_payload(start_path=_root_dir(self))
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class AssistantChatHandler(APIHandler):
    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        prompt = body.get("prompt")
        history = body.get("history")
        notebook = body.get("notebook")
        if not isinstance(prompt, str):
            raise web.HTTPError(400, reason="Prompt must be a string.")
        if not prompt.strip():
            raise web.HTTPError(400, reason="Prompt must not be empty.")

        payload = await _run_llm(
            self,
            chat_payload,
            prompt=prompt,
            history=history,
            notebook=notebook,
            start_path=_root_dir(self),
        )
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


def _auto_check_rules(result: Any) -> list[tuple[str, str, int, str]]:
    """Return (award_key, category, xp, label) for satisfied conditions.

    These award small XP when the analyzer sees the user has engaged with or
    structured the notebook, so progress keeps rewarding good behaviour even
    without pressing a claim button.
    """
    issue_kinds = {issue["kind"] for issue in result.issues}
    has_visual = any(c.region == "visualize" for c in result.cells)
    has_model = any(c.region == "model" for c in result.cells)
    has_eval = any(
        any(kw in c.source_preview for kw in ("score", "accuracy_", "report", "confusion_", "cross_val"))
        for c in result.cells
        if c.region == "model"
    )
    has_markdown = any(c.cell_type == "markdown" and c.source_preview.strip() for c in result.cells)

    checks: list[tuple[str, str, int, str, bool]] = [
        ("auto:no-unused-vars", "stabilization", 4, "No unused variables", "unused_variable" not in issue_kinds),
        (
            "auto:clean-execution",
            "stabilization",
            6,
            "Execution order is consistent",
            "out_of_order" not in issue_kinds and "not_executed" not in issue_kinds,
        ),
        ("auto:no-duplicates", "stabilization", 3, "No duplicated cells", "duplicated" not in issue_kinds),
        ("auto:has-visualization", "exploration", 5, "Notebook includes a visualization", has_visual),
        ("auto:model-evaluated", "understanding", 8, "Model has an evaluation step", has_model and has_eval),
        ("auto:has-markdown", "reflection", 4, "Narrative markdown present", has_markdown),
    ]
    return [(k, c, p, l) for k, c, p, l, satisfied in checks if satisfied]


class AnalyzeHandler(APIHandler):
    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        notebook_path = str(body.get("notebookPath") or "")
        key_ns = _notebook_ns(body)

        def run() -> dict[str, Any]:
            result = analyze_notebook(body, notebook_path=notebook_path)
            payload = result_to_dict(result)
            # Namespace auto-check keys per notebook, then apply against the
            # global progression file.
            checks = [
                (f"{key_ns}{key}", category, xp, label)
                for key, category, xp, label in _auto_check_rules(result)
            ]
            new_progress, auto_applied = _mutate_progress(
                lambda s: gamification.apply_auto_checks(s, checks)
            )
            payload["questState"] = gamification.public_view(new_progress)
            payload["autoCompleted"] = auto_applied
            return payload

        try:
            payload = await asyncio.to_thread(run)
        except Exception as exc:  # noqa: BLE001
            raise web.HTTPError(500, reason=str(exc)) from exc

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class QuestInitHandler(APIHandler):
    """Return the full user profile (settings + progress + sync metadata)."""

    def _get_public_profile(self) -> dict[str, Any]:
        profile = profile_store.load()
        profile["progress"] = gamification.public_view(profile.get("progress") or {})
        return profile

    @web.authenticated
    def post(self) -> None:
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"profile": self._get_public_profile()}))

    @web.authenticated
    def get(self) -> None:
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"profile": self._get_public_profile()}))


class MissionClaimHandler(APIHandler):
    """Award XP for a mission. Idempotent on (notebook, missionId)."""

    @web.authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        mission_id = str(body.get("missionId") or "")
        category = str(body.get("category") or "exploration")
        xp = int(body.get("xp") or 0)
        label = str(body.get("label") or mission_id)
        key_ns = _notebook_ns(body)
        if not mission_id:
            raise web.HTTPError(400, reason="missionId required")

        new_progress, outcome = _mutate_progress(
            lambda s: gamification.award_xp(
                s,
                category=category,
                amount=xp,
                award_key=f"{key_ns}mission:{mission_id}",
                label=label,
            )
        )
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"state": gamification.public_view(new_progress), "outcome": outcome}))


class ExplainCellHandler(APIHandler):
    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        cell = body.get("cell")
        analysis = body.get("analysis")
        if not isinstance(cell, dict):
            raise web.HTTPError(400, reason="cell payload is required")

        payload = await _run_llm(
            self,
            explain_cell_payload,
            cell=cell,
            analysis=analysis if isinstance(analysis, dict) else None,
            start_path=_root_dir(self),
            difficulty=_difficulty_from_body(body),
        )

        source = str(cell.get("source") or "")
        cell_hash = (
            hashlib.sha1(source.encode("utf-8"), usedforsecurity=False).hexdigest()[:12]
            if source
            else ""
        )
        key_ns = _notebook_ns(body)
        outcome = {"granted": False, "xpAwarded": 0}
        if cell_hash:
            cell_index = cell.get("index")
            label = (
                f"Read cell {cell_index + 1}"
                if isinstance(cell_index, int)
                else "Read a cell"
            )
            new_progress, outcome = _mutate_progress(
                lambda s: gamification.award_explore(
                    s, cell_hash=cell_hash, amount=3, label=label, key_ns=key_ns
                )
            )
            state_view = gamification.public_view(new_progress)
        else:
            state_view = _view_progress()
        payload["outcome"] = outcome
        payload["state"] = state_view
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class ReflectPromptHandler(APIHandler):
    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        cell = body.get("cell")
        if not isinstance(cell, dict):
            raise web.HTTPError(400, reason="cell payload is required")

        payload = await _run_llm(
            self,
            reflect_prompt_payload,
            cell=cell,
            start_path=_root_dir(self),
            difficulty=_difficulty_from_body(body),
        )
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class ReflectAnswerHandler(APIHandler):
    @web.authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        cell_index = int(body.get("cellIndex") or 0)
        text = str(body.get("text") or "").strip()
        key_ns = _notebook_ns(body)
        if not text:
            raise web.HTTPError(400, reason="Reflection text cannot be empty.")

        new_progress, outcome = _mutate_progress(
            lambda s: gamification.record_reflection(
                s, cell_index=cell_index, text=text, key_ns=key_ns
            )
        )
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"state": gamification.public_view(new_progress), "outcome": outcome}))


class NextStepsHandler(APIHandler):
    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        analysis = body.get("analysis")
        if not isinstance(analysis, dict):
            raise web.HTTPError(400, reason="analysis payload is required")

        payload = await _run_llm(
            self,
            next_steps_payload,
            analysis=analysis,
            start_path=_root_dir(self),
            difficulty=_difficulty_from_body(body),
        )
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class QuizGenerateHandler(APIHandler):
    """Generate a between-cell activity (quiz / predict / teachback / …).

    The activity kind comes from the slot (the analyzer decides which kind each
    injection point offers); defaults to a quiz for back-compat.
    """

    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        slot = body.get("slot")
        cells = body.get("cells")
        if not isinstance(slot, dict):
            raise web.HTTPError(400, reason="slot is required")
        if not isinstance(cells, list):
            raise web.HTTPError(400, reason="cells list is required")

        kind = str(slot.get("kind") or body.get("kind") or activities.KIND_QUIZ)

        try:
            payload = await _run_llm(
                self,
                activities.generate_activity,
                kind=kind,
                slot=slot,
                cells=cells,
                start_path=_root_dir(self),
                difficulty=_difficulty_from_body(body),
            )
        except ValueError as exc:
            raise web.HTTPError(400, reason=str(exc)) from exc

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class ActivityGradeHandler(APIHandler):
    """Grade a free-text ("open") activity answer with the LLM and award XP.

    Idempotent per (notebook, slotId): the first passing answer awards XP; later
    submissions just return the verdict.
    """

    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        slot_id = str(body.get("slotId") or "")
        kind = str(body.get("kind") or activities.KIND_TEACHBACK)
        prompt = str(body.get("prompt") or "")
        answer = str(body.get("answer") or "")
        rubric = body.get("rubric") if isinstance(body.get("rubric"), list) else []
        cell_source = str(body.get("cellSource") or "")
        key_ns = _notebook_ns(body)
        if not slot_id:
            raise web.HTTPError(400, reason="slotId required")

        try:
            verdict = await _run_llm(
                self,
                activities.grade_open_activity,
                prompt=prompt,
                rubric=[str(r) for r in rubric],
                answer=answer,
                cell_source=cell_source,
                start_path=_root_dir(self),
                difficulty=_difficulty_from_body(body),
            )
        except ValueError as exc:
            raise web.HTTPError(400, reason=str(exc)) from exc

        outcome = {"granted": False, "xpAwarded": 0}
        if verdict.get("passed"):
            category = activities.category_for(kind)
            new_progress, outcome = _mutate_progress(
                lambda s: gamification.award_xp(
                    s,
                    category=category,
                    amount=8,
                    award_key=f"{key_ns}activity:{slot_id}",
                    label=f"{kind} · explained in own words",
                )
            )
            state_view = gamification.public_view(new_progress)
        else:
            state_view = _view_progress()

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"verdict": verdict, "outcome": outcome, "state": state_view}))


class ActivityRegistryHandler(APIHandler):
    """Public list of available between-cell activity kinds."""

    @web.authenticated
    def get(self) -> None:
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"activities": activities.public_registry()}))


class FlowyQuizHandler(APIHandler):
    """Generate a spontaneous quiz about an arbitrary snippet.

    Flowy fires this from the sidebar — e.g. right after the learner pastes a
    big block of code — to check they understand what they just dropped in.
    """

    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        code = str(body.get("code") or "")
        context = str(body.get("context") or "")
        if not code.strip():
            raise web.HTTPError(400, reason="code is required")

        try:
            payload = await _run_llm(
                self,
                activities.spontaneous_quiz_payload,
                code=code,
                context=context,
                start_path=_root_dir(self),
                difficulty=_difficulty_from_body(body),
            )
        except ValueError as exc:
            raise web.HTTPError(400, reason=str(exc)) from exc

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class FlowyQuizAnswerHandler(APIHandler):
    """Award XP for answering a spontaneous Flowy quiz (idempotent per challenge)."""

    @web.authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        challenge_id = str(body.get("challengeId") or "")
        correct = bool(body.get("correct"))
        key_ns = _notebook_ns(body)
        if not challenge_id:
            raise web.HTTPError(400, reason="challengeId required")

        amount = 6 if correct else 2
        new_progress, outcome = _mutate_progress(
            lambda s: gamification.award_xp(
                s,
                category="understanding",
                amount=amount,
                award_key=f"{key_ns}flowy-quiz:{challenge_id}",
                label="Flowy quiz" + (" · correct" if correct else " · attempt"),
            )
        )
        self.set_header("Content-Type", "application/json")
        self.finish(
            json.dumps(
                {"state": gamification.public_view(new_progress), "outcome": outcome, "correct": correct}
            )
        )


_QUIZ_CATEGORY_BY_REGION = {
    "load": "exploration",
    "clean": "stabilization",
    "explore": "exploration",
    "visualize": "exploration",
    "model": "understanding",
}


class QuizAnswerHandler(APIHandler):
    @web.authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        slot_id = str(body.get("slotId") or "")
        region = str(body.get("region") or "")
        correct = bool(body.get("correct"))
        key_ns = _notebook_ns(body)
        if not slot_id:
            raise web.HTTPError(400, reason="slotId required")

        category = _QUIZ_CATEGORY_BY_REGION.get(region, "understanding")
        new_progress, outcome = _mutate_progress(
            lambda s: gamification.record_quiz_attempt(
                s, slot_id=slot_id, correct=correct, category=category, key_ns=key_ns
            )
        )
        self.set_header("Content-Type", "application/json")
        self.finish(
            json.dumps(
                {"state": gamification.public_view(new_progress), "outcome": outcome, "correct": correct}
            )
        )


class SettingsGetHandler(APIHandler):
    @web.authenticated
    def get(self) -> None:
        payload = profile_store.public_settings(start_path=_root_dir(self))
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class SettingsSaveHandler(APIHandler):
    @web.authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        # profile_store.update_settings expects camelCase keys natively —
        # pass them through without translation.
        updates: dict[str, Any] = {}
        for key in ("model", "baseUrl", "apiKey"):
            if key in body and isinstance(body[key], str):
                updates[key] = body[key].strip()
        if "favoriteModels" in body and isinstance(body["favoriteModels"], list):
            updates["favoriteModels"] = [str(m) for m in body["favoriteModels"] if m]
        with profile_store._LOCK:
            profile = profile_store.load()
            profile = profile_store.update_settings(profile, updates)
            profile_store.save(profile)
        payload = profile_store.public_settings(start_path=_root_dir(self))
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class StateWipeHandler(APIHandler):
    @web.authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        scope = str(body.get("scope") or "notebook")
        if scope == "global":
            with profile_store._LOCK:
                profile = profile_store.load()
                profile = profile_store.reset_progress(profile)
                profile_store.save(profile)
                new_progress = profile_store.get_progress(profile)
        else:
            notebook_key = _notebook_ns(body).rstrip(":")
            with profile_store._LOCK:
                profile = profile_store.load()
                profile = profile_store.forget_notebook_in_profile(profile, notebook_key)
                profile_store.save(profile)
                new_progress = profile_store.get_progress(profile)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"state": gamification.public_view(new_progress)}))


class ProfileResetHandler(APIHandler):
    """Wipe the entire user profile (settings + progress) for a fresh start."""

    @web.authenticated
    def post(self) -> None:
        with profile_store._LOCK:
            empty = profile_store.save(profile_store._empty_profile())
        empty["progress"] = gamification.public_view(empty.get("progress") or {})
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"profile": empty}))


def setup_handlers(web_app: Any) -> None:
    base_url = web_app.settings.get("base_url", "/")
    handlers = [
        (url_path_join(base_url, "piis-assistant", "status"), AssistantStatusHandler),
        (url_path_join(base_url, "piis-assistant", "chat"), AssistantChatHandler),
        (url_path_join(base_url, "piis-assistant", "analyze"), AnalyzeHandler),
        (url_path_join(base_url, "piis-assistant", "quest", "init"), QuestInitHandler),
        (url_path_join(base_url, "piis-assistant", "mission", "claim"), MissionClaimHandler),
        (url_path_join(base_url, "piis-assistant", "quest", "claim"), MissionClaimHandler),
        (url_path_join(base_url, "piis-assistant", "explain-cell"), ExplainCellHandler),
        (url_path_join(base_url, "piis-assistant", "reflect", "prompt"), ReflectPromptHandler),
        (url_path_join(base_url, "piis-assistant", "reflect", "answer"), ReflectAnswerHandler),
        (url_path_join(base_url, "piis-assistant", "next-steps"), NextStepsHandler),
        (url_path_join(base_url, "piis-assistant", "quiz", "generate"), QuizGenerateHandler),
        (url_path_join(base_url, "piis-assistant", "quiz", "answer"), QuizAnswerHandler),
        (url_path_join(base_url, "piis-assistant", "activity", "generate"), QuizGenerateHandler),
        (url_path_join(base_url, "piis-assistant", "activity", "answer"), QuizAnswerHandler),
        (url_path_join(base_url, "piis-assistant", "activity", "grade"), ActivityGradeHandler),
        (url_path_join(base_url, "piis-assistant", "activities"), ActivityRegistryHandler),
        (url_path_join(base_url, "piis-assistant", "flowy", "quiz"), FlowyQuizHandler),
        (url_path_join(base_url, "piis-assistant", "flowy", "quiz", "answer"), FlowyQuizAnswerHandler),
        (url_path_join(base_url, "piis-assistant", "settings"), SettingsGetHandler),
        (url_path_join(base_url, "piis-assistant", "settings", "save"), SettingsSaveHandler),
        (url_path_join(base_url, "piis-assistant", "state", "wipe"), StateWipeHandler),
        (url_path_join(base_url, "piis-assistant", "profile", "reset"), ProfileResetHandler),
    ]
    web_app.add_handlers(r".*$", handlers)


def load_jupyter_server_extension(serverapp: Any) -> None:
    setup_handlers(serverapp.web_app)
    serverapp.log.info("Registered FlowQuest server routes at /piis-assistant/...")
