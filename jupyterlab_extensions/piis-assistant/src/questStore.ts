/**
 * Per-notebook FlowQuest state, persisted inside the notebook's own metadata.
 *
 * The notebook file gains a top-level ``metadata.flowquest`` object. After
 * the v2 gamification rework this stores:
 *   - baseline LLM health scoring,
 *   - earned health points per criterion,
 *   - award log,
 *   - reflections,
 *   - quiz records.
 *
 * Progress travels with the .ipynb.
 */

import { NotebookPanel } from '@jupyterlab/notebook';

import type { QuestState, QuizRecord } from './types';

const METADATA_KEY = 'flowquest';
const QUIZZES_KEY = 'quizzes';

export const EMPTY_QUEST_STATE: QuestState = {
  notebookKey: '',
  notebookPath: '',
  schemaVersion: 2,
  initialized: false,
  baselineHealth: 0,
  baselineBreakdown: {},
  baselineNotes: '',
  healthPoints: {},
  completedAwardKeys: [],
  awardLog: [],
  reflections: [],
  quizAttempts: 0,
  quizCorrect: 0,
  streakDays: 0,
  lastActiveTs: 0,
  wonAt: 0,
  difficulty: 'medium',
  healthScore: 0,
  healthTarget: 100,
  healthRemaining: 100,
  healthProgress: 0,
  healthLabel: '—',
  rankTitle: 'Notebook Novice',
  pointsEarned: 0,
  pointsAvailable: 0,
  won: false,
  criteria: []
};

interface RawQuestMetadata {
  schemaVersion?: number;
  initialized?: boolean;
  baselineHealth?: number;
  baselineBreakdown?: Record<string, number | null>;
  baselineNotes?: string;
  healthPoints?: Record<string, number>;
  completedAwardKeys?: string[];
  awardLog?: Array<{ key: string; criterion: string; points: number; label: string; ts: number }>;
  reflections?: Array<{ cellIndex: number; text: string; ts: number }>;
  quizAttempts?: number;
  quizCorrect?: number;
  streakDays?: number;
  lastActiveTs?: number;
  wonAt?: number;
  difficulty?: string;
  quizzes?: Record<string, QuizRecord>;
}

export class QuestMetadataStore {
  constructor(private panel: NotebookPanel) {
    this.panel.disposed.connect(() => {
      if (this.pendingSaveHandle !== null) {
        window.clearTimeout(this.pendingSaveHandle);
        this.pendingSaveHandle = null;
      }
    });
  }

  /** Raw persisted blob. Backend-friendly shape. */
  readRaw(): RawQuestMetadata {
    const model = this.panel.content.model;
    if (!model) {
      return {};
    }
    const value = model.sharedModel.getMetadata(METADATA_KEY);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as RawQuestMetadata;
    }
    return {};
  }

  /** Persist a fresh public state back into notebook metadata. */
  write(state: QuestState): void {
    const model = this.panel.content.model;
    if (!model) {
      return;
    }
    const existing = this.readRaw();
    const serialized: RawQuestMetadata = {
      schemaVersion: state.schemaVersion ?? 2,
      initialized: state.initialized,
      baselineHealth: state.baselineHealth,
      baselineBreakdown: { ...(state.baselineBreakdown || {}) },
      baselineNotes: state.baselineNotes,
      healthPoints: { ...(state.healthPoints || {}) },
      completedAwardKeys: state.completedAwardKeys.slice(-800),
      awardLog: state.awardLog.slice(-200),
      reflections: state.reflections.slice(-100),
      quizAttempts: state.quizAttempts,
      quizCorrect: state.quizCorrect,
      streakDays: state.streakDays,
      lastActiveTs: state.lastActiveTs || Date.now() / 1000,
      wonAt: state.wonAt,
      difficulty: state.difficulty ?? 'medium',
      quizzes: existing.quizzes ?? {}
    };
    // Skip no-op writes
    try {
      if (existing && JSON.stringify(existing) === JSON.stringify(serialized)) {
        return;
      }
    } catch {
      /* fall through */
    }
    model.sharedModel.setMetadata(METADATA_KEY, serialized as unknown as never);
    this.scheduleSave();
  }

  readQuizzes(): Record<string, QuizRecord> {
    const raw = this.readRaw();
    const quizzes = raw.quizzes;
    if (quizzes && typeof quizzes === 'object' && !Array.isArray(quizzes)) {
      return quizzes as Record<string, QuizRecord>;
    }
    return {};
  }

  writeQuiz(record: QuizRecord): void {
    const model = this.panel.content.model;
    if (!model) {
      return;
    }
    const existing = this.readRaw();
    const quizzes: Record<string, QuizRecord> = { ...(existing.quizzes ?? {}) };
    quizzes[record.slotId] = record;
    const next: RawQuestMetadata = { ...existing, [QUIZZES_KEY]: quizzes };
    model.sharedModel.setMetadata(METADATA_KEY, next as unknown as never);
    this.scheduleSave();
  }

  async ensureSaved(): Promise<void> {
    if (this.pendingSaveHandle !== null) {
      window.clearTimeout(this.pendingSaveHandle);
      this.pendingSaveHandle = null;
    }
    try {
      await this.panel.context.save();
    } catch {
      /* ignore */
    }
  }

  private scheduleSave(): void {
    if (this.pendingSaveHandle !== null) {
      window.clearTimeout(this.pendingSaveHandle);
    }
    this.pendingSaveHandle = window.setTimeout(() => {
      this.pendingSaveHandle = null;
      this.panel.context.save().catch(() => {
        /* best-effort */
      });
    }, 2000);
  }

  private pendingSaveHandle: number | null = null;
}
