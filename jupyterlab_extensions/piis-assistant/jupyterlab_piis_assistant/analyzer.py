"""Notebook analysis for FlowQuest.

Takes the serialized notebook payload sent by the frontend and produces:
- per-cell workflow classification and dependency edges
- detected workflow issues
- auto-generated missions grounded in actual problems

The goal is not perfect static analysis but useful, grounded signal for the
gamified UI. Everything is heuristic and best-effort.
"""

from __future__ import annotations

import ast
import builtins
import hashlib
import re
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable

from .activities import ACTIVITY_SPECS, KIND_QUIZ, activity_spec


# ---------------------------------------------------------------------------
# Region classification keywords
# ---------------------------------------------------------------------------


_REGION_KEYWORDS: list[tuple[str, list[str]]] = [
    (
        "load",
        [
            "pd.read_",
            "pd.DataFrame(",
            "read_csv",
            "read_excel",
            "read_parquet",
            "read_sql",
            "load_dataset",
            "open(",
            "fetch_",
            "np.load",
            "loadtxt",
            "make_classification",
            "make_regression",
            "make_blobs",
            "datasets.load_",
        ],
    ),
    (
        "clean",
        [
            ".dropna",
            ".fillna",
            ".drop(",
            ".rename",
            ".astype",
            ".replace",
            ".strip(",
            ".map(",
            ".apply(",
            ".str.",
            ".clip(",
            "StandardScaler",
            "MinMaxScaler",
            "LabelEncoder",
            "OneHotEncoder",
            "SimpleImputer",
            "train_test_split",
        ],
    ),
    (
        "explore",
        [
            ".describe(",
            ".head(",
            ".tail(",
            ".info(",
            ".value_counts(",
            ".corr(",
            ".shape",
            ".columns",
            ".dtypes",
            ".unique(",
            ".nunique(",
            ".isnull(",
            ".isna(",
            ".groupby(",
        ],
    ),
    (
        "visualize",
        [
            "plt.",
            "sns.",
            ".plot(",
            "px.",
            "go.",
            "fig.",
            "ax.",
            "matplotlib",
            "seaborn",
            "plotly",
            ".hist(",
            ".scatter(",
            ".boxplot(",
            ".barplot(",
            "plt.show",
            "plt.figure",
        ],
    ),
    (
        "model",
        [
            ".fit(",
            ".predict(",
            ".score(",
            "LogisticRegression",
            "LinearRegression",
            "RandomForest",
            "GradientBoosting",
            "XGB",
            "DecisionTree",
            "KNeighbors",
            "SVC",
            "KMeans",
            "cross_val_score",
            "GridSearchCV",
            "accuracy_score",
            "mean_squared_error",
            "classification_report",
            "confusion_matrix",
            "torch.",
            "tf.",
            "keras.",
        ],
    ),
    (
        "setup",
        ["import ", "from ", "%matplotlib", "warnings.filterwarnings", "pd.set_option", "np.random.seed"],
    ),
]


REGION_ORDER = ["setup", "load", "clean", "explore", "visualize", "model", "output", "narrative", "other"]

REGION_ICONS = {
    "setup": "⚙️",
    "load": "📦",
    "clean": "🧼",
    "explore": "🔍",
    "visualize": "📊",
    "model": "🧠",
    "output": "🖨️",
    "narrative": "📝",
    "other": "✨",
}


# Regions that should trigger a between-cell activity after their last cell.
_ACTIVITY_REGIONS: tuple[str, ...] = ("load", "clean", "explore", "visualize", "model")


_ACTIVITY_TOPICS: dict[str, str] = {
    "load": "how this cell obtains data",
    "clean": "how this cell transforms or filters data",
    "explore": "what this cell reveals about the data",
    "visualize": "what this visualization communicates",
    "model": "the modeling decision in this cell",
}


_STD_BUILTINS = set(dir(builtins))
_COMMON_IMPLICIT = {
    "display",
    "get_ipython",
    "In",
    "Out",
    "exit",
    "quit",
    "help",
    "pd",
    "np",
    "plt",
    "sns",
    "px",
    "go",
    "tf",
    "torch",
}


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class CellIssue:
    kind: str
    severity: str  # "info" | "warn" | "error"
    message: str


