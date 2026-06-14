/**
 * Between-cell activity injector (React version).
 *
 * Anchors virtual activity cells to real notebook cells by stable cell id and
 * renders each slot with the appropriate React activity component.
 */

import { createRoot, type Root } from 'react-dom/client';
import type { NotebookPanel } from '@jupyterlab/notebook';

import { ChoiceActivity } from './components/ChoiceActivity';
import { OpenActivity } from './components/OpenActivity';
import { activityIcon, icon } from './icons';
import { QuestMetadataStore } from './questStore';
import { FlowQuestStore } from './state';
import { toFriendlyError } from './uiFeedback';
import type {
  ActivityKind,
  AnalysisResponse,
  CellAnalysis,
  InjectionPoint,
  QuizRecord
} from './types';

const HOST_CLASS = 'flowquest-questCell';

interface QuestCellRendererCallbacks {
  store: FlowQuestStore;
  notebookPath: string;
  onXpGained: (amount: number, category: string, source: string) => void;
  getPanel: () => NotebookPanel;
  getStore: () => QuestMetadataStore;
  isConfigured: () => boolean;
}

interface SlotEntry {
  slot: InjectionPoint;
  host: HTMLElement;
  root: Root;
  loading: boolean;
  record: QuizRecord | null;
  error: { kind: string; message: string } | null;
  hidden: boolean;
}

export class QuestCellRenderer {
  private entries = new Map<string, SlotEntry>();
  private unsubscribe: (() => void) | null = null;
  private lastAnalysis: AnalysisResponse | null = null;

  constructor(private callbacks: QuestCellRendererCallbacks) {
    // Subscribe to the notebook's slice so injection points appear as soon as
    // the analysis completes (and disappear when the analysis is cleared).
    this.unsubscribe = this.callbacks.store.subscribeNotebook(
      this.callbacks.notebookPath,
      () => {
        const slice = this.callbacks.store.getNotebookSlice(this.callbacks.notebookPath);
        if (slice.analysis !== this.lastAnalysis) {
          this.lastAnalysis = slice.analysis;
          this.refresh(slice.analysis);
        }
      }
    );
    // If the analysis is already in the store (e.g. from a prior scan), pick
    // it up immediately instead of waiting for the next mutation.
    const initial = this.callbacks.store.getNotebookSlice(this.callbacks.notebookPath);
    if (initial.analysis) {
      this.lastAnalysis = initial.analysis;
      this.refresh(initial.analysis);
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.detachAll();
  }

  private currentAnalysis(): AnalysisResponse | null {
    return this.lastAnalysis;
  }

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
        entry?.root.unmount();
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
          root: createRoot(host),
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
    this.entries.forEach(entry => {
      entry.root.unmount();
      entry.host.remove();
    });
    this.entries.clear();
  }

  private findAnchor(slot: InjectionPoint, cells: CellAnalysis[]): HTMLElement | null {
    const panel = this.callbacks.getPanel();
    const widgets = panel.content.widgets;
    const model = panel.content.model;
    if (!model) return null;

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
    if (!parent) return;
    const nextSibling = anchor.nextElementSibling;
    if (host.parentElement !== parent || host.previousElementSibling !== anchor) {
      if (nextSibling) {
        parent.insertBefore(host, nextSibling);
      } else {
        parent.appendChild(host);
      }
    }
  }

