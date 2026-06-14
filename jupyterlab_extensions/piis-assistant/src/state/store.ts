/**
 * FlowQuest central state store.
 *
 * The single source of truth for all frontend state. Every mutation goes
 * through the store, which:
 *
 *   - Calls the backend (when needed)
 *   - Receives the canonical state from the server response
 *   - Rejects stale updates (older timestamp than the current state)
 *   - Notifies subscribers so every React/Lumino surface stays in sync
 *
 * API methods live here for now but are thin wrappers around ``apiRequest``
 * that adopt the returned state. The store owns no business logic — the
 * server is the source of truth.
 */

import { apiRequest } from '../api';
import { EMPTY_QUEST_STATE } from '../questState';
import type {
  AnalysisResponse,
  ClaimResponse,
  ConversationMessage,
  DifficultyLevel,
  EndpointStatus,
  ExplainResponse,
  GlobalSettings,
  NextStepsResponse,
  QuestState,
  ReflectPromptResponse
} from '../types';

type Listener = () => void;

export interface SyncStatus {
  status: 'idle' | 'syncing' | 'synced' | 'error';
  lastSyncedAt: number;
  error: string | null;
}

/**
 * The full user profile as returned by `/piis-assistant/quest/init`. This is
 * the canonical shape persisted server-side at `~/.flowquest/profile.json`.
 *
 * Note: the ``settings`` block is only used by the settings modal (which
 * fetches it via the separate ``/settings`` GET endpoint). The store does
 * NOT use ``profile.settings`` — it only cares about ``profile.progress``.
 */
export interface Profile {
  schemaVersion: number;
  lastSyncedAt: number;
  settings: {
    baseUrl: string | null;
    model: string | null;
    favoriteModels: string[];
    apiKey: string | null;
    difficulty: DifficultyLevel;
  };
  progress: QuestState;
}

export interface NotebookSlice {
  analysis: AnalysisResponse | null;
  state: QuestState;
  chat: ConversationMessage[];
  analyzing: boolean;
}

/** Shared singleton — returned by getNotebookSlice for unknown paths. */
const EMPTY_SLICE: NotebookSlice = Object.freeze({
  analysis: null,
  state: EMPTY_QUEST_STATE,
  chat: [],
  analyzing: false
});

function isFresher(incoming: QuestState, current: QuestState): boolean {
  return (incoming.lastActiveTs ?? 0) >= (current.lastActiveTs ?? 0);
}

function _emptyProfile(): Profile {
  return {
    schemaVersion: 2,
    lastSyncedAt: 0,
    settings: {
      baseUrl: null,
      model: null,
      favoriteModels: [],
      apiKey: null,
      difficulty: 'medium'
    },
    progress: { ...EMPTY_QUEST_STATE }
  };
}

export class FlowQuestStore {
  private profile: Profile = _emptyProfile();
  private globalState: QuestState = this.profile.progress;
  private syncStatusValue: SyncStatus = {
    status: 'idle',
    lastSyncedAt: 0,
    error: null
  };
  private endpointStatusValue: EndpointStatus = {
    configured: false,
    model: 'Unavailable',
    baseUrl: 'Unavailable',
    envFile: 'not found',
    message: 'Status has not been loaded yet.'
  };

  private notebookSlices = new Map<string, NotebookSlice>();

  // ---- Listener sets ----
  private listeners = new Set<Listener>();
  private globalListeners = new Set<Listener>();
  private notebookListeners = new Map<string, Set<Listener>>();
  private syncListeners = new Set<Listener>();
  private endpointStatusListeners = new Set<Listener>();

  // ---- Subscriptions (stable for useSyncExternalStore) ----

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeGlobal(listener: Listener): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  subscribeNotebook(notebookPath: string, listener: Listener): () => void {
    let set = this.notebookListeners.get(notebookPath);
    if (!set) {
      set = new Set();
      this.notebookListeners.set(notebookPath, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.notebookListeners.delete(notebookPath);
      }
    };
  }

