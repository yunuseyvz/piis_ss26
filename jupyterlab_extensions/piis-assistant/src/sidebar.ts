import { Widget } from '@lumino/widgets';

import { apiRequest, escapeHtml } from './api';
import type {
  AnalysisResponse,
  ClaimResponse,
  ConversationMessage,
  EndpointStatus,
  FlatIssue,
  InitializeResponse,
  Mission,
  NextStepsResponse,
  NotebookContext,
  QuestState,
  SidebarPhase,
  SidebarTab
} from './types';
import { EMPTY_QUEST_STATE, EMPTY_NOTEBOOK } from './notebookContext';

const SIDEBAR_ID = 'jupyterlab-piis-assistant:sidebar';
const MESSAGE_HISTORY_LIMIT = 10;

const MISSION_KIND_ICON: Record<string, string> = {
  exploration: '🧭',
  understanding: '🧠',
  stabilization: '🛠️',
  reflection: '🪞'
};

const EMPTY_STATUS: EndpointStatus = {
  configured: false,
  model: 'Unavailable',
  baseUrl: 'Unavailable',
  envFile: 'not found',
  message: 'Status has not been loaded yet.'
};

const INITIAL_MESSAGE: ConversationMessage = {
  role: 'assistant',
  content:
    'Welcome to FlowQuest. Press Initialize in the banner to get your Notebook Health baseline. Then claim missions, answer quizzes, and push Health to 100 to win.',
  meta: 'FlowQuest ready',
  includeInHistory: false
};

export interface SidebarCallbacks {
  refreshAnalysis: () => Promise<void>;
  focusCell: (index: number) => void;
  applyState: (state: QuestState) => void;
  getState: () => QuestState;
  getNotebookPath: () => string;
  initializeNotebook: () => Promise<void>;
  openSettings: (tab?: 'global' | 'notebook') => void;
}

export class AssistantSidebar extends Widget {
  static readonly ID = SIDEBAR_ID;

  constructor(private callbacks: SidebarCallbacks) {
    super();
    this.id = SIDEBAR_ID;
    this.title.label = 'FlowQuest';
    this.title.caption = 'FlowQuest — gamified notebook companion';
    this.title.closable = false;
    this.title.iconClass = 'flowquest-sidebarIcon';
    this.addClass('flowquest');
    this.addClass('flowquest-sidebar');
    this.render();
    void this.refreshStatus();
  }

  get phase(): SidebarPhase {
    return this._phase;
  }

  updateNotebookContext(context: NotebookContext): void {
    this._notebook = context;
    this.render();
  }

  updateAnalysis(analysis: AnalysisResponse | null): void {
    this._analysis = analysis;
    if (analysis?.questState) {
      this._questState = analysis.questState;
    }
    if (analysis?.autoCompleted?.length) {
      const total = analysis.autoCompleted.reduce((acc, m) => acc + (m.points || 0), 0);
      if (total > 0) {
        this.flashToast(
          `+${total} health from ${analysis.autoCompleted.length} auto-check(s)`
        );
      }
    }
    this.render();
  }

  updateQuestState(state: QuestState): void {
    this._questState = state;
    this.render();
  }

  setAnalyzing(isAnalyzing: boolean): void {
    this._analyzing = isAnalyzing;
    this.render();
  }

  setInitializing(flag: boolean): void {
    this._initializing = flag;
    this.render();
  }

  flashToast(message: string): void {
    this._toast = message;
    this.render();
    window.setTimeout(() => {
      if (this._toast === message) {
        this._toast = null;
        this.render();
      }
    }, 3200);
  }

  showTab(tab: SidebarTab): void {
    this._tab = tab;
    this.render();
  }

  async refreshStatus(): Promise<void> {
    this.render();
    try {
      this._status = await apiRequest<EndpointStatus>('piis-assistant/status', { method: 'GET' });
      this._meta = this._status.message;
    } catch (error) {
      this._status = {
        configured: false,
        model: 'Unavailable',
        baseUrl: 'Unavailable',
        envFile: 'not found',
        message: error instanceof Error ? error.message : 'Unknown error'
      };
      this._meta = this._status.message;
    }
    this.render();
  }

  async askAboutActiveCell(): Promise<void> {
    const prompt =
      this._notebook.contextMode === 'active-cell'
        ? 'Explain the attached active cell and tell me what I should inspect next.'
        : 'Explain the attached notebook context and tell me what I should inspect next.';
    this._tab = 'chat';
    await this.submitPrompt(prompt);
  }

