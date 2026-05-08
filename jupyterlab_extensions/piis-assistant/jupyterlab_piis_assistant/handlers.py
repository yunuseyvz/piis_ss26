from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
from tornado import web

from .ai_backend import chat_payload, status_payload


def _root_dir(handler: APIHandler) -> Path:
    contents_manager = handler.settings.get("contents_manager")
    root_dir = getattr(contents_manager, "root_dir", None)
    if isinstance(root_dir, str) and root_dir:
        return Path(root_dir)
    server_root = handler.settings.get("server_root_dir")
    if isinstance(server_root, str) and server_root:
        return Path(server_root)
    return Path.cwd()


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
        if not isinstance(prompt, str):
            raise web.HTTPError(400, reason="Prompt must be a string.")

        try:
            payload = await asyncio.to_thread(chat_payload, prompt=prompt, start_path=_root_dir(self))
        except ValueError as exc:
            raise web.HTTPError(400, reason=str(exc)) from exc
        except Exception as exc:
            raise web.HTTPError(500, reason=str(exc)) from exc

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


def setup_handlers(web_app: Any) -> None:
    base_url = web_app.settings.get("base_url", "/")
    handlers = [
        (url_path_join(base_url, "piis-assistant", "status"), AssistantStatusHandler),
        (url_path_join(base_url, "piis-assistant", "chat"), AssistantChatHandler),
    ]
    web_app.add_handlers(r".*$", handlers)


def load_jupyter_server_extension(serverapp: Any) -> None:
    setup_handlers(serverapp.web_app)
    serverapp.log.info("Registered PIIS assistant server routes at /piis-assistant/...")