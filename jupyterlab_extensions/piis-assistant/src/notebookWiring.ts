import { JupyterFrontEnd } from '@jupyterlab/application';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';

import { apiRequest } from './api';
import { AvatarAssistant } from './avatarAssistant';
import { NotebookBanner } from './notebookBanner';
import { buildAnalysisPayload, describeNotebook } from './notebookContext';
import { QuestCellRenderer } from './questCells';
import { QuestMetadataStore } from './questStore';
import { AssistantSidebar } from './sidebar';
import { SettingsPanel } from './settingsPanel';
import { HandbookPanel } from './handbookPanel';
import { FlowQuestStore } from './state';
import type { AnalysisResponse, QuestState } from './types';

export interface WiringDependencies {
  app: JupyterFrontEnd;
  store: FlowQuestStore;
  notebookTracker: INotebookTracker;
  sidebar: AssistantSidebar;
  settingsPanel: SettingsPanel;
  handbookPanel: HandbookPanel;
}

interface PanelBundle {
  avatar: AvatarAssistant;
  banner: NotebookBanner;
  questCells: QuestCellRenderer;
  metadata: QuestMetadataStore;
  analyzeTimer: number | null;
  pendingChanges: boolean;
}

export class NotebookWiring {
  private bundles = new WeakMap<NotebookPanel, PanelBundle>();
  private connected = new WeakSet<NotebookPanel>();
  private deps: WiringDependencies;

  constructor(deps: WiringDependencies) {
    this.deps = deps;
    this.deps.notebookTracker.forEach(panel => this.connectPanel(panel));
    this.deps.notebookTracker.widgetAdded.connect((_sender, panel) => {
      this.connectPanel(panel);
      this.syncNotebookContext();
    });
    this.deps.notebookTracker.currentChanged.connect(() => {
      this.syncNotebookContext();
      const panel = this.currentPanel();
      if (panel) {
        const path = panel.context.path;
        const slice = this.deps.store.getNotebookSlice(path);
        if (!slice.analysis) {
          this.scheduleAnalyze(panel, 200);
        }
      }
    });
    this.syncNotebookContext();
  }

  currentPanel = (): NotebookPanel | null => this.deps.notebookTracker.currentWidget;
  currentNotebookPath = (): string => this.currentPanel()?.context.path ?? '';

  currentNotebookState = (): QuestState => {
    const path = this.currentNotebookPath();
    if (!path) return this.deps.store.getGlobalState();
    return this.deps.store.getNotebookSlice(path).state;
  };

  notebookAnalysis = (panel: NotebookPanel | null): AnalysisResponse | null => {
    if (!panel) return null;
    return this.deps.store.getNotebookSlice(panel.context.path).analysis;
  };

  syncNotebookContext = (): void => {
    const panel = this.currentPanel();
    const path = panel?.context.path ?? '';
    this.deps.sidebar.setCurrentNotebook(describeNotebook(panel), path);
  };