  private async generate(slotId: string): Promise<void> {
    const entry = this.entries.get(slotId);
    if (!entry) return;

    if (!this.callbacks.isConfigured()) {
      entry.error = {
        kind: 'auth',
        message: 'No model configured. Open Settings to set up an endpoint.'
      };
      entry.loading = false;
      this.renderSlot(entry, this.currentAnalysis()?.cells ?? []);
      return;
    }

    entry.record = null;
    entry.hidden = false;
    entry.loading = true;
    entry.error = null;
    this.renderSlot(entry, this.currentAnalysis()?.cells ?? []);

    try {
      const analysis = this.currentAnalysis();
      const generated = await this.callbacks.store.generateActivity({
        slot: entry.slot,
        kind: entry.slot.kind,
        cells: analysis?.cells ?? []
      });
      const isOpen = entry.slot.response === 'open';
      const record: QuizRecord = {
        slotId,
        anchorCellId: entry.slot.anchorCellId,
        region: entry.slot.region,
        activityKind: entry.slot.kind,
        quiz: isOpen
          ? { question: '', options: [], correctIndex: 0, explanation: '' }
          : {
              question: generated.question ?? 'What does this cell do?',
              options: generated.options ?? [],
              correctIndex: generated.correctIndex ?? 0,
              explanation: generated.explanation ?? '',
              model: generated.model
            },
        open: isOpen
          ? {
              prompt: generated.prompt ?? 'Explain what this cell does.',
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
      this.renderSlot(entry, this.currentAnalysis()?.cells ?? []);
    }
  }

  private async answerChoice(slotId: string, selectedIndex: number): Promise<void> {
    const entry = this.entries.get(slotId);
    if (!entry || !entry.record) return;
    const record = entry.record;
    if (record.answeredCorrectly) return;

    const correct = selectedIndex === record.quiz.correctIndex;
    record.attempts += 1;
    record.selectedIndex = selectedIndex;
    record.answeredCorrectly = correct;

    try {
      const response = await this.callbacks.store.answerActivity({
        notebookPath: this.callbacks.notebookPath,
        slotId,
        region: entry.slot.region,
        correct
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
    } catch (error) {
      entry.error = toFriendlyError(error);
    }

    this.callbacks.getStore().writeQuiz(record);
    this.renderSlot(entry, this.currentAnalysis()?.cells ?? []);
  }

  private async submitOpen(slotId: string, answer: string): Promise<void> {
    const entry = this.entries.get(slotId);
    if (!entry || !entry.record || !entry.record.open) return;
    const record = entry.record;
    if (record.openVerdict?.passed) return;
    const open = record.open!;

    record.openAnswer = answer;
    record.attempts += 1;
    entry.loading = true;
    this.renderSlot(entry, this.currentAnalysis()?.cells ?? []);

    const anchorCell = this.currentAnalysis()
      ?.cells.find((c: CellAnalysis) => c.cellId === entry.slot.anchorCellId);

    try {
      const response = await this.callbacks.store.gradeActivity({
        slotId,
        kind: entry.slot.kind,
        prompt: open.prompt,
        rubric: open.rubric,
        answer,
        cellSource: anchorCell?.sourcePreview ?? '',
        notebookPath: this.callbacks.store.getGlobalState().notebookPath
      });
      record.openVerdict = response.verdict;
      record.answeredCorrectly = Boolean(response.verdict.passed);
      if (response.outcome.granted) {
        const awarded = response.outcome.xpAwarded ?? 0;
        record.awardedXp += awarded;
        this.callbacks.onXpGained(awarded, response.outcome.category ?? 'reflection', 'Teach-back');
      }
    } catch (error) {
      entry.error = toFriendlyError(error);
    } finally {
      entry.loading = false;
      this.callbacks.getStore().writeQuiz(record);
      this.renderSlot(entry, this.currentAnalysis()?.cells ?? []);
    }
  }

  private patchRecord(slotId: string, patch: Partial<QuizRecord>): void {
    const entry = this.entries.get(slotId);
    if (!entry || !entry.record) return;
    entry.record = { ...entry.record, ...patch };
    this.callbacks.getStore().writeQuiz(entry.record);
  }

  private setHidden(slotId: string, hidden: boolean): void {
    const entry = this.entries.get(slotId);
    if (!entry) return;
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
    this.renderSlot(entry, this.currentAnalysis()?.cells ?? []);
  }

  private renderSlot(entry: SlotEntry, cells: CellAnalysis[]): void {
    if (entry.hidden) {
      this.renderStub(entry, cells);
      return;
    }

    const kind = entry.slot.kind;
    if (kind === 'teachback') {
      entry.root.render(
        <OpenActivity
          slot={entry.slot}
          record={entry.record}
          cells={cells}
          loading={entry.loading}
          error={entry.error}
          onGenerate={() => void this.generate(entry.slot.slotId)}
          onSubmit={answer => void this.submitOpen(entry.slot.slotId, answer)}
          onDismiss={() => this.setHidden(entry.slot.slotId, true)}
          onDraftChange={value => this.patchRecord(entry.slot.slotId, { openAnswer: value })}
        />
      );
    } else {
      entry.root.render(
        <ChoiceActivity
          kind={kind as ActivityKind}
          slot={entry.slot}
          record={entry.record}
          cells={cells}
          loading={entry.loading}
          error={entry.error}
          onGenerate={() => void this.generate(entry.slot.slotId)}
          onAnswer={idx => void this.answerChoice(entry.slot.slotId, idx)}
          onDismiss={() => this.setHidden(entry.slot.slotId, true)}
        />
      );
    }
  }

  private renderStub(entry: SlotEntry, cells: CellAnalysis[]): void {
    const slot = entry.slot;
    const record = entry.record;
    const anchorCell = cells.find(c => c.cellId === slot.anchorCellId);
    const anchorLabel = anchorCell ? `Cell ${anchorCell.index + 1}` : 'anchor cell';
    const solved = Boolean(record?.answeredCorrectly || record?.openVerdict?.passed);
    const labelText = solved
      ? `${slot.kindLabel || 'Activity'} solved · hidden`
      : `${slot.kindLabel || 'Activity'} hidden`;

    const iconHtml = solved ? icon('success') : activityIcon(slot.kind);

    entry.root.render(
      <div className="flowquest-questCellStub">
        <span 
          className="flowquest-questCellStubIcon" 
          dangerouslySetInnerHTML={{ __html: iconHtml }} 
        />
        <div className="flowquest-questCellStubBody">
          <div className="flowquest-questCellStubTitle">{labelText}</div>
          <div className="flowquest-questCellStubMeta">
            {slot.region} checkpoint on {anchorLabel}
          </div>
        </div>
        <button 
          type="button" 
          className="flowquest-btn flowquest-btn-ghost"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            this.setHidden(slot.slotId, false);
          }}
        >
          Show
        </button>
      </div>
    );
  }
}
