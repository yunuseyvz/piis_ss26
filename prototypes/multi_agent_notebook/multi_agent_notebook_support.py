from __future__ import annotations

import json
from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

from prototypes.shared.hf_openai_client import HuggingFaceOpenAIClient


@dataclass
class AgentTurn:
    agent: str
    role: str
    focus: str
    observation: str
    evidence: str
    action: str
    urgency: int
    confidence: float

    def to_dict(self) -> dict[str, object]:
        row = asdict(self)
        row["priority_score"] = round(self.urgency * self.confidence, 2)
        return row


def make_customer_health_dataset(n_customers: int = 2200, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    analysis_date = pd.Timestamp("2026-01-01")

    signup_months = pd.date_range("2024-01-01", "2025-12-01", freq="MS")
    customers = pd.DataFrame(
        {
            "customer_id": np.arange(1000, 1000 + n_customers),
            "segment": rng.choice(
                ["SMB", "Mid-Market", "Enterprise"],
                size=n_customers,
                p=[0.55, 0.30, 0.15],
            ),
            "region": rng.choice(
                ["North America", "Europe", "APAC", "LATAM"],
                size=n_customers,
                p=[0.42, 0.28, 0.20, 0.10],
            ),
            "acquisition_channel": rng.choice(
                ["Organic", "Partner", "Paid Search", "Outbound", "Community"],
                size=n_customers,
                p=[0.18, 0.22, 0.24, 0.18, 0.18],
            ),
            "signup_date": pd.to_datetime(rng.choice(signup_months, size=n_customers)),
        }
    )

    customers["tenure_months"] = (
        (analysis_date.year - customers["signup_date"].dt.year) * 12
        + (analysis_date.month - customers["signup_date"].dt.month)
    ).clip(lower=1)

    segment_base_mrr = customers["segment"].map(
        {"SMB": 240, "Mid-Market": 960, "Enterprise": 2900}
    )
    segment_login_base = customers["segment"].map(
        {"SMB": 10, "Mid-Market": 18, "Enterprise": 25}
    )
    segment_adoption_base = customers["segment"].map(
        {"SMB": 0.42, "Mid-Market": 0.58, "Enterprise": 0.67}
    )
    segment_ticket_base = customers["segment"].map(
        {"SMB": 2.6, "Mid-Market": 2.1, "Enterprise": 1.8}
    )
    onboarding_base = customers["segment"].map(
        {"SMB": 4.0, "Mid-Market": 10.0, "Enterprise": 24.0}
    )

    customers["monthly_recurring_revenue"] = np.clip(
        rng.normal(segment_base_mrr, segment_base_mrr * 0.18),
        60,
        None,
    ).round(2)
    customers["product_logins_last_30"] = np.clip(
        rng.normal(
            segment_login_base
            + (customers["acquisition_channel"] == "Community") * 2.5,
            4.0,
        ),
        1,
        None,
    ).round().astype(int)
    customers["active_days_last_30"] = np.clip(
        customers["product_logins_last_30"] + rng.normal(4.0, 3.0, size=n_customers),
        1,
        30,
    ).round().astype(int)
    customers["feature_adoption_rate"] = np.clip(
        rng.normal(segment_adoption_base + customers["tenure_months"] * 0.01, 0.12),
        0.05,
        0.98,
    ).round(3)
    customers["support_tickets_last_90"] = rng.poisson(
        segment_ticket_base
        + (customers["feature_adoption_rate"] < 0.35) * 1.2
        + (customers["region"] == "LATAM") * 0.4
    ).astype(int)
    customers["nps_score"] = np.clip(
        rng.normal(
            35
            + 35 * customers["feature_adoption_rate"]
            - 2.5 * customers["support_tickets_last_90"],
            14,
        ),
        -40,
        90,
    ).round(0)
    customers["onboarding_hours"] = np.clip(
        rng.normal(onboarding_base, 3.0),
        1,
        None,
    ).round(1)
    customers["renewal_discount_pct"] = np.clip(
        rng.normal(
            np.where(customers["segment"].eq("Enterprise"), 9, 4)
            + np.where(customers["acquisition_channel"].eq("Paid Search"), 2, 0),
            3,
        ),
        0,
        25,
    ).round(1)
    customers["payment_failures_last_6m"] = rng.poisson(
        0.25
        + (customers["region"] == "LATAM") * 0.3
        + (customers["segment"] == "SMB") * 0.2
    ).astype(int)
    customers["usage_growth_pct"] = np.clip(
        rng.normal(
            6
            + 26 * customers["feature_adoption_rate"]
            - 1.5 * customers["support_tickets_last_90"],
            12,
        ),
        -40,
        55,
    ).round(1)
    customers["expansion_intent_score"] = np.clip(
        rng.normal(
            45
            + 30 * customers["feature_adoption_rate"]
            + 0.08 * customers["nps_score"]
            + 0.02 * customers["monthly_recurring_revenue"],
            11,
        ),
        5,
        99,
    ).round(1)

    risk_logit = (
        -0.9
        - 3.0 * customers["feature_adoption_rate"]
        - 0.07 * customers["active_days_last_30"]
        + 0.38 * customers["support_tickets_last_90"]
        - 0.025 * customers["nps_score"]
        + 0.55 * customers["payment_failures_last_6m"]
        - 0.03 * customers["usage_growth_pct"]
        - 0.025 * customers["expansion_intent_score"]
        + 0.12 * customers["renewal_discount_pct"]
        + np.where(customers["segment"].eq("SMB"), 0.55, 0)
        + np.where(customers["acquisition_channel"].eq("Paid Search"), 0.28, 0)
        + np.where(customers["region"].eq("LATAM"), 0.25, 0)
        + np.where(customers["tenure_months"] < 6, 0.55, 0)
    )
    churn_probability = 1 / (1 + np.exp(-risk_logit))
    customers["is_churned"] = rng.binomial(1, churn_probability)
    customers["cohort_month"] = customers["signup_date"].dt.to_period("M").dt.to_timestamp()

    nps_missing = rng.choice(customers.index, size=int(n_customers * 0.05), replace=False)
    growth_missing = rng.choice(
        customers.index,
        size=int(n_customers * 0.03),
        replace=False,
    )
    customers.loc[nps_missing, "nps_score"] = np.nan
    customers.loc[growth_missing, "usage_growth_pct"] = np.nan

    return customers.sort_values("signup_date").reset_index(drop=True)


def prepare_customer_health_data(
    n_customers: int = 2200,
    seed: int = 42,
) -> pd.DataFrame:
    customers = make_customer_health_dataset(n_customers=n_customers, seed=seed)
    customers["churn_label"] = customers["is_churned"].map(
        {0: "Retained", 1: "Churned"}
    )

    customers = customers.assign(
        health_score=(
            45 * customers["feature_adoption_rate"]
            + 1.2 * customers["active_days_last_30"]
            + 0.35
            * customers["nps_score"].fillna(customers["nps_score"].median())
            - 2.5 * customers["support_tickets_last_90"]
            - 6.0 * customers["payment_failures_last_6m"]
            + 0.25
            * customers["usage_growth_pct"].fillna(
                customers["usage_growth_pct"].median()
            )
        ).round(1),
        revenue_at_risk=np.where(
            customers["is_churned"].eq(1),
            customers["monthly_recurring_revenue"],
            0,
        ).round(2),
        mrr_bucket=pd.cut(
            customers["monthly_recurring_revenue"],
            bins=[0, 300, 1200, np.inf],
            labels=["Starter", "Growth", "Strategic"],
        ),
        cohort_quarter=customers["cohort_month"].dt.to_period("Q").astype(str),
    )
    customers["risk_band"] = pd.cut(
        customers["health_score"],
        bins=[-np.inf, 35, 55, np.inf],
        labels=["Critical", "Watch", "Healthy"],
    )
    return customers


def overview_table(customers: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "metric": [
                "Rows",
                "Churn rate",
                "Average MRR",
                "Revenue at risk",
                "Median health score",
                "Missing NPS share",
                "Missing usage growth share",
            ],
            "value": [
                f"{len(customers):,}",
                f"{customers['is_churned'].mean():.1%}",
                f"${customers['monthly_recurring_revenue'].mean():,.0f}",
                f"${customers['revenue_at_risk'].sum():,.0f}",
                f"{customers['health_score'].median():.1f}",
                f"{customers['nps_score'].isna().mean():.1%}",
                f"{customers['usage_growth_pct'].isna().mean():.1%}",
            ],
        }
    )


