/**
 * Between-cell activity injector.
 *
 * A FlowQuest "quest cell" is a DOM element that looks and feels like a notebook
 * cell but is not part of the nbformat cell list. Each one is anchored to a real
 * cell by its stable nbformat cell id, so it survives cell insertions,
 * deletions, and moves.
 *
 * This class owns the generic plumbing — anchoring, attaching, persistence,
 * generate/answer/grade network calls — and delegates the actual rendering and
 * interaction to a :class:`CellModule` chosen by the slot's ``kind`` (see
 * ``cellModules/``). The backend analyzer decides which kind each injection
 * point offers (quiz, predict, teachback, …); generated content and progress
 * are persisted in ``notebook.metadata.flowquest.quizzes`` so they travel with
 * the .ipynb.
 */

import type { NotebookPanel } from '@jupyterlab/notebook';

import { apiRequest } from './api';
import { moduleFor } from './cellModules';
import type { CellModuleActions } from './cellModules';
import { activityIcon, icon as renderUiIcon } from './icons';
import { QuestMetadataStore } from './questStore';
import { toFriendlyError } from './uiFeedback';
import type {
  ActivityGradeResponse,
  AnalysisResponse,
  CellAnalysis,
  InjectionPoint,
  OpenContent,
  QuestState,
  QuizContent,
  QuizRecord
} from './types';

const HOST_CLASS = 'flowquest-questCell';

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
  hidden: boolean;
}

export class QuestCellRenderer {
  constructor(private callbacks: QuestCellRendererCallbacks) {
    this.actions = {
      generate: slotId => void this.generate(slotId),
      answerChoice: (slotId, idx) => void this.answerChoice(slotId, idx),
      submitOpen: (slotId, answer) => void this.submitOpen(slotId, answer),
      setHidden: (slotId, hidden) => this.setHidden(slotId, hidden),
      patchRecord: (slotId, patch) => this.patchRecord(slotId, patch)
    };
  }

