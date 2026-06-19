/**
 * FlowQuest handbook — thin wrapper that mounts the React handbook modal.
 */

import { ReactWidgetBase } from './ReactWidget';
import { HandbookModal } from './components/HandbookModal';

export interface HandbookPanelOptions {
}

export class HandbookPanel extends ReactWidgetBase {
  private isOpen = false;
  private chapterId: string | undefined;
  constructor(options: HandbookPanelOptions = {}) {
    super();
    document.body.appendChild(this.host);
    this.render();
  }

  isVisible(): boolean {
    return this.isOpen;
  }

  open(chapterId?: string): void {
    this.chapterId = chapterId;
    this.isOpen = true;
    this.render();
  }

  close(): void {
    this.isOpen = false;
    this.render();
  }

  protected render(): void {
    this.root.render(
      <HandbookModal
        isOpen={this.isOpen}
        initialChapter={this.chapterId}
        onClose={() => this.close()}
      />
    );
  }
}