  async explainSelectedOutput(): Promise<void> {
    this._tab = 'chat';
    const outputText = this._notebook.selectedOutput || this._notebook.activeOutput;
    if (!outputText) {
      this._phase = 'error';
      this._messages.push({
        role: 'assistant',
        content:
          'Select some output text, or focus a cell that already has output, before using the output explanation action.',
        meta: 'Output context required',
        includeInHistory: false
      });
      this._meta = 'There is no selected or active output to attach right now.';
      this.render();
      return;
    }
    await this.submitPrompt(
      'Explain the attached output in context and tell me what conclusion I should draw next.'
    );
  }

  private render(): void {
    this.node.innerHTML = `
      <div class="flowquest-shell">
        ${this.renderHeader()}
        ${this.renderTabs()}
        <div class="flowquest-body">
          ${this._tab === 'quest' ? this.renderQuestTab() : ''}
          ${this._tab === 'workflow' ? this.renderWorkflowTab() : ''}
          ${this._tab === 'chat' ? this.renderChatTab() : ''}
        </div>
        ${this._toast ? `<div class="flowquest-toast">${escapeHtml(this._toast)}</div>` : ''}
      </div>
    `;
    this.bindHandlers();
  }

  private renderHeader(): string {
    const statusClass = this._status.configured ? 'is-live' : 'is-missing';
    const state = this._questState ?? EMPTY_QUEST_STATE;
    const rank = state.rankTitle ?? 'Notebook Novice';
    const health = state.healthScore;
    const target = state.healthTarget || 100;
    const progress = Math.min(100, Math.round((state.healthProgress ?? 0) * 100));
    const won = state.won;
    return `
      <header class="flowquest-header">
        <div class="flowquest-brand">
          <span class="flowquest-brandMark">🗺️</span>
          <div class="flowquest-brandCopy">
            <div class="flowquest-brandTitle">FlowQuest</div>
            <div class="flowquest-brandSubtitle">${escapeHtml(rank)}</div>
          </div>
        </div>
        <div class="flowquest-headerMeta">
          <span class="flowquest-pill ${statusClass}">${escapeHtml(
            this._status.configured ? 'live' : 'missing'
          )}</span>
          ${
            won
              ? '<span class="flowquest-pill flowquest-pill-win">🏆 100%</span>'
              : `<span class="flowquest-pill flowquest-pill-muted">${escapeHtml(
                  state.healthLabel ?? '—'
                )}</span>`
          }
          <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="settings" title="Settings">⚙️</button>
          <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="refresh">↻</button>
        </div>
        <div class="flowquest-xpBar" title="${health} / ${target}">
          <div class="flowquest-xpBarFill ${won ? 'is-win' : ''}" style="width: ${progress}%"></div>
          <span class="flowquest-xpBarLabel">${health} / ${target} · ${escapeHtml(
            state.healthLabel ?? '—'
          )}</span>
        </div>
      </header>
    `;
  }

  private renderTabs(): string {
    const tabs: Array<{ id: SidebarTab; icon: string; label: string }> = [
      { id: 'quest', icon: '⭐', label: 'Quest' },
      { id: 'workflow', icon: '🗺️', label: 'Workflow' },
      { id: 'chat', icon: '💬', label: 'Chat' }
    ];
    return `
      <nav class="flowquest-tabs" role="tablist">
        ${tabs
          .map(
            tab => `
              <button
                type="button"
                role="tab"
                aria-selected="${this._tab === tab.id}"
                class="flowquest-tab ${this._tab === tab.id ? 'is-active' : ''}"
                data-action="tab"
                data-tab="${tab.id}"
              >
                <span class="flowquest-tabIcon">${escapeHtml(tab.icon)}</span>
                <span>${escapeHtml(tab.label)}</span>
              </button>
            `
          )
          .join('')}
      </nav>
    `;
  }