  /** Re-render all virtual cells to reflect the latest analysis. */
  refresh(analysis: AnalysisResponse | null): void {
    if (!analysis) {
      this.detachAll();
      return;
    }

    const injectionPoints = analysis.injectionPoints ?? [];
    const desired = new Map<string, InjectionPoint>();
    injectionPoints.forEach(point => desired.set(point.slotId, point));

    Array.from(this.entries.keys()).forEach(slotId => {
      if (!desired.has(slotId)) {
        const entry = this.entries.get(slotId);
        entry?.host.remove();
        this.entries.delete(slotId);
      }
    });

    const storedQuizzes = this.callbacks.getStore().readQuizzes();
    desired.forEach((slot, slotId) => {
      let entry = this.entries.get(slotId);
      if (!entry) {
        const host = document.createElement('div');
        host.className = HOST_CLASS;
        host.dataset.slotId = slotId;
        // The host lives inside the notebook DOM, where JupyterLab intercepts
        // mouse + keyboard events to drive cell focus / command-mode shortcuts.
        // That preventDefault on mousedown stops our inputs from ever gaining
        // focus (so you can't type). Contain those events within the activity
        // cell so its form controls behave like normal HTML. Attached once on
        // the persistent host, so it survives re-renders.
        const contain = (event: Event) => event.stopPropagation();
        [
          'mousedown',
          'mouseup',
          'click',
          'dblclick',
          'keydown',
          'keyup',
          'keypress',
          'contextmenu',
          'focusin',
          'focusout'
        ].forEach(type => host.addEventListener(type, contain));
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

  detachAll(): void {
    this.entries.forEach(entry => entry.host.remove());
    this.entries.clear();
  }

  private findAnchor(slot: InjectionPoint, cells: CellAnalysis[]): HTMLElement | null {
    const panel = this.callbacks.getPanel();
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
    const fallback = cells.find(c => c.cellId === slot.anchorCellId);
    if (fallback && widgets[fallback.index]) {
      return widgets[fallback.index].node as HTMLElement;
    }
    return null;
  }

  private attachAfter(host: HTMLElement, anchor: HTMLElement): void {
    const parent = anchor.parentElement;
    if (!parent) {
      return;
    }
    const nextSibling = anchor.nextElementSibling;
    if (host.parentElement !== parent || host.previousElementSibling !== anchor) {
      if (nextSibling) {
        parent.insertBefore(host, nextSibling);
      } else {
        parent.appendChild(host);
      }
    }
  }

  /** Generate (or regenerate) the activity content for a slot. */
  private async generate(slotId: string): Promise<void> {
    const entry = this.entries.get(slotId);
    if (!entry) {
      return;
    }
    // Regenerating clears the prior record; un-hide either way.
    entry.record = null;
    entry.hidden = false;
    entry.loading = true;
    entry.error = null;
    this.renderSlot(entry, this.callbacks.getAnalysis()?.cells ?? []);

    try {
      const analysis = this.callbacks.getAnalysis();
      const generated = await apiRequest<QuizContent & OpenContent>(
        'piis-assistant/activity/generate',
        {
          method: 'POST',
          body: JSON.stringify({
            slot: entry.slot,
            kind: entry.slot.kind,
            cells: analysis?.cells ?? [],
            difficulty: this.callbacks.getState().difficulty
          })
        }
      );
      const isOpen = entry.slot.response === 'open';
      const record: QuizRecord = {
        slotId,
        anchorCellId: entry.slot.anchorCellId,
        region: entry.slot.region,
        activityKind: entry.slot.kind,
        quiz: isOpen
          ? { question: '', options: [], correctIndex: 0, explanation: '' }
          : {
              question: generated.question,
              options: generated.options,
              correctIndex: generated.correctIndex,
              explanation: generated.explanation,
              model: generated.model
            },
        open: isOpen
          ? {
              prompt: generated.prompt,
              rubric: generated.rubric ?? [],
              hint: generated.hint ?? '',
              model: generated.model
            }
          : undefined,
        openAnswer: '',
        openVerdict: null,
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

  /** Submit a multiple-choice answer (choice activities). */
  private async answerChoice(slotId: string, selectedIndex: number): Promise<void> {
    const entry = this.entries.get(slotId);
    if (!entry || !entry.record) {
      return;
    }
    const record = entry.record;
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
        outcome: { granted: boolean; xpAwarded?: number; category?: string };
        correct: boolean;
      }>('piis-assistant/activity/answer', {
        method: 'POST',
        body: JSON.stringify({
          state: this.callbacks.getState(),
          notebookPath: this.callbacks.getState().notebookPath,
          slotId,
          region: entry.slot.region,
          correct
        })
      });
      if (response.outcome.granted) {
        const awarded = response.outcome.xpAwarded ?? 0;
        record.awardedXp += awarded;
        this.callbacks.onXpGained(
          awarded,
          response.outcome.category ?? 'understanding',
          correct ? 'Quiz correct' : 'Quiz attempt'
        );
      }
      this.callbacks.applyState(response.state);
    } catch (error) {
      entry.error = toFriendlyError(error);
    }

    this.callbacks.getStore().writeQuiz(record);
    this.renderSlot(entry, this.callbacks.getAnalysis()?.cells ?? []);
  }

  /** Submit a free-text answer for LLM grading (open activities). */
  private async submitOpen(slotId: string, answer: string): Promise<void> {
    const entry = this.entries.get(slotId);
    if (!entry || !entry.record || !entry.record.open) {
      return;
    }
    const record = entry.record;
    if (record.openVerdict?.passed) {
      return;
    }
    const open = record.open;
    if (!open) {
      return;
    }
    record.openAnswer = answer;
    record.attempts += 1;
    entry.loading = true;
    this.renderSlot(entry, this.callbacks.getAnalysis()?.cells ?? []);

    const anchorCell = this.callbacks
      .getAnalysis()
      ?.cells.find(c => c.cellId === entry.slot.anchorCellId);

    try {
      const response = await apiRequest<ActivityGradeResponse>('piis-assistant/activity/grade', {
        method: 'POST',
        body: JSON.stringify({
          slotId,
          kind: entry.slot.kind,
          prompt: open.prompt,
          rubric: open.rubric,
          answer,
          cellSource: anchorCell?.sourcePreview ?? '',
          notebookPath: this.callbacks.getState().notebookPath,
          difficulty: this.callbacks.getState().difficulty
        })
      });
      record.openVerdict = response.verdict;
      record.answeredCorrectly = Boolean(response.verdict.passed);
      if (response.outcome.granted) {
        const awarded = response.outcome.xpAwarded ?? 0;
        record.awardedXp += awarded;
        this.callbacks.onXpGained(awarded, response.outcome.category ?? 'reflection', 'Teach-back');
      }
      this.callbacks.applyState(response.state);
    } catch (error) {
      entry.error = toFriendlyError(error);
    } finally {
      entry.loading = false;
      this.callbacks.getStore().writeQuiz(record);
      this.renderSlot(entry, this.callbacks.getAnalysis()?.cells ?? []);
    }
  }

  /** Update a record in place (e.g. open-answer draft) and persist it. */
  private patchRecord(slotId: string, patch: Partial<QuizRecord>): void {
    const entry = this.entries.get(slotId);
    if (!entry || !entry.record) {
      return;
    }
    entry.record = { ...entry.record, ...patch };
    this.callbacks.getStore().writeQuiz(entry.record);
    // No re-render: this is called from an input handler; re-rendering would
    // drop focus. The DOM already reflects the user's typing.
  }

  private setHidden(slotId: string, hidden: boolean): void {
    const entry = this.entries.get(slotId);
    if (!entry) {
      return;
    }
    entry.hidden = hidden;
    const stub: QuizRecord =
      entry.record ?? {
        slotId,
        anchorCellId: entry.slot.anchorCellId,
        region: entry.slot.region,
        activityKind: entry.slot.kind,
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

  private renderSlot(entry: SlotEntry, cells: CellAnalysis[]): void {
    if (entry.hidden) {
      this.renderStub(entry, cells);
      return;
    }
    const module = moduleFor(entry.slot.kind);
    module.render(
      {
        host: entry.host,
        slot: entry.slot,
        record: entry.record,
        cells,
        loading: entry.loading,
        error: entry.error,
        rerender: () => this.renderSlot(entry, this.callbacks.getAnalysis()?.cells ?? [])
      },
      this.actions
    );
  }

  private renderStub(entry: SlotEntry, cells: CellAnalysis[]): void {
    const slot = entry.slot;
    const record = entry.record;
    const anchorCell = cells.find(c => c.cellId === slot.anchorCellId);
    const anchorLabel = anchorCell ? `Cell ${anchorCell.index + 1}` : 'anchor cell';
    const solved = Boolean(record?.answeredCorrectly || record?.openVerdict?.passed);
    const labelGlyph = solved ? renderUiIcon('success') : activityIcon(slot.kind);
    const labelText = solved
      ? `${slot.kindLabel || 'Activity'} solved · hidden`
      : `${slot.kindLabel || 'Activity'} hidden`;
    entry.host.innerHTML = `
      <div class="flowquest-questCellStub">
        <span class="flowquest-questCellStubIcon">${labelGlyph}</span>
        <div class="flowquest-questCellStubBody">
          <div class="flowquest-questCellStubTitle">${escapeStub(labelText)}</div>
          <div class="flowquest-questCellStubMeta">${escapeStub(
            `${slot.region} checkpoint on ${anchorLabel}`
          )}</div>
        </div>
        <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="reveal">${renderUiIcon('reveal')} Show</button>
      </div>
    `;
    const reveal = entry.host.querySelector<HTMLButtonElement>('[data-action="reveal"]');
    if (reveal) {
      reveal.onclick = () => this.setHidden(slot.slotId, false);
    }
  }

  private entries = new Map<string, SlotEntry>();
  private actions: CellModuleActions;
}

function escapeStub(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