@dataclass
class CellAnalysis:
    index: int
    cell_id: str
    cell_type: str
    exec_count: int | None
    region: str
    region_icon: str
    defines: list[str] = field(default_factory=list)
    uses: list[str] = field(default_factory=list)
    imports: list[str] = field(default_factory=list)
    produces_plot: bool = False
    produces_output: bool = False
    depends_on: list[int] = field(default_factory=list)
    dependents: list[int] = field(default_factory=list)
    issues: list[CellIssue] = field(default_factory=list)
    summary: str = ""
    source_hash: str = ""
    source_preview: str = ""


@dataclass
class Mission:
    id: str
    kind: str  # exploration | understanding | stabilization | reflection
    title: str
    description: str
    xp: int
    cell_indices: list[int]
    completion_hint: str
    auto_completable: bool = False


@dataclass
class AnalysisResult:
    cells: list[CellAnalysis]
    issues: list[dict[str, Any]]
    region_counts: dict[str, int]
    missions: list[Mission]
    summary: dict[str, Any]
    injection_points: list[dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# AST helpers
# ---------------------------------------------------------------------------


def _safe_parse(source: str) -> ast.Module | None:
    # Strip IPython magics and shell commands so the AST parses.
    cleaned_lines = []
    for line in source.splitlines():
        stripped = line.lstrip()
        if stripped.startswith(("%", "!", "?")):
            cleaned_lines.append("")
            continue
        cleaned_lines.append(line)
    cleaned = "\n".join(cleaned_lines)
    try:
        return ast.parse(cleaned)
    except SyntaxError:
        return None


class _NameCollector(ast.NodeVisitor):
    def __init__(self) -> None:
        self.defines: set[str] = set()
        self.uses: set[str] = set()
        self.imports: set[str] = set()
        self.import_aliases: set[str] = set()

    def visit_Assign(self, node: ast.Assign) -> None:
        for target in node.targets:
            self._add_target(target)
        self.visit(node.value)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        self._add_target(node.target)
        self.visit(node.value)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        self._add_target(node.target)
        if node.value is not None:
            self.visit(node.value)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.defines.add(node.name)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.defines.add(node.name)
        self.generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.defines.add(node.name)
        self.generic_visit(node)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            name = alias.asname or alias.name.split(".")[0]
            self.defines.add(name)
            self.import_aliases.add(name)
            self.imports.add(alias.name)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""
        for alias in node.names:
            name = alias.asname or alias.name
            self.defines.add(name)
            self.import_aliases.add(name)
            self.imports.add(f"{module}.{alias.name}" if module else alias.name)

    def visit_For(self, node: ast.For) -> None:
        self._add_target(node.target)
        self.generic_visit(node)

    def visit_With(self, node: ast.With) -> None:
        for item in node.items:
            if item.optional_vars is not None:
                self._add_target(item.optional_vars)
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load):
            self.uses.add(node.id)
        elif isinstance(node.ctx, (ast.Store, ast.Del)):
            self.defines.add(node.id)

    def _add_target(self, target: ast.AST) -> None:
        if isinstance(target, ast.Name):
            self.defines.add(target.id)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                self._add_target(elt)
        elif isinstance(target, ast.Starred):
            self._add_target(target.value)
        elif isinstance(target, (ast.Subscript, ast.Attribute)):
            # Treat `df["x"] = ...` as a use of df, not a new binding.
            self.visit(target)


# ---------------------------------------------------------------------------
# Region classification
# ---------------------------------------------------------------------------


def _classify_region(cell_type: str, source: str) -> str:
    if cell_type == "markdown":
        return "narrative"
    if cell_type == "raw":
        return "other"

    stripped = source.strip()
    if not stripped:
        return "other"

    score: dict[str, int] = {}
    for region, keywords in _REGION_KEYWORDS:
        for keyword in keywords:
            hits = source.count(keyword)
            if hits:
                score[region] = score.get(region, 0) + hits

    if not score:
        # Heuristic: short cells that only print/display are output cells.
        if re.fullmatch(r"[\w.()\"'\[\], \n]+", stripped) and (
            stripped.startswith("print(") or (stripped.endswith(")") and len(stripped) < 80)
        ):
            return "output"
        return "other"

    return max(score, key=lambda key: score[key])


# ---------------------------------------------------------------------------
# Public analyzer
# ---------------------------------------------------------------------------


def _hash_source(source: str) -> str:
    normalized = re.sub(r"\s+", " ", source.strip())
    return hashlib.sha1(normalized.encode("utf-8"), usedforsecurity=False).hexdigest()[:10]


def _cell_summary(source: str, limit: int = 80) -> str:
    stripped = source.strip()
    if not stripped:
        return "[empty cell]"
    first_line = stripped.splitlines()[0]
    if len(first_line) > limit:
        return first_line[: limit - 1] + "…"
    return first_line


