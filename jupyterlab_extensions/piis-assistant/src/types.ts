/**
 * Shared FlowQuest types. These mirror the JSON structures produced by
 * jupyterlab_piis_assistant.analyzer and the backend handlers.
 */

export type MessageRole = 'user' | 'assistant';
export type SidebarPhase = 'idle' | 'loading' | 'ready' | 'error';
export type ContextMode = 'active-cell' | 'whole-notebook' | 'workspace';
export type SidebarTab = 'quest' | 'chat';
export type MissionKind =
  | 'exploration'
  | 'understanding'
  | 'stabilization'
  | 'reflection';
export type IssueSeverity = 'info' | 'warn' | 'error';

export interface CriterionProgress {
  id: string;
  label: string;
  icon: string;
  weight: number;
  budget: number;
  baselineScore: number | null;
  earned: number;
  description: string;
}

export interface AwardLogEntry {
  key: string;
  criterion: string;
  points: number;
  label: string;
  ts: number;
}

export interface QuestState {
  notebookKey: string;
  notebookPath: string;
  schemaVersion: number;
  initialized: boolean;
  baselineHealth: number;
  baselineBreakdown: Record<string, number | null>;
  baselineNotes: string;
  healthPoints: Record<string, number>;
  completedAwardKeys: string[];
  awardLog: AwardLogEntry[];
  reflections: Array<{ cellIndex: number; text: string; ts: number }>;
  quizAttempts: number;
  quizCorrect: number;
  streakDays: number;
  lastActiveTs: number;
  wonAt: number;
  difficulty: 'easy' | 'medium' | 'hard';
  healthScore: number;
  healthTarget: number;
  healthRemaining: number;
  healthProgress: number;
  healthLabel: string;
  rankTitle: string;
  pointsEarned: number;
  pointsAvailable: number;
  won: boolean;
  criteria: CriterionProgress[];
}export interface ConversationMessage {
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
  criterion_id: string;
  health_points: number;
}

export interface InjectionPoint {
  slotId: string;
  kind: 'quiz';
  region: string;
  topic: string;
  anchorCellId: string;
  anchorCellIndex: number;
  contextCellIds: string[];
  kindIcon: string;
}

export interface QuizContent {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  model?: string;
}

export interface QuizRecord {
  slotId: string;
  anchorCellId: string;
  region: string;
  quiz: QuizContent;
  generatedAt: number;
  selectedIndex: number | null;
  answeredCorrectly: boolean;
  attempts: number;
  awardedXp: number;
  /** When true, the user dismissed the quiz cell — render a small stub
   * with a "show again" action instead of the full panel. */
  hidden?: boolean;
}

export interface FlatIssue {
  cell_index: number;
  kind: string;
  severity: IssueSeverity;
  message: string;
  region: string;
}

export interface AnalysisResponse {
  health: number;
  healthLabel: string;
  healthBreakdown: Record<IssueSeverity, number>;
  cells: CellAnalysis[];
  issues: FlatIssue[];
  regionCounts: Record<string, number>;
  regionOrder: string[];
  regionIcons: Record<string, string>;
  missions: Mission[];
  injectionPoints: InjectionPoint[];
  summary: Record<string, unknown>;
  questState: QuestState;
  autoCompleted: Array<{ awardKey: string; criterion: string; points: number; label: string }>;
  criteria?: Array<{ id: string; label: string; icon: string; weight: number; pointBudget: number }>;
}

export interface ExplainResponse {
  explanation: string;
  model: string;
  outcome?: { granted: boolean; pointsAwarded?: number };
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
    pointsAwarded?: number;
    reason?: string;
    criterion?: string;
  };
}

export interface InitializeResponse {
  state: QuestState;
  baseline: {
    baselineHealth: number;
    breakdown: Record<string, number | null>;
    notes: string;
    model: string;
    fallback?: boolean;
    fallbackError?: string;
  };
  notebookPath: string;
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

export type DifficultyLevel = 'easy' | 'medium' | 'hard';
