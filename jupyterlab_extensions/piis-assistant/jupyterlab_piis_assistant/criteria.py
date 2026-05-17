"""FlowQuest health criteria.

Edit this file to change how notebooks are scored.

The criteria drive two things:

1. **LLM baseline scoring.** When the user clicks "Initialize" in the
   FlowQuest HUD banner, the model receives the criteria list here and is
   asked to rate each criterion on a 0-10 scale given the current notebook
   contents. The weighted sum becomes the baseline Notebook Health (0-100).

2. **Point budgets for missions and quizzes.** Each criterion also declares
   how many health points the user can earn by completing activities tied
   to it. The ``point_budget`` field caps how much the LLM baseline *can*
   leave on the table for the user to earn back through gameplay.

The goal of the game is simple: push Notebook Health to >= 100.

Do not rename the top-level list (`HEALTH_CRITERIA`); the handlers import it
by name.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class HealthCriterion:
    #: Short stable identifier used in responses and missions.
    id: str
    #: Short human label shown in the UI.
    label: str
    #: 2-3 sentence description handed to the LLM.
    description: str
    #: 0-100 weight. Weights across all criteria do not have to sum to 100
    #: because the final score is normalised at the end.
    weight: int
    #: Maximum number of health points that missions/quizzes tied to this
    #: criterion can award. Keep the sum of all budgets around 120-150 so
    #: the user has enough runway to reach 100 regardless of baseline.
    point_budget: int
    #: Emoji icon shown next to the criterion in the UI.
    icon: str


HEALTH_CRITERIA: list[HealthCriterion] = [
    HealthCriterion(
        id="workflow_clarity",
        label="Workflow clarity",
        description=(
            "How clearly the notebook communicates the analytical journey. "
            "A clear notebook has coherent region progression (setup, load, "
            "clean, explore, visualize, model) and narrative markdown that "
            "explains *why* things happen, not just *what*."
        ),
        weight=20,
        point_budget=25,
        icon="🧭",
    ),
    HealthCriterion(
        id="execution_consistency",
        label="Execution consistency",
        description=(
            "Whether the notebook runs top-to-bottom without hidden state. "
            "All code cells should have execution counts in strictly "
            "increasing order, with no skipped or out-of-order cells."
        ),
        weight=15,
        point_budget=20,
        icon="⚙️",
    ),
    HealthCriterion(
        id="data_hygiene",
        label="Data hygiene",
        description=(
            "How well the notebook handles data quality. Good notebooks "
            "inspect missing values, coerce types deliberately, document "
            "transformations, and do not silently drop rows."
        ),
        weight=15,
        point_budget=20,
        icon="🧼",
    ),
    HealthCriterion(
        id="reproducibility",
        label="Reproducibility",
        description=(
            "Would another person get the same result? Check for pinned "
            "random seeds, deterministic data loading, explicit library "
            "imports, and absence of hard-coded absolute paths."
        ),
        weight=10,
        point_budget=15,
        icon="🔁",
    ),
    HealthCriterion(
        id="analysis_depth",
        label="Analysis depth",
        description=(
            "Beyond loading and cleaning, does the notebook actually explore "
            "the data and draw conclusions? Look for summary statistics, "
            "multiple perspectives (plots, groupbys), and written reasoning."
        ),
        weight=15,
        point_budget=20,
        icon="🔍",
    ),
    HealthCriterion(
        id="model_rigor",
        label="Model rigor",
        description=(
            "If the notebook trains a model, is it evaluated honestly? "
            "Check for train/test split, a metric that matches the task, "
            "and at least one baseline or sanity check. If no model is "
            "present, score this criterion a neutral 5."
        ),
        weight=10,
        point_budget=15,
        icon="🧠",
    ),
    HealthCriterion(
        id="reader_understanding",
        label="Reader understanding",
        description=(
            "How well will a new reader understand the notebook? This "
            "rewards good markdown, labeled plots, and self-explaining "
            "cells. Long stretches of unexplained code hurt this score."
        ),
        weight=15,
        point_budget=20,
        icon="🪞",
    ),
]


def total_weight() -> int:
    return sum(c.weight for c in HEALTH_CRITERIA)


def total_point_budget() -> int:
    return sum(c.point_budget for c in HEALTH_CRITERIA)


def by_id(criterion_id: str) -> HealthCriterion | None:
    for criterion in HEALTH_CRITERIA:
        if criterion.id == criterion_id:
            return criterion
    return None


__all__ = ["HealthCriterion", "HEALTH_CRITERIA", "total_weight", "total_point_budget", "by_id"]