def _clip(text: str, limit: int) -> str:
    stripped = text.strip()
    if len(stripped) <= limit:
        return stripped
    return stripped[: limit - 1] + "…"


def analyze_notebook(payload: Any, notebook_path: str | None = None) -> AnalysisResult:
    cells_in = payload.get("cells") if isinstance(payload, dict) else None
    if not isinstance(cells_in, list):
        cells_in = []

    analyses: list[CellAnalysis] = []
    defined_by: dict[str, int] = {}  # variable name -> first defining cell index
    definition_map: dict[str, list[int]] = {}  # name -> list of cell indices defining it
    seen_hashes: dict[str, int] = {}

    for index, raw in enumerate(cells_in):
        if not isinstance(raw, dict):
            continue
        cell_type = str(raw.get("cell_type") or raw.get("type") or "code")
        source = str(raw.get("source") or "")
        cell_id = str(raw.get("id") or f"cell-{index}")
        exec_count_raw = raw.get("exec_count") if raw.get("exec_count") is not None else raw.get("execution_count")
        try:
            exec_count = int(exec_count_raw) if exec_count_raw is not None else None
        except (TypeError, ValueError):
            exec_count = None
        produces_output = bool(raw.get("has_output"))
        produces_plot = bool(raw.get("has_plot"))

        region = _classify_region(cell_type, source)

        defines: list[str] = []
        uses: list[str] = []
        imports: list[str] = []
        import_aliases: list[str] = []
        if cell_type == "code" and source.strip():
            tree = _safe_parse(source)
            if tree is not None:
                collector = _NameCollector()
                collector.visit(tree)
                defines = sorted(collector.defines)
                uses = sorted(u for u in collector.uses if u not in _STD_BUILTINS)
                imports = sorted(collector.imports)
                import_aliases = sorted(collector.import_aliases)

        analysis = CellAnalysis(
            index=index,
            cell_id=cell_id,
            cell_type=cell_type,
            exec_count=exec_count,
            region=region,
            region_icon=REGION_ICONS.get(region, "✨"),
            defines=defines,
            uses=uses,
            imports=imports,
            produces_plot=produces_plot,
            produces_output=produces_output,
            summary=_cell_summary(source),
            source_hash=_hash_source(source) if source.strip() else "",
            source_preview=_clip(source, 320),
        )
        analysis._import_aliases = import_aliases  # type: ignore[attr-defined]
        analyses.append(analysis)

        for name in defines:
            defined_by.setdefault(name, index)
            definition_map.setdefault(name, []).append(index)

    # Second pass: dependencies, duplicates, issues, execution order.
    duplicate_groups: dict[str, list[int]] = {}
    for analysis in analyses:
        if analysis.cell_type == "code" and analysis.source_hash:
            duplicate_groups.setdefault(analysis.source_hash, []).append(analysis.index)

    last_exec_count: int | None = None
    for analysis in analyses:
        source_text = analysis.source_preview
        if analysis.cell_type == "code":
            # Dependencies via name resolution.
            deps: set[int] = set()
            for name in analysis.uses:
                defining_cells = definition_map.get(name)
                if not defining_cells:
                    continue
                for idx in defining_cells:
                    if idx < analysis.index:
                        deps.add(idx)
            analysis.depends_on = sorted(deps)

            # Issues: empty cell
            if not source_text.strip():
                analysis.issues.append(
                    CellIssue(kind="empty_cell", severity="info", message="Empty code cell.")
                )

            # Issues: not executed
            if source_text.strip() and analysis.exec_count is None:
                analysis.issues.append(
                    CellIssue(
                        kind="not_executed",
                        severity="warn",
                        message="Cell has source but no execution count.",
                    )
                )

            # Issues: out-of-order execution
            if analysis.exec_count is not None:
                if last_exec_count is not None and analysis.exec_count < last_exec_count:
                    analysis.issues.append(
                        CellIssue(
                            kind="out_of_order",
                            severity="warn",
                            message=f"Executed ({analysis.exec_count}) after a later-numbered cell ({last_exec_count}).",
                        )
                    )
                last_exec_count = max(last_exec_count or 0, analysis.exec_count)

            # Issues: undefined reference
            unknown = [
                name
                for name in analysis.uses
                if name not in definition_map
                and name not in _COMMON_IMPLICIT
                and not name.startswith("_")
            ]
            if unknown:
                short = ", ".join(unknown[:5])
                analysis.issues.append(
                    CellIssue(
                        kind="undefined_reference",
                        severity="warn",
                        message=f"References names not defined anywhere in the notebook: {short}.",
                    )
                )

            # Issues: duplicated source
            dup = duplicate_groups.get(analysis.source_hash, [])
            if analysis.source_hash and len(dup) > 1 and dup[0] == analysis.index:
                others = ", ".join(f"#{i + 1}" for i in dup[1:])
                analysis.issues.append(
                    CellIssue(
                        kind="duplicated",
                        severity="info",
                        message=f"Identical source appears in cells {others}.",
                    )
                )

    # Populate dependents (reverse edges).
    for analysis in analyses:
        for dep_index in analysis.depends_on:
            if 0 <= dep_index < len(analyses):
                analyses[dep_index].dependents.append(analysis.index)

    # Disconnected code cells (no deps and no dependents and not setup).
    code_cells = [c for c in analyses if c.cell_type == "code" and c.source_preview.strip()]
    for analysis in code_cells:
        is_alone = not analysis.depends_on and not analysis.dependents
        if is_alone and analysis.region not in {"setup", "narrative"} and analysis.region != "output":
            # Skip tiny cells like a single print statement.
            if analysis.defines or len(analysis.uses) > 1:
                analysis.issues.append(
                    CellIssue(
                        kind="disconnected",
                        severity="info",
                        message="Cell does not connect to any other cell's data flow.",
                    )
                )

    # Unused variable detection.
    all_uses: set[str] = set()
    for analysis in analyses:
        all_uses.update(analysis.uses)
    for analysis in analyses:
        if not analysis.defines:
            continue
        aliases = set(getattr(analysis, "_import_aliases", []))  # type: ignore[attr-defined]
        unused = [
            name
            for name in analysis.defines
            if name not in all_uses
            and not name.startswith("_")
            and name not in _STD_BUILTINS
            and name not in aliases
        ]
        # Skip loop/comprehension throwaway names.
        unused = [n for n in unused if n not in {"i", "j", "k", "_"}]
        if unused:
            short = ", ".join(unused[:5])
            analysis.issues.append(
                CellIssue(
                    kind="unused_variable",
                    severity="info",
                    message=f"Defines variables never used later: {short}.",
                )
            )

    # Region counts.
    region_counts: dict[str, int] = {name: 0 for name in REGION_ORDER}
    for analysis in analyses:
        region_counts[analysis.region] = region_counts.get(analysis.region, 0) + 1

    # Top-level issue list (flat).
    flat_issues: list[dict[str, Any]] = []
    for analysis in analyses:
        for issue in analysis.issues:
            flat_issues.append(
                {
                    "cell_index": analysis.index,
                    "kind": issue.kind,
                    "severity": issue.severity,
                    "message": issue.message,
                    "region": analysis.region,
                }
            )

    missions = generate_missions(analyses, flat_issues)

    injection_points = _compute_injection_points(analyses)

    summary = {
        "cell_count": len(analyses),
        "code_cells": sum(1 for c in analyses if c.cell_type == "code"),
        "markdown_cells": sum(1 for c in analyses if c.cell_type == "markdown"),
        "executed_cells": sum(1 for c in analyses if c.cell_type == "code" and c.exec_count),
        "unique_regions": sum(1 for name, count in region_counts.items() if count),
        "notebook_path": notebook_path or "",
    }

    return AnalysisResult(
        cells=analyses,
        issues=flat_issues,
        region_counts=region_counts,
        missions=missions,
        summary=summary,
        injection_points=injection_points,
    )


