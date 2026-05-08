from __future__ import annotations

import difflib
import re
from typing import Any
from dataclasses import asdict, dataclass, fields

import numpy as np
import pandas as pd

from prototypes.shared.hf_openai_client import HuggingFaceOpenAIClient


DISPLAY_NAMES = {
    "feature_adoption_rate": "feature adoption rate",
    "health_score": "health score",
    "payment_failures_last_6m": "payment failures",
    "usage_growth_pct": "usage growth",
    "nps_score": "NPS score",
    "monthly_recurring_revenue": "monthly recurring revenue",
    "active_days_last_30": "active days",
}

DISPLAY_TO_COLUMN = {value: key for key, value in DISPLAY_NAMES.items()}
SEGMENTS = ["SMB", "Mid-Market", "Enterprise"]
CHANNELS = ["Organic", "Partner", "Paid Search", "Outbound", "Community"]
GROUP_OPTIONS = ["region", "segment", "acquisition_channel", "risk_band"]
SCHEMA_COLUMNS = [
    "customer_id",
    "segment",
    "region",
    "acquisition_channel",
    "signup_date",
    "tenure_months",
    "monthly_recurring_revenue",
    "product_logins_last_30",
    "active_days_last_30",
    "feature_adoption_rate",
    "support_tickets_last_90",
    "nps_score",
    "payment_failures_last_6m",
    "usage_growth_pct",
    "is_churned",
    "churn_label",
    "health_score",
    "risk_band",
]


@dataclass
class AnalysisSpec:
    segment: str = "SMB"
    acquisition_channel: str = "Paid Search"
    churn_only: bool = True
    drop_missing_nps: bool = True
    drop_missing_growth: bool = False
    zscore_columns: tuple[str, ...] = ("feature_adoption_rate", "health_score")
    group_by: str = "region"
    summary_columns: tuple[str, ...] = (
        "health_score",
        "feature_adoption_rate",
        "payment_failures_last_6m",
    )
    sort_by: str = "health_score"
    sort_ascending: bool = True

    def to_metadata(self) -> str:
        parts = []
        for field in fields(self):
            value = getattr(self, field.name)
            if isinstance(value, tuple):
                parts.append(f"{field.name}={','.join(value)}")
            else:
                parts.append(f"{field.name}={value}")
        return "; ".join(parts)

    def labels(self) -> dict[str, str]:
        return {
            column: DISPLAY_NAMES.get(column, column.replace("_", " "))
            for column in set(self.summary_columns) | set(self.zscore_columns)
        }


@dataclass
class DriftReport:
    status: str
    score: float
    matched_claims: list[str]
    stale_narrative_claims: list[str]
    stale_code_operations: list[str]
    explanation: str

    def to_rows(self) -> list[dict[str, object]]:
        return [
            {"field": "status", "value": self.status},
            {"field": "score", "value": round(self.score, 2)},
            {"field": "matched_claims", "value": "; ".join(self.matched_claims) or "none"},
            {"field": "stale_narrative_claims", "value": "; ".join(self.stale_narrative_claims) or "none"},
            {"field": "stale_code_operations", "value": "; ".join(self.stale_code_operations) or "none"},
            {"field": "explanation", "value": self.explanation},
        ]


