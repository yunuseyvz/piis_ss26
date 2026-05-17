import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';

import { apiRequest } from './api';
import { CellDecorator } from './cellDecorations';
import { NotebookBanner } from './notebookBanner';
import { buildAnalysisPayload, describeNotebook } from './notebookContext';
import { QuestCellRenderer } from './questCells';
import { QuestMetadataStore, EMPTY_QUEST_STATE } from './questStore';
import { SettingsPanel } from './settingsPanel';
import { AssistantSidebar } from './sidebar';
import type { AnalysisResponse, InitializeResponse, QuestState } from './types';

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

  const currentPanel = (): NotebookPanel | null => notebookTracker.currentWidget;
  const currentBundle = (): PanelBundle | null => {
    const panel = currentPanel();
    return panel ? bundles.get(panel) ?? null : null;
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
    applyState: state => {
      const panel = currentPanel();
      if (!panel) {
        return;
      }
      const bundle = bundles.get(panel);
      if (!bundle) {
        return;
      }
      bundle.state = withPanelIdentity(state, panel);
      bundle.store.write(bundle.state);
      bundle.banner.update(bundle.analysis, bundle.state);
    },
    getState: () => {
      const bundle = currentBundle();
      return bundle?.state ?? { ...EMPTY_QUEST_STATE };
    },
    getNotebookPath: () => currentPanel()?.context.path ?? '',
    initializeNotebook: async () => {
      const panel = currentPanel();
      if (!panel) {
        sidebar.flashToast('Open a notebook first.');
        return;
      }
      await initializeNotebook(panel);
    },
    openSettings: tab => settingsPanel.open(tab ?? 'global')
  });

  const settingsPanel = new SettingsPanel({
    getState: () => {
      const bundle = currentBundle();
      return bundle?.state ?? { ...EMPTY_QUEST_STATE };
    },
    applyState: state => {
      const panel = currentPanel();
      if (!panel) return;
      const bundle = bundles.get(panel);
      if (!bundle) return;
      bundle.state = withPanelIdentity(state, panel);
      bundle.store.write(bundle.state);
      bundle.banner.update(bundle.analysis, bundle.state);
      sidebar.updateQuestState(bundle.state);
      bundle.decorator.refresh(bundle.analysis, bundle.state);
      bundle.questCells.refresh(bundle.analysis);
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
      if (bundle) {
        sidebar.updateQuestState(bundle.state);
      }
    } else {
      sidebar.updateAnalysis(null);
      sidebar.updateQuestState({ ...EMPTY_QUEST_STATE });
    }
  };

  const analyze = async (panel: NotebookPanel, force = false): Promise<void> => {
    if (!panel.context.isReady) {
      await panel.context.ready;
    }
    sidebar.setAnalyzing(true);
    const bundlePre = bundles.get(panel);
    bundlePre?.banner.setAnalyzing(true);
    try {
      const bundle = bundles.get(panel);
      const payload = buildAnalysisPayload(panel);
      const rawState = bundle?.store.readRaw() ?? {};
      const response = await apiRequest<AnalysisResponse>('piis-assistant/analyze', {
        method: 'POST',
        body: JSON.stringify({ ...payload, state: rawState })
      });
      if (bundle) {
        bundle.analysis = response;
        bundle.state = withPanelIdentity(response.questState, panel);
        bundle.store.write(bundle.state);
        bundle.decorator.refresh(response, bundle.state);
        bundle.questCells.refresh(response);
        bundle.banner.update(response, bundle.state);
      }
      if (panel === currentPanel()) {
        sidebar.updateAnalysis(response);
        if (bundle) {
          sidebar.updateQuestState(bundle.state);
        }
      }
      if (force) {
        sidebar.flashToast('Scanned notebook.');
      }
    } catch (error) {
      sidebar.flashToast(`Analyze failed: ${(error as Error).message}`);
    } finally {
      sidebar.setAnalyzing(false);
      const bundle = bundles.get(panel);
      bundle?.banner.setAnalyzing(false);
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

  const initializeNotebook = async (panel: NotebookPanel): Promise<void> => {
    const bundle = bundles.get(panel);
    if (!bundle) {
      sidebar.flashToast('Notebook not ready yet.');
      return;
    }
    // Make sure we have a current analysis to grade against.
    if (!bundle.analysis) {
      await analyze(panel, false);
    }
    if (!bundle.analysis) {
      sidebar.flashToast('Scan the notebook first.');
      return;
    }
    sidebar.setInitializing(true);
    bundle.banner.setInitializing(true);
    try {
      const response = await apiRequest<InitializeResponse>('piis-assistant/initialize', {
        method: 'POST',
        body: JSON.stringify({
          state: bundle.store.readRaw(),
          analysis: bundle.analysis,
          notebookPath: panel.context.path
        })
      });
      bundle.state = withPanelIdentity(response.state, panel);
      bundle.store.write(bundle.state);
      bundle.banner.update(bundle.analysis, bundle.state);
      if (panel === currentPanel()) {
        sidebar.updateQuestState(bundle.state);
      }
      sidebar.flashToast(
        `Baseline: ${response.baseline.baselineHealth}/100${
          response.baseline.fallback ? ' (fallback scoring)' : ''
        }`
      );
      // Run another analyze pass now that we're initialized so auto-checks fire.
      void analyze(panel);
    } catch (error) {
      sidebar.flashToast(`Initialize failed: ${(error as Error).message}`);
    } finally {
      sidebar.setInitializing(false);
      bundle.banner.setInitializing(false);
    }
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
      // Hydrate the initial public view from raw metadata by asking the backend
      // (it normalizes and computes level/rank/progress).
      let initialState: QuestState = { ...EMPTY_QUEST_STATE };
      apiRequest<{ state: QuestState }>('piis-assistant/quest/init', {
        method: 'POST',
        body: JSON.stringify({ state: store.readRaw() })
      })
        .then(response => {
          const bundle = bundles.get(panel);
          if (!bundle) {
            return;
          }
          bundle.state = withPanelIdentity(response.state, panel);
          bundle.store.write(bundle.state);
          if (panel === currentPanel()) {
            sidebar.updateQuestState(bundle.state);
          }
          bundle.decorator.refresh(bundle.analysis, bundle.state);
          bundle.questCells.refresh(bundle.analysis);
          bundle.banner.update(bundle.analysis, bundle.state);
        })
        .catch(() => {
          /* ignore */
        });

      const decorator = new CellDecorator(panel, {
        getAnalysis: () => bundles.get(panel)?.analysis ?? null,
        getState: () => bundles.get(panel)?.state ?? { ...EMPTY_QUEST_STATE },
        getNotebookPath: () => panel.context.path,
        applyState: state => {
          const bundle = bundles.get(panel);
          if (!bundle) {
            return;
          }
          bundle.state = withPanelIdentity(state, panel);
          bundle.store.write(bundle.state);
          if (panel === currentPanel()) {
            sidebar.updateQuestState(bundle.state);
          }
          bundle.banner.update(bundle.analysis, bundle.state);
        },
        onXpGained: (amount, category) => {
          sidebar.flashToast(`+${amount} XP · ${category}`);
        },
        openSidebar: () => {
          app.shell.activateById(AssistantSidebar.ID);
        }
      });

      const questCells = new QuestCellRenderer({
        getAnalysis: () => bundles.get(panel)?.analysis ?? null,
        getState: () => bundles.get(panel)?.state ?? { ...EMPTY_QUEST_STATE },
        applyState: state => {
          const bundle = bundles.get(panel);
          if (!bundle) {
            return;
          }
          bundle.state = withPanelIdentity(state, panel);
          bundle.store.write(bundle.state);
          if (panel === currentPanel()) {
            sidebar.updateQuestState(bundle.state);
          }
          bundle.banner.update(bundle.analysis, bundle.state);
        },
        onXpGained: (amount, category, source) => {
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
        initialize: () => initializeNotebook(panel),
        openSettings: tab => settingsPanel.open(tab ?? 'notebook')
      });

      bundles.set(panel, {
        decorator,
        questCells,
        banner,
        analysis: null,
        state: initialState,
        store,
        analyzeTimer: null
      });

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
      bundles.delete(panel);
      if (panel === currentPanel()) {
        syncNotebookContext();
      }
    });
  };

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

function withPanelIdentity(state: QuestState, panel: NotebookPanel): QuestState {
  return {
    ...state,
    notebookKey: panel.context.path,
    notebookPath: panel.context.path
  };
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'FlowQuest — a gamified notebook companion for JupyterLab.',
  autoStart: true,
  requires: [ICommandPalette, INotebookTracker],
  activate
};

export default plugin;