def notebook_fingerprint(customers: pd.DataFrame, seed: int) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "attribute": [
                "seed",
                "rows",
                "columns",
                "churn_rate",
                "revenue_at_risk",
                "avg_health_score",
            ],
            "value": [
                seed,
                len(customers),
                customers.shape[1],
                round(float(customers["is_churned"].mean()), 4),
                round(float(customers["revenue_at_risk"].sum()), 2),
                round(float(customers["health_score"].mean()), 2),
            ],
        }
    )


def build_agent_context(customers: pd.DataFrame, seed: int) -> dict[str, object]:
    segment_channel = (
        customers.groupby(["segment", "acquisition_channel"], as_index=False)
        .agg(
            customers=("customer_id", "count"),
            churn_rate=("is_churned", "mean"),
            avg_health_score=("health_score", "mean"),
            revenue_at_risk=("revenue_at_risk", "sum"),
        )
        .sort_values(["revenue_at_risk", "churn_rate"], ascending=False)
        .reset_index(drop=True)
    )
    segment_region = (
        customers.groupby(["segment", "region"], as_index=False)
        .agg(
            customers=("customer_id", "count"),
            churn_rate=("is_churned", "mean"),
            revenue_at_risk=("revenue_at_risk", "sum"),
        )
        .sort_values("customers")
        .reset_index(drop=True)
    )
    cohort_summary = (
        customers.groupby(["cohort_quarter", "segment"], as_index=False)
        .agg(
            customers=("customer_id", "count"),
            churn_rate=("is_churned", "mean"),
            avg_health_score=("health_score", "mean"),
        )
        .sort_values(["churn_rate", "customers"], ascending=False)
        .reset_index(drop=True)
    )

    overall_metrics = {
        "rows": len(customers),
        "churn_rate": float(customers["is_churned"].mean()),
        "revenue_at_risk": float(customers["revenue_at_risk"].sum()),
        "missing_nps_share": float(customers["nps_score"].isna().mean()),
        "missing_growth_share": float(customers["usage_growth_pct"].isna().mean()),
    }

    return {
        "seed": seed,
        "overall_metrics": overall_metrics,
        "top_segment_channel": segment_channel.iloc[0].to_dict(),
        "smallest_segment_region": segment_region.iloc[0].to_dict(),
        "weakest_cohort": cohort_summary.iloc[0].to_dict(),
        "segment_channel": segment_channel,
        "segment_region": segment_region,
        "cohort_summary": cohort_summary,
    }


