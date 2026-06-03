/**
 * Shared FlowQuest progression state (global, user-scoped).
 *
 * Since v4 the XP + Levels progression is owned by the server
 * (``~/.flowquest/progress.json``) and shared across every open notebook. The
 * frontend keeps a single in-memory mirror, hydrated from ``quest/init`` and
 * refreshed by every mutating response. ``difficulty`` is the one per-notebook
 * field; it's merged in from each notebook's ``metadata.flowquest``.
 */

import type { QuestState } from './types';

export const EMPTY_QUEST_STATE: QuestState = {
  notebookKey: '',
  notebookPath: '',
  schemaVersion: 4,
  xpTotal: 0,
  xpByCategory: {
    exploration: 0,
    understanding: 0,
    stabilization: 0,
    reflection: 0
  },
  completedAwardKeys: [],
  exploredCellHashes: [],
  awardLog: [],
  reflections: [],
  quizAttempts: 0,
  quizCorrect: 0,
  streakDays: 0,
  lastActiveTs: 0,
  difficulty: 'medium',
  level: 1,
  rankTitle: 'Notebook Novice',
  xpIntoLevel: 0,
  xpForNextLevel: 40,
  xpToNextLevel: 40,
  levelProgress: 0,
  categoryTotal: 0
};
