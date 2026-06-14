/**
 * FlowQuest settings panel — thin wrapper that mounts the React settings modal.
 */

import { ReactWidgetBase } from './ReactWidget';
import { SettingsModal } from './components/SettingsModal';
import { FlowQuestStore } from './state';
import type { DifficultyLevel, QuestState } from './types';

export interface SettingsPanelCallbacks {
  store: FlowQuestStore;
  getCurrentNotebookState: () => QuestState;
  setDifficulty: (level: DifficultyLevel) => void;
  flashToast: (message: string) => void;
  onFreshStart: () => void | Promise<void>;
}

export class SettingsPanel extends ReactWidgetBase {
  private callbacks: SettingsPanelCallbacks;
  private isOpen = false;
  private tab: 'global' | 'notebook' = 'global';

  constructor(callbacks: SettingsPanelCallbacks) {
    super();
    document.body.appendChild(this.host);
    this.callbacks = callbacks;
    this.render();
  }

  isVisible(): boolean {
    return this.isOpen;
  }

  open(tab: 'global' | 'notebook' = 'global'): void {
    this.isOpen = true;
    this.tab = tab;
    this.render();
  }

  close(): void {
    this.isOpen = false;
    this.render();
  }

  protected render(): void {
    this.root.render(
      <SettingsModal
        isOpen={this.isOpen}
        initialTab={this.tab}
        onClose={() => this.close()}
        store={this.callbacks.store}
        getCurrentNotebookState={this.callbacks.getCurrentNotebookState}
        setDifficulty={this.callbacks.setDifficulty}
        flashToast={this.callbacks.flashToast}
        onFreshStart={this.callbacks.onFreshStart}
      />
    );
  }
}