# ---------------------------------------------------------------------------
# Injection points: where to slip in virtual FlowQuest cells
# ---------------------------------------------------------------------------


def _compute_injection_points(cells: list[CellAnalysis]) -> list[dict[str, Any]]:
    """Return a list of virtual-cell injection slots anchored to real cells.

    Each slot is a dict with:
      - ``anchorCellId``: id of the real cell that the virtual cell attaches
        below. Using the id (not the index) makes the anchor survive cell
        insertions and deletions.
      - ``anchorCellIndex``: current index of that cell (for UX / ordering).
      - ``kind``: which between-cell activity to offer (``quiz``, ``predict``,
        ``teachback`` — see :mod:`activities`). Varied across the notebook so
        the learner meets a mix of intelligent tasks.
      - ``topic``: short human description of why the slot exists.
      - ``region``: the region of the anchor cell.
      - ``slotId``: stable id of the form ``<anchorCellId>::<kind>:region`` so a
        given spot only gets one virtual cell.
    """

    points: list[dict[str, Any]] = []

    # Trigger an activity after the last cell of each interesting region run.
    runs: list[tuple[str, int, int]] = []  # (region, start_index, end_index)
    current: tuple[str, int, int] | None = None
    for cell in cells:
        if cell.cell_type != "code":
            if current is not None:
                runs.append(current)
                current = None
            continue
        region = cell.region
        if region not in _ACTIVITY_REGIONS:
            if current is not None:
                runs.append(current)
                current = None
            continue
        if current is None:
            current = (region, cell.index, cell.index)
        elif current[0] == region:
            current = (region, current[1], cell.index)
        else:
            runs.append(current)
            current = (region, cell.index, cell.index)
    if current is not None:
        runs.append(current)

    for run_index, (region, _start, end) in enumerate(runs):
        anchor = cells[end]
        if not anchor.source_preview.strip():
            continue
        kind = _activity_kind_for(region, run_index)
        spec = activity_spec(kind)
        slot_id = f"{anchor.cell_id}::{kind}:{region}"
        points.append(
            {
                "slotId": slot_id,
                "kind": kind,
                "kindLabel": spec["label"],
                "response": spec["response"],
                "region": region,
                "topic": _ACTIVITY_TOPICS.get(region, "this part of the workflow"),
                "anchorCellId": anchor.cell_id,
                "anchorCellIndex": anchor.index,
                "contextCellIds": [
                    cells[i].cell_id
                    for i in range(max(0, end - 2), min(len(cells), end + 1))
                ],
                "kindIcon": spec["icon"],
            }
        )

    return points