  private renderQuestTab(): string {
    const state = this._questState ?? EMPTY_QUEST_STATE;
    const analysis = this._analysis;
    const notebookLabel = this._notebook.hasNotebook ? this._notebook.notebookName : 'No notebook open';
    const notInitialized = !state.initialized;

    const health = state.healthScore;
    const target = state.healthTarget || 100;
    const remaining = Math.max(0, state.healthRemaining);
    const progress = Math.round((state.healthProgress ?? 0) * 100);
    const healthClass = healthClassFor(health, state.won);

    const missions = analysis?.missions ?? [];
    const completed = new Set(state.completedAwardKeys ?? []);
    const isMissionClaimed = (missionId: string): boolean =>
      completed.has(`mission:${missionId}`);
    const openMissions = missions.filter(m => !isMissionClaimed(m.id));

    const missionHtml = missions
      .map(mission => this.renderMissionCard(mission, isMissionClaimed(mission.id)))
      .join('');

    const criteriaHtml = (state.criteria ?? [])
      .map(criterion => {
        const budget = Math.max(1, criterion.budget);
        const earned = criterion.earned ?? 0;
        const pct = Math.min(100, Math.round((earned / budget) * 100));
        const baselineScore =
          criterion.baselineScore !== null && criterion.baselineScore !== undefined
            ? criterion.baselineScore
            : null;
        return `
          <li class="flowquest-critRow">
            <div class="flowquest-critHead">
              <span class="flowquest-critIcon">${escapeHtml(criterion.icon)}</span>
              <span class="flowquest-critLabel">${escapeHtml(criterion.label)}</span>
              <span class="flowquest-critValue">${earned}/${budget} pts${
                baselineScore !== null ? ` · baseline ${baselineScore}/10` : ''
              }</span>
            </div>
            <div class="flowquest-critBar">
              <div class="flowquest-critBarFill" style="width: ${pct}%"></div>
            </div>
          </li>
        `;
      })
      .join('');

    const awardLogHtml = (state.awardLog ?? [])
      .slice(-8)
      .reverse()
      .map(
        entry => `
          <li class="flowquest-awardLogEntry">
            <span class="flowquest-awardPoints">+${entry.points}</span>
            <span class="flowquest-awardLabel">${escapeHtml(entry.label)}</span>
          </li>
        `
      )
      .join('');

    return `
      <section class="flowquest-tabPanel">
        <div class="flowquest-card">
          <div class="flowquest-cardHead">
            <div>
              <div class="flowquest-eyebrow">Notebook</div>
              <div class="flowquest-cardTitle">${escapeHtml(notebookLabel)}</div>
            </div>
            <button type="button" class="flowquest-btn flowquest-btn-primary" data-action="analyze"
              ${this._analyzing ? 'disabled' : ''}>
              ${this._analyzing ? 'Scanning…' : '🔄 Re-scan'}
            </button>
          </div>

          ${
            notInitialized
              ? `
                <div class="flowquest-initCard">
                  <div class="flowquest-initCardHead">
                    <span class="flowquest-initMark">🧭</span>
                    <div>
                      <div class="flowquest-cardTitle">Start your quest</div>
                      <div class="flowquest-dim">
                        FlowQuest will grade your notebook against ${escapeHtml(
                          String(state.criteria.length || 7)
                        )} criteria and give you a baseline. Your mission: push Notebook Health to 100.
                      </div>
                    </div>
                  </div>
                  <button type="button" class="flowquest-btn flowquest-btn-primary flowquest-btn-big"
                    data-action="initialize" ${this._initializing ? 'disabled' : ''}>
                    ${this._initializing ? 'Scoring baseline…' : '🚀 Initialize FlowQuest'}
                  </button>
                </div>
              `
              : `
                <div class="flowquest-healthRow">
                  <div class="flowquest-healthCircle ${healthClass}">
                    <div class="flowquest-healthValue">${health}</div>
                    <div class="flowquest-healthHint">/ ${target}</div>
                  </div>
                  <div class="flowquest-healthCopy">
                    <div class="flowquest-healthLabel">${escapeHtml(state.healthLabel)}${
                      state.won ? ' · 🏆 won' : ''
                    }</div>
                    <div class="flowquest-healthSub">
                      ${
                        state.won
                          ? 'You pushed Notebook Health past 100. Well done.'
                          : `${remaining} health to reach 100 · ${openMissions.length} mission${
                              openMissions.length === 1 ? '' : 's'
                            } open.`
                      }
                    </div>
                    <div class="flowquest-bannerXpBar">
                      <div class="flowquest-bannerXpBarFill ${state.won ? 'is-win' : ''}" style="width: ${progress}%"></div>
                    </div>
                    ${
                      state.baselineNotes
                        ? `<div class="flowquest-dim flowquest-baselineNotes">${escapeHtml(
                            state.baselineNotes
                          )}</div>`
                        : ''
                    }
                  </div>
                </div>

                <ul class="flowquest-critList">${criteriaHtml}</ul>
              `
          }
        </div>

        <div class="flowquest-card">
          <div class="flowquest-cardHead">
            <div class="flowquest-cardTitle">Missions</div>
            <div class="flowquest-dim">${missions.length} total · ${openMissions.length} open</div>
          </div>
          ${
            missions.length
              ? `<ul class="flowquest-missionList">${missionHtml}</ul>`
              : '<div class="flowquest-dim">No missions yet. Run a scan to generate some.</div>'
          }
        </div>

        ${
          awardLogHtml
            ? `
              <div class="flowquest-card">
                <div class="flowquest-cardHead">
                  <div class="flowquest-cardTitle">Recent rewards</div>
                </div>
                <ul class="flowquest-awardLog">${awardLogHtml}</ul>
              </div>
            `
            : ''
        }

        <div class="flowquest-card">
          <div class="flowquest-cardHead">
            <div class="flowquest-cardTitle">What should I do next?</div>
            <button type="button" class="flowquest-btn" data-action="next-steps" ${
              !analysis || this._loadingNextSteps ? 'disabled' : ''
            }>
              ${this._loadingNextSteps ? 'Thinking…' : '✨ Ask FlowQuest'}
            </button>
          </div>
          ${
            this._nextSteps
              ? `<div class="flowquest-block">${escapeHtml(this._nextSteps)}</div>`
              : '<div class="flowquest-dim">Get three contextual next-step ideas grounded in your notebook.</div>'
          }
        </div>
      </section>
    `;
  }

