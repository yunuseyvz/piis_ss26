/**
 * FlowQuest floating avatar — Lumino shell that mounts the React avatar app.
 */

import type { NotebookPanel } from '@jupyterlab/notebook';

import { ReactWidgetBase } from './ReactWidget';

import {
  AvatarAssistant as AvatarAssistantComponent,
  type AvatarAssistantHandle,
  type PastedSnippet
} from './components/AvatarAssistant';
import { FlowQuestStore } from './state';
import type { AnalysisResponse, QuestState } from './types';

const HOST_CLASS = 'flowquest-avatarHost';

interface AvatarCallbacks {
  store: FlowQuestStore;
  openSidebar: (tab?: 'quest' | 'cell' | 'chat') => void;
  focusCell: (index: number) => void;
  startPasteQuiz: (snippet: PastedSnippet) => void;
}

export class AvatarAssistant extends ReactWidgetBase {
  private panel: NotebookPanel;
  private callbacks: AvatarCallbacks;
  private ref = { current: null as AvatarAssistantHandle | null };

  constructor(panel: NotebookPanel, callbacks: AvatarCallbacks) {
    super();
    this.host.className = HOST_CLASS;
    this.panel = panel;
    this.callbacks = callbacks;
    this.attach();
    this.render();
    this.panel.disposed.connect(() => this.dispose());
    this.panel.content.modelChanged.connect(() => this.attach());
  }

  // dispose() is handled by base class

  update(_analysis: AnalysisResponse | null, _state: QuestState | null): void {
    this.attach();
    this.render();
  }

  setThinking(thinking: boolean): void {
    this.ref.current?.setThinking(thinking);
  }

  flash(message: string): void {
    this.ref.current?.flash(message);
  }

  celebrateXp(amount: number): void {
    this.ref.current?.celebrateXp(amount);
  }

  reactToPaste(_code: string, _lineCount: number): void {
    // Paste handling lives in the React component.
  }

  private attach(): void {
    const notebookNode = this.panel.content.node;
    const cellsContainer =
      notebookNode.querySelector('.jp-Notebook-container') ??
      notebookNode.querySelector('.jp-WindowedPanel-outer') ??
      notebookNode;

    if (!cellsContainer) return;
    if (this.host.parentElement === cellsContainer) return;
    if (this.host.parentElement) {
      this.host.remove();
    }
    cellsContainer.appendChild(this.host);
  }

  protected render(): void {
    this.root.render(
      <AvatarAssistantComponent
        ref={this.ref}
        panelNode={this.panel.content.node}
        store={this.callbacks.store}
        onOpenSidebar={this.callbacks.openSidebar}
        onFocusCell={this.callbacks.focusCell}
        onStartPasteQuiz={this.callbacks.startPasteQuiz}
      />
    );
  }
}

export type { PastedSnippet };
