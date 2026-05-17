/**
 * Virtual FlowQuest cells injected between real notebook cells.
 *
 * A "quest cell" is a DOM element that looks and feels like a notebook cell
 * but is not part of the nbformat cell list. Each one is anchored to a real
 * cell by its stable nbformat cell id, so it survives cell insertions,
 * deletions, and moves.
 *
 * Currently one kind is supported: ``quiz``. The backend (analyzer.py) emits
 * injection points when it sees a run of load / clean / explore / visualize /
 * model cells; the frontend fetches a JSON multiple-choice quiz from
 * ``/piis-assistant/quiz/generate`` and renders it inline, below the anchor
 * cell's input area.
 *
 * Quiz progress (generated question, selected option, correctness, attempts)
 * is persisted in ``notebook.metadata.flowquest.quizzes`` by the
 * :class:`QuestMetadataStore`, so the quiz travels with the .ipynb file.
 */

import type { NotebookPanel } from '@jupyterlab/notebook';

import { apiRequest, escapeHtml } from './api';
import { QuestMetadataStore } from './questStore';
import { toFriendlyError } from './uiFeedback';
import type {
  AnalysisResponse,
  CellAnalysis,
  InjectionPoint,
  QuestState,
  QuizContent,
  QuizRecord
} from './types';

const HOST_CLASS = 'flowquest-questCell';
const KIND_ICON: Record<string, string> = {
  quiz: '🎯'
};

interface QuestCellRendererCallbacks {
  getAnalysis: () => AnalysisResponse | null;
  getState: () => QuestState;
  applyState: (state: QuestState) => void;
  onXpGained: (amount: number, category: string, source: string) => void;
  getPanel: () => NotebookPanel;
  getStore: () => QuestMetadataStore;
}

interface SlotEntry {
  slot: InjectionPoint;
  host: HTMLElement;
  loading: boolean;
  record: QuizRecord | null;
  error: { kind: string; message: string } | null;
  /** Dismissed by the user. Persisted into the QuizRecord (creates an
   * empty stub record if there isn't one yet). */
  hidden: boolean;
}

export class QuestCellRenderer {
  constructor(private callbacks: QuestCellRendererCallbacks) {}

  /** Re-render all virtual cells to reflect the latest analysis. */
  refresh(analysis: AnalysisResponse | null): void {
    if (!analysis) {
      this.detachAll();
      return;
    }

    const injectionPoints = analysis.injectionPoints ?? [];
    const desired = new Map<string, InjectionPoint>();
    injectionPoints.forEach(point => desired.set(point.slotId, point));

    // Remove stale entries
    Array.from(this.entries.keys()).forEach(slotId => {
      if (!desired.has(slotId)) {
        const entry = this.entries.get(slotId);
        entry?.host.remove();
        this.entries.delete(slotId);
      }
    });

    // Create or move entries
    const storedQuizzes = this.callbacks.getStore().readQuizzes();
    desired.forEach((slot, slotId) => {
      let entry = this.entries.get(slotId);
      if (!entry) {
        const host = document.createElement('div');
        host.className = HOST_CLASS;
        host.dataset.slotId = slotId;
        const stored = storedQuizzes[slotId] ?? null;
        entry = {
          slot,
          host,
          loading: false,
          record: stored,
          error: null,
          hidden: Boolean(stored?.hidden)
        };
        this.entries.set(slotId, entry);
      } else {
        entry.slot = slot;
        const stored = storedQuizzes[slotId];
        if (stored) {
          // Always sync hidden flag from disk so a saved/reloaded notebook honours it.
          entry.hidden = Boolean(stored.hidden);
          if (!entry.record) {
            entry.record = stored;
          }
        }
      }

      const anchor = this.findAnchor(slot, analysis.cells);
      if (anchor) {
        this.attachAfter(entry.host, anchor);
      } else {
        entry.host.remove();
      }
      this.renderSlot(entry, analysis.cells);
    });
  }

  /** Detach all virtual cells from the DOM (panel disposal, notebook close). */
  detachAll(): void {
    this.entries.forEach(entry => entry.host.remove());
    this.entries.clear();
  }

