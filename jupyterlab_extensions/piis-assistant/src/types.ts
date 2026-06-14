/**
 * Shared FlowQuest types. These mirror the JSON structures produced by
 * jupyterlab_piis_assistant.analyzer and the backend handlers.
 */

export type MessageRole = 'user' | 'assistant';
export type SidebarPhase = 'idle' | 'loading' | 'ready' | 'error';
export type ContextMode = 'active-cell' | 'whole-notebook' | 'workspace';
export type SidebarTab = 'quest' | 'cell' | 'chat';
export type MissionKind =
  | 'exploration'
  | 'understanding'
  | 'stabilization'
  | 'reflection';
export type IssueSeverity = 'info' | 'warn' | 'error';
export type DifficultyLevel = 'easy' | 'medium' | 'hard';

export interface AwardLogEntry {
  key: string;
  category: MissionKind;
  xp: number;
  label: string;
  ts: number;
}

/**
 * The XP + Levels progression state. Mirrors gamification.public_view().
 *
 * Since v4, XP/levels are GLOBAL (user-scoped, owned by the server at
 * ~/.flowquest/progress.json) and shared across every open notebook.
 * ``difficulty`` is the one per-notebook field, merged in from the notebook's
 * metadata.flowquest. ``notebookKey``/``notebookPath`` identify which notebook
 * the merged view belongs to (used for per-notebook idempotency namespacing).
 */
export interface QuestState {
  notebookKey: string;
  notebookPath: string;
  schemaVersion: number;
  xpTotal: number;
  xpByCategory: Record<MissionKind, number>;
  completedAwardKeys: string[];
  exploredCellHashes: string[];
  awardLog: AwardLogEntry[];
  reflections: Array<{ cellIndex: number; text: string; ts: number }>;
  quizAttempts: number;
  quizCorrect: number;
  streakDays: number;
  lastActiveTs: number;
  difficulty: DifficultyLevel;
  // Derived (computed by the backend)
  level: number;
  rankTitle: string;
  xpIntoLevel: number;
  xpForNextLevel: number;
  xpToNextLevel: number;
  levelProgress: number;
  categoryTotal: number;
}

export interface ConversationMessage {
  role: MessageRole;
  content: string;
  meta: string;
  includeInHistory: boolean;
}

export interface NotebookContext {
  hasNotebook: boolean;
  notebookName: string;
  path: string;
  cellCount: number;
  activeCellIndex: number;
  activeCellType: string;
  activeCellSource: string;
  activeOutput: string;
  selectedOutput: string;
  kernelName: string;
  kernelStatus: string;
  contextMode: ContextMode;
  attachmentLabel: string;
  attachmentPreview: string;
  attachedPromptContext: string;
}

export interface EndpointStatus {
  configured: boolean;
  model: string;
  baseUrl: string;
  envFile: string;
  message: string;
}

export interface CellIssue {
  kind: string;
  severity: IssueSeverity;
  message: string;
}

export interface CellAnalysis {
  index: number;
  cellId: string;
  cellType: string;
  execCount: number | null;
  region: string;
  regionIcon: string;
  defines: string[];
  uses: string[];
  imports: string[];
  dependsOn: number[];
  dependents: number[];
  producesPlot: boolean;
  producesOutput: boolean;
  summary: string;
  sourcePreview: string;
  issues: CellIssue[];
}

export interface Mission {
  id: string;
  kind: MissionKind;
  title: string;
  description: string;
  xp: number;
  cell_indices: number[];
  completion_hint: string;
  auto_completable: boolean;
}

export type ActivityKind = 'quiz' | 'predict' | 'teachback';
export type ActivityResponse = 'choice' | 'open';

export interface InjectionPoint {
  slotId: string;
  kind: ActivityKind;
  /** 'choice' (MCQ) or 'open' (free-text, LLM-graded). */
  response: ActivityResponse;
  kindLabel: string;
  region: string;
  topic: string;
  anchorCellId: string;
  anchorCellIndex: number;
  contextCellIds: string[];
  kindIcon: string;
}

/** Multiple-choice content (quiz + predict activities). */
export interface QuizContent {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  model?: string;
  kind?: ActivityKind;
  response?: ActivityResponse;
}

/** Open-ended content (teachback activity). */
export interface OpenContent {
  prompt: string;
  rubric: string[];
  hint: string;
  model?: string;
  kind?: ActivityKind;
  response?: ActivityResponse;
}

/** LLM verdict returned when grading an open activity. */
export interface OpenVerdict {
  passed: boolean;
  score: number;
  feedback: string;
  model?: string;
}

export interface QuizRecord {
  slotId: string;
  anchorCellId: string;
  region: string;
  /** Which activity kind this slot rendered. Older records omit it (quiz). */
  activityKind?: ActivityKind;
  /** Choice activities store the generated MCQ here. */
  quiz: QuizContent;
  /** Open activities store the generated prompt + rubric here. */
  open?: OpenContent;
  /** Open activities: the learner's free-text answer + grading verdict. */
  openAnswer?: string;
  openVerdict?: OpenVerdict | null;
  generatedAt: number;
  selectedIndex: number | null;
  answeredCorrectly: boolean;
  attempts: number;
  awardedXp: number;
  /** When true, the user dismissed the activity cell — render a small stub
   * with a "show again" action instead of the full panel. */
  hidden?: boolean;
}

export interface ActivityGradeResponse {
  verdict: OpenVerdict;
  outcome: { granted: boolean; xpAwarded?: number; category?: MissionKind };
  state: QuestState;
}

/** A spontaneous quiz Flowy fires about an arbitrary snippet (e.g. a paste). */
export interface FlowyQuiz {
  challengeId: string;
  source: string;
  quiz: QuizContent;
  selectedIndex: number | null;
  answeredCorrectly: boolean;
  awardedXp: number;
}

export interface FlatIssue {
  cell_index: number;
  kind: string;
  severity: IssueSeverity;
  message: string;
  region: string;
}

export interface AnalysisResponse {
  cells: CellAnalysis[];
  issues: FlatIssue[];
  regionCounts: Record<string, number>;
  regionOrder: string[];
  regionIcons: Record<string, string>;
  missions: Mission[];
  injectionPoints: InjectionPoint[];
  summary: Record<string, unknown>;
  questState: QuestState;
  autoCompleted: Array<{ awardKey: string; category: MissionKind; xp: number; label: string }>;
}

export interface ExplainResponse {
  explanation: string;
  model: string;
  outcome?: { granted: boolean; xpAwarded?: number };
  state?: QuestState;
}

export interface ReflectPromptResponse {
  question: string;
  model: string;
}

export interface NextStepsResponse {
  suggestions: string;
  model: string;
}

export interface ClaimResponse {
  state: QuestState;
  outcome: {
    granted: boolean;
    xpAwarded?: number;
    reason?: string;
    category?: MissionKind;
  };
}

export interface GlobalSettings {
  model: string;
  baseUrl: string;
  apiKeySet: boolean;
  apiKeyPreview: string;
  apiKeyStorage?: 'keychain' | 'file' | 'env' | 'none';
  keychainAvailable?: boolean;
  settingsFile: string | null;
  envFile: string | null;
  favoriteModels: string[];
}
