from __future__ import annotations

import html
from typing import Iterable

import pandas as pd
from IPython.display import HTML


def inject_theme() -> HTML:
    return HTML(
        """
<style>
  .lp-shell {
    font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
    color: #10213a;
  }
  .lp-hero {
    position: relative;
    overflow: hidden;
    padding: 28px 32px;
    border-radius: 24px;
    color: #f7fbff;
    background: linear-gradient(135deg, #133c55 0%, #386fa4 45%, #59a5d8 100%);
    box-shadow: 0 24px 60px rgba(19, 60, 85, 0.28);
    margin: 8px 0 22px 0;
  }
  .lp-hero::after {
    content: "";
    position: absolute;
    inset: auto -40px -60px auto;
    width: 220px;
    height: 220px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.16);
    filter: blur(0px);
  }
  .lp-title {
    font-family: "Iowan Old Style", "Georgia", serif;
    font-size: 2rem;
    font-weight: 700;
    margin: 0 0 8px 0;
    line-height: 1.1;
  }
  .lp-subtitle {
    max-width: 880px;
    margin: 0;
    font-size: 1rem;
    line-height: 1.6;
    color: rgba(247, 251, 255, 0.92);
  }
  .lp-pills {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 16px;
  }
  .lp-pill {
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.18);
    border: 1px solid rgba(255, 255, 255, 0.2);
    padding: 6px 12px;
    font-size: 0.84rem;
    letter-spacing: 0.01em;
  }
  .lp-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 14px;
    margin: 14px 0 24px 0;
  }
  .lp-card {
    border-radius: 18px;
    padding: 16px 18px;
    background: linear-gradient(180deg, #ffffff 0%, #f4f9ff 100%);
    border: 1px solid rgba(56, 111, 164, 0.12);
    box-shadow: 0 14px 30px rgba(25, 66, 109, 0.08);
  }
  .lp-card-title {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #5b6f86;
    margin-bottom: 8px;
  }
  .lp-card-value {
    font-size: 1.35rem;
    font-weight: 700;
    line-height: 1.2;
    color: #10213a;
  }
  .lp-card-note {
    font-size: 0.9rem;
    line-height: 1.5;
    color: #41576f;
    margin-top: 8px;
  }
  .lp-section {
    border-radius: 20px;
    padding: 18px 20px;
    background: #fbfdff;
    border: 1px solid rgba(56, 111, 164, 0.15);
    box-shadow: 0 10px 28px rgba(25, 66, 109, 0.06);
    margin: 12px 0 20px 0;
  }
  .lp-section h3 {
    margin: 0 0 8px 0;
    font-size: 1.05rem;
    color: #16324f;
  }
  .lp-section p {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.6;
    color: #41576f;
  }
  .lp-section.info {
    background: linear-gradient(180deg, #f7fbff 0%, #eef6ff 100%);
  }
  .lp-section.warn {
    background: linear-gradient(180deg, #fffaf2 0%, #fff2da 100%);
  }
  .lp-pre {
    margin-top: 12px;
    white-space: pre-wrap;
    font-family: "JetBrains Mono", "SFMono-Regular", monospace;
    font-size: 0.84rem;
    line-height: 1.6;
    padding: 16px 18px;
    border-radius: 18px;
    background: #0f1b2d;
    color: #e8f1ff;
    overflow-x: auto;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06);
  }
  .lp-agent-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 14px;
    margin: 16px 0 22px 0;
  }
  .lp-agent-card {
    border-radius: 18px;
    padding: 16px 18px;
    background: linear-gradient(180deg, #ffffff 0%, #f7fbff 100%);
    border: 1px solid rgba(56, 111, 164, 0.14);
    box-shadow: 0 14px 32px rgba(25, 66, 109, 0.07);
  }
  .lp-agent-name {
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: #5b6f86;
    margin-bottom: 6px;
  }
  .lp-agent-focus {
    font-size: 1.02rem;
    font-weight: 700;
    color: #16324f;
    margin-bottom: 8px;
  }
  .lp-agent-copy {
    font-size: 0.92rem;
    line-height: 1.55;
    color: #41576f;
  }
  .lp-badge {
    display: inline-block;
    margin-top: 12px;
    border-radius: 999px;
    padding: 6px 10px;
    background: #e8f3ff;
    color: #174a76;
    font-size: 0.8rem;
    font-weight: 600;
  }
</style>
        """
    )


def hero(title: str, subtitle: str, pills: Iterable[str] | None = None) -> HTML:
    pill_html = ""
    if pills:
        pill_html = "<div class='lp-pills'>" + "".join(
            f"<span class='lp-pill'>{html.escape(pill)}</span>" for pill in pills
        ) + "</div>"
    return HTML(
        f"""
<div class="lp-shell">
  <section class="lp-hero">
    <div class="lp-title">{html.escape(title)}</div>
    <p class="lp-subtitle">{html.escape(subtitle)}</p>
    {pill_html}
  </section>
</div>
        """
    )


def metric_cards(items: Iterable[dict[str, object]]) -> HTML:
    cards = []
    for item in items:
        cards.append(
            f"""
            <article class="lp-card">
              <div class="lp-card-title">{html.escape(str(item.get('title', 'Metric')))}</div>
              <div class="lp-card-value">{html.escape(str(item.get('value', '')))}</div>
              <div class="lp-card-note">{html.escape(str(item.get('note', '')))}</div>
            </article>
            """
        )
    return HTML(f"<div class='lp-shell'><section class='lp-grid'>{''.join(cards)}</section></div>")


def callout(title: str, body: str, tone: str = "info") -> HTML:
    tone_class = "warn" if tone == "warn" else "info"
    return HTML(
        f"""
<div class="lp-shell">
  <section class="lp-section {tone_class}">
    <h3>{html.escape(title)}</h3>
    <p>{html.escape(body)}</p>
  </section>
</div>
        """
    )


def code_panel(title: str, body: str) -> HTML:
    return HTML(
        f"""
<div class="lp-shell">
  <section class="lp-section info">
    <h3>{html.escape(title)}</h3>
    <pre class="lp-pre">{html.escape(body)}</pre>
  </section>
</div>
        """
    )


def agent_cards(frame: pd.DataFrame) -> HTML:
    cards = []
    for _, row in frame.iterrows():
        cards.append(
            f"""
            <article class="lp-agent-card">
              <div class="lp-agent-name">{html.escape(str(row.get('agent', 'Agent')))}</div>
              <div class="lp-agent-focus">{html.escape(str(row.get('focus', '')))}</div>
              <div class="lp-agent-copy"><strong>Observation:</strong> {html.escape(str(row.get('observation', '')))}</div>
              <div class="lp-agent-copy" style="margin-top:8px;"><strong>Action:</strong> {html.escape(str(row.get('action', '')))}</div>
              <span class="lp-badge">Priority {html.escape(str(row.get('priority_score', '')))}</span>
            </article>
            """
        )
    return HTML(f"<div class='lp-shell'><section class='lp-agent-grid'>{''.join(cards)}</section></div>")