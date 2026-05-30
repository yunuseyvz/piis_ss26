import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';

import { apiRequest } from './api';
import { AvatarAssistant } from './avatarAssistant';
import { CellDecorator } from './cellDecorations';
import { NotebookBanner } from './notebookBanner';
import { buildAnalysisPayload, describeNotebook } from './notebookContext';
import { QuestCellRenderer } from './questCells';
import { QuestMetadataStore } from './questStore';
import { EMPTY_QUEST_STATE } from './questState';
import { SettingsPanel } from './settingsPanel';
import { AssistantSidebar } from './sidebar';
import type { AnalysisResponse, QuestState } from './types';

const PLUGIN_ID = 'jupyterlab-piis-assistant:plugin';
const COMMAND_FOCUS_SIDEBAR = 'jupyterlab-piis-assistant:focus-sidebar';
const COMMAND_SEND_ACTIVE_CELL = 'jupyterlab-piis-assistant:send-active-cell';
const COMMAND_EXPLAIN_OUTPUT = 'jupyterlab-piis-assistant:explain-selected-output';
const COMMAND_ANALYZE = 'jupyterlab-piis-assistant:analyze-notebook';
const COMMAND_OPEN_QUEST = 'jupyterlab-piis-assistant:open-quest-tab';

interface PanelBundle {
  decorator: CellDecorator;
  questCells: QuestCellRenderer;
  banner: NotebookBanner;
  avatar: AvatarAssistant;
  analysis: AnalysisResponse | null;
  state: QuestState;
  store: QuestMetadataStore;
  analyzeTimer: number | null;
}