  subscribeSyncStatus(listener: Listener): () => void {
    this.syncListeners.add(listener);
    return () => this.syncListeners.delete(listener);
  }

  subscribeEndpointStatus(listener: Listener): () => void {
    this.endpointStatusListeners.add(listener);
    return () => this.endpointStatusListeners.delete(listener);
  }

  // ---- Snapshot getters (stable for useSyncExternalStore) ----

  getGlobalState(): QuestState {
    return this.globalState;
  }

  getProfile(): Profile {
    return this.profile;
  }

  getSyncStatus(): SyncStatus {
    return this.syncStatusValue;
  }

  getEndpointStatus(): EndpointStatus {
    return this.endpointStatusValue;
  }

  getLastSyncedAt(): number {
    return this.profile.lastSyncedAt ?? 0;
  }

  /**
   * Return the notebook slice for a path, or the frozen empty singleton.
   *
   * Returning a frozen singleton (instead of spreading a new object every
   * call) ensures ``useSyncExternalStore`` sees a stable reference for
   * unknown/not-yet-registered paths.
   */
  getNotebookSlice(notebookPath: string): NotebookSlice {
    return this.notebookSlices.get(notebookPath) ?? EMPTY_SLICE;
  }

  // ---- State adoption ----

  /**
   * Adopt a server-provided progress state. Stale responses
   * (older timestamp than the current state) are silently dropped.
   */
  adoptGlobalState(incoming: QuestState, options: { force?: boolean } = {}): boolean {
    if (!options.force && !isFresher(incoming, this.globalState)) {
      return false;
    }
    this.globalState = { ...incoming };
    this.profile = {
      ...this.profile,
      progress: this.globalState,
      lastSyncedAt: Date.now() / 1000
    };
    this.setSyncStatus('synced');
    this.refreshNotebookSlices();
    this.emitGlobal();
    this.emit();
    return true;
  }

  /**
   * Adopt a full profile from the server. This is the canonical way to
   * hydrate the store from `quest/init` and from `profile/reset`.
   */
  adoptProfile(profile: Profile): void {
    this.profile = { ...profile, progress: { ...profile.progress } };
    this.globalState = this.profile.progress;
    this.refreshNotebookSlices();
    this.setSyncStatus('synced');
    this.emitGlobal();
    this.emit();
  }

  // ---- Initialization ----

  /**
   * Hydrate the store from the server's canonical profile.
   */
  async loadInitial(): Promise<Profile | null> {
    this.setSyncStatus('syncing');
    try {
      const response = await apiRequest<{ profile: Profile }>(
        'piis-assistant/quest/init',
        { method: 'GET' }
      );
      this.adoptProfile(response.profile);
      return response.profile;
    } catch (error) {
      this.setSyncStatus('error', error instanceof Error ? error.message : 'Could not load profile');
      return null;
    }
  }

  /**
   * Wipe the global profile for a fresh start.
   */
  async resetEverything(): Promise<Profile> {
    this.setSyncStatus('syncing');
    try {
      const response = await apiRequest<{ profile: Profile }>(
        'piis-assistant/profile/reset',
        { method: 'POST' }
      );
      this.adoptProfile(response.profile);
      return response.profile;
    } catch (error) {
      this.setSyncStatus('error', error instanceof Error ? error.message : 'Reset failed');
      throw error;
    }
  }

  // ---- Notebook slice management ----

  ensureNotebookSlice(
    notebookPath: string,
    seed: Partial<NotebookSlice> = {}
  ): NotebookSlice {
    let slice = this.notebookSlices.get(notebookPath);
    if (!slice) {
      slice = {
        analysis: null,
        state: { ...this.globalState, notebookKey: notebookPath, notebookPath },
        chat: [],
        analyzing: false,
        ...seed
      };
      this.notebookSlices.set(notebookPath, slice);
    } else if (Object.keys(seed).length > 0) {
      slice = { ...slice, ...seed };
      this.notebookSlices.set(notebookPath, slice);
    }
    return slice;
  }

