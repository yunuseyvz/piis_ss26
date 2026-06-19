/**
 * React handbook modal for FlowQuest.
 *
 * Displays the static guide chapters with a table of contents and a replay tour
 * button.
 */

import { useState } from 'react';

import { Markdown } from './shared';
import { Icon } from './shared/Icon';
import type { IconName } from '../icons';

interface Chapter {
  id: string;
  title: string;
  icon: IconName;
  body: string;
}

const CHAPTERS: Chapter[] = [
  {
    id: 'overview',
    title: 'What is FlowQuest?',
    icon: 'handbook',
    body: `
# What is FlowQuest?

FlowQuest is a **gamified, context-aware companion for JupyterLab**. It reads the
notebook you're working in and turns the act of working through it — exploring,
understanding, stabilising, and reflecting — into a quest with **XP, levels,
ranks, missions, quizzes, and per-cell hints**.

It rewards *engagement and workflow understanding*, not final code correctness.
The goal is an assistant that helps you author and understand notebooks without
turning into a generic chatbot.

## The five surfaces

- **Sidebar** — three tabs: **Quest** (your progression, missions, next steps),
  **Flowy** (spontaneous quizzes on code you paste or focus), and **Chat** (a
  notebook-aware assistant).
- **In-notebook banner** — a heads-up display at the top of each notebook: level,
  XP bar, open-mission count, difficulty, and quick actions.
- **Per-cell chip** — a small pill on every cell showing its region, an issue
  dot, and a mission star. Click it to expand the inline panel.
- **Inline cell panel** — Explain / Reflect actions, detected issues,
  dependencies, and missions for that one cell.
- **Flowy avatar** — a floating companion that reacts to your progress and
  notices large pastes.
`
  },
  {
    id: 'xp',
    title: 'XP, levels & categories',
    icon: 'star',
    body: `
# XP, levels & categories

## XP and levels

You earn **XP** for engaging with your notebook. XP only ever grows — there is no
health score, no penalty, and no way to lose progress. Your **level** is derived
from your total XP, and each level carries a **rank title** (Notebook Novice →
Flow Seeker → … → FlowQuest Legend).

**XP is global.** It belongs to *you*, not to any single notebook, and
accumulates across every notebook you open. The XP bar and level in the header
reflect your whole journey.

## The four categories

Every XP award also lands in one of four buckets, shown as the donut chart in the
header:

- **Exploration** — discovering and reading your notebook.
- **Understanding** — proving you grasp what the code does.
- **Stabilization** — improving notebook structure and hygiene.
- **Reflection** — reasoning about your choices in your own words.

The categories are purely informational — they describe *how* you earned XP. Your
level depends only on the total.

## How you earn XP

- **Explain a cell** — +3 (first time per cell).
- **Reflect on a cell** — +6 for writing a short reflection.
- **Claim a mission** — the mission's XP, into the mission's category.
- **Answer a between-cell quiz / prediction** — +5 correct, +2 for an attempt.
- **Pass a teach-back** — +8 for explaining a cell in your own words.
- **Answer a Flowy paste-quiz** — +6 correct, +2 for an attempt.
- **Auto-checks** — small awards when a scan sees good structure (a chart, an
  evaluated model, no duplicate cells, narrative markdown, …).
`
  },
  {
    id: 'missions',
    title: 'Missions',
    icon: 'quest',
    body: `
# Missions

Missions are concrete, notebook-specific goals generated when FlowQuest scans
your notebook. Each one targets a real situation it found and awards XP when you
claim it.

Examples:

- **Fix the flow** — some cells ran out of order or weren't executed; restart and
  run top to bottom.
- **Cut the copies** — identical cells exist; consolidate them.
- **Revive the dead code** — variables are defined but never used.
- **See the shape of your data** — you have data but no visualization yet.
- **Put the model on trial** — a model is trained but never evaluated.
- **Explain the choice** — reflect on a decision in a key cell.

Find missions in the **Quest** tab and in the inline panel of any cell they
target (marked with a star icon on the cell chip). A mission is earnable **once per
notebook**, so the same mission in a different notebook is a fresh goal.
`
  },
  {
    id: 'regions',
    title: 'Cell regions & analysis',
    icon: 'region-explore',
    body: `
# Cell regions & analysis

Every time you edit, FlowQuest analyses the notebook **locally** (no LLM, no
network) and tags each cell with a **region** based on what its code does:

- **Setup** — imports, config, random seeds.
- **Load** — reading data (\`read_csv\`, \`load_dataset\`, …).
- **Clean** — filtering, transforming, scaling, train/test split.
- **Explore** — \`describe\`, \`head\`, \`value_counts\`, correlations.
- **Visualize** — plots and charts.
- **Model** — fitting, predicting, scoring.
- **Output** — printing results.
- **Narrative** — markdown cells.

## The chip badges

The inline panel shows facts derived by parsing your code:

- **exec #N** — the cell's execution count (or *not executed*).
- **defines / uses** — the names the cell creates and reads.
- **← cell N / → cell N** — the data-flow graph: which cells this one depends on,
  and which depend on it.

## Issues

The analyser flags things like cells run out of order, undefined references,
duplicate cells, unused variables, and disconnected cells. The coloured dot on a
cell's chip reflects the most severe issue on that cell. Issues drive both the
inline **Issues** list and which missions get generated.
`
  },
  {
    id: 'activities',
    title: 'Quizzes & activities',
    icon: 'understanding',
    body: `
# Quizzes & activities

Between regions of your notebook, FlowQuest inserts **virtual activity cells** —
they look like notebook cells but aren't part of your file. Each one is generated
by the assistant from the surrounding code, so it's always specific to what
you're working on.

Three kinds:

- **Understanding check** — a multiple-choice question about a cell.
- **Predict the result** — guess what a cell produces before running it.
- **Teach it back** — explain a cell in your own words; the assistant grades
  your answer against a short rubric.

Multiple-choice answers are graded instantly and locally. Teach-back answers are
graded by the assistant (with a lenient fallback if the model is unreachable).

## Flowy quizzes

**Flowy**, the floating avatar, watches for large pastes into cells. Paste a chunk
of code and tap Flowy — it'll generate a quick quiz to check you actually
understand what you dropped in. You can also trigger this from the **Flowy** tab's
"Quiz me on the active cell" button.
`
  },
  {
    id: 'chat',
    title: 'Chat & difficulty',
    icon: 'chat',
    body: `
# Chat & difficulty

## Notebook-aware chat

The **Chat** tab is a conversational assistant that automatically sees your whole
notebook — every cell, its outputs, and which cell is active. Ask it to explain
the cell you're on, suggest next steps, or find problems. Chat history is saved
**per notebook** and travels with the \`.ipynb\`.

## Difficulty

Each notebook has a **difficulty** (easy / medium / hard) set in
**Settings → This notebook**. It changes the *tone and depth* of every assistant
response — explanations, quiz wording, reflective questions, and grading
strictness — but it does **not** change how much XP anything is worth.

- **Easy** — beginner-friendly, gentle.
- **Medium** — practitioner depth, balanced.
- **Hard** — senior-reviewer mode, terse and strict.
`
  },
  {
    id: 'setup',
    title: 'Setup & data',
    icon: 'settings',
    body: `
# Setup & where your data lives

## Connecting a model

FlowQuest's generative features (chat, explanations, quizzes, reflections) need
an OpenAI-compatible LLM endpoint. Set your **model**, **base URL**, and
**API key** in **Settings → Global**. The structural features — regions, issues,
missions, XP, auto-checks — work fully **without** a model configured.

## Where things are stored

- **Progression** (XP, levels, award log) is **global**, saved on the server at
  \`~/.flowquest/progress.json\`. Resetting it lives in **Settings → Global**.
- **Settings** (model, base URL, API key) live at \`~/.flowquest/settings.json\`
  (the API key prefers your OS keychain when available).
- **Per-notebook data** — difficulty, generated quizzes, and chat history — lives
  inside the notebook's own metadata, so it travels with the \`.ipynb\`.

## Resetting

- **Settings → Global** → reset all XP & levels (global, irreversible).
- **Settings → This notebook** → clear this notebook's checkpoints so its
  missions, quizzes, and reflections can be re-earned. Your global XP stays.
`
  }
];