function activate(
  app: JupyterFrontEnd,
  palette: ICommandPalette,
  notebookTracker: INotebookTracker
): void {
  const bundles = new WeakMap<NotebookPanel, PanelBundle>();
  const connected = new WeakSet<NotebookPanel>();
  // Open panels we can iterate over (WeakMap isn't iterable). Used to push the
  // shared global progression to every notebook at once.
  const openPanels = new Set<NotebookPanel>();

  // XP + Levels are GLOBAL (user-scoped, owned by the server). A single
  // in-memory mirror is shared by every open notebook; difficulty is the only
  // per-notebook field, merged in per panel.
  let globalState: QuestState = { ...EMPTY_QUEST_STATE };

  const currentPanel = (): NotebookPanel | null => notebookTracker.currentWidget;

  /** The global progression as seen by a specific notebook (adds its path +
   * per-notebook difficulty). */
  const mergedState = (panel: NotebookPanel): QuestState => {
    const bundle = bundles.get(panel);
    const difficulty = bundle?.store.readDifficulty() ?? 'medium';
    return {
      ...globalState,
      notebookKey: panel.context.path,
      notebookPath: panel.context.path,
      difficulty
    };
  };

  /** Re-render every open notebook's surfaces from the shared global state. */
  const propagateGlobalState = (): void => {
    openPanels.forEach(panel => {
      const bundle = bundles.get(panel);
      if (!bundle) {
        return;
      }
      bundle.state = mergedState(panel);
      bundle.banner.update(bundle.analysis, bundle.state);
      bundle.avatar.update(bundle.analysis, bundle.state);
      bundle.decorator.refresh(bundle.analysis, bundle.state);
      bundle.questCells.refresh(bundle.analysis);
    });
    const cur = currentPanel();
    const curBundle = cur ? bundles.get(cur) : null;
    sidebar.updateQuestState(curBundle ? curBundle.state : { ...globalState });
  };

  /** Adopt a fresh global progression (from the server) and fan it out. */
  const commitGlobalState = (incoming: QuestState): void => {
    globalState = { ...incoming };
    propagateGlobalState();
  };

  const sidebar = new AssistantSidebar({
    refreshAnalysis: async () => {
      const panel = currentPanel();
      if (!panel) {
        sidebar.flashToast('Open a notebook first.');
        return;
      }
      await analyze(panel, true);
    },
    focusCell: index => {
      const panel = currentPanel();
      if (!panel) {
        return;
      }
      const widget = panel.content.widgets[index];
      if (!widget) {
        return;
      }
      panel.content.activeCellIndex = index;
      widget.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      widget.node.classList.add('flowquest-flash');
      window.setTimeout(() => widget.node.classList.remove('flowquest-flash'), 1400);
    },
    applyState: state => commitGlobalState(state),
    getState: () => {
      const panel = currentPanel();
      return panel ? mergedState(panel) : { ...globalState };
    },
    getNotebookPath: () => currentPanel()?.context.path ?? '',
    openSettings: tab => settingsPanel.open(tab ?? 'global'),
    saveChat: messages => {
      const panel = currentPanel();
      if (!panel) {
        return;
      }
      bundles.get(panel)?.store.writeChat(messages);
    }
  });

  const settingsPanel = new SettingsPanel({
    getState: () => {
      const panel = currentPanel();
      return panel ? mergedState(panel) : { ...globalState };
    },
    applyState: state => commitGlobalState(state),
    setDifficulty: level => {
      const panel = currentPanel();
      if (!panel) return;
      const bundle = bundles.get(panel);
      if (!bundle) return;
      bundle.store.writeDifficulty(level);
      bundle.state = mergedState(panel);
      bundle.banner.update(bundle.analysis, bundle.state);
      sidebar.updateQuestState(bundle.state);
    },
    flashToast: message => sidebar.flashToast(message)
  });

  app.shell.add(sidebar, 'left', { rank: 880 });

  const syncNotebookContext = (): void => {
    const panel = currentPanel();
    sidebar.updateNotebookContext(describeNotebook(panel));
    if (panel) {
      const bundle = bundles.get(panel);
      sidebar.updateAnalysis(bundle?.analysis ?? null);
      sidebar.updateQuestState(bundle ? bundle.state : { ...globalState });
      // Swap the chat thread to this notebook (only once its store is ready).
      if (bundle) {
        sidebar.setActiveChat(panel.context.path, bundle.store.readChat());
      }
    } else {
      sidebar.updateAnalysis(null);
      sidebar.updateQuestState({ ...globalState });
      sidebar.setActiveChat('', []);
    }
  };

  const analyze = async (panel: NotebookPanel, force = false): Promise<void> => {
    if (!panel.context.isReady) {
      await panel.context.ready;
    }
    sidebar.setAnalyzing(true);
    const bundlePre = bundles.get(panel);
    bundlePre?.banner.setAnalyzing(true);
    bundlePre?.avatar.setThinking(true);
    try {
      const bundle = bundles.get(panel);
      const payload = buildAnalysisPayload(panel);
      const response = await apiRequest<AnalysisResponse>('piis-assistant/analyze', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (bundle) {
        bundle.analysis = response;
      }
      if (panel === currentPanel()) {
        sidebar.updateAnalysis(response);
      }
      // response.questState is the GLOBAL progression; adopt + fan out. This
      // also refreshes this panel's analysis-dependent surfaces.
      commitGlobalState(response.questState);
      if (force) {
        sidebar.flashToast('Scanned notebook.');
      }
    } catch (error) {
      sidebar.flashToast(`Analyze failed: ${(error as Error).message}`);
    } finally {
      sidebar.setAnalyzing(false);
      const bundle = bundles.get(panel);
      bundle?.banner.setAnalyzing(false);
      bundle?.avatar.setThinking(false);
    }
  };

  const scheduleAnalyze = (panel: NotebookPanel, delay = 900): void => {
    const bundle = bundles.get(panel);
    if (!bundle) {
      return;
    }
    if (bundle.analyzeTimer !== null) {
      window.clearTimeout(bundle.analyzeTimer);
    }
    bundle.analyzeTimer = window.setTimeout(() => {
      bundle.analyzeTimer = null;
      void analyze(panel);
    }, delay);
  };

  const connectPanel = (panel: NotebookPanel): void => {
    if (connected.has(panel)) {
      return;
    }
    connected.add(panel);

    const refreshIfCurrent = (): void => {
      if (panel === currentPanel()) {
        syncNotebookContext();
      }
    };
    const refreshOnSelection = (): void => {
      refreshIfCurrent();
    };

    panel.context.pathChanged.connect(refreshIfCurrent);
    panel.sessionContext.statusChanged.connect(refreshIfCurrent);
    panel.content.activeCellChanged.connect(refreshIfCurrent);

    void panel.context.ready.then(() => {
      const store = new QuestMetadataStore(panel);
      const initialState: QuestState = {
        ...globalState,
        notebookKey: panel.context.path,
        notebookPath: panel.context.path,
        difficulty: store.readDifficulty()
      };

      const decorator = new CellDecorator(panel, {
        getAnalysis: () => bundles.get(panel)?.analysis ?? null,
        getState: () => bundles.get(panel)?.state ?? { ...globalState },
        getNotebookPath: () => panel.context.path,
        applyState: state => commitGlobalState(state),
        onXpGained: (amount, category) => {
          bundles.get(panel)?.avatar.celebrateXp(amount);
          sidebar.flashToast(`+${amount} XP · ${category}`);
        },
        openSidebar: () => {
          app.shell.activateById(AssistantSidebar.ID);
        }
      });

      const questCells = new QuestCellRenderer({
        getAnalysis: () => bundles.get(panel)?.analysis ?? null,
        getState: () => bundles.get(panel)?.state ?? { ...globalState },
        applyState: state => commitGlobalState(state),
        onXpGained: (amount, category, source) => {
          bundles.get(panel)?.avatar.celebrateXp(amount);
          sidebar.flashToast(`+${amount} XP · ${source || category}`);
        },
        getPanel: () => panel,
        getStore: () => store
      });

      const banner = new NotebookBanner(panel, {
        openSidebar: tab => {
          app.shell.activateById(AssistantSidebar.ID);
          if (tab) {
            sidebar.showTab(tab);
          }
        },
        rescan: () => analyze(panel, true),
        openSettings: tab => settingsPanel.open(tab ?? 'notebook')
      });

      const avatar = new AvatarAssistant(panel, {
        openSidebar: tab => {
          app.shell.activateById(AssistantSidebar.ID);
          if (tab) {
            sidebar.showTab(tab);
          }
        },
        focusCell: index => {
          const widget = panel.content.widgets[index];
          if (!widget) {
            return;
          }
          panel.content.activeCellIndex = index;
          widget.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        },
        startPasteQuiz: snippet => {
          app.shell.activateById(AssistantSidebar.ID);
          sidebar.showTab('flowy');
          void sidebar.startPasteQuiz(snippet.code);
        }
      });

      bundles.set(panel, {
        decorator,
        questCells,
        banner,
        avatar,
        analysis: null,
        state: initialState,
        store,
        analyzeTimer: null
      });
      openPanels.add(panel);

      const model = panel.content.model;
      if (model) {
        model.cells.changed.connect(() => {
          refreshIfCurrent();
          scheduleAnalyze(panel, 1400);
        });
        for (let i = 0; i < model.cells.length; i += 1) {
          const cellModel = model.cells.get(i);
          cellModel.sharedModel.changed.connect(() => {
            scheduleAnalyze(panel, 1600);
          });
        }
      }

      refreshIfCurrent();
      scheduleAnalyze(panel, 300);
    });

    panel.content.node.addEventListener('mouseup', refreshOnSelection, { passive: true });
    panel.content.node.addEventListener('keyup', refreshOnSelection);

    panel.disposed.connect(() => {
      panel.content.node.removeEventListener('mouseup', refreshOnSelection);
      panel.content.node.removeEventListener('keyup', refreshOnSelection);
      const bundle = bundles.get(panel);
      if (bundle?.analyzeTimer !== null && bundle?.analyzeTimer !== undefined) {
        window.clearTimeout(bundle.analyzeTimer);
      }
      void bundle?.store.ensureSaved();
      bundle?.decorator.dispose();
      bundle?.questCells.detachAll();
      bundle?.banner.dispose();
      bundle?.avatar.dispose();
      bundles.delete(panel);
      openPanels.delete(panel);
      if (panel === currentPanel()) {
        syncNotebookContext();
      }
    });
  };

  // Hydrate the global progression from the server, then refresh surfaces.
  void apiRequest<{ state: QuestState }>('piis-assistant/quest/init', { method: 'GET' })
    .then(response => commitGlobalState(response.state))
    .catch(() => {
      /* offline / not configured — keep the empty state */
    });

  notebookTracker.forEach(connectPanel);
  notebookTracker.widgetAdded.connect((_sender, panel) => {
    connectPanel(panel);
    syncNotebookContext();
  });
  notebookTracker.currentChanged.connect(() => {
    syncNotebookContext();
    const panel = currentPanel();
    if (panel) {
      const bundle = bundles.get(panel);
      if (bundle && !bundle.analysis) {
        scheduleAnalyze(panel, 200);
      }
    }
  });
  syncNotebookContext();

  app.commands.addCommand(COMMAND_FOCUS_SIDEBAR, {
    label: 'FlowQuest: Focus Sidebar',
    execute: () => {
      app.shell.activateById(AssistantSidebar.ID);
    }
  });

  app.commands.addCommand(COMMAND_OPEN_QUEST, {
    label: 'FlowQuest: Open Quest Tab',
    execute: () => {
      app.shell.activateById(AssistantSidebar.ID);
      sidebar.showTab('quest');
    }
  });

  app.commands.addCommand(COMMAND_ANALYZE, {
    label: 'FlowQuest: Re-scan Current Notebook',
    execute: async () => {
      const panel = currentPanel();
      if (!panel) {
        sidebar.flashToast('Open a notebook first.');
        return;
      }
      app.shell.activateById(AssistantSidebar.ID);
      await analyze(panel, true);
    }
  });

  app.commands.addCommand(COMMAND_SEND_ACTIVE_CELL, {
    label: 'FlowQuest: Ask About Attached Context',
    execute: () => {
      app.shell.activateById(AssistantSidebar.ID);
      sidebar.showTab('chat');
      void sidebar.askAboutActiveCell();
    }
  });

  app.commands.addCommand(COMMAND_EXPLAIN_OUTPUT, {
    label: 'FlowQuest: Explain Selected Output',
    execute: () => {
      app.shell.activateById(AssistantSidebar.ID);
      sidebar.showTab('chat');
      void sidebar.explainSelectedOutput();
    }
  });

  palette.addItem({ command: COMMAND_FOCUS_SIDEBAR, category: 'FlowQuest' });
  palette.addItem({ command: COMMAND_OPEN_QUEST, category: 'FlowQuest' });
  palette.addItem({ command: COMMAND_ANALYZE, category: 'FlowQuest' });
  palette.addItem({ command: COMMAND_SEND_ACTIVE_CELL, category: 'FlowQuest' });
  palette.addItem({ command: COMMAND_EXPLAIN_OUTPUT, category: 'FlowQuest' });
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'FlowQuest — a gamified notebook companion for JupyterLab.',
  autoStart: true,
  requires: [ICommandPalette, INotebookTracker],
  activate
};

export default plugin;
