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
  errorMessage: string | null;
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
        entry = {
          slot,
          host,
          loading: false,
          record: storedQuizzes[slotId] ?? null,
          errorMessage: null
        };
        this.entries.set(slotId, entry);
      } else {
        entry.slot = slot;
        if (!entry.record && storedQuizzes[slotId]) {
          entry.record = storedQuizzes[slotId];
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
    entry.errorMessage = null;
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
      entry.errorMessage = `Could not generate quiz: ${(error as Error).message}`;
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
      entry.errorMessage = `Could not record answer: ${(error as Error).message}`;
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
        <div class="flowquest-questCellBadge">
          <span class="flowquest-questCellBadgeIcon">${escapeHtml(
            KIND_ICON[slot.kind] ?? '✨'
          )}</span>
          <span class="flowquest-questCellBadgeLabel">FlowQuest · ${escapeHtml(slot.kind)}</span>
        </div>
        <div class="flowquest-questCellTitle">
          <span class="flowquest-questCellRegion">${escapeHtml(regionIcon)} ${escapeHtml(slot.region)}</span>
          <span class="flowquest-questCellAnchor">anchored to ${escapeHtml(anchorLabel)}</span>
        </div>
        <div class="flowquest-questCellStatus flowquest-questCellStatus-${escapeHtml(status)}">
          ${escapeHtml(renderStatusLabel(status, record))}
        </div>
      </div>
    `;

    let body = '';
    if (entry.loading && !record) {
      body = `<div class="flowquest-questCellLoading">Generating quiz…</div>`;
    } else if (entry.errorMessage) {
      body = `
        <div class="flowquest-questCellError">${escapeHtml(entry.errorMessage)}</div>
        <div class="flowquest-actionsRow">
          <button type="button" class="flowquest-btn flowquest-btn-primary" data-action="generate">Try again</button>
          <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="dismiss">Dismiss</button>
        </div>
      `;
    } else if (!record) {
      body = `
        <div class="flowquest-questCellIntro">
          <p>FlowQuest spotted a good <strong>${escapeHtml(
            slot.region
          )}</strong> checkpoint here. Generate a quiz about ${escapeHtml(
            slot.topic
          )} and earn <strong>+5 Notebook Health</strong> when you get it right.</p>
        </div>
        <div class="flowquest-actionsRow">
          <button type="button" class="flowquest-btn flowquest-btn-primary" data-action="generate" ${
            entry.loading ? 'disabled' : ''
          }>${entry.loading ? 'Generating…' : '🎯 Generate quiz'}</button>
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
               <strong>Correct.</strong> ${escapeHtml(quiz.explanation)}
             </div>`
          : `<div class="flowquest-quizFeedback is-wrong">
               <strong>Not quite.</strong> ${escapeHtml(
                 quiz.options[quiz.correctIndex] ?? ''
               )} is the right answer. ${escapeHtml(quiz.explanation)}
             </div>`
        : '';

      const xpLine = record.awardedXp
        ? `<div class="flowquest-quizXp">+${record.awardedXp} health earned</div>`
        : '';

      body = `
        <div class="flowquest-quizQuestion">${escapeHtml(quiz.question)}</div>
        <ul class="flowquest-quizOptions">${optionsHtml}</ul>
        ${feedback}
        ${xpLine}
        <div class="flowquest-actionsRow">
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
      <div class="flowquest-questCellInner">
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
          void this.generateQuiz(entry.slot.slotId);
          return;
        }
        if (action === 'dismiss') {
          entry.host.style.display = 'none';
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
