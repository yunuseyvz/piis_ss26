from __future__ import annotations

from pathlib import Path

from setuptools import setup


HERE = Path(__file__).parent.resolve()
PYTHON_PACKAGE = "jupyterlab_piis_assistant"
LABEXTENSION_NAME = "jupyterlab-piis-assistant"
LABEXTENSION_DIR = HERE / PYTHON_PACKAGE / "labextension"
INSTALL_JSON = HERE / "install.json"
SERVER_CONFIG_JSON = HERE / "jupyter-config" / "jupyter_server_config.d" / "jupyterlab_piis_assistant.json"


def iter_labextension_files() -> list[tuple[str, list[str]]]:
    if not LABEXTENSION_DIR.exists():
        raise RuntimeError("Run `npm run build` before installing this package.")

    data_files: list[tuple[str, list[str]]] = []
    for path in sorted(LABEXTENSION_DIR.rglob("*")):
        if not path.is_file():
            continue
        relative_parent = path.relative_to(LABEXTENSION_DIR).parent
        target_dir = Path("share") / "jupyter" / "labextensions" / LABEXTENSION_NAME / relative_parent
        data_files.append((str(target_dir), [path.relative_to(HERE).as_posix()]))

    if INSTALL_JSON.exists():
        install_target = Path("share") / "jupyter" / "labextensions" / LABEXTENSION_NAME
        data_files.append((str(install_target), [INSTALL_JSON.relative_to(HERE).as_posix()]))

    return data_files


def iter_server_config_files() -> list[tuple[str, list[str]]]:
    if not SERVER_CONFIG_JSON.exists():
        return []

    target_dir = Path("etc") / "jupyter" / "jupyter_server_config.d"
    return [(str(target_dir), [SERVER_CONFIG_JSON.relative_to(HERE).as_posix()])]


setup(
    name=LABEXTENSION_NAME,
    version="0.1.0",
    description="A minimal JupyterLab assistant sidebar for the PIIS notebook experiments.",
    packages=[PYTHON_PACKAGE],
    include_package_data=True,
    python_requires=">=3.10",
    install_requires=["jupyter_server>=2.0", "openai>=1.78.1", "python-dotenv>=1.1.0"],
    data_files=[*iter_labextension_files(), *iter_server_config_files()],
)