def _activity_kind_for(region: str, run_index: int) -> str:
    """Pick a between-cell activity kind for a region run.

    Deterministic (so the same notebook yields stable slots across re-scans):
    rotates through the kinds whose ``regions`` include this region, offset by
    the run index so a notebook with several runs gets a varied mix.
    """
    eligible = [
        spec["kind"]
        for spec in ACTIVITY_SPECS.values()
        if region in spec.get("regions", ())
    ]
    if not eligible:
        return KIND_QUIZ
    return eligible[run_index % len(eligible)]


# ---------------------------------------------------------------------------
# Missions
# ---------------------------------------------------------------------------


def generate_missions(cells: list[CellAnalysis], issues: list[dict[str, Any]]) -> list[Mission]:
    missions: list[Mission] = []

    def add(mission: Mission) -> None:
        missions.append(mission)

    issues_by_kind: dict[str, list[dict[str, Any]]] = {}
    for issue in issues:
        issues_by_kind.setdefault(issue["kind"], []).append(issue)

    # Stabilization: unused variables
    unused = issues_by_kind.get("unused_variable", [])
    if unused:
        cell_indices = sorted({i["cell_index"] for i in unused})
        add(
            Mission(
                id="stab-unused-variables",
                kind="stabilization",
                title="Revive the dead code",
                description=f"Your notebook defines {len(unused)} variable group(s) that no later cell uses. "
                "Either drop the cell or wire the output into your analysis.",
                xp=6,
                cell_indices=cell_indices,
                completion_hint="When the unused variables are gone (or consumed), this mission auto-clears.",
                auto_completable=True,
            )
        )

    # Stabilization: execution order
    ooo = issues_by_kind.get("out_of_order", [])
    not_exec = issues_by_kind.get("not_executed", [])
    if ooo or not_exec:
        cell_indices = sorted({i["cell_index"] for i in ooo + not_exec})
        add(
            Mission(
                id="stab-rerun-clean",
                kind="stabilization",
                title="Fix the flow",
                description="Some cells were not executed or were run out of order. "
                "Restart the kernel and run the notebook top to bottom so execution numbers are consistent.",
                xp=8,
                cell_indices=cell_indices,
                completion_hint="This clears once every code cell has an increasing execution number.",
                auto_completable=True,
            )
        )

    # Stabilization: duplicated cells
    dup = issues_by_kind.get("duplicated", [])
    if dup:
        cell_indices = sorted({i["cell_index"] for i in dup})
        add(
            Mission(
                id="stab-dedupe",
                kind="stabilization",
                title="Cut the copies",
                description="Some cells have identical code. Extract a helper function or keep only one authoritative cell.",
                xp=5,
                cell_indices=cell_indices,
                completion_hint="Auto-clears once the duplicates are consolidated.",
                auto_completable=True,
            )
        )

    # Understanding: disconnected cells
    disc = issues_by_kind.get("disconnected", [])
    if disc:
        cell_indices = sorted({i["cell_index"] for i in disc})
        add(
            Mission(
                id="und-wire-orphans",
                kind="understanding",
                title="Trace the orphans",
                description="Some cells do not connect to any other cell's data flow. "
                "Figure out whether they belong in the story or should be removed.",
                xp=5,
                cell_indices=cell_indices,
                completion_hint="Use the Explain action on each orphan cell to inspect it.",
            )
        )

    # Exploration: if there is no visualize region yet but there is data
    has_data = any(c.region in {"load", "clean", "explore"} for c in cells)
    has_viz = any(c.region == "visualize" for c in cells)
    if has_data and not has_viz:
        add(
            Mission(
                id="expl-add-visual",
                kind="exploration",
                title="See the shape of your data",
                description="You have data loading and cleaning but no visualization yet. "
                "Add a plot to surface missing values or distributions.",
                xp=8,
                cell_indices=[],
                completion_hint="Add any plt/sns/px cell to complete this mission.",
                auto_completable=True,
            )
        )

    # Understanding: if there is a model but no evaluation
    has_model = any(c.region == "model" for c in cells)
    if has_model:
        eval_keywords = ("score", "accuracy_", "report", "confusion_", "cross_val")
        has_eval = any(
            any(kw in c.source_preview for kw in eval_keywords)
            for c in cells
            if c.region == "model"
        )
        if not has_eval:
            model_cells = sorted({c.index for c in cells if c.region == "model"})
            add(
                Mission(
                    id="und-evaluate-model",
                    kind="understanding",
                    title="Put the model on trial",
                    description="Your notebook trains a model but never scores it. "
                    "Add an evaluation step so you know whether it actually works.",
                    xp=10,
                    cell_indices=model_cells,
                    completion_hint="Add any score/accuracy/classification_report call.",
                    auto_completable=True,
                )
            )

    # Reflection: pick one model or transform cell and ask "why"
    reflection_target: CellAnalysis | None = None
    for preferred in ("model", "clean", "visualize"):
        for c in cells:
            if c.region == preferred and c.defines:
                reflection_target = c
                break
        if reflection_target is not None:
            break
    if reflection_target is not None:
        add(
            Mission(
                id=f"refl-why-{reflection_target.index}",
                kind="reflection",
                title="Explain the choice",
                description=f"Cell {reflection_target.index + 1} ({reflection_target.region}) makes a decision. "
                "Open the reflect action on it and write in your own words why this choice belongs in the workflow.",
                xp=6,
                cell_indices=[reflection_target.index],
                completion_hint="Use the Reflect action on the highlighted cell and claim the XP.",
            )
        )

    # Exploration baseline
    if not missions and cells:
        mid_index = min(len(cells) - 1, max(0, len(cells) // 2))
        add(
            Mission(
                id="expl-tour",
                kind="exploration",
                title="Take the grand tour",
                description="Explore at least three different workflow regions to claim this XP.",
                xp=5,
                cell_indices=[0, mid_index, len(cells) - 1],
                completion_hint="Click Explain on three different cells across the notebook.",
            )
        )

    return missions


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def result_to_dict(result: AnalysisResult) -> dict[str, Any]:
    return {
        "cells": [
            {
                "index": c.index,
                "cellId": c.cell_id,
                "cellType": c.cell_type,
                "execCount": c.exec_count,
                "region": c.region,
                "regionIcon": c.region_icon,
                "defines": c.defines,
                "uses": c.uses,
                "imports": c.imports,
                "dependsOn": c.depends_on,
                "dependents": c.dependents,
                "producesPlot": c.produces_plot,
                "producesOutput": c.produces_output,
                "summary": c.summary,
                "sourcePreview": c.source_preview,
                "issues": [asdict(issue) for issue in c.issues],
            }
            for c in result.cells
        ],
        "issues": result.issues,
        "regionCounts": result.region_counts,
        "regionOrder": REGION_ORDER,
        "regionIcons": REGION_ICONS,
        "missions": [asdict(m) for m in result.missions],
        "injectionPoints": result.injection_points,
        "summary": result.summary,
    }


__all__ = [
    "analyze_notebook",
    "result_to_dict",
    "generate_missions",
    "AnalysisResult",
    "CellAnalysis",
    "Mission",
    "REGION_ICONS",
    "REGION_ORDER",
]