  setNotebookSlice(notebookPath: string, patch: Partial<NotebookSlice>): void {
    const current = this.notebookSlices.get(notebookPath) ?? {
      analysis: null,
      state: { ...this.globalState, notebookKey: notebookPath, notebookPath },
      chat: [],
      analyzing: false
    };
    const next = { ...current, ...patch };
    this.notebookSlices.set(notebookPath, next);
    this.emitNotebook(notebookPath);
    this.emit();
  }

  removeNotebookSlice(notebookPath: string): void {
    this.notebookSlices.delete(notebookPath);
    this.notebookListeners.delete(notebookPath);
    this.emit();
  }

  // ---- API methods ----

  async claimMission(args: {
    notebookPath: string;
    missionId: string;
    category: string;
    xp: number;
    label: string;
  }): Promise<ClaimResponse> {
    const response = await apiRequest<ClaimResponse>('piis-assistant/mission/claim', {
      method: 'POST',
      body: JSON.stringify({
        state: this.globalState,
        notebookPath: args.notebookPath,
        missionId: args.missionId,
        category: args.category,
        xp: args.xp,
        label: args.label
      })
    });
    if (response.state) {
      this.adoptGlobalState(response.state);
    }
    return response;
  }

  async explainCell(args: {
    notebookPath: string;
    cell: { index: number; region: string; source: string };
  }): Promise<ExplainResponse> {
    const response = await apiRequest<ExplainResponse>('piis-assistant/explain-cell', {
      method: 'POST',
      body: JSON.stringify({
        state: this.globalState,
        notebookPath: args.notebookPath,
        cell: args.cell
      })
    });
    if (response.state) {
      this.adoptGlobalState(response.state);
    }
    return response;
  }

  async reflectPrompt(args: {
    cell: { index: number; region: string; source: string };
    difficulty: QuestState['difficulty'];
  }): Promise<ReflectPromptResponse> {
    return apiRequest<ReflectPromptResponse>('piis-assistant/reflect/prompt', {
      method: 'POST',
      body: JSON.stringify({ cell: args.cell, difficulty: args.difficulty })
    });
  }

  async reflectAnswer(args: {
    notebookPath: string;
    cellIndex: number;
    text: string;
  }): Promise<ClaimResponse> {
    const response = await apiRequest<ClaimResponse>('piis-assistant/reflect/answer', {
      method: 'POST',
      body: JSON.stringify({
        state: this.globalState,
        notebookPath: args.notebookPath,
        cellIndex: args.cellIndex,
        text: args.text
      })
    });
    if (response.state) {
      this.adoptGlobalState(response.state);
    }
    return response;
  }

  async loadNextSteps(analysis: AnalysisResponse): Promise<NextStepsResponse> {
    return apiRequest<NextStepsResponse>('piis-assistant/next-steps', {
      method: 'POST',
      body: JSON.stringify({
        analysis,
        difficulty: this.globalState.difficulty
      })
    });
  }

  async generateActivity(args: {
    slot: unknown;
    kind: string;
    cells: unknown;
  }): Promise<{
    question?: string;
    options?: string[];
    correctIndex?: number;
    explanation?: string;
    model?: string;
    prompt?: string;
    rubric?: string[];
    hint?: string;
  }> {
    return apiRequest('piis-assistant/activity/generate', {
      method: 'POST',
      body: JSON.stringify({
        slot: args.slot,
        kind: args.kind,
        cells: args.cells,
        difficulty: this.globalState.difficulty
      })
    });
  }

  /** C4 fix: accept notebookPath as a parameter instead of reading from globalState. */
  async answerActivity(args: {
    notebookPath: string;
    slotId: string;
    region: string;
    correct: boolean;
  }): Promise<{
    state: QuestState;
    outcome: { granted: boolean; xpAwarded?: number; category?: string };
    correct: boolean;
  }> {
    const response = await apiRequest<{
      state: QuestState;
      outcome: { granted: boolean; xpAwarded?: number; category?: string };
      correct: boolean;
    }>('piis-assistant/activity/answer', {
      method: 'POST',
      body: JSON.stringify({
        state: this.globalState,
        notebookPath: args.notebookPath,
        slotId: args.slotId,
        region: args.region,
        correct: args.correct
      })
    });
    if (response.state) {
      this.adoptGlobalState(response.state);
    }
    return response;
  }