  private findAnchor(slot: InjectionPoint, cells: CellAnalysis[]): HTMLElement | null {
    const panel = this.callbacks.getPanel();
    // Prefer stable id.
    const widgets = panel.content.widgets;
    const model = panel.content.model;
    if (!model) {
      return null;
    }
    for (let i = 0; i < model.cells.length; i += 1) {
      const cellModel = model.cells.get(i);
      const id = (cellModel.sharedModel as unknown as { id?: string }).id;
      if (id === slot.anchorCellId && widgets[i]) {
        return widgets[i].node as HTMLElement;
      }
    }
    // Fall back to the analyzer's reported index.
    const fallback = cells.find(c => c.cellId === slot.anchorCellId);
    if (fallback && widgets[fallback.index]) {
      return widgets[fallback.index].node as HTMLElement;
    }
    return null;
  }

  private attachAfter(host: HTMLElement, anchor: HTMLElement): void {
    // Insert the quest cell as the next sibling of the anchor cell's DOM node.
    const parent = anchor.parentElement;
    if (!parent) {
      return;
    }
    const nextSibling = anchor.nextElementSibling;
    // Only move if it's not already in the right place to avoid flicker.
    if (host.parentElement !== parent || host.previousElementSibling !== anchor) {
      if (nextSibling) {
        parent.insertBefore(host, nextSibling);
      } else {
        parent.appendChild(host);
      }
    }
  }

  private async generateQuiz(slotId: string): Promise<void> {
    const entry = this.entries.get(slotId);
    if (!entry) {
      return;
    }
    entry.loading = true;
    entry.error = null;
    this.renderSlot(entry, this.callbacks.getAnalysis()?.cells ?? []);

    try {
      const analysis = this.callbacks.getAnalysis();
      const quiz = await apiRequest<QuizContent>('piis-assistant/quiz/generate', {
        method: 'POST',
        body: JSON.stringify({
          slot: entry.slot,
          cells: analysis?.cells ?? []
        })
      });
      const record: QuizRecord = {
        slotId,
        anchorCellId: entry.slot.anchorCellId,
        region: entry.slot.region,
        quiz,
        generatedAt: Date.now() / 1000,
        selectedIndex: null,
        answeredCorrectly: false,
        attempts: 0,
        awardedXp: 0
      };
      entry.record = record;
      this.callbacks.getStore().writeQuiz(record);
    } catch (error) {
      entry.error = toFriendlyError(error);
    } finally {
      entry.loading = false;
      this.renderSlot(entry, this.callbacks.getAnalysis()?.cells ?? []);
    }
  }

  private async submitAnswer(slotId: string, selectedIndex: number): Promise<void> {
    const entry = this.entries.get(slotId);
    if (!entry || !entry.record) {
      return;
    }
    const record = entry.record;
    // Ignore repeated selections after a correct answer.
    if (record.answeredCorrectly) {
      return;
    }

    const correct = selectedIndex === record.quiz.correctIndex;
    record.attempts += 1;
    record.selectedIndex = selectedIndex;
    record.answeredCorrectly = correct;

    try {
      const response = await apiRequest<{
        state: QuestState;
        outcome: { granted: boolean; pointsAwarded?: number };
        correct: boolean;
      }>('piis-assistant/quiz/answer', {
        method: 'POST',
        body: JSON.stringify({
          state: this.callbacks.getState(),
          slotId,
          region: entry.slot.region,
          correct
        })
      });
      if (response.outcome.granted) {
        const awarded = response.outcome.pointsAwarded ?? 0;
        record.awardedXp += awarded;
        this.callbacks.onXpGained(
          awarded,
          'understanding',
          correct ? 'Quiz correct' : 'Quiz attempt'
        );
      }
      this.callbacks.applyState(response.state);
    } catch (error) {
      entry.error = toFriendlyError(error);
    }

    // Persist the updated record so the answer survives reloads.
    this.callbacks.getStore().writeQuiz(record);
    this.renderSlot(entry, this.callbacks.getAnalysis()?.cells ?? []);
  }