class NotebookAgent:
    agent: str = "Agent"
    role: str = "General notebook collaborator"


class AnalystAgent(NotebookAgent):
    agent = "Analyst"
    role = "Propose the most valuable next analytical slice"


class CriticAgent(NotebookAgent):
    agent = "Critic"
    role = "Challenge overconfident claims and request robustness checks"


class ReproducerAgent(NotebookAgent):
    agent = "Reproducer"
    role = "Audit reproducibility, execution order, and notebook hygiene"


class WriterAgent(NotebookAgent):
    agent = "Writer"
    role = "Maintain the narrative layer and draft notebook prose"


class ReviewerAgent(NotebookAgent):
    agent = "Reviewer"
    role = "Prioritize the next notebook edits across agents"


class MultiAgentNotebookPrototype:
    def __init__(
        self,
        client: HuggingFaceOpenAIClient,
    ) -> None:
        if client is None:
            raise ValueError("A live Hugging Face OpenAI-compatible client is required for the multi-agent prototype.")
        self.agents: list[NotebookAgent] = [
            AnalystAgent(),
            CriticAgent(),
            ReproducerAgent(),
            WriterAgent(),
            ReviewerAgent(),
        ]
        self.client = client
        self.active_mode = "live_ai"

    def _coerce_turn(
        self,
        payload: dict[str, object],
        agent: NotebookAgent,
    ) -> AgentTurn:
        urgency_value = payload["urgency"]
        confidence_value = payload["confidence"]
        try:
            urgency = int(urgency_value)
        except (TypeError, ValueError):
            raise ValueError(f"Invalid urgency value: {urgency_value}")
        try:
            confidence = float(confidence_value)
        except (TypeError, ValueError):
            raise ValueError(f"Invalid confidence value: {confidence_value}")
        return AgentTurn(
            agent=agent.agent,
            role=agent.role,
            focus=str(payload["focus"]),
            observation=str(payload["observation"]),
            evidence=str(payload["evidence"]),
            action=str(payload["action"]),
            urgency=max(1, min(5, urgency)),
            confidence=max(0.0, min(1.0, confidence)),
        )

    def _ai_turn(
        self,
        agent: NotebookAgent,
        context: dict[str, object],
        previous_turns: list[AgentTurn],
    ) -> AgentTurn:
        previous_rows = [turn.to_dict() for turn in previous_turns]
        prompt_payload = {
            "agent": agent.agent,
            "role": agent.role,
            "context": context,
            "previous_turns": previous_rows,
        }
        system_prompt = (
            "You are one role in a multi-agent notebook council. "
            "Ground every response in the supplied context and return only a JSON object with keys focus, observation, evidence, action, urgency, confidence. "
            "Keep urgency between 1 and 5 and confidence between 0 and 1. "
            "This prototype depends on a live model endpoint, so keep the framing fully model-driven and avoid describing any alternate execution path."
        )
        user_prompt = (
            "Produce the response for this notebook agent. Do not invent metrics outside the payload.\n\n"
            + json.dumps(prompt_payload, indent=2, default=str)
        )
        payload = self.client.chat_json(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=0.35,
            max_tokens=800,
        )
        return self._coerce_turn(payload, agent)

    def run(
        self,
        customers: pd.DataFrame,
        seed: int,
    ) -> tuple[list[AgentTurn], dict[str, object]]:
        context = build_agent_context(customers, seed=seed)
        turns: list[AgentTurn] = []
        for agent in self.agents:
            turns.append(self._ai_turn(agent, context, turns))
        self.active_mode = "live_ai"
        context["run_mode"] = self.active_mode
        return turns, context