  async gradeActivity(args: {
    slotId: string;
    kind: string;
    prompt: string;
    rubric: string[];
    answer: string;
    cellSource: string;
    notebookPath: string;
  }): Promise<{
    verdict: { passed: boolean; score: number; feedback: string; model?: string };
    outcome: { granted: boolean; xpAwarded?: number; category?: string };
    state: QuestState;
  }> {
    const response = await apiRequest<{
      verdict: { passed: boolean; score: number; feedback: string; model?: string };
      outcome: { granted: boolean; xpAwarded?: number; category?: string };
      state: QuestState;
    }>('piis-assistant/activity/grade', {
      method: 'POST',
      body: JSON.stringify({
        ...args,
        difficulty: this.globalState.difficulty
      })
    });
    if (response.state) {
      this.adoptGlobalState(response.state);
    }
    return response;
  }

  async answerFlowyQuiz(args: {
    challengeId: string;
    correct: boolean;
    notebookPath: string;
  }): Promise<ClaimResponse> {
    const response = await apiRequest<ClaimResponse>('piis-assistant/flowy/quiz/answer', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: args.challengeId,
        correct: args.correct,
        notebookPath: args.notebookPath
      })
    });
    if (response.state) {
      this.adoptGlobalState(response.state);
    }
    return response;
  }

  async wipeProgress(args: { scope: 'notebook' | 'global'; notebookPath: string }): Promise<{
    state: QuestState;
  }> {
    const response = await apiRequest<{ state: QuestState }>('piis-assistant/state/wipe', {
      method: 'POST',
      body: JSON.stringify({ scope: args.scope, notebookPath: args.notebookPath })
    });
    if (response.state) {
      this.adoptGlobalState(response.state, { force: true });
    }
    return response;
  }

    // ---- Settings ----

  async checkEndpointStatus(): Promise<EndpointStatus> {
    try {
      const response = await apiRequest<EndpointStatus>('piis-assistant/status', {
        method: 'GET'
      });
      this.endpointStatusValue = response;
      this.endpointStatusListeners.forEach(l => l());
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.endpointStatusValue = {
        configured: false,
        model: 'Unavailable',
        baseUrl: 'Unavailable',
        envFile: 'not found',
        message
      };
      this.endpointStatusListeners.forEach(l => l());
      return this.endpointStatusValue;
    }
  }

  async loadSettings(): Promise<GlobalSettings> {
    return apiRequest<GlobalSettings>('piis-assistant/settings', { method: 'GET' });
  }

  async saveSettings(payload: {
    model: string;
    baseUrl: string;
    apiKey?: string;
  }): Promise<GlobalSettings> {
    return apiRequest<GlobalSettings>('piis-assistant/settings/save', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  // ---- Private helpers ----

  private refreshNotebookSlices(): void {
    for (const [path, slice] of this.notebookSlices.entries()) {
      const next: NotebookSlice = {
        ...slice,
        state: {
          ...this.globalState,
          notebookKey: path,
          notebookPath: path,
          difficulty: slice.state.difficulty ?? this.globalState.difficulty
        }
      };
      this.notebookSlices.set(path, next);
    }
  }

  private setSyncStatus(status: SyncStatus['status'], error?: string): void {
    this.syncStatusValue = {
      status,
      lastSyncedAt: status === 'synced' ? Date.now() / 1000 : this.syncStatusValue.lastSyncedAt,
      error: error ?? null
    };
    this.emitSync();
  }

  private emit(): void {
    this.listeners.forEach(l => l());
  }

  private emitGlobal(): void {
    this.globalListeners.forEach(l => l());
  }

  private emitNotebook(notebookPath: string): void {
    this.notebookListeners.get(notebookPath)?.forEach(l => l());
  }

  private emitSync(): void {
    this.syncListeners.forEach(l => l());
  }
}
