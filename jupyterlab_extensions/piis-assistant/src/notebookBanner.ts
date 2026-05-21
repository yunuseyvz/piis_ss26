/**
 * FlowQuest HUD banner — top of each notebook.
 *
 * Simplified v3: shows XP score, missions count, and quick actions.
 * No baseline scoring, no health meter, no workflow map.
 */

import type { NotebookPanel } from '@jupyterlab/notebook';

import { escapeHtml } from './api';
import type { AnalysisResponse, QuestState } from './types';

const HOST_CLASS = 'flowquest-banner';

interface BannerCallbacks {
  openSidebar: (tab?: 'quest' | 'chat') => void;
  rescan: () => Promise<void>;
  openSettings: (tab?: 'global' | 'notebook') => void;
}

export class NotebookBanner {
  constructor(private panel: NotebookPanel, private callbacks: BannerCallbacks) {
    this.host = document.createElement('div');
    this.host.className = HOST_CLASS;
    this.attach();
    this.panel.disposed.connect(() => this.dispose());
    this.panel.content.modelChanged.connect(() => this.attach());
  }

  update(analysis: AnalysisResponse | null, state: QuestState): void {
    this.analysis = analysis;
    this.state = state;
    this.attach();
    this.render();
  }

  setAnalyzing(isAnalyzing: boolean): void {
    this.analyzing = isAnalyzing;
    this.render();
  }

  dispose(): void {
    this.host.remove();
  }

  private attach(): void {
    const notebookNode = this.panel.content.node;
    const cellsContainer =
      notebookNode.querySelector('.jp-Notebook-container') ??
      notebookNode.querySelector('.jp-WindowedPanel-outer') ??
      notebookNode;

    if (!cellsContainer) {
      return;
    }
    if (this.host.parentElement === cellsContainer && cellsContainer.firstChild === this.host) {
      return;
    }
    if (this.host.parentElement) {
      this.host.remove();
    }
    cellsContainer.insertBefore(this.host, cellsContainer.firstChild);
  }

  private render(): void {
    const analysis = this.analysis;
    const state = this.state;
    const xp = state?.pointsEarned ?? 0;
    const rank = state?.rankTitle ?? 'Notebook Novice';

    const missions = analysis?.missions ?? [];
    const completedSet = new Set(state?.completedAwardKeys ?? []);
    const openMissionCount = missions.filter(m => !completedSet.has(`mission:${m.id}`)).length;
    const quizCount = (analysis?.injectionPoints ?? []).length;

    this.host.innerHTML = `
      <div class="flowquest-bannerInner">
        <div class="flowquest-bannerBrand" data-action="open-sidebar">
          <span class="flowquest-bannerMark">🗺️</span>
          <div>
            <div class="flowquest-bannerTitle">FlowQuest</div>
            <div class="flowquest-bannerSub">${escapeHtml(rank)}</div>
          </div>
        </div>

        <button
          type="button"
          class="flowquest-bannerTile flowquest-bannerTile-level"
          data-action="open-quest"
          title="Open Quest tab"
        >
          <div class="flowquest-bannerTileLabel">XP Score</div>
          <div class="flowquest-bannerTileValue">${xp}</div>
          <div class="flowquest-bannerTileFoot">collect more by completing missions</div>
        </button>

        <button
          type="button"
          class="flowquest-bannerTile flowquest-bannerTile-missions"
          data-action="open-quest"
          title="Open Quest tab"
        >
          <div class="flowquest-bannerTileLabel">Missions</div>
          <div class="flowquest-bannerTileValue">${openMissionCount}</div>
          <div class="flowquest-bannerTileFoot">${missions.length} total · ${quizCount} quiz${
            quizCount === 1 ? '' : 'zes'
          }</div>
        </button>

        <div class="flowquest-bannerActions">
          <span class="flowquest-bannerDifficulty"
            data-action="open-difficulty"
            title="Difficulty — click to change"
          >${escapeHtml(difficultyLabelFor(state?.difficulty ?? 'medium'))}</span>
          <button
            type="button"
            class="flowquest-bannerIconBtn"
            data-action="open-settings"
            title="FlowQuest settings"
          >⚙️</button>
          <button
            type="button"
            class="flowquest-bannerIconBtn"
            data-action="rescan"
            title="Re-scan notebook"
            ${this.analyzing ? 'disabled' : ''}
          >${this.analyzing ? '…' : '↻'}</button>
          <button
            type="button"
            class="flowquest-bannerIconBtn"
            data-action="open-sidebar"
            title="Open FlowQuest sidebar"
          >▸</button>
        </div>
      </div>
    `;

    this.host.querySelectorAll<HTMLElement>('[data-action]').forEach(element => {
      element.onclick = event => {
        event.stopPropagation();
        const action = element.dataset.action;
        if (action === 'rescan') {
          void this.callbacks.rescan();
          return;
        }
        if (action === 'open-settings') {
          this.callbacks.openSettings('global');
          return;
        }
        if (action === 'open-difficulty') {
          this.callbacks.openSettings('notebook');
          return;
        }
        if (action === 'open-quest') {
          this.callbacks.openSidebar('quest');
          return;
        }
        this.callbacks.openSidebar();
      };
    });
  }

  private analysis: AnalysisResponse | null = null;
  private state: QuestState | null = null;
  private analyzing = false;
  private host: HTMLElement;
}

function difficultyLabelFor(value: string): string {
  const normalized = (value || '').toLowerCase();
  if (normalized === 'easy') return '🌱 easy';
  if (normalized === 'hard') return '🔥 hard';
  return '🧗 medium';
}
