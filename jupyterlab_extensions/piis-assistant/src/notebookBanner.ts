/**
 * FlowQuest HUD banner — top of each notebook.
 *
 * Simplified v3: shows XP score, missions count, and quick actions.
 * No baseline scoring, no health meter, no workflow map.
 */

import type { NotebookPanel } from '@jupyterlab/notebook';

import { escapeHtml, notebookAwardPrefix } from './api';
import type { AnalysisResponse, QuestState } from './types';

const HOST_CLASS = 'flowquest-banner';

interface BannerCallbacks {
  openSidebar: (tab?: 'quest' | 'chat') => void;
  rescan: () => Promise<void>;
  openSettings: (tab?: 'global' | 'notebook') => void;
  openHandbook: () => void;
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
    const xp = state?.xpTotal ?? 0;
    const level = state?.level ?? 1;
    const rank = state?.rankTitle ?? 'Notebook Novice';
    const progress = Math.max(0, Math.min(100, Math.round((state?.levelProgress ?? 0) * 100)));
    const toNext = state?.xpToNextLevel ?? 0;

    const meterHtml = `<span class="flowquest-levelMeterFill" style="width:${progress}%"></span>`;

    const missions = analysis?.missions ?? [];
    const completedSet = new Set(state?.completedAwardKeys ?? []);
    const awardPrefix = notebookAwardPrefix(state?.notebookPath);
    const openMissionCount = missions.filter(
      m => !completedSet.has(`${awardPrefix}mission:${m.id}`)
    ).length;
    const quizCount = (analysis?.injectionPoints ?? []).length;

    this.host.innerHTML = `
      <div class="flowquest-bannerInner">
        <button type="button" class="flowquest-bannerBrand" data-action="open-sidebar">
          <span class="flowquest-bannerMark">🗺️</span>
          <span class="flowquest-bannerBrandText">
            <span class="flowquest-bannerTitle">FlowQuest</span>
            <span class="flowquest-bannerSub">${escapeHtml(rank)}</span>
          </span>
        </button>

        <button type="button" class="flowquest-bannerLevel" data-action="open-quest" title="${xp} XP total">
          <span class="flowquest-bannerLevelTop">
            <span class="flowquest-bannerLevelBadge">Lv ${level}</span>
            <span class="flowquest-bannerLevelXp">${xp} XP</span>
          </span>
          <span class="flowquest-levelMeter">${meterHtml}</span>
          <span class="flowquest-bannerLevelFoot">${
            toNext > 0 ? `${toNext} XP to level ${level + 1}` : `Level ${level}`
          }</span>
        </button>

        <button
          type="button"
          class="flowquest-bannerMissions"
          data-action="open-quest"
          title="Open Quest tab"
        >
          <span class="flowquest-bannerMissionsLabel">Missions</span>
          <span class="flowquest-bannerMissionsValue">${openMissionCount}</span>
          <span class="flowquest-bannerMissionsFoot">${missions.length} total · ${quizCount} quiz${
            quizCount === 1 ? '' : 'zes'
          }</span>
        </button>

        <div class="flowquest-bannerActions">
          <button
            type="button"
            class="flowquest-bannerDifficulty"
            data-action="open-difficulty"
            title="Difficulty — click to change"
          >${escapeHtml(difficultyLabelFor(state?.difficulty ?? 'medium'))}</button>
          <button
            type="button"
            class="flowquest-bannerIconBtn"
            data-action="open-handbook"
            title="FlowQuest handbook"
          >📖</button>
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
        if (action === 'open-handbook') {
          this.callbacks.openHandbook();
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
