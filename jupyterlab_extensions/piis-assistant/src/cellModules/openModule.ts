/**
 * Open activities — free-text "teach it back" tasks.
 *
 * The LLM generates a short prompt + a hidden rubric. The learner explains the
 * cell in their own words; the answer is sent to the backend ``activity/grade``
 * route where the LLM judges it against the rubric and awards XP on a pass.
 */

import { escapeHtml } from '../api';
import type { ActivityKind, QuizRecord } from '../types';
import type {
  CellModule,
  CellModuleActions,
  CellModuleRenderArgs
} from './types';

export class OpenModule implements CellModule {
  readonly kind: ActivityKind = 'teachback';

  render(args: CellModuleRenderArgs, actions: CellModuleActions): void {
    const { host, slot, record, cells, loading, error } = args;
    const anchorCell = cells.find(c => c.cellId === slot.anchorCellId);
    const anchorLabel = anchorCell ? `Cell ${anchorCell.index + 1}` : 'anchor cell';
    const regionIcon = anchorCell?.regionIcon ?? '✨';

    const verdict = record?.openVerdict ?? null;
    const passed = Boolean(verdict?.passed);
    const status = !record ? 'empty' : passed ? 'solved' : record.attempts > 0 ? 'in-progress' : 'ready';

    const header = `
      <div class="flowquest-questCellHeader flowquest-questCellHeader-${escapeHtml(slot.region)}">
        <div class="flowquest-questCellHeaderTop">
          <span class="flowquest-questCellEyebrow">FlowQuest · teach it back</span>
          <span class="flowquest-questCellStatus flowquest-questCellStatus-${escapeHtml(status)}">
            ${escapeHtml(statusLabel(status, record))}
          </span>
        </div>
        <div class="flowquest-questCellHeaderMain">
          <span class="flowquest-questCellMark">${escapeHtml(slot.kindIcon || '🗣️')}</span>
          <div class="flowquest-questCellHeaderTitle">
            <div class="flowquest-questCellRegion">
              <span class="flowquest-questCellRegionIcon">${escapeHtml(regionIcon)}</span>
              <span>${escapeHtml(slot.kindLabel || 'Teach it back')}</span>
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
            <div class="flowquest-questCellLoadingTitle">Preparing a prompt…</div>
            <div class="flowquest-questCellLoadingHint">Reading <strong>${escapeHtml(anchorLabel)}</strong>.</div>
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
    } else if (!record || !record.open) {
      body = `
        <div class="flowquest-questCellIntro">
          <div class="flowquest-questCellIntroIcon">🗣️</div>
          <div class="flowquest-questCellIntroBody">
            <div class="flowquest-questCellIntroTitle">Explain it in your own words</div>
            <p>FlowQuest will ask you to teach back <strong>${escapeHtml(
              slot.topic
            )}</strong>. Your answer is graded by the assistant. <strong>+8 XP</strong> on a pass.</p>
          </div>
        </div>
        <div class="flowquest-actionsRow">
          <button type="button" class="flowquest-btn flowquest-btn-primary" data-action="generate" ${
            loading ? 'disabled' : ''
          }>${loading ? 'Preparing…' : '🗣️ Get my prompt'}</button>
          <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="dismiss">Skip</button>
        </div>
      `;
    } else {
      const open = record.open;
      const answer = record.openAnswer ?? '';
      const grading = args.loading && Boolean(record.open);
      const feedback = verdict
        ? `<div class="flowquest-quizFeedback ${passed ? 'is-correct' : 'is-wrong'}">
             <span class="flowquest-quizFeedbackIcon">${passed ? '✓' : '✗'}</span>
             <span><strong>${passed ? `Passed · ${verdict.score}/100.` : 'Not yet.'}</strong> ${escapeHtml(
               verdict.feedback
             )}</span>
           </div>`
        : '';
      const xpLine = record.awardedXp
        ? `<div class="flowquest-quizXp">+${record.awardedXp} XP earned</div>`
        : '';
      const hintLine =
        open.hint && !passed
          ? `<div class="flowquest-questCellHint">💡 ${escapeHtml(open.hint)}</div>`
          : '';

      body = `
        <div class="flowquest-quizQuestion">${escapeHtml(open.prompt)}</div>
        ${hintLine}
        <textarea class="flowquest-textarea" data-field="open" rows="3" ${
          passed ? 'disabled' : ''
        } placeholder="Explain in a sentence or two…">${escapeHtml(answer)}</textarea>
        ${feedback}
        ${xpLine}
        <div class="flowquest-actionsRow">
          ${
            passed
              ? '<button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="regenerate">↻ New prompt</button>'
              : `<button type="button" class="flowquest-btn flowquest-btn-primary" data-action="submit" ${
                  grading ? 'disabled' : ''
                }>${grading ? 'Grading…' : 'Submit answer'}</button>
                 <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="dismiss">Hide</button>`
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
    this.bind(host, slot.slotId, actions);
  }

  private bind(host: HTMLElement, slotId: string, actions: CellModuleActions): void {
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea[data-field="open"]');
    if (textarea) {
      textarea.oninput = () => {
        // Persist the draft so it survives a re-render, without grading.
        actions.patchRecord(slotId, { openAnswer: textarea.value });
      };
      // JupyterLab's notebook intercepts keystrokes for command-mode shortcuts
      // (a, b, dd, …) and calls preventDefault, which stops a plain injected
      // textarea from receiving input. Stop the events from reaching the
      // notebook handler so typing works normally inside the activity cell.
      const stop = (event: Event) => event.stopPropagation();
      textarea.addEventListener('keydown', stop);
      textarea.addEventListener('keypress', stop);
      textarea.addEventListener('keyup', stop);
      // Ctrl/Cmd+Enter submits; plain Enter inserts a newline (it's an essay).
      textarea.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          actions.submitOpen(slotId, textarea.value);
        }
      });
    }
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
        if (action === 'submit') {
          const value = textarea?.value ?? '';
          actions.submitOpen(slotId, value);
        }
      };
    });
  }
}

function statusLabel(status: string, record: QuizRecord | null): string {
  if (status === 'solved') {
    return '✅ passed';
  }
  if (status === 'in-progress' && record) {
    return `attempt ${record.attempts}`;
  }
  if (status === 'ready') {
    return '🗣️ ready';
  }
  return '🗺️ checkpoint';
}
