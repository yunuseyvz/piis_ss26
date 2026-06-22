import { JupyterFrontEnd } from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';

import { AssistantSidebar } from './sidebar';
import { ENABLE_CHAT_TAB } from './components/SidebarApp';

export const COMMAND_FOCUS_SIDEBAR = 'jupyterlab-piis-assistant:focus-sidebar';
export const COMMAND_SEND_ACTIVE_CELL = 'jupyterlab-piis-assistant:send-active-cell';
export const COMMAND_EXPLAIN_OUTPUT = 'jupyterlab-piis-assistant:explain-selected-output';
export const COMMAND_ANALYZE = 'jupyterlab-piis-assistant:analyze-notebook';
export const COMMAND_OPEN_QUEST = 'jupyterlab-piis-assistant:open-quest-tab';
export const COMMAND_FRESH_START = 'jupyterlab-piis-assistant:fresh-start';

export interface CommandDependencies {
  app: JupyterFrontEnd;
  palette: ICommandPalette;
  sidebar: AssistantSidebar;
  analyzeCurrentNotebook: () => Promise<void>;
  freshStart: () => Promise<void>;
  requireNotebook: () => boolean;
}

export function registerCommands(deps: CommandDependencies): void {
  const { app, palette, sidebar, analyzeCurrentNotebook, freshStart, requireNotebook } = deps;

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
      if (!requireNotebook()) return;
      app.shell.activateById(AssistantSidebar.ID);
      await analyzeCurrentNotebook();
    }
  });

  app.commands.addCommand(COMMAND_SEND_ACTIVE_CELL, {
    label: 'FlowQuest: Ask About Attached Context',
    isVisible: () => ENABLE_CHAT_TAB,
    execute: () => {
      app.shell.activateById(AssistantSidebar.ID);
      sidebar.showTab('chat');
      void sidebar.askAboutActiveCell();
    }
  });

  app.commands.addCommand(COMMAND_EXPLAIN_OUTPUT, {
    label: 'FlowQuest: Explain Selected Output',
    isVisible: () => ENABLE_CHAT_TAB,
    execute: () => {
      app.shell.activateById(AssistantSidebar.ID);
      sidebar.showTab('chat');
      void sidebar.explainSelectedOutput();
    }
  });

  app.commands.addCommand(COMMAND_FRESH_START, {
    label: 'FlowQuest: Fresh Start (Reset Everything)',
    execute: () => {
      void freshStart();
    }
  });

  palette.addItem({ command: COMMAND_FOCUS_SIDEBAR, category: 'FlowQuest' });
  palette.addItem({ command: COMMAND_OPEN_QUEST, category: 'FlowQuest' });
  palette.addItem({ command: COMMAND_ANALYZE, category: 'FlowQuest' });
  palette.addItem({ command: COMMAND_SEND_ACTIVE_CELL, category: 'FlowQuest' });
  palette.addItem({ command: COMMAND_EXPLAIN_OUTPUT, category: 'FlowQuest' });
  palette.addItem({ command: COMMAND_FRESH_START, category: 'FlowQuest' });
}
