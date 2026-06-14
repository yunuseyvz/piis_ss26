/**
 * Per-notebook FlowQuest metadata, persisted inside the notebook's own file.
 *
 * Since v4, XP and levels are **global** (user-scoped, owned by the server at
 * ``~/.flowquest/progress.json``) — they are no longer stored per notebook.
 * What remains in ``metadata.flowquest`` is only the data that is genuinely
 * per-notebook:
 *
 *   - ``difficulty``  — the per-notebook difficulty preference
 *   - ``quizzes``     — generated quiz content + answers, anchored to cells
 *   - ``chat``        — the Flowy chat transcript for this notebook
 *
 * Quiz content and chat are inherently tied to a notebook, so they travel with
 * the ``.ipynb``. Progression does not.
 */

import { NotebookPanel } from '@jupyterlab/notebook';

import type { ConversationMessage, DifficultyLevel, QuizRecord } from './types';

const METADATA_KEY = 'flowquest';
const QUIZZES_KEY = 'quizzes';
const CHAT_KEY = 'chat';
const CHAT_LIMIT = 50;

interface RawQuestMetadata {
  difficulty?: string;
  quizzes?: Record<string, QuizRecord>;
  chat?: ConversationMessage[];
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

  /** Raw persisted blob (difficulty + quizzes only). */
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

  /** Read the difficulty preference (frontend-owned, per notebook). */
  readDifficulty(): DifficultyLevel {
    const raw = this.readRaw().difficulty;
    if (raw === 'easy' || raw === 'hard' || raw === 'medium') {
      return raw;
    }
    return 'medium';
  }

  /** Persist just the difficulty without disturbing other fields. */
  writeDifficulty(difficulty: DifficultyLevel): void {
    const model = this.panel.content.model;
    if (!model) {
      return;
    }
    const existing = this.readRaw();
    if (existing.difficulty === difficulty) {
      return;
    }
    const next: RawQuestMetadata = { ...existing, difficulty };
    model.sharedModel.setMetadata(METADATA_KEY, next as unknown as never);
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

  /** Read the saved Flowy chat transcript for this notebook. */
  readChat(): ConversationMessage[] {
    const chat = this.readRaw().chat;
    if (!Array.isArray(chat)) {
      return [];
    }
    return chat.filter(
      (m): m is ConversationMessage =>
        !!m &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string'
    );
  }

  /** Persist the Flowy chat transcript for this notebook (most recent kept). */
  writeChat(messages: ConversationMessage[]): void {
    const model = this.panel.content.model;
    if (!model) {
      return;
    }
    const existing = this.readRaw();
    const trimmed = messages.slice(-CHAT_LIMIT);
    const next: RawQuestMetadata = { ...existing, [CHAT_KEY]: trimmed };
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

  /**
   * Wipe every FlowQuest field from this notebook's metadata (difficulty,
   * quizzes, chat) and persist immediately. Used by the "Fresh start"
   * reset.
   */
  clearAll(): void {
    const model = this.panel.content.model;
    if (!model) return;
    if (this.pendingSaveHandle !== null) {
      window.clearTimeout(this.pendingSaveHandle);
      this.pendingSaveHandle = null;
    }
    model.sharedModel.setMetadata(METADATA_KEY, {} as unknown as never);
    this.panel.context.save().catch(() => {
      /* best-effort */
    });
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
