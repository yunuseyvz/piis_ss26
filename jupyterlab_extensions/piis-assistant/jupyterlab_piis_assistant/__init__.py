from .handlers import load_jupyter_server_extension

__all__ = ["__version__", "load_jupyter_server_extension"]

__version__ = "0.1.0"


def _jupyter_labextension_paths() -> list[dict[str, str]]:
    return [{"src": "labextension", "dest": "jupyterlab-piis-assistant"}]


def _jupyter_server_extension_points() -> list[dict[str, str]]:
    return [{"module": "jupyterlab_piis_assistant"}]


_jupyter_server_extension_paths = _jupyter_server_extension_points