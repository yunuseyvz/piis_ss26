/**
 * FlowQuest HUD banner — top of each notebook.
 *
 * After the Health-based rework this focuses on the single progression goal:
 * push Notebook Health from the baseline to >= 100. The banner surfaces a
 * prominent health bar, the Initialize button before baseline scoring, and
 * quick-jump tiles for open missions and region distribution.
 */

import type { NotebookPanel } from '@jupyterlab/notebook';

import { escapeHtml } from './api';
import type { AnalysisResponse, QuestState } from './types';

const HOST_CLASS = 'flowquest-banner';

interface BannerCallbacks {
  openSidebar: (tab?: 'quest' | 'workflow' | 'chat') => void;
  rescan: () => Promise<void>;
  initialize: () => Promise<void>;
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

  setInitializing(flag: boolean): void {
    this.initializing = flag;
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
    const initialized = Boolean(state?.initialized);
    const won = Boolean(state?.won);

    const health = state?.healthScore ?? 0;
    const target = state?.healthTarget ?? 100;
    const progress = Math.max(
      0,
      Math.min(100, Math.round((state?.healthProgress ?? 0) * 100))
    );
    const healthLabel = state?.healthLabel ?? '—';
    const healthClass = healthClassFor(health, won);
    const rank = state?.rankTitle ?? 'Notebook Novice';

    const missions = analysis?.missions ?? [];
    const completedSet = new Set(state?.completedAwardKeys ?? []);
    const openMissionCount = missions.filter(m => !completedSet.has(`mission:${m.id}`)).length;
    const quizCount = (analysis?.injectionPoints ?? []).length;

    const regionCounts = analysis?.regionCounts ?? {};
    const regionOrder = analysis?.regionOrder ?? [
      'setup',
      'load',
      'clean',
      'explore',
      'visualize',
      'model',
      'output',
      'narrative',
      'other'
    ];
    const regionIcons = analysis?.regionIcons ?? {};
    const activeRegions = regionOrder.filter(r => (regionCounts[r] ?? 0) > 0);
    const totalCells = Math.max(
      1,
      activeRegions.reduce((acc, r) => acc + (regionCounts[r] ?? 0), 0)
    );
    const regionSegments = activeRegions
      .map(region => {
        const count = regionCounts[region] ?? 0;
        const width = (count / totalCells) * 100;
        const icon = regionIcons[region] ?? '✨';
        return `
          <span
            class="flowquest-bannerRegionSeg flowquest-region-${escapeHtml(region)}"
            style="width: ${width.toFixed(2)}%"
            title="${escapeHtml(`${region}: ${count} cell${count === 1 ? '' : 's'}`)}"
            data-action="open-workflow"
          ><span class="flowquest-bannerRegionIcon">${escapeHtml(icon)}</span></span>
        `;
      })
      .join('');

    const winStripe = won ? 'is-win' : '';
    this.host.innerHTML = `
      <div class="flowquest-bannerInner ${winStripe}">
        <div class="flowquest-bannerBrand" data-action="open-sidebar">
          <span class="flowquest-bannerMark">${won ? '🏆' : '🗺️'}</span>
          <div>
            <div class="flowquest-bannerTitle">FlowQuest</div>
            <div class="flowquest-bannerSub">${escapeHtml(rank)}</div>
          </div>
        </div>

        <div class="flowquest-bannerHealthWrap ${healthClass}" data-action="open-quest">
          <div class="flowquest-bannerHealthTop">
            <span class="flowquest-bannerHealthLabel">Notebook Health</span>
            <span class="flowquest-bannerHealthStatus">${escapeHtml(
              won ? 'Complete 🏆' : healthLabel
            )}</span>
          </div>
          <div class="flowquest-bannerHealthBar">
            <div
              class="flowquest-bannerHealthBarFill ${won ? 'is-win' : ''}"
              style="width: ${progress}%"
            ></div>
            <span class="flowquest-bannerHealthBarMark" style="left: 100%">Goal</span>
          </div>
          <div class="flowquest-bannerHealthValue">
            <strong>${health}</strong><span> / ${target}</span>
            ${
              !won && initialized
                ? `<span class="flowquest-bannerHealthRemaining">· ${Math.max(
                    0,
                    target - health
                  )} to go</span>`
                : ''
            }
          </div>
        </div>

        ${
          !initialized
            ? `
              <button
                type="button"
                class="flowquest-bannerInitBtn"
                data-action="initialize"
                ${this.initializing ? 'disabled' : ''}
                title="FlowQuest will grade your notebook against fixed criteria and give you a baseline score."
              >${this.initializing ? '…scoring baseline' : '🚀 Initialize FlowQuest'}</button>
            `
            : `
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
            `
        }

        <button
          type="button"
          class="flowquest-bannerTile flowquest-bannerTile-regions"
          data-action="open-workflow"
          title="Open Workflow tab"
        >
          <div class="flowquest-bannerTileLabel">Regions</div>
          <div class="flowquest-bannerRegionBar">
            ${regionSegments || '<span class="flowquest-bannerRegionEmpty">scan pending</span>'}
          </div>
          <div class="flowquest-bannerTileFoot">${activeRegions.length} active · ${totalCells} cells</div>
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
        if (action === 'initialize') {
          void this.callbacks.initialize();
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
        if (action === 'open-workflow') {
          this.callbacks.openSidebar('workflow');
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
  private initializing = false;
  private host: HTMLElement;
}

function healthClassFor(health: number, won: boolean): string {
  if (won) return 'is-win';
  if (health >= 80) return 'is-thriving';
  if (health >= 55) return 'is-stable';
  if (health >= 30) return 'is-fragile';
  return 'is-critical';
}

function difficultyLabelFor(value: string): string {
  const normalized = (value || '').toLowerCase();
  if (normalized === 'easy') return '🌱 easy';
  if (normalized === 'hard') return '🔥 hard';
  return '🧗 medium';
}