  analyze = async (panel: NotebookPanel, force = false): Promise<void> => {
    if (!panel.context.isReady) {
      await panel.context.ready;
    }
    const path = panel.context.path;
    this.deps.store.setNotebookSlice(path, { analyzing: true });
    this.bundles.get(panel)?.banner.update();
    this.bundles.get(panel)?.avatar.setThinking(true);
    try {
      const payload = buildAnalysisPayload(panel);
      const response = await apiRequest<AnalysisResponse>('piis-assistant/analyze', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      this.deps.store.adoptGlobalState(response.questState);
      this.deps.store.setNotebookSlice(path, {
        analysis: response,
        analyzing: false,
        state: {
          ...response.questState,
          notebookKey: path,
          notebookPath: path,
          difficulty: this.bundles.get(panel)?.metadata.readDifficulty() ?? 'medium'
        }
      });
      const auto = response.autoCompleted ?? [];
      if (auto.length) {
        this.deps.sidebar.showAutoChecks(auto);
      }
      if (force) {
        this.deps.sidebar.flashToast('Scanned notebook.');
      }
    } catch (error) {
      this.deps.sidebar.flashToast(`Analyze failed: ${(error as Error).message}`);
      this.deps.store.setNotebookSlice(path, { analyzing: false });
    } finally {
      const bundle = this.bundles.get(panel);
      bundle?.banner.update();
      bundle?.avatar.setThinking(false);
    }
  };

  scheduleAnalyze = (panel: NotebookPanel, delay = 900): void => {
    const bundle = this.bundles.get(panel);
    if (!bundle) return;
    if (bundle.analyzeTimer !== null) {
      window.clearTimeout(bundle.analyzeTimer);
    }
    bundle.analyzeTimer = window.setTimeout(() => {
      bundle.analyzeTimer = null;
      void this.analyze(panel);
    }, delay);
  };

  connectPanel = (panel: NotebookPanel): void => {
    if (this.connected.has(panel)) return;
    this.connected.add(panel);

    const refreshIfCurrent = (): void => {
      if (panel === this.currentPanel()) this.syncNotebookContext();
    };

    panel.context.pathChanged.connect(refreshIfCurrent);
    panel.sessionContext.statusChanged.connect(refreshIfCurrent);
    panel.content.activeCellChanged.connect(refreshIfCurrent);

    void panel.context.ready.then(() => {
      const path = panel.context.path;
      const metadata = new QuestMetadataStore(panel);
      const difficulty = metadata.readDifficulty();

      this.deps.store.ensureNotebookSlice(path, {
        chat: metadata.readChat(),
        state: {
          ...this.deps.store.getGlobalState(),
          notebookKey: path,
          notebookPath: path,
          difficulty
        }
      });

      void Promise.all([panel.context.ready, panel.revealed]).then(() => {
        const slice = this.deps.store.getNotebookSlice(path);
        if (!slice.analysis) {
          this.scheduleAnalyze(panel, 1000);
        }
      });


      const questCells = new QuestCellRenderer({
        store: this.deps.store,
        notebookPath: path,
        getPanel: () => panel,
        getStore: () => metadata,
        isConfigured: () => this.deps.sidebar.isConfigured(),
        onXpGained: (amount, category, source) => {
          this.bundles.get(panel)?.avatar.celebrateXp(amount);
          this.deps.sidebar.flashToast(`+${amount} XP · ${source || category}`);
        }
      });

      const banner = new NotebookBanner(panel, {
        store: this.deps.store,
        openSidebar: tab => {
          if (!tab && this.deps.sidebar.isVisible) {
            void this.deps.app.commands.execute('application:toggle-right-area');
          } else {
            this.deps.app.shell.activateById(AssistantSidebar.ID);
            if (tab) {
              this.deps.sidebar.showTab(tab);
            }
          }
        },
        rescan: () => this.analyze(panel, true),
        openSettings: tab => this.deps.settingsPanel.open(tab ?? 'notebook'),
        openHandbook: () => this.deps.handbookPanel.open()
      });

      const avatar = new AvatarAssistant(panel, {
        store: this.deps.store,
        openSidebar: tab => {
          if (!tab && this.deps.sidebar.isVisible) {
            void this.deps.app.commands.execute('application:toggle-right-area');
          } else {
            this.deps.app.shell.activateById(AssistantSidebar.ID);
            if (tab) {
              this.deps.sidebar.showTab(tab);
            }
          }
        },
        focusCell: index => {
          const widget = panel.content.widgets[index];
          if (!widget) return;
          panel.content.activeCellIndex = index;
          widget.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
          widget.node.classList.add('flowquest-flash');
          window.setTimeout(() => widget.node.classList.remove('flowquest-flash'), 1400);
        },
        startPasteQuiz: snippet => {
          this.deps.app.shell.activateById(AssistantSidebar.ID);
          this.deps.sidebar.showTab('cell');
          void this.deps.sidebar.startPasteQuiz(snippet.code);
        }
      });

      this.bundles.set(panel, {
        questCells,
        banner,
        avatar,
        metadata,
        analyzeTimer: null,
        pendingChanges: false
      });

      panel.disposed.connect(() => {
        const bundle = this.bundles.get(panel);
        bundle?.questCells.dispose();
        bundle?.banner.dispose();
        bundle?.avatar.dispose();
        this.bundles.delete(panel);
        this.deps.store.removeNotebookSlice(path);
        if (panel === this.currentPanel()) {
          this.syncNotebookContext();
        }
      });
    });
  };

  saveChat = (messages: any[]): void => {
    const panel = this.currentPanel();
    if (!panel) return;
    const slice = this.deps.store.getNotebookSlice(panel.context.path);
    this.deps.store.setNotebookSlice(panel.context.path, {
      chat: messages,
      state: { ...slice.state }
    });
    this.bundles.get(panel)?.metadata.writeChat(messages);
  };

  writeDifficulty = (level: string): void => {
    const panel = this.currentPanel();
    if (!panel) return;
    const path = panel.context.path;
    const slice = this.deps.store.getNotebookSlice(path);
    this.bundles.get(panel)?.metadata.writeDifficulty(level as any);
    const nextState = {
      ...slice.state,
      difficulty: level as any,
      lastActiveTs: Date.now() / 1000
    };
    this.deps.store.setNotebookSlice(path, {
      state: nextState,
      chat: slice.chat,
      analysis: slice.analysis,
      analyzing: slice.analyzing
    });
  };

  freshStart = async (): Promise<void> => {
    this.deps.sidebar.flashToast('Resetting FlowQuest…');
    try {
      await this.deps.store.resetEverything();
    } catch (error) {
      this.deps.sidebar.flashToast(`Reset failed: ${(error as Error).message}`);
      return;
    }
    this.deps.notebookTracker.forEach(panel => {
      const bundle = this.bundles.get(panel);
      bundle?.metadata.clearAll();
      const path = panel.context.path;
      this.deps.store.setNotebookSlice(path, {
        state: {
          ...this.deps.store.getGlobalState(),
          notebookKey: path,
          notebookPath: path,
          difficulty: 'medium'
        },
        chat: [],
        analysis: null
      });
    });
    this.deps.sidebar.flashToast('Fresh start · everything reset.');
  };
}
