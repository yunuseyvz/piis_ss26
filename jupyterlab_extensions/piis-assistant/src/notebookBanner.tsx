/**
 * FlowQuest in-notebook banner — Lumino shell that mounts the React banner.
 *
 * The banner subscribes to the store for global + per-notebook state (the
 * `analyzing` flag lives on the notebook slice, not in this wrapper). The
 * wrapper owns the Lumino lifecycle and DOM placement.
 */

import type { NotebookPanel } from '@jupyterlab/notebook';

import { ReactWidgetBase } from './ReactWidget';
import { NotebookBanner as NotebookBannerComponent } from './components/NotebookBanner';
import { FlowQuestStore, useGlobalState, useNotebookState } from './state';

const HOST_CLASS = 'flowquest-banner';

interface BannerCallbacks {
  store: FlowQuestStore;
  openSidebar: (tab?: 'quest' | 'chat') => void;
  rescan: () => Promise<void>;
  openSettings: (tab?: 'global' | 'notebook') => void;
  openHandbook: () => void;
}

export class NotebookBanner extends ReactWidgetBase {
  private panel: NotebookPanel;
  private callbacks: BannerCallbacks;

  constructor(panel: NotebookPanel, callbacks: BannerCallbacks) {
    super();
    this.host.className = HOST_CLASS;
    this.panel = panel;
    this.callbacks = callbacks;
    this.attach();
    this.render();
    this.panel.disposed.connect(() => this.dispose());
    this.panel.content.modelChanged.connect(() => this.attach());
  }

  update(): void {
    this.attach();
    this.render();
  }

  /** No-op: the store drives the analyzing flag. Kept for API compatibility. */
  setAnalyzing(_value: boolean): void {
    /* no-op */
  }

  // dispose() is handled by base class

  private attach(): void {
    const notebookNode = this.panel.content.node;
    const cellsContainer =
      notebookNode.querySelector('.jp-Notebook-container') ??
      notebookNode.querySelector('.jp-WindowedPanel-outer') ??
      notebookNode;

    if (!cellsContainer) return;
    if (this.host.parentElement === cellsContainer && cellsContainer.firstChild === this.host) {
      return;
    }
    if (this.host.parentElement) {
      this.host.remove();
    }
    cellsContainer.insertBefore(this.host, cellsContainer.firstChild);
  }

  protected render(): void {
    const path = this.panel.context.path;
    this.root.render(
      <NotebookBannerComponent
        store={this.callbacks.store}
        notebookPath={path}
        useGlobalStateHook={useGlobalState}
        useNotebookStateHook={useNotebookState}
        onOpenSidebar={this.callbacks.openSidebar}
        onRescan={() => void this.callbacks.rescan()}
        onOpenSettings={this.callbacks.openSettings}
        onOpenHandbook={this.callbacks.openHandbook}
      />
    );
  }
}