def make_customer_health_dataset(n_customers: int = 2200, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    analysis_date = pd.Timestamp("2026-01-01")

    signup_months = pd.date_range("2024-01-01", "2025-12-01", freq="MS")
    customers = pd.DataFrame(
        {
            "customer_id": np.arange(1000, 1000 + n_customers),
            "segment": rng.choice(["SMB", "Mid-Market", "Enterprise"], size=n_customers, p=[0.55, 0.30, 0.15]),
            "region": rng.choice(["North America", "Europe", "APAC", "LATAM"], size=n_customers, p=[0.42, 0.28, 0.20, 0.10]),
            "acquisition_channel": rng.choice(["Organic", "Partner", "Paid Search", "Outbound", "Community"], size=n_customers, p=[0.18, 0.22, 0.24, 0.18, 0.18]),
            "signup_date": pd.to_datetime(rng.choice(signup_months, size=n_customers)),
        }
    )

    customers["tenure_months"] = (
        (analysis_date.year - customers["signup_date"].dt.year) * 12
        + (analysis_date.month - customers["signup_date"].dt.month)
    ).clip(lower=1)

    segment_base_mrr = customers["segment"].map({"SMB": 240, "Mid-Market": 960, "Enterprise": 2900})
    segment_login_base = customers["segment"].map({"SMB": 10, "Mid-Market": 18, "Enterprise": 25})
    segment_adoption_base = customers["segment"].map({"SMB": 0.42, "Mid-Market": 0.58, "Enterprise": 0.67})
    segment_ticket_base = customers["segment"].map({"SMB": 2.6, "Mid-Market": 2.1, "Enterprise": 1.8})

    customers["monthly_recurring_revenue"] = np.clip(rng.normal(segment_base_mrr, segment_base_mrr * 0.18), 60, None).round(2)
    customers["product_logins_last_30"] = np.clip(rng.normal(segment_login_base, 4.0), 1, None).round().astype(int)
    customers["active_days_last_30"] = np.clip(customers["product_logins_last_30"] + rng.normal(4.0, 3.0, size=n_customers), 1, 30).round().astype(int)
    customers["feature_adoption_rate"] = np.clip(rng.normal(segment_adoption_base + customers["tenure_months"] * 0.01, 0.12), 0.05, 0.98).round(3)
    customers["support_tickets_last_90"] = rng.poisson(segment_ticket_base + (customers["feature_adoption_rate"] < 0.35) * 1.2).astype(int)
    customers["nps_score"] = np.clip(rng.normal(35 + 35 * customers["feature_adoption_rate"] - 2.5 * customers["support_tickets_last_90"], 14), -40, 90).round(0)
    customers["payment_failures_last_6m"] = rng.poisson(0.25 + (customers["segment"] == "SMB") * 0.2).astype(int)
    customers["usage_growth_pct"] = np.clip(rng.normal(6 + 26 * customers["feature_adoption_rate"] - 1.5 * customers["support_tickets_last_90"], 12), -40, 55).round(1)

    risk_logit = (
        -0.9
        - 3.0 * customers["feature_adoption_rate"]
        - 0.07 * customers["active_days_last_30"]
        + 0.38 * customers["support_tickets_last_90"]
        - 0.025 * customers["nps_score"]
        + 0.55 * customers["payment_failures_last_6m"]
        - 0.03 * customers["usage_growth_pct"]
        + np.where(customers["segment"].eq("SMB"), 0.55, 0)
        + np.where(customers["acquisition_channel"].eq("Paid Search"), 0.28, 0)
    )
    churn_probability = 1 / (1 + np.exp(-risk_logit))
    customers["is_churned"] = rng.binomial(1, churn_probability)
    customers["churn_label"] = customers["is_churned"].map({0: "Retained", 1: "Churned"})

    nps_missing = rng.choice(customers.index, size=int(n_customers * 0.05), replace=False)
    growth_missing = rng.choice(customers.index, size=int(n_customers * 0.03), replace=False)
    customers.loc[nps_missing, "nps_score"] = np.nan
    customers.loc[growth_missing, "usage_growth_pct"] = np.nan

    customers["health_score"] = (
        45 * customers["feature_adoption_rate"]
        + 1.2 * customers["active_days_last_30"]
        + 0.35 * customers["nps_score"].fillna(customers["nps_score"].median())
        - 2.5 * customers["support_tickets_last_90"]
        - 6.0 * customers["payment_failures_last_6m"]
        + 0.25 * customers["usage_growth_pct"].fillna(customers["usage_growth_pct"].median())
    ).round(1)
    customers["risk_band"] = pd.cut(
        customers["health_score"],
        bins=[-np.inf, 35, 55, np.inf],
        labels=["Critical", "Watch", "Healthy"],
    )
    return customers


def default_spec() -> AnalysisSpec:
    return AnalysisSpec()


def _human_list(items: tuple[str, ...] | list[str]) -> str:
    values = [DISPLAY_NAMES.get(item, item.replace("_", " ")) for item in items]
    if not values:
        return "no columns"
    if len(values) == 1:
        return values[0]
    return ", ".join(values[:-1]) + f", and {values[-1]}"


def render_markdown_from_spec(spec: AnalysisSpec) -> str:
    missing_parts = []
    if spec.drop_missing_nps:
        missing_parts.append("NPS score")
    if spec.drop_missing_growth:
        missing_parts.append("usage growth")
    missing_clause = "We keep all rows."
    if missing_parts:
        missing_clause = f"We drop rows missing {_human_list(tuple(m.replace(' ', '_').lower() for m in missing_parts)).replace('_', ' ')} before comparison."
        missing_clause = missing_clause.replace("nps score", "NPS score")

    churn_clause = "churned" if spec.churn_only else "all"
    group_label = spec.group_by.replace("_", " ")
    return (
        f"We focus on {churn_clause} {spec.segment} customers acquired through {spec.acquisition_channel}. "
        f"{missing_clause} "
        f"We z-score {_human_list(spec.zscore_columns)}. "
        f"Finally, we compare the average {_human_list(spec.summary_columns)} by {group_label} and sort the summary by {DISPLAY_NAMES.get(spec.sort_by, spec.sort_by.replace('_', ' '))}."
    )


def render_code_from_spec(spec: AnalysisSpec) -> str:
    metadata = spec.to_metadata()
    drop_missing = []
    if spec.drop_missing_nps:
        drop_missing.append("nps_score")
    if spec.drop_missing_growth:
        drop_missing.append("usage_growth_pct")

    lines = [
        f"# sync-spec: {metadata}",
        "analysis_df = customers.copy()",
        f"analysis_df = analysis_df.loc[analysis_df['segment'].eq('{spec.segment}')]",
        f"analysis_df = analysis_df.loc[analysis_df['acquisition_channel'].eq('{spec.acquisition_channel}')]",
    ]
    if spec.churn_only:
        lines.append("analysis_df = analysis_df.loc[analysis_df['is_churned'].eq(1)]")
    if drop_missing:
        lines.append(f"analysis_df = analysis_df.dropna(subset={drop_missing!r})")
    if spec.zscore_columns:
        lines.extend(
            [
                f"for column in {list(spec.zscore_columns)!r}:",
                "    centered = analysis_df[column] - analysis_df[column].mean()",
                "    scaled = analysis_df[column].std(ddof=0)",
                "    analysis_df[f'{column}_z'] = centered / scaled if scaled else 0.0",
            ]
        )

    agg_lines = ["summary = analysis_df.groupby(%r, as_index=False).agg(" % spec.group_by, "    customers=('customer_id', 'count'),"]
    for column in spec.summary_columns:
        agg_lines.append(f"    {column}=('{column}', 'mean'),")
    for column in spec.zscore_columns:
        agg_lines.append(f"    {column}_z=('{column}_z', 'mean'),")
    agg_lines.extend(
        [
            ")",
            f"summary = summary.sort_values('{spec.sort_by}', ascending={spec.sort_ascending})",
            "summary",
        ]
    )
    lines.extend(agg_lines)
    return "\n".join(lines)


def _parse_tuple(raw_value: str) -> tuple[str, ...]:
    if not raw_value:
        return tuple()
    return tuple(item for item in raw_value.split(",") if item)


def extract_spec_from_code(code: str) -> AnalysisSpec:
    match = re.search(r"^# sync-spec:\s*(.+)$", code, re.MULTILINE)
    if not match:
        return default_spec()

    parsed: dict[str, object] = {}
    for part in match.group(1).split(";"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key in {"churn_only", "drop_missing_nps", "drop_missing_growth", "sort_ascending"}:
            parsed[key] = value.lower() == "true"
        elif key in {"zscore_columns", "summary_columns"}:
            parsed[key] = _parse_tuple(value)
        else:
            parsed[key] = value

    baseline = default_spec()
    for field in fields(AnalysisSpec):
        if field.name not in parsed:
            parsed[field.name] = getattr(baseline, field.name)
    return AnalysisSpec(**parsed)


def extract_spec_from_markdown(markdown: str) -> AnalysisSpec:
    baseline = default_spec()
    lowered = markdown.lower()

    segment = next((value for value in SEGMENTS if value.lower() in lowered), baseline.segment)
    channel = next((value for value in CHANNELS if value.lower() in lowered), baseline.acquisition_channel)
    churn_only = "churned" in lowered or "lost customers" in lowered
    drop_missing_nps = "missing nps" in lowered or "missing nps score" in lowered
    drop_missing_growth = "missing usage growth" in lowered or "missing growth" in lowered or "missing usage_growth_pct" in lowered

    zscore_columns = []
    if any(token in lowered for token in ["z-score", "z score", "standardize", "normalize"]):
        for label, column in DISPLAY_TO_COLUMN.items():
            if label in lowered or column in lowered:
                zscore_columns.append(column)
    if not zscore_columns:
        zscore_columns = list(baseline.zscore_columns)

    summary_columns = []
    for label, column in DISPLAY_TO_COLUMN.items():
        if label in lowered or column in lowered:
            summary_columns.append(column)
    if not summary_columns:
        summary_columns = list(baseline.summary_columns)

    group_by = baseline.group_by
    for option in GROUP_OPTIONS:
        option_label = option.replace("_", " ")
        if f"by {option_label}" in lowered or f"across {option_label}" in lowered:
            group_by = option
            break

    sort_by = baseline.sort_by
    for label, column in DISPLAY_TO_COLUMN.items():
        if f"sort the summary by {label}" in lowered or f"rank the summary by {label}" in lowered:
            sort_by = column
            break

    return AnalysisSpec(
        segment=segment,
        acquisition_channel=channel,
        churn_only=churn_only,
        drop_missing_nps=drop_missing_nps,
        drop_missing_growth=drop_missing_growth,
        zscore_columns=tuple(dict.fromkeys(zscore_columns)),
        group_by=group_by,
        summary_columns=tuple(dict.fromkeys(summary_columns)),
        sort_by=sort_by,
        sort_ascending=baseline.sort_ascending,
    )


def _spec_claims(spec: AnalysisSpec) -> set[str]:
    claims = {
        f"segment:{spec.segment}",
        f"channel:{spec.acquisition_channel}",
        f"churn_only:{spec.churn_only}",
        f"drop_missing_nps:{spec.drop_missing_nps}",
        f"drop_missing_growth:{spec.drop_missing_growth}",
        f"group_by:{spec.group_by}",
        f"sort_by:{spec.sort_by}",
    }
    claims.update(f"zscore:{column}" for column in spec.zscore_columns)
    claims.update(f"summary:{column}" for column in spec.summary_columns)
    return claims


def compute_drift_report(markdown: str, code: str) -> DriftReport:
    markdown_spec = extract_spec_from_markdown(markdown)
    code_spec = extract_spec_from_code(code)
    narrative_claims = _spec_claims(markdown_spec)
    code_claims = _spec_claims(code_spec)

    matched = sorted(narrative_claims & code_claims)
    stale_narrative = sorted(narrative_claims - code_claims)
    stale_code = sorted(code_claims - narrative_claims)

    denominator = max(len(narrative_claims | code_claims), 1)
    score = len(matched) / denominator
    if score >= 0.9:
        status = "aligned"
        explanation = "Narrative and code describe the same slice and transformations."
    elif score >= 0.65:
        status = "watch"
        explanation = "The notebook section is partially aligned, but some claims have drifted."
    else:
        status = "drifted"
        explanation = "The prose and code now describe materially different operations."

    return DriftReport(
        status=status,
        score=score,
        matched_claims=matched,
        stale_narrative_claims=stale_narrative,
        stale_code_operations=stale_code,
        explanation=explanation,
    )


def unified_diff(old_text: str, new_text: str, from_name: str, to_name: str) -> str:
    diff = difflib.unified_diff(
        old_text.splitlines(),
        new_text.splitlines(),
        fromfile=from_name,
        tofile=to_name,
        lineterm="",
    )
    return "\n".join(diff)


def execute_analysis_code(customers: pd.DataFrame, code: str) -> pd.DataFrame:
    namespace: dict[str, object] = {
        "customers": customers.copy(),
        "np": np,
        "pd": pd,
    }
    exec(code, namespace, namespace)
    summary = namespace.get("summary")
    if not isinstance(summary, pd.DataFrame):
        raise ValueError("Expected the rendered code to define a pandas DataFrame named 'summary'.")
    return summary.round(3)


def _strip_code_fences(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z0-9_+-]*\n", "", cleaned)
        cleaned = re.sub(r"\n```$", "", cleaned)
    return cleaned.strip()


def _schema_prompt() -> str:
    display_map = ", ".join(f"{label} -> {column}" for column, label in DISPLAY_NAMES.items())
    columns = ", ".join(SCHEMA_COLUMNS)
    return (
        f"Use exact dataframe column names only. Available columns: {columns}. "
        f"Human-readable labels map to exact columns as follows: {display_map}. "
        "Do not invent shortened aliases or friendly replacements like usage_growth or payment_failures."
    )


def ai_prose_to_code(
    markdown: str,
    current_code: str,
    client: HuggingFaceOpenAIClient,
) -> dict[str, str]:
    system_prompt = (
        "You are updating a Jupyter notebook code cell so it matches the notebook narrative. "
        "Return only Python code with no markdown fences and keep the overall coding style compact. "
        + _schema_prompt()
    )
    user_prompt = (
        "Update the following code so it matches the revised notebook narrative. "
        "Keep the code executable as-is and continue defining a DataFrame named summary.\n\n"
        f"Narrative:\n{markdown}\n\nCurrent code:\n{current_code}"
    )
    updated_code = _strip_code_fences(client.chat(system_prompt, user_prompt))
    return {
        "mode": "ai",
        "updated_code": updated_code,
        "diff": unified_diff(current_code, updated_code, "current_code.py", "ai_suggested_code.py"),
        "summary": "Generated a code update from the Hugging Face OpenAI-compatible endpoint.",
    }


def ai_repair_code(
    markdown: str,
    current_code: str,
    invalid_code: str,
    error_message: str,
    client: HuggingFaceOpenAIClient,
) -> dict[str, str]:
    system_prompt = (
        "You are repairing a Jupyter notebook code cell after execution failed. "
        "Return only fixed Python code with no markdown fences. "
        + _schema_prompt()
    )
    user_prompt = (
        "The following AI-generated code failed when executed against the notebook dataframe. "
        "Repair it so it matches the narrative, uses exact schema names, and still defines a DataFrame named summary.\n\n"
        f"Narrative:\n{markdown}\n\nCurrent baseline code:\n{current_code}\n\nInvalid AI code:\n{invalid_code}\n\nExecution error:\n{error_message}"
    )
    repaired_code = _strip_code_fences(client.chat(system_prompt, user_prompt, temperature=0.1, max_tokens=1000))
    return {
        "mode": "ai-repair",
        "updated_code": repaired_code,
        "diff": unified_diff(current_code, repaired_code, "current_code.py", "ai_repaired_code.py"),
        "summary": "Repaired a failed AI-generated code suggestion using a second model pass.",
    }


def ai_code_to_prose(
    current_markdown: str,
    code: str,
    client: HuggingFaceOpenAIClient,
) -> dict[str, str]:
    system_prompt = (
        "You are updating notebook narrative so it matches a Python analysis cell. "
        "Return only the revised notebook prose as a single paragraph with no markdown heading."
    )
    user_prompt = (
        "Rewrite the following notebook prose so it matches the updated code while preserving a concise analytical voice.\n\n"
        f"Current prose:\n{current_markdown}\n\nUpdated code:\n{code}"
    )
    updated_markdown = client.chat(system_prompt, user_prompt)
    return {
        "mode": "ai",
        "updated_markdown": updated_markdown,
        "diff": unified_diff(current_markdown, updated_markdown, "current_markdown.md", "ai_suggested_markdown.md"),
        "summary": "Generated a narrative rewrite from the Hugging Face OpenAI-compatible endpoint.",
    }


def _validate_generated_code(code: str) -> None:
    compile(code, "<generated_sync_code>", "exec")
    if "summary" not in code:
        raise ValueError("Generated code must define a DataFrame named 'summary'.")


def _coerce_status(value: str) -> str:
    allowed = {"aligned", "watch", "drifted"}
    if value not in allowed:
        raise ValueError(f"Unsupported drift status: {value}")
    return value


def _coerce_string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    if value in (None, ""):
        return []
    return [str(value)]


def ai_drift_report(
    markdown: str,
    code: str,
    client: HuggingFaceOpenAIClient,
) -> DriftReport:
    system_prompt = (
        "You are checking whether a notebook markdown explanation and a Python analysis cell still match. "
        "Return only a JSON object with keys: status, score, matched_claims, stale_narrative_claims, stale_code_operations, explanation. "
        "Use status values aligned, watch, or drifted. Score must be a float between 0 and 1."
    )
    user_prompt = (
        "Compare the following notebook prose and code. Be conservative and ground every claim in the actual text.\n\n"
        f"Markdown:\n{markdown}\n\nCode:\n{code}"
    )
    payload = client.chat_json(system_prompt, user_prompt, temperature=0.1, max_tokens=700)
    return DriftReport(
        status=_coerce_status(str(payload["status"])),
        score=max(0.0, min(1.0, float(payload["score"]))),
        matched_claims=_coerce_string_list(payload.get("matched_claims")),
        stale_narrative_claims=_coerce_string_list(payload.get("stale_narrative_claims")),
        stale_code_operations=_coerce_string_list(payload.get("stale_code_operations")),
        explanation=str(payload["explanation"]),
    )


def assess_drift(
    markdown: str,
    code: str,
    client: HuggingFaceOpenAIClient,
) -> DriftReport:
    return ai_drift_report(markdown, code, client)


def suggest_prose_to_code(
    markdown: str,
    current_code: str,
    customers: pd.DataFrame,
    client: HuggingFaceOpenAIClient,
) -> dict[str, str]:
    suggestion = ai_prose_to_code(markdown, current_code, client)
    try:
        _validate_generated_code(suggestion["updated_code"])
        execute_analysis_code(customers, suggestion["updated_code"])
        return suggestion
    except Exception as exc:
        repaired = ai_repair_code(
            markdown=markdown,
            current_code=current_code,
            invalid_code=suggestion["updated_code"],
            error_message=str(exc),
            client=client,
        )
        _validate_generated_code(repaired["updated_code"])
        execute_analysis_code(customers, repaired["updated_code"])
        return repaired


def suggest_code_to_prose(
    current_markdown: str,
    code: str,
    client: HuggingFaceOpenAIClient,
) -> dict[str, str]:
    suggestion = ai_code_to_prose(current_markdown, code, client)
    if not suggestion["updated_markdown"].strip():
        raise ValueError("AI returned empty markdown.")
    return suggestion


def example_markdown_edit() -> str:
    return (
        "We focus on churned Mid-Market customers acquired through Partner. "
        "We drop rows missing NPS score and missing usage growth before comparison. "
        "We z-score feature adoption rate, health score, and usage growth. "
        "Finally, we compare the average health score, usage growth, and payment failures by region and sort the summary by usage growth."
    )


def example_code_edit() -> str:
    spec = AnalysisSpec(
        segment="Enterprise",
        acquisition_channel="Partner",
        churn_only=True,
        drop_missing_nps=True,
        drop_missing_growth=False,
        zscore_columns=("feature_adoption_rate", "health_score", "payment_failures_last_6m"),
        group_by="acquisition_channel",
        summary_columns=("health_score", "feature_adoption_rate", "payment_failures_last_6m", "monthly_recurring_revenue"),
        sort_by="monthly_recurring_revenue",
        sort_ascending=False,
    )
    return render_code_from_spec(spec)


def drift_rows(markdown: str, code: str) -> list[dict[str, object]]:
    return compute_drift_report(markdown, code).to_rows()


def spec_rows(spec: AnalysisSpec) -> list[dict[str, object]]:
    return [{"field": key, "value": value} for key, value in asdict(spec).items()]