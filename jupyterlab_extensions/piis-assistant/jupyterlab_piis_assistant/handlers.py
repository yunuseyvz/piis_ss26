from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any

from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
from tornado import web

from . import gamification, criteria, settings as settings_store
from .ai_backend import (
    baseline_health_payload,
    chat_payload,
    explain_cell_payload,
    next_steps_payload,
    quiz_payload,
    reflect_prompt_payload,
    status_payload,
)
from .analyzer import analyze_notebook, result_to_dict


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

        try:
            payload = await asyncio.to_thread(
                chat_payload,
                prompt=prompt,
                history=history,
                notebook=notebook,
                start_path=_root_dir(self),
            )
        except ValueError as exc:
            raise web.HTTPError(400, reason=str(exc)) from exc
        except Exception as exc:
            raise web.HTTPError(500, reason=str(exc)) from exc

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


def _auto_check_rules(result: Any) -> list[tuple[str, str, int, str]]:
    """Return (award_key, criterion_id, points, label) for satisfied conditions.

    These award small health boosts when the analyzer sees structural
    improvements, so the user's work keeps rewarding them even if they forget
    to press a claim button.
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
    has_seed = any("random_state" in c.source_preview or "np.random.seed" in c.source_preview for c in result.cells)

    checks: list[tuple[str, str, int, str, bool]] = [
        ("auto:no-unused-vars", "workflow_clarity", 4, "No unused variables detected", "unused_variable" not in issue_kinds),
        (
            "auto:clean-execution",
            "execution_consistency",
            6,
            "Execution order is consistent",
            "out_of_order" not in issue_kinds and "not_executed" not in issue_kinds,
        ),
        ("auto:no-duplicates", "workflow_clarity", 3, "No duplicated cells", "duplicated" not in issue_kinds),
        ("auto:has-visualization", "analysis_depth", 5, "Notebook includes a visualization", has_visual),
        ("auto:model-evaluated", "model_rigor", 8, "Model has an evaluation step", has_model and has_eval),
        ("auto:has-markdown", "reader_understanding", 4, "Narrative markdown present", has_markdown),
        ("auto:seeded", "reproducibility", 4, "Random seed set for reproducibility", has_seed),
    ]
    return [(k, c, p, l) for k, c, p, l, satisfied in checks if satisfied]


class AnalyzeHandler(APIHandler):
    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        notebook_path = str(body.get("notebookPath") or "")
        incoming_state = body.get("state")

        def run() -> dict[str, Any]:
            result = analyze_notebook(body, notebook_path=notebook_path)
            payload = result_to_dict(result)
            state = gamification.normalize_state(incoming_state)
            auto_applied: list[dict[str, Any]] = []
            if state.get("initialized"):
                checks = _auto_check_rules(result)
                state, auto_applied = gamification.apply_auto_checks(state, checks)
            payload["questState"] = gamification.public_view(state)
            payload["autoCompleted"] = auto_applied
            payload["criteria"] = [
                {
                    "id": c.id,
                    "label": c.label,
                    "icon": c.icon,
                    "weight": c.weight,
                    "pointBudget": c.point_budget,
                }
                for c in criteria.HEALTH_CRITERIA
            ]
            return payload

        try:
            payload = await asyncio.to_thread(run)
        except Exception as exc:
            raise web.HTTPError(500, reason=str(exc)) from exc

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class InitializeHandler(APIHandler):
    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        analysis = body.get("analysis")
        incoming_state = body.get("state")
        notebook_path = str(body.get("notebookPath") or "")
        if not isinstance(analysis, dict):
            raise web.HTTPError(400, reason="analysis payload is required")

        try:
            baseline = await asyncio.to_thread(
                baseline_health_payload,
                analysis=analysis,
                start_path=_root_dir(self),
                difficulty=_difficulty_from_body(body),
            )
        except Exception as exc:
            raise web.HTTPError(500, reason=str(exc)) from exc

        state = gamification.initialize_state(
            incoming_state,
            baseline_health=int(baseline["baselineHealth"]),
            breakdown=dict(baseline["breakdown"]),
            notes=str(baseline.get("notes") or ""),
        )
        payload = {
            "state": gamification.public_view(state),
            "baseline": baseline,
            "notebookPath": notebook_path,
        }
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class QuestInitHandler(APIHandler):
    """Normalize a raw state blob and return its public view."""

    @web.authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        incoming = body.get("state")
        state = gamification.normalize_state(incoming)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"state": gamification.public_view(state)}))


class MissionClaimHandler(APIHandler):
    """Award health points for a mission. Idempotent on missionId."""

    @web.authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        incoming = body.get("state")
        mission_id = str(body.get("missionId") or "")
        criterion_id = str(body.get("criterionId") or "workflow_clarity")
        points = int(body.get("points") or 0)
        label = str(body.get("label") or mission_id)

        if not mission_id:
            raise web.HTTPError(400, reason="missionId required")

        new_state, outcome = gamification.award_health(
            incoming,
            criterion_id=criterion_id,
            points=points,
            award_key=f"mission:{mission_id}",
            label=label,
        )
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"state": gamification.public_view(new_state), "outcome": outcome}))


class ExplainCellHandler(APIHandler):
    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        cell = body.get("cell")
        analysis = body.get("analysis")
        incoming = body.get("state")
        if not isinstance(cell, dict):
            raise web.HTTPError(400, reason="cell payload is required")

        try:
            payload = await asyncio.to_thread(
                explain_cell_payload,
                cell=cell,
                analysis=analysis if isinstance(analysis, dict) else None,
                start_path=_root_dir(self),
                difficulty=_difficulty_from_body(body),
            )
        except Exception as exc:
            raise web.HTTPError(500, reason=str(exc)) from exc

        source = str(cell.get("source") or "")
        cell_hash = (
            hashlib.sha1(source.encode("utf-8"), usedforsecurity=False).hexdigest()[:12]
            if source
            else ""
        )
        state = gamification.normalize_state(incoming)
        outcome = {"granted": False, "pointsAwarded": 0}
        if cell_hash:
            state, outcome = gamification.award_health(
                state,
                criterion_id="reader_understanding",
                points=2,
                award_key=f"explain:{cell_hash}",
                label=f"Read cell {cell.get('index', '?') + 1 if isinstance(cell.get('index'), int) else '?'}",
            )
        payload["outcome"] = outcome
        payload["state"] = gamification.public_view(state)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class ReflectPromptHandler(APIHandler):
    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        cell = body.get("cell")
        if not isinstance(cell, dict):
            raise web.HTTPError(400, reason="cell payload is required")

        try:
            payload = await asyncio.to_thread(
                reflect_prompt_payload,
                cell=cell,
                start_path=_root_dir(self),
                difficulty=_difficulty_from_body(body),
            )
        except Exception as exc:
            raise web.HTTPError(500, reason=str(exc)) from exc

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class ReflectAnswerHandler(APIHandler):
    @web.authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        incoming = body.get("state")
        cell_index = int(body.get("cellIndex") or 0)
        text = str(body.get("text") or "").strip()
        if not text:
            raise web.HTTPError(400, reason="Reflection text cannot be empty.")

        new_state, outcome = gamification.record_reflection(
            incoming,
            cell_index=cell_index,
            text=text,
        )
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"state": gamification.public_view(new_state), "outcome": outcome}))


class NextStepsHandler(APIHandler):
    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        analysis = body.get("analysis")
        if not isinstance(analysis, dict):
            raise web.HTTPError(400, reason="analysis payload is required")

        try:
            payload = await asyncio.to_thread(
                next_steps_payload,
                analysis=analysis,
                start_path=_root_dir(self),
                difficulty=_difficulty_from_body(body),
            )
        except Exception as exc:
            raise web.HTTPError(500, reason=str(exc)) from exc

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class QuizGenerateHandler(APIHandler):
    @web.authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        slot = body.get("slot")
        cells = body.get("cells")
        if not isinstance(slot, dict):
            raise web.HTTPError(400, reason="slot is required")
        if not isinstance(cells, list):
            raise web.HTTPError(400, reason="cells list is required")

        try:
            payload = await asyncio.to_thread(
                quiz_payload,
                slot=slot,
                cells=cells,
                start_path=_root_dir(self),
                difficulty=_difficulty_from_body(body),
            )
        except ValueError as exc:
            raise web.HTTPError(400, reason=str(exc)) from exc
        except Exception as exc:
            raise web.HTTPError(500, reason=str(exc)) from exc

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


_QUIZ_CRITERION_BY_REGION = {
    "load": "data_hygiene",
    "clean": "data_hygiene",
    "explore": "analysis_depth",
    "visualize": "analysis_depth",
    "model": "model_rigor",
}


class QuizAnswerHandler(APIHandler):
    @web.authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        incoming = body.get("state")
        slot_id = str(body.get("slotId") or "")
        region = str(body.get("region") or "")
        correct = bool(body.get("correct"))
        if not slot_id:
            raise web.HTTPError(400, reason="slotId required")

        criterion_id = _QUIZ_CRITERION_BY_REGION.get(region, "reader_understanding")
        new_state, outcome = gamification.record_quiz_attempt(
            incoming,
            slot_id=slot_id,
            correct=correct,
            criterion_id=criterion_id,
        )
        self.set_header("Content-Type", "application/json")
        self.finish(
            json.dumps(
                {
                    "state": gamification.public_view(new_state),
                    "outcome": outcome,
                    "correct": correct,
                }
            )
        )


class CriteriaHandler(APIHandler):
    @web.authenticated
    def get(self) -> None:
        payload = [
            {
                "id": c.id,
                "label": c.label,
                "description": c.description,
                "weight": c.weight,
                "pointBudget": c.point_budget,
                "icon": c.icon,
            }
            for c in criteria.HEALTH_CRITERIA
        ]
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"criteria": payload, "healthTarget": gamification.HEALTH_TARGET}))


class SettingsGetHandler(APIHandler):
    @web.authenticated
    def get(self) -> None:
        payload = settings_store.public_settings(start_path=_root_dir(self))
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class SettingsSaveHandler(APIHandler):
    @web.authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        updates: dict[str, Any] = {}
        for key in ("model", "baseUrl", "apiKey"):
            if key in body and isinstance(body[key], str):
                stored_key = {
                    "model": "model",
                    "baseUrl": "base_url",
                    "apiKey": "api_key",
                }[key]
                updates[stored_key] = body[key].strip()
        if "favoriteModels" in body and isinstance(body["favoriteModels"], list):
            updates["favorite_models"] = list(body["favoriteModels"])
        settings_store.save_global_settings(updates)
        payload = settings_store.public_settings(start_path=_root_dir(self))
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class StateDifficultyHandler(APIHandler):
    @web.authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        new_state = gamification.set_difficulty(body.get("state"), str(body.get("difficulty") or ""))
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"state": gamification.public_view(new_state)}))


class StateWipeHandler(APIHandler):
    @web.authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        keep_difficulty = bool(body.get("keepDifficulty", True))
        new_state = gamification.wipe_state(body.get("state"), keep_difficulty=keep_difficulty)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"state": gamification.public_view(new_state)}))


def setup_handlers(web_app: Any) -> None:
    base_url = web_app.settings.get("base_url", "/")
    handlers = [
        (url_path_join(base_url, "piis-assistant", "status"), AssistantStatusHandler),
        (url_path_join(base_url, "piis-assistant", "chat"), AssistantChatHandler),
        (url_path_join(base_url, "piis-assistant", "analyze"), AnalyzeHandler),
        (url_path_join(base_url, "piis-assistant", "initialize"), InitializeHandler),
        (url_path_join(base_url, "piis-assistant", "quest", "init"), QuestInitHandler),
        (url_path_join(base_url, "piis-assistant", "mission", "claim"), MissionClaimHandler),
        # Keep the old claim endpoint alive for a release to not break cached clients.
        (url_path_join(base_url, "piis-assistant", "quest", "claim"), MissionClaimHandler),
        (url_path_join(base_url, "piis-assistant", "explain-cell"), ExplainCellHandler),
        (url_path_join(base_url, "piis-assistant", "reflect", "prompt"), ReflectPromptHandler),
        (url_path_join(base_url, "piis-assistant", "reflect", "answer"), ReflectAnswerHandler),
        (url_path_join(base_url, "piis-assistant", "next-steps"), NextStepsHandler),
        (url_path_join(base_url, "piis-assistant", "quiz", "generate"), QuizGenerateHandler),
        (url_path_join(base_url, "piis-assistant", "quiz", "answer"), QuizAnswerHandler),
        (url_path_join(base_url, "piis-assistant", "criteria"), CriteriaHandler),
        (url_path_join(base_url, "piis-assistant", "settings"), SettingsGetHandler),
        (url_path_join(base_url, "piis-assistant", "settings", "save"), SettingsSaveHandler),
        (url_path_join(base_url, "piis-assistant", "state", "difficulty"), StateDifficultyHandler),
        (url_path_join(base_url, "piis-assistant", "state", "wipe"), StateWipeHandler),
    ]
    web_app.add_handlers(r".*$", handlers)


def load_jupyter_server_extension(serverapp: Any) -> None:
    setup_handlers(serverapp.web_app)
    serverapp.log.info("Registered FlowQuest server routes at /piis-assistant/...")
