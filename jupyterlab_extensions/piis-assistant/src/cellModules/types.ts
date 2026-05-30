/**
 * Between-cell activity modules.
 *
 * FlowQuest injects intelligent, LLM-generated activities below real notebook
 * cells. Each *kind* of activity (quiz, predict-the-output, teach-it-back, …)
 * is implemented as a :class:`CellModule`. The generic
 * :class:`BetweenCellInjector` owns the DOM plumbing — anchoring a host element
 * to a stable cell id, surviving cell moves, persistence — and delegates the
 * actual rendering and interaction to the module registered for the slot's
 * ``kind``.
 *
 * Adding a new activity is: implement a CellModule, register it in
 * ``cellModules/index.ts``, and teach the backend analyzer to emit that kind.
 */

import type { QuestMetadataStore } from '../questStore';
import type {
  ActivityKind,
  AnalysisResponse,
  CellAnalysis,
  InjectionPoint,
  QuestState,
  QuizRecord
} from '../types';

/** Shared services a module uses to read state, persist, and award XP. */
export interface CellModuleContext {
  getAnalysis: () => AnalysisResponse | null;
  getState: () => QuestState;
  getStore: () => QuestMetadataStore;
  /** Adopt a fresh global progression returned by the backend. */
  applyState: (state: QuestState) => void;
  /** Fire when XP is gained so the UI can celebrate (avatar pop + toast). */
  onXpGained: (amount: number, category: string, source: string) => void;
}

/** Everything a module needs to render one slot. */
export interface CellModuleRenderArgs {
  host: HTMLElement;
  slot: InjectionPoint;
  /** Persisted record for this slot (generated content + progress), if any. */
  record: QuizRecord | null;
  cells: CellAnalysis[];
  loading: boolean;
  error: { kind: string; message: string } | null;
  /** Re-render this slot from the injector (after a state change). */
  rerender: () => void;
}

export interface CellModule {
  /** Activity kind(s) this module handles. */
  readonly kind: ActivityKind;
  /** Render the slot's content into ``args.host``. The module binds its own
   * event handlers and calls back into the injector via the provided
   * callbacks (generate / answer / grade / setHidden). */
  render(args: CellModuleRenderArgs, actions: CellModuleActions): void;
}

/** Actions the injector exposes to a module's event handlers. */
export interface CellModuleActions {
  /** (Re)generate the activity content for this slot from the backend. */
  generate: (slotId: string) => void;
  /** Submit a multiple-choice answer (choice activities). */
  answerChoice: (slotId: string, selectedIndex: number) => void;
  /** Submit a free-text answer for LLM grading (open activities). */
  submitOpen: (slotId: string, answer: string) => void;
  /** Show/hide the slot (persisted). */
  setHidden: (slotId: string, hidden: boolean) => void;
  /** Update the in-memory + persisted record without a network call. */
  patchRecord: (slotId: string, patch: Partial<QuizRecord>) => void;
}