interface HandbookModalProps {
  isOpen: boolean;
  initialChapter?: string;
  onClose: () => void;
}

export function HandbookModal({
  isOpen,
  initialChapter,
  onClose
}: HandbookModalProps): JSX.Element | null {
  const [activeChapter, setActiveChapter] = useState(
    CHAPTERS.find(c => c.id === initialChapter)?.id ?? CHAPTERS[0].id
  );

  if (!isOpen) {
    return null;
  }

  const chapter = CHAPTERS.find(c => c.id === activeChapter) ?? CHAPTERS[0];

  return (
    <div className="flowquest-handbookHost">
      <div className="flowquest-settingsBackdrop" onClick={onClose} />
      <div className="flowquest-handbookModal flowquest" role="dialog" aria-modal="true" aria-label="FlowQuest handbook">
        <header className="flowquest-settingsHeader">
          <div className="flowquest-settingsHeading">
            <span className="flowquest-settingsIcon">
              <Icon name="handbook" size={20} />
            </span>
            <div>
              <div className="flowquest-cardTitle">FlowQuest Handbook</div>
              <div className="flowquest-dim">Everything FlowQuest is and does.</div>
            </div>
          </div>
          <div className="flowquest-handbookHeaderActions">
            <button type="button" className="flowquest-btn flowquest-btn-ghost" onClick={onClose}>
              <Icon name="close" /> Close
            </button>
          </div>
        </header>

        <div className="flowquest-handbookBody">
          <nav className="flowquest-handbookNav" role="tablist">
            {CHAPTERS.map(c => (
              <button
                key={c.id}
                type="button"
                className={`flowquest-handbookNavItem ${c.id === chapter.id ? 'is-active' : ''}`}
                onClick={() => {
                  setActiveChapter(c.id);
                }}
              >
                <span className="flowquest-handbookNavIcon">
                  <Icon name={c.icon} />
                </span>
                <span>{c.title}</span>
              </button>
            ))}
          </nav>
          <article className="flowquest-handbookContent flowquest-md">
            <Markdown source={chapter.body} />
          </article>
        </div>
      </div>
    </div>
  );
}