  private renderMissionCard(mission: Mission, claimed: boolean): string {
    const points = mission.health_points || mission.xp;
    const kindIcon = MISSION_KIND_ICON[mission.kind] ?? '✨';
    const targets = mission.cell_indices.length
      ? `<div class="flowquest-missionTargets">Cells: ${mission.cell_indices
          .map(
            i => `<button type="button" class="flowquest-chipMini" data-action="focus-cell" data-index="${i}">#${
              i + 1
            }</button>`
          )
          .join(' ')}</div>`
      : '';
    return `
      <li class="flowquest-missionCard flowquest-mission-${escapeHtml(mission.kind)} ${
        claimed ? 'is-complete' : ''
      }">
        <div class="flowquest-missionHead">
          <span class="flowquest-missionKind">${kindIcon} ${escapeHtml(mission.kind)}</span>
          <span class="flowquest-missionXp">+${points} health</span>
        </div>
        <div class="flowquest-missionTitle">${escapeHtml(mission.title)}</div>
        <div class="flowquest-missionDesc">${escapeHtml(mission.description)}</div>
        ${targets}
        <div class="flowquest-missionHint">${escapeHtml(mission.completion_hint)}</div>
        <div class="flowquest-missionActions">
          <button
            type="button"
            class="flowquest-btn flowquest-btn-primary"
            data-action="claim"
            data-mission="${escapeHtml(mission.id)}"
            data-criterion="${escapeHtml(mission.criterion_id)}"
            data-points="${points}"
            data-label="${escapeHtml(mission.title)}"
            ${claimed ? 'disabled' : ''}
          >${claimed ? 'Claimed' : 'Claim +' + points}</button>
        </div>
      </li>
    `;
  }

  private renderWorkflowTab(): string {
    const analysis = this._analysis;
    if (!analysis) {
      return `
        <section class="flowquest-tabPanel">
          <div class="flowquest-card">
            <div class="flowquest-cardTitle">Workflow map</div>
            <div class="flowquest-dim">Open a notebook and run a scan to build the workflow map.</div>
            <button type="button" class="flowquest-btn flowquest-btn-primary" data-action="analyze">Scan now</button>
          </div>
        </section>
      `;
    }

    const regionCounts = analysis.regionCounts;
    const maxCount = Math.max(1, ...Object.values(regionCounts));
    const regions = analysis.regionOrder
      .filter(region => (regionCounts[region] ?? 0) > 0)
      .map(region => {
        const count = regionCounts[region] ?? 0;
        const icon = analysis.regionIcons[region] ?? '✨';
        const width = Math.max(6, Math.round((count / maxCount) * 100));
        return `
          <div class="flowquest-regionRow" data-region="${escapeHtml(region)}">
            <div class="flowquest-regionLabel"><span>${escapeHtml(icon)}</span> ${escapeHtml(region)}</div>
            <div class="flowquest-regionBar">
              <div class="flowquest-regionBarFill flowquest-region-${escapeHtml(region)}" style="width: ${width}%"></div>
            </div>
            <div class="flowquest-regionCount">${count}</div>
          </div>
        `;
      })
      .join('');

    const cellRows = analysis.cells
      .map(cell => {
        const worst = cell.issues.reduce<string>((acc, issue) => {
          if (issue.severity === 'error') return 'error';
          if (issue.severity === 'warn' && acc !== 'error') return 'warn';
          if (issue.severity === 'info' && acc === '') return 'info';
          return acc;
        }, '');
        return `
          <li class="flowquest-cellRow flowquest-region-${escapeHtml(cell.region)} ${
            worst ? `has-${worst}` : ''
          }">
            <button type="button" class="flowquest-cellRowBtn" data-action="focus-cell" data-index="${cell.index}">
              <span class="flowquest-cellRowIcon">${escapeHtml(cell.regionIcon)}</span>
              <span class="flowquest-cellRowIndex">#${cell.index + 1}</span>
              <span class="flowquest-cellRowSummary">${escapeHtml(cell.summary || '[empty]')}</span>
              <span class="flowquest-cellRowTags">
                ${cell.issues
                  .map(
                    issue =>
                      `<span class="flowquest-tag flowquest-tag-${issue.severity}" title="${escapeHtml(
                        issue.message
                      )}">${escapeHtml(issue.kind.replace(/_/g, ' '))}</span>`
                  )
                  .join('')}
              </span>
            </button>
          </li>
        `;
      })
      .join('');

    const issueList = analysis.issues
      .map(
        issue => `
          <li class="flowquest-issueEntry flowquest-issue-${issue.severity}">
            <button type="button" class="flowquest-issueBtn" data-action="focus-cell" data-index="${issue.cell_index}">
              <span class="flowquest-issueIcon">${escapeHtml(
                issue.severity === 'error' ? '🔥' : issue.severity === 'warn' ? '⚠️' : '💡'
              )}</span>
              <span>
                <strong>Cell ${issue.cell_index + 1}</strong> · ${escapeHtml(
                  issue.kind.replace(/_/g, ' ')
                )}
              </span>
              <span class="flowquest-dim">${escapeHtml(issue.message)}</span>
            </button>
          </li>
        `
      )
      .join('');

    return `
      <section class="flowquest-tabPanel">
        <div class="flowquest-card">
          <div class="flowquest-cardHead">
            <div class="flowquest-cardTitle">Region map</div>
            <div class="flowquest-dim">${analysis.summary.code_cells ?? 0} code · ${
              analysis.summary.markdown_cells ?? 0
            } md</div>
          </div>
          <div class="flowquest-regionList">${regions || '<div class="flowquest-dim">No regions classified yet.</div>'}</div>
        </div>

        <div class="flowquest-card">
          <div class="flowquest-cardHead">
            <div class="flowquest-cardTitle">Cells</div>
            <div class="flowquest-dim">${analysis.cells.length} total</div>
          </div>
          <ul class="flowquest-cellList">${cellRows}</ul>
        </div>

        <div class="flowquest-card">
          <div class="flowquest-cardHead">
            <div class="flowquest-cardTitle">Issues</div>
            <div class="flowquest-dim">${analysis.issues.length} detected</div>
          </div>
          ${
            analysis.issues.length
              ? `<ul class="flowquest-issueFeed">${issueList}</ul>`
              : '<div class="flowquest-dim">✨ No issues detected. Great shape.</div>'
          }
        </div>
      </section>
    `;
  }

  private renderChatTab(): string {
    const disabled = !this._status.configured || this._phase === 'loading';
    const statusClass = this._status.configured ? 'is-live' : 'is-missing';
    const items = [...this._messages];
    if (this._phase === 'loading') {
      items.push({
        role: 'assistant',
        content: 'Thinking…',
        meta: 'Waiting for model response',
        includeInHistory: false
      });
    }
    const messagesHtml = items
      .map(message => {
        const bubbleClass = message.role === 'user' ? 'is-user' : 'is-assistant';
        const label = message.role === 'user' ? 'You' : 'FlowQuest';
        return `
          <article class="flowquest-message ${bubbleClass}">
            <div class="flowquest-messageLabel">${escapeHtml(label)}</div>
            <div class="flowquest-bubble ${bubbleClass}">${escapeHtml(message.content)}</div>
            <div class="flowquest-messageMeta">${escapeHtml(message.meta)}</div>
          </article>
        `;
      })
      .join('');

    return `
      <section class="flowquest-tabPanel flowquest-chatPanel">
        <div class="flowquest-chatHeader">
          <div>
            <div class="flowquest-eyebrow">Notebook chat</div>
            <div class="flowquest-cardTitle">Ask anything · context is auto-attached</div>
          </div>
          <div class="flowquest-chatHeaderMeta">
            <span class="flowquest-pill ${statusClass}">${escapeHtml(
              this._status.configured ? 'live' : 'missing'
            )}</span>
            <span class="flowquest-pill flowquest-pill-muted">${escapeHtml(this._status.model)}</span>
            <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="clear-chat">New</button>
          </div>
        </div>

        <div class="flowquest-thread">${messagesHtml}</div>

        <div class="flowquest-compose">
          ${this.renderAttachedContext()}
          <textarea class="flowquest-textarea" data-field="prompt" placeholder="Ask FlowQuest…">${escapeHtml(
            this._prompt
          )}</textarea>
          <div class="flowquest-actionsRow">
            <button type="button" class="flowquest-btn flowquest-btn-primary" data-action="ask" ${
              disabled ? 'disabled' : ''
            }>Ask</button>
            <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="clear-prompt">Clear</button>
          </div>
          <div class="flowquest-dim">${escapeHtml(this._meta)}</div>
        </div>
      </section>
    `;
  }

  private renderAttachedContext(): string {
    const notebook = this._notebook;
    const badges: string[] = [];
    if (notebook.contextMode === 'active-cell') {
      badges.push(`Cell ${notebook.activeCellIndex + 1}`);
      badges.push(notebook.activeCellType);
    } else if (notebook.contextMode === 'whole-notebook') {
      badges.push('Notebook');
      badges.push(`${notebook.cellCount} cells`);
    } else {
      badges.push('Workspace');
    }
    badges.push(notebook.kernelStatus);

    return `
      <div class="flowquest-attached">
        <div class="flowquest-attachedHead">
          <div>
            <div class="flowquest-attachedTitle">Auto-attached context</div>
            <div class="flowquest-dim">Appended behind your message.</div>
          </div>
          <div class="flowquest-attachedBadges">
            ${badges.map(b => `<span class="flowquest-pill flowquest-pill-muted">${escapeHtml(b)}</span>`).join('')}
          </div>
        </div>
        <div class="flowquest-dim">${escapeHtml(notebook.path)}</div>
        <div class="flowquest-preview">${escapeHtml(notebook.attachmentPreview)}</div>
      </div>
    `;
  }

  private bindHandlers(): void {
    const textarea = this.node.querySelector<HTMLTextAreaElement>('textarea[data-field="prompt"]');
    if (textarea) {
      textarea.oninput = event => {
        this._prompt = (event.currentTarget as HTMLTextAreaElement).value;
      };
    }

    this.node.querySelectorAll<HTMLElement>('[data-action]').forEach(element => {
      element.onclick = () => {
        const action = element.dataset.action;
        if (action === 'tab') {
          this._tab = (element.dataset.tab as SidebarTab) ?? this._tab;
          this.render();
          return;
        }
        if (action === 'refresh') {
          void this.refreshStatus();
          return;
        }
        if (action === 'settings') {
          this.callbacks.openSettings('global');
          return;
        }
        if (action === 'analyze') {
          void this.callbacks.refreshAnalysis();
          return;
        }
        if (action === 'initialize') {
          void this.callbacks.initializeNotebook();
          return;
        }
        if (action === 'ask') {
          void this.submitPrompt();
          return;
        }
        if (action === 'clear-prompt') {
          this._prompt = '';
          this.render();
          return;
        }
        if (action === 'clear-chat') {
          this._messages = [INITIAL_MESSAGE];
          this._phase = 'idle';
          this._meta = this._status.message;
          this.render();
          return;
        }
        if (action === 'claim') {
          const missionId = element.dataset.mission ?? '';
          const criterionId = element.dataset.criterion ?? 'workflow_clarity';
          const points = Number(element.dataset.points ?? '0');
          const label = element.dataset.label ?? missionId;
          void this.claim(missionId, criterionId, points, label);
          return;
        }
        if (action === 'focus-cell') {
          const index = Number(element.dataset.index ?? '-1');
          if (index >= 0) {
            this.callbacks.focusCell(index);
          }
          return;
        }
        if (action === 'next-steps') {
          void this.loadNextSteps();
          return;
        }
      };
    });
  }

  private async claim(
    missionId: string,
    criterionId: string,
    points: number,
    label: string
  ): Promise<void> {
    try {
      const response = await apiRequest<ClaimResponse>('piis-assistant/mission/claim', {
        method: 'POST',
        body: JSON.stringify({
          state: this.callbacks.getState(),
          missionId,
          criterionId,
          points,
          label
        })
      });
      if (response.outcome?.granted) {
        this.flashToast(`+${response.outcome.pointsAwarded ?? 0} health`);
      }
      this._questState = response.state;
      this.callbacks.applyState(response.state);
      this.render();
    } catch (error) {
      this.flashToast(`Could not claim: ${(error as Error).message}`);
    }
  }

  private async loadNextSteps(): Promise<void> {
    if (!this._analysis) {
      return;
    }
    this._loadingNextSteps = true;
    this.render();
    try {
      const response = await apiRequest<NextStepsResponse>('piis-assistant/next-steps', {
        method: 'POST',
        body: JSON.stringify({ analysis: this._analysis })
      });
      this._nextSteps = response.suggestions;
    } catch (error) {
      this._nextSteps = `Could not load suggestions: ${(error as Error).message}`;
    } finally {
      this._loadingNextSteps = false;
      this.render();
    }
  }

  private historyPayload(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this._messages
      .filter(message => message.includeInHistory)
      .slice(-MESSAGE_HISTORY_LIMIT)
      .map(message => ({ role: message.role, content: message.content }));
  }

  private async submitPrompt(overridePrompt?: string): Promise<void> {
    const prompt = (overridePrompt ?? this._prompt).trim();
    if (!prompt) {
      this._phase = 'error';
      this._messages.push({
        role: 'assistant',
        content: 'Enter a prompt before sending a request.',
        meta: 'Prompt validation',
        includeInHistory: false
      });
      this._meta = 'Type something in the compose box.';
      this.render();
      return;
    }

    const context = this._notebook;
    this._messages.push({
      role: 'user',
      content: prompt,
      meta: context.attachmentLabel,
      includeInHistory: true
    });
    this._phase = 'loading';
    this._meta = `Attaching ${context.attachmentLabel.toLowerCase()}.`;
    this.render();

    try {
      const response = await apiRequest<{ response: string; model: string }>(
        'piis-assistant/chat',
        {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            history: this.historyPayload(),
            notebook: context
          })
        }
      );
      this._phase = 'ready';
      this._messages.push({
        role: 'assistant',
        content: response.response,
        meta: `Model: ${response.model}`,
        includeInHistory: true
      });
      this._meta = `Model: ${response.model}`;
      if (!overridePrompt) {
        this._prompt = '';
      }
    } catch (error) {
      this._phase = 'error';
      this._messages.push({
        role: 'assistant',
        content: error instanceof Error ? error.message : 'Unknown error',
        meta: 'Request failed',
        includeInHistory: false
      });
      this._meta = 'Check the root .env values and Jupyter server logs.';
    }

    this.render();
  }

  private _analysis: AnalysisResponse | null = null;
  private _analyzing = false;
  private _initializing = false;
  private _loadingNextSteps = false;
  private _messages: ConversationMessage[] = [INITIAL_MESSAGE];
  private _meta = 'Status has not been loaded yet.';
  private _nextSteps = '';
  private _notebook: NotebookContext = EMPTY_NOTEBOOK;
  private _phase: SidebarPhase = 'idle';
  private _prompt = '';
  private _questState: QuestState | null = null;
  private _status: EndpointStatus = EMPTY_STATUS;
  private _tab: SidebarTab = 'quest';
  private _toast: string | null = null;
}

function healthClassFor(health: number, won: boolean): string {
  if (won) return 'is-win';
  if (health >= 80) return 'is-thriving';
  if (health >= 55) return 'is-stable';
  if (health >= 30) return 'is-fragile';
  return 'is-critical';
}

export type { FlatIssue, InitializeResponse };