  private renderSlot(entry: SlotEntry, cells: CellAnalysis[]): void {
    const slot = entry.slot;
    const record = entry.record;
    const anchorCell = cells.find(c => c.cellId === slot.anchorCellId);
    const anchorLabel = anchorCell ? `Cell ${anchorCell.index + 1}` : 'anchor cell';

    if (entry.hidden) {
      const solved = Boolean(record?.answeredCorrectly);
      const labelEmoji = solved ? '✅' : '🎯';
      const labelText = solved ? 'Quiz solved · hidden' : 'Quiz hidden';
      entry.host.innerHTML = `
        <div class="flowquest-questCellStub">
          <span class="flowquest-questCellStubIcon">${labelEmoji}</span>
          <div class="flowquest-questCellStubBody">
            <div class="flowquest-questCellStubTitle">${escapeHtml(labelText)}</div>
            <div class="flowquest-questCellStubMeta">${escapeHtml(
              `${slot.region} checkpoint on ${anchorLabel}`
            )}</div>
          </div>
          <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="reveal">↩️ Show</button>
        </div>
      `;
      this.bindActions(entry);
      return;
    }

    const regionIcon = anchorCell?.regionIcon ?? '✨';
    const status = record
      ? record.answeredCorrectly
        ? 'solved'
        : record.attempts > 0
          ? 'in-progress'
          : 'ready'
      : 'empty';
    const kindIcon = KIND_ICON[slot.kind] ?? '✨';

    const attemptsHtml = record
      ? `<span class="flowquest-questCellAttempts" title="Attempts">${
          record.attempts
            ? Array.from({ length: Math.min(record.attempts, 4) })
                .map(
                  (_, i) =>
                    `<span class="flowquest-questCellAttempt ${
                      record.answeredCorrectly && i === record.attempts - 1
                        ? 'is-correct'
                        : ''
                    }"></span>`
                )
                .join('')
            : ''
        }</span>`
      : '';

    const header = `
      <div class="flowquest-questCellHeader flowquest-questCellHeader-${escapeHtml(slot.region)}">
        <div class="flowquest-questCellHeaderTop">
          <span class="flowquest-questCellEyebrow">FlowQuest checkpoint</span>
          <span class="flowquest-questCellStatus flowquest-questCellStatus-${escapeHtml(status)}">
            ${escapeHtml(renderStatusLabel(status, record))}
          </span>
        </div>
        <div class="flowquest-questCellHeaderMain">
          <span class="flowquest-questCellMark">${escapeHtml(kindIcon)}</span>
          <div class="flowquest-questCellHeaderTitle">
            <div class="flowquest-questCellRegion">
              <span class="flowquest-questCellRegionIcon">${escapeHtml(regionIcon)}</span>
              <span>${escapeHtml(slot.region)}</span>
            </div>
            <div class="flowquest-questCellAnchor">on ${escapeHtml(anchorLabel)}</div>
          </div>
          ${attemptsHtml}
        </div>
      </div>
    `;

    let body = '';
    if (entry.loading && !record) {
      body = `
        <div class="flowquest-questCellLoadingPanel" role="status" aria-live="polite">
          <span class="flowquest-thinkingSpinner"></span>
          <div>
            <div class="flowquest-questCellLoadingTitle">Generating quiz…</div>
            <div class="flowquest-questCellLoadingHint">
              Reading <strong>${escapeHtml(anchorLabel)}</strong> and the cells around it.
            </div>
          </div>
        </div>
      `;
    } else if (entry.error) {
      const icon =
        entry.error.kind === 'timeout'
          ? '⏱️'
          : entry.error.kind === 'auth'
            ? '🔐'
            : '⚠️';
      body = `
        <div class="flowquest-inlineError">
          <div class="flowquest-inlineErrorHead">
            <span class="flowquest-inlineErrorIcon">${escapeHtml(icon)}</span>
            <span>${escapeHtml(entry.error.message)}</span>
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
          <div class="flowquest-questCellIntroIcon">🎯</div>
          <div class="flowquest-questCellIntroBody">
            <div class="flowquest-questCellIntroTitle">Test your understanding of this region</div>
            <p>One short multiple-choice question about <strong>${escapeHtml(
              slot.topic
            )}</strong>. <strong>+5 Notebook Health</strong> if you get it right.</p>
          </div>
        </div>
        <div class="flowquest-actionsRow">
          <button type="button" class="flowquest-btn flowquest-btn-primary" data-action="generate" ${
            entry.loading ? 'disabled' : ''
          }>${
            entry.loading
              ? `<span class="flowquest-spinnerInline"><span class="flowquest-spinnerDot"></span><span class="flowquest-spinnerDot"></span><span class="flowquest-spinnerDot"></span><span>Generating…</span></span>`
              : '🎯 Start the quiz'
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
              <button
                type="button"
                class="${optionClass}"
                data-action="answer"
                data-index="${idx}"
                ${locked ? 'disabled' : ''}
              >
                <span class="flowquest-quizOptionLetter">${String.fromCharCode(65 + idx)}</span>
                <span class="flowquest-quizOptionText">${escapeHtml(option)}</span>
              </button>
            </li>
          `;
        })
        .join('');

      const feedback = selected !== null
        ? record.answeredCorrectly
          ? `<div class="flowquest-quizFeedback is-correct">
               <span class="flowquest-quizFeedbackIcon">✓</span>
               <span><strong>Correct.</strong> ${escapeHtml(quiz.explanation)}</span>
             </div>`
          : `<div class="flowquest-quizFeedback is-wrong">
               <span class="flowquest-quizFeedbackIcon">✗</span>
               <span><strong>Not quite.</strong> ${escapeHtml(
                 quiz.options[quiz.correctIndex] ?? ''
               )} is the right answer. ${escapeHtml(quiz.explanation)}</span>
             </div>`
        : '';

      const xpLine = record.awardedXp
        ? `<div class="flowquest-quizXp">+${record.awardedXp} Notebook Health earned</div>`
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

    entry.host.innerHTML = `
      <div class="flowquest-questCellInner flowquest-questCellInner-${escapeHtml(slot.region)}">
        ${header}
        <div class="flowquest-questCellBody">${body}</div>
      </div>
    `;
    this.bindActions(entry);
  }

  private bindActions(entry: SlotEntry): void {
    entry.host.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
      button.onclick = () => {
        const action = button.dataset.action;
        if (action === 'generate' || action === 'regenerate') {
          if (action === 'regenerate') {
            entry.record = null;
          }
          // Re-showing through (re)generation also un-hides.
          entry.hidden = false;
          void this.generateQuiz(entry.slot.slotId);
          return;
        }
        if (action === 'dismiss') {
          this.setHidden(entry, true);
          return;
        }
        if (action === 'reveal') {
          this.setHidden(entry, false);
          return;
        }
        if (action === 'answer') {
          const idx = Number(button.dataset.index ?? '-1');
          if (idx >= 0) {
            void this.submitAnswer(entry.slot.slotId, idx);
          }
        }
      };
    });
  }

  /** Persist hidden flag and re-render. Creates a stub record if needed so
   * the flag is round-tripped through metadata.flowquest. */
  private setHidden(entry: SlotEntry, hidden: boolean): void {
    entry.hidden = hidden;
    const stub: QuizRecord =
      entry.record ?? {
        slotId: entry.slot.slotId,
        anchorCellId: entry.slot.anchorCellId,
        region: entry.slot.region,
        // Empty placeholder; we only persist hidden state in this case.
        quiz: { question: '', options: [], correctIndex: 0, explanation: '' },
        generatedAt: Date.now() / 1000,
        selectedIndex: null,
        answeredCorrectly: false,
        attempts: 0,
        awardedXp: 0
      };
    stub.hidden = hidden;
    entry.record = stub;
    this.callbacks.getStore().writeQuiz(stub);
    this.renderSlot(entry, this.callbacks.getAnalysis()?.cells ?? []);
  }

  private entries = new Map<string, SlotEntry>();
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
