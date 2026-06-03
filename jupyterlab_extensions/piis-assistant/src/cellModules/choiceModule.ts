/**
 * Choice activities — multiple-choice between-cell tasks.
 *
 * Handles two LLM-generated kinds that share the same MCQ shape:
 *   - ``quiz``    — "do you understand this cell?"
 *   - ``predict`` — "what will this cell produce when it runs?"
 *
 * The content is a generated question + four options; grading is exact
 * (compare the selected index with ``correctIndex``) and XP is awarded by the
 * backend ``activity/answer`` route.
 */

import { escapeHtml } from '../api';
import type { ActivityKind, QuizRecord } from '../types';
import type {
  CellModule,
  CellModuleActions,
  CellModuleRenderArgs
} from './types';

const COPY: Record<
  ActivityKind,
  { eyebrow: string; introTitle: string; introBody: (topic: string) => string; cta: string }
> = {
  quiz: {
    eyebrow: 'FlowQuest · understanding check',
    introTitle: 'Test your understanding of this region',
    introBody: topic =>
      `One short multiple-choice question about <strong>${escapeHtml(topic)}</strong>. <strong>+5 XP</strong> if you get it right.`,
    cta: '🎯 Start the quiz'
  },
  predict: {
    eyebrow: 'FlowQuest · predict the result',
    introTitle: 'Predict what this cell produces',
    introBody: topic =>
      `Before you run it — what will happen? One multiple-choice prediction about <strong>${escapeHtml(topic)}</strong>. <strong>+5 XP</strong> if you call it right.`,
    cta: '🔮 Make a prediction'
  },
  // teachback is handled by the open module; present only for type completeness.
  teachback: {
    eyebrow: 'FlowQuest · checkpoint',
    introTitle: 'Checkpoint',
    introBody: () => 'Answer to earn XP.',
    cta: 'Start'
  }
};

export class ChoiceModule implements CellModule {
  constructor(public readonly kind: ActivityKind) {}

