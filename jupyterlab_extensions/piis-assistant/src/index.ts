/**
 * FlowQuest plugin entry point.
 *
 * Owns the single `FlowQuestStore` instance, wires JupyterLab events to it,
 * and constructs the Lumino shell widgets that render the React UI.
 */

import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';

import { SettingsPanel } from './settingsPanel';
import { AssistantSidebar } from './sidebar';
import { HandbookPanel } from './handbookPanel';
import { FlowQuestStore } from './state';
import { NotebookWiring } from './notebookWiring';
import { registerCommands } from './commands';

const PLUGIN_ID = 'jupyterlab-piis-assistant:plugin';

async function activate(
  app: JupyterFrontEnd,
  palette: ICommandPalette,
  notebookTracker: INotebookTracker
): Promise<void> {
  const store = new FlowQuestStore();

  let wiring: NotebookWiring;

  const sidebar = new AssistantSidebar({
    store,
    getCurrentNotebookPath: () => wiring?.currentNotebookPath() ?? '',
    getCurrentNotebookCells: () => wiring?.currentNotebookCells() ?? [],
    refreshAnalysis: async () => {
      const panel = wiring?.currentPanel();
      if (!panel) {
        sidebar.flashToast('Open a notebook first.');
        return;
      }
      await wiring.analyze(panel, true);
    },
    focusCell: index => {
      const panel = wiring?.currentPanel();
      if (!panel) return;
      const widget = panel.content.widgets[index];
      if (!widget) return;
      panel.content.activeCellIndex = index;
      widget.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      widget.node.classList.add('flowquest-flash');
      window.setTimeout(() => widget.node.classList.remove('flowquest-flash'), 1400);
    },
    openSettings: tab => settingsPanel.open(tab ?? 'global'),
    openHandbook: () => handbookPanel.open(),
    saveChat: messages => wiring?.saveChat(messages)
  });

  const settingsPanel = new SettingsPanel({
    store,
    getCurrentNotebookState: () => wiring?.currentNotebookState() ?? store.getGlobalState(),
    setDifficulty: level => wiring?.writeDifficulty(level),
    flashToast: message => sidebar.flashToast(message),
    onFreshStart: () => wiring?.freshStart()
  });

  app.shell.add(sidebar, 'left', { rank: 880 });

  const handbookPanel = new HandbookPanel({});

  wiring = new NotebookWiring({
    app,
    store,
    notebookTracker,
    sidebar,
    settingsPanel,
    handbookPanel
  });

  // Hydrate the full profile (settings + progress) from the server BEFORE
  // any React tree renders, so the user never sees a flash of empty state.
  await store.loadInitial();

  registerCommands({
    app,
    palette,
    sidebar,
    analyzeCurrentNotebook: async () => {
      const panel = wiring.currentPanel();
      if (panel) await wiring.analyze(panel, true);
    },
    freshStart: () => wiring.freshStart(),
    requireNotebook: () => {
      if (!wiring.currentPanel()) {
        sidebar.flashToast('Open a notebook first.');
        return false;
      }
      return true;
    }
  });
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'FlowQuest — a gamified notebook companion for JupyterLab.',
  autoStart: true,
  requires: [ICommandPalette, INotebookTracker],
  activate
};

export default plugin;