def turns_to_frame(turns: list[AgentTurn]) -> pd.DataFrame:
    rows = []
    for step, turn in enumerate(turns, start=1):
        row = turn.to_dict()
        row["step"] = step
        rows.append(row)
    columns = [
        "step",
        "agent",
        "role",
        "focus",
        "observation",
        "evidence",
        "action",
        "urgency",
        "confidence",
        "priority_score",
    ]
    return pd.DataFrame(rows)[columns]


def priority_board(turns: list[AgentTurn]) -> pd.DataFrame:
    board = turns_to_frame(turns)[
        ["agent", "focus", "action", "urgency", "confidence", "priority_score"]
    ].copy()
    board["urgency_label"] = board["urgency"].map(
        {5: "Critical", 4: "High", 3: "Medium", 2: "Low", 1: "Backlog"}
    )
    return board.sort_values("priority_score", ascending=False).reset_index(drop=True)


def planned_notebook_cells(turns: list[AgentTurn]) -> pd.DataFrame:
    board = priority_board(turns)
    return pd.DataFrame(
        {
            "cell_title": [
                "Intervention analysis for high-risk slice",
                "Robustness and missing-data appendix",
                "Reproducibility fingerprint cell",
                "Narrative checkpoint note",
            ],
            "owner_agent": ["Analyst", "Critic", "Reproducer", "Writer"],
            "goal": [
                board.loc[board["agent"].eq("Analyst"), "action"].iloc[0],
                board.loc[board["agent"].eq("Critic"), "action"].iloc[0],
                board.loc[board["agent"].eq("Reproducer"), "action"].iloc[0],
                board.loc[board["agent"].eq("Writer"), "action"].iloc[0],
            ],
            "priority_score": [
                board.loc[board["agent"].eq("Analyst"), "priority_score"].iloc[0],
                board.loc[board["agent"].eq("Critic"), "priority_score"].iloc[0],
                board.loc[board["agent"].eq("Reproducer"), "priority_score"].iloc[0],
                board.loc[board["agent"].eq("Writer"), "priority_score"].iloc[0],
            ],
        }
    ).sort_values("priority_score", ascending=False).reset_index(drop=True)


def writer_note(turns: list[AgentTurn]) -> str:
    writer_turn = next(turn for turn in turns if turn.agent == "Writer")
    return writer_turn.action