  render(args: CellModuleRenderArgs, actions: CellModuleActions): void {
    const { host, slot, record, cells, loading, error } = args;
    const copy = COPY[this.kind] ?? COPY.quiz;
    const anchorCell = cells.find(c => c.cellId === slot.anchorCellId);
    const anchorLabel = anchorCell ? `Cell ${anchorCell.index + 1}` : 'anchor cell';
    const regionIcon = anchorCell?.regionIcon ?? '✨';

    const status = record
      ? record.answeredCorrectly
        ? 'solved'
        : record.attempts > 0
          ? 'in-progress'
          : 'ready'
      : 'empty';

    const header = `
      <div class="flowquest-questCellHeader flowquest-questCellHeader-${escapeHtml(slot.region)}">
        <div class="flowquest-questCellHeaderTop">
          <span class="flowquest-questCellEyebrow">${escapeHtml(copy.eyebrow)}</span>
          <span class="flowquest-questCellStatus flowquest-questCellStatus-${escapeHtml(status)}">
            ${escapeHtml(renderStatusLabel(status, record))}
          </span>
        </div>
        <div class="flowquest-questCellHeaderMain">
          <span class="flowquest-questCellMark">${escapeHtml(slot.kindIcon || '🎯')}</span>
          <div class="flowquest-questCellHeaderTitle">
            <div class="flowquest-questCellRegion">
              <span class="flowquest-questCellRegionIcon">${escapeHtml(regionIcon)}</span>
              <span>${escapeHtml(slot.kindLabel || slot.region)}</span>
            </div>
            <div class="flowquest-questCellAnchor">on ${escapeHtml(anchorLabel)}</div>
          </div>
        </div>
      </div>
    `;

    let body = '';
    if (loading && !record) {
      body = `
        <div class="flowquest-questCellLoadingPanel" role="status" aria-live="polite">
          <span class="flowquest-thinkingSpinner"></span>
          <div>
            <div class="flowquest-questCellLoadingTitle">Generating activity…</div>
            <div class="flowquest-questCellLoadingHint">
              Reading <strong>${escapeHtml(anchorLabel)}</strong> and the cells around it.
            </div>
          </div>
        </div>
      `;
    } else if (error) {
      const icon = error.kind === 'timeout' ? '⏱️' : error.kind === 'auth' ? '🔐' : '⚠️';
      body = `
        <div class="flowquest-inlineError">
          <div class="flowquest-inlineErrorHead">
            <span class="flowquest-inlineErrorIcon">${escapeHtml(icon)}</span>
            <span>${escapeHtml(error.message)}</span>
          </div>
          <div class="flowquest-actionsRow">
            <button type="button" class="flowquest-btn flowquest-btn-primary" data-action="generate">↻ Retry</button>
            <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="dismiss">Dismiss</button>
          </div>
        </div>
      `;
    } else if (!record) {
      body = `
        <div class="flowquest-questCellIntro">
          <div class="flowquest-questCellIntroIcon">${escapeHtml(slot.kindIcon || '🎯')}</div>
          <div class="flowquest-questCellIntroBody">
            <div class="flowquest-questCellIntroTitle">${escapeHtml(copy.introTitle)}</div>
            <p>${copy.introBody(slot.topic)}</p>
          </div>
        </div>
        <div class="flowquest-actionsRow">
          <button type="button" class="flowquest-btn flowquest-btn-primary" data-action="generate" ${
            loading ? 'disabled' : ''
          }>${
            loading
              ? `<span class="flowquest-spinnerInline"><span class="flowquest-spinnerDot"></span><span class="flowquest-spinnerDot"></span><span class="flowquest-spinnerDot"></span><span>Generating…</span></span>`
              : escapeHtml(copy.cta)
          }</button>
          <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="dismiss">Skip</button>
        </div>
      `;
    } else {
      const quiz = record.quiz;
      const selected = record.selectedIndex;
      const locked = record.answeredCorrectly;
      const optionsHtml = quiz.options
        .map((option, idx) => {
          let optionClass = 'flowquest-quizOption';
          if (selected === idx) {
            optionClass += idx === quiz.correctIndex ? ' is-correct' : ' is-wrong';
          } else if (locked && idx === quiz.correctIndex) {
            optionClass += ' is-correct';
          }
          return `
            <li>
              <button type="button" class="${optionClass}" data-action="answer" data-index="${idx}" ${
                locked ? 'disabled' : ''
              }>
                <span class="flowquest-quizOptionLetter">${String.fromCharCode(65 + idx)}</span>
                <span class="flowquest-quizOptionText">${escapeHtml(option)}</span>
              </button>
            </li>
          `;
        })
        .join('');

      const feedback =
        selected !== null
          ? record.answeredCorrectly
            ? `<div class="flowquest-quizFeedback is-correct"><span class="flowquest-quizFeedbackIcon">✓</span><span><strong>Correct.</strong> ${escapeHtml(
                quiz.explanation
              )}</span></div>`
            : `<div class="flowquest-quizFeedback is-wrong"><span class="flowquest-quizFeedbackIcon">✗</span><span><strong>Not quite.</strong> ${escapeHtml(
                quiz.options[quiz.correctIndex] ?? ''
              )} is the right answer. ${escapeHtml(quiz.explanation)}</span></div>`
          : '';

      const xpLine = record.awardedXp
        ? `<div class="flowquest-quizXp">+${record.awardedXp} XP earned</div>`
        : '';

      body = `
        <div class="flowquest-quizQuestion">${escapeHtml(quiz.question)}</div>
        <ul class="flowquest-quizOptions">${optionsHtml}</ul>
        ${feedback}
        ${xpLine}
        <div class="flowquest-actionsRow flowquest-actionsRow-quiz">
          <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="regenerate">↻ New question</button>
          ${
            !locked
              ? '<button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="dismiss">Hide</button>'
              : ''
          }
        </div>
      `;
    }

    host.innerHTML = `
      <div class="flowquest-questCellInner flowquest-questCellInner-${escapeHtml(slot.region)}">
        ${header}
        <div class="flowquest-questCellBody">${body}</div>
      </div>
    `;
    bindChoiceActions(host, slot.slotId, actions);
  }
}

function bindChoiceActions(
  host: HTMLElement,
  slotId: string,
  actions: CellModuleActions
): void {
  host.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
    button.onclick = () => {
      const action = button.dataset.action;
      if (action === 'generate' || action === 'regenerate') {
        actions.generate(slotId);
        return;
      }
      if (action === 'dismiss') {
        actions.setHidden(slotId, true);
        return;
      }
      if (action === 'answer') {
        const idx = Number(button.dataset.index ?? '-1');
        if (idx >= 0) {
          actions.answerChoice(slotId, idx);
        }
      }
    };
  });
}

function renderStatusLabel(status: string, record: QuizRecord | null): string {
  if (status === 'solved') {
    return '✅ solved';
  }
  if (status === 'in-progress' && record) {
    return `attempt ${record.attempts}`;
  }
  if (status === 'ready') {
    return '🎯 ready';
  }
  return '🗺️ checkpoint';
}
