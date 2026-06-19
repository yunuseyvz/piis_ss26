/**
 * FlowQuest sidebar — Lumino shell that mounts the React sidebar app.
 *
 * State comes from the `FlowQuestStore`; the wrapper just owns the React
 * root, the Lumino widget lifecycle, and the imperative methods that
 * `index.ts` calls.
 */

import { LuminoReactWidget } from './ReactWidget';
import { SidebarApp, type SidebarAppHandle, type SidebarAppProps } from './components/SidebarApp';
import { FlowQuestStore, StoreProvider } from './state';
import { EMPTY_NOTEBOOK } from './notebookContext';
import type { ConversationMessage, NotebookContext, SidebarTab } from './types';

const SIDEBAR_ID = 'jupyterlab-piis-assistant:sidebar';

export interface SidebarCallbacks {
  store: FlowQuestStore;
  getCurrentNotebookPath: () => string;
  getCurrentNotebookCells: () => Array<{ index: number; source: string }>;
  refreshAnalysis: () => Promise<void>;
  focusCell: (index: number) => void;
  openSettings: (tab?: 'global' | 'notebook') => void;
  openHandbook: () => void;
  saveChat: (messages: ConversationMessage[]) => void;
}

export class AssistantSidebar extends LuminoReactWidget {
  static readonly ID = SIDEBAR_ID;

  private appRef = { current: null as SidebarAppHandle | null };
  private callbacks: SidebarCallbacks;
  private notebook: NotebookContext = EMPTY_NOTEBOOK;
  private notebookPath: string = '';

  constructor(callbacks: SidebarCallbacks) {
    super();
    this.callbacks = callbacks;
    this.id = SIDEBAR_ID;
    this.title.label = 'FlowQuest';
    this.title.caption = 'FlowQuest — gamified notebook companion';
    this.title.closable = false;
    this.title.iconClass = 'flowquest-sidebarIcon';
    this.addClass('flowquest');
    this.addClass('flowquest-sidebar');
    this.renderReact();
  }

  /** Update the active notebook context (called on focus / path change). */
  setCurrentNotebook(context: NotebookContext, path: string): void {
    this.notebook = context;
    this.notebookPath = path;
    this.renderReact();
  }

  /** Kept for API compatibility; the sidebar reads analyzing from the store. */
  setAnalyzing(_value: boolean): void {
    /* no-op: analyzing lives in the store */
  }

  flashToast(message: string): void {
    this.appRef.current?.flashToast(message);
  }

  showTab(tab: SidebarTab): void {
    this.appRef.current?.showTab(tab);
    this.renderReact();
  }

  isConfigured(): boolean {
    return this.appRef.current?.isConfigured() ?? false;
  }

  async askAboutActiveCell(): Promise<void> {
    await this.appRef.current?.askAboutActiveCell();
  }

  async explainSelectedOutput(): Promise<void> {
    await this.appRef.current?.explainSelectedOutput();
  }

  async startPasteQuiz(code: string): Promise<void> {
    await this.appRef.current?.startPasteQuiz(code);
  }

  protected renderReact(): void {
    const { store, getCurrentNotebookPath, getCurrentNotebookCells, refreshAnalysis, focusCell, openSettings, openHandbook, saveChat } = this.callbacks;
    const props: SidebarAppProps = {
      store,
      callbacks: {
        refreshAnalysis,
        focusCell,
        applyState: state => store.adoptGlobalState(state, { force: true }),
        getState: () => store.getGlobalState(),
        getNotebookPath: getCurrentNotebookPath,
        getNotebookCells: getCurrentNotebookCells,
        openSettings,
        openHandbook,
        saveChat
      },
      notebook: this.notebook,
      notebookPath: this.notebookPath
    };
    this.root.render(
      <StoreProvider store={store}>
        <SidebarApp ref={this.appRef} {...props} />
      </StoreProvider>
    );
  }
}
