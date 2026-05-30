import { Widget } from '@lumino/widgets';

import { apiRequest, escapeHtml, notebookAwardPrefix } from './api';
import { renderMarkdown } from './markdown';
import { toFriendlyError, inlineSpinnerHtml, thinkingHtml } from './uiFeedback';
import type {
  AnalysisResponse,
  ClaimResponse,
  ConversationMessage,
  EndpointStatus,
  FlatIssue,
  FlowyQuiz,
  Mission,
  MissionKind,
  NextStepsResponse,
  NotebookContext,
  QuestState,
  QuizContent,
  SidebarPhase,
  SidebarTab
} from './types';
import { EMPTY_QUEST_STATE } from './questState';
import { EMPTY_NOTEBOOK } from './notebookContext';
import { renderFlowySvg } from './flowySprite';

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
    'Welcome to FlowQuest! Complete missions, answer quizzes, and collect XP to level up your notebook.',
  meta: 'FlowQuest ready',
  includeInHistory: false
};

export interface SidebarCallbacks {
  refreshAnalysis: () => Promise<void>;
  focusCell: (index: number) => void;
  applyState: (state: QuestState) => void;
  getState: () => QuestState;
  getNotebookPath: () => string;
  openSettings: (tab?: 'global' | 'notebook') => void;
  openHandbook: () => void;
  /** Persist the chat transcript into the active notebook's metadata. */
  saveChat: (messages: ConversationMessage[]) => void;
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

  /**
   * Switch the chat thread to a given notebook. Flushes the current transcript
   * to its notebook first, then adopts the new notebook's saved transcript.
   * Called by the host when the active notebook changes (and the store for the
   * new notebook is ready). Chat is stored per notebook in metadata.flowquest.
   */
  setActiveChat(notebookPath: string, saved: ConversationMessage[]): void {
    if (notebookPath === this._chatNotebookPath) {
      return;
    }
    if (this._chatNotebookPath) {
      this.persistChat();
    }
    this._chatNotebookPath = notebookPath;
    this._messages = saved.length ? [...saved] : [INITIAL_MESSAGE];
    this._phase = 'idle';
    this.render();
  }

  /** Save the current transcript into the active notebook (skips the canned
   * welcome-only state so we don't write empty chats). */
  private persistChat(): void {
    if (!this._chatNotebookPath) {
      return;
    }
    const hasRealTurns = this._messages.some(m => m.includeInHistory);
    this.callbacks.saveChat(hasRealTurns ? this._messages : []);
  }

  updateAnalysis(analysis: AnalysisResponse | null): void {
    this._analysis = analysis;
    if (analysis?.questState) {
      this._questState = analysis.questState;
    }
    if (analysis?.autoCompleted?.length) {
      const total = analysis.autoCompleted.reduce((acc, m) => acc + (m.xp || 0), 0);
      if (total > 0) {
        this.flashToast(
          `+${total} XP from ${analysis.autoCompleted.length} auto-check(s)`
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
    // Re-rendering rebuilds the whole subtree, which resets the scroll
    // position of the scrollable body. Capture it before and restore it after
    // so an action (claim, answer, etc.) doesn't yank the user back to the top.
    // Only restore within the same tab — switching tabs should start at the top.
    const prevBody = this.node.querySelector<HTMLElement>('.flowquest-body');
    const sameTab = this._renderedTab === this._tab;
    const prevScroll = prevBody && sameTab ? prevBody.scrollTop : 0;

    this.node.innerHTML = `
      <div class="flowquest-shell">
        ${this.renderHeader()}
        ${this.renderTabs()}
        <div class="flowquest-body">
          ${this._tab === 'quest' ? this.renderQuestTab() : ''}
          ${this._tab === 'flowy' ? this.renderFlowyTab() : ''}
          ${this._tab === 'chat' ? this.renderChatTab() : ''}
        </div>
        ${this._toast ? `<div class="flowquest-toast">${escapeHtml(this._toast)}</div>` : ''}
      </div>
    `;
    this.bindHandlers();
    this._renderedTab = this._tab;

    if (prevScroll > 0) {
      const body = this.node.querySelector<HTMLElement>('.flowquest-body');
      if (body) {
        body.scrollTop = prevScroll;
      }
    }
  }

  private renderHeader(): string {
    const statusClass = this._status.configured ? 'is-live' : 'is-missing';
    const state = this._questState ?? EMPTY_QUEST_STATE;
    const rank = state.rankTitle ?? 'Notebook Novice';
    const xp = state.xpTotal ?? 0;
    const level = state.level ?? 1;
    const progress = Math.max(0, Math.min(100, Math.round((state.levelProgress ?? 0) * 100)));
    const toNext = state.xpToNextLevel ?? 0;
    const meterHtml = `<span class="flowquest-levelMeterFill" style="width:${progress}%"></span>`;
    return `
      <header class="flowquest-header">
        <div class="flowquest-brand">
          <span class="flowquest-brandMark">🗺️</span>
          <div class="flowquest-brandCopy">
            <div class="flowquest-brandTitle">FlowQuest</div>
            <div class="flowquest-brandSubtitle">Lv ${level} · ${escapeHtml(rank)}</div>
          </div>
        </div>
        <div class="flowquest-headerMeta">
          <span class="flowquest-pill ${statusClass}">${escapeHtml(
            this._status.configured ? 'live' : 'missing'
          )}</span>
          <span class="flowquest-pill flowquest-pill-muted">${xp} XP</span>
          <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="handbook" title="Open the FlowQuest handbook">📖</button>
          <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="settings" title="Settings">⚙️</button>
          <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="refresh">↻</button>
        </div>
        <div class="flowquest-levelMeter" title="${state.xpIntoLevel ?? 0} / ${state.xpForNextLevel ?? 0} XP into level ${level}">
          ${meterHtml}
        </div>
        <div class="flowquest-levelMeterLabel">${
          toNext > 0 ? `${toNext} XP to level ${level + 1}` : `Level ${level}`
        }</div>
        ${this.renderCategoryChart()}
      </header>
    `;
  }

  /** Donut chart of XP distribution across the four categories (global). */
  private renderCategoryChart(): string {
    const state = this._questState ?? EMPTY_QUEST_STATE;
    const cats: Array<{ key: MissionKind; label: string; color: string }> = [
      { key: 'exploration', label: 'Exploration', color: 'var(--fq-exploration)' },
      { key: 'understanding', label: 'Understanding', color: 'var(--fq-understanding)' },
      { key: 'stabilization', label: 'Stabilization', color: 'var(--fq-stabilization)' },
      { key: 'reflection', label: 'Reflection', color: 'var(--fq-reflection)' }
    ];
    const total = cats.reduce((sum, cat) => sum + (state.xpByCategory?.[cat.key] ?? 0), 0);

    // Build the donut arcs. Each segment is a circle whose visible dash spans
    // its share of the ring; dashoffset shifts it to sit after the previous
    // segments. The <g> rotation makes 0% start at the top (12 o'clock).
    let cumulative = 0;
    const segments = cats
      .map(cat => {
        const value = state.xpByCategory?.[cat.key] ?? 0;
        const pct = total > 0 ? (value / total) * 100 : 0;
        if (pct <= 0) {
          return '';
        }
        const seg = `<circle class="flowquest-donutSeg" cx="18" cy="18" r="15.915" fill="none"
          stroke="${cat.color}" stroke-width="4.5"
          stroke-dasharray="${pct.toFixed(2)} ${(100 - pct).toFixed(2)}"
          stroke-dashoffset="${(-cumulative).toFixed(2)}" />`;
        cumulative += pct;
        return seg;
      })
      .join('');

    const donut = `
      <svg class="flowquest-donut" viewBox="0 0 36 36" role="img" aria-label="XP by category">
        <g transform="rotate(-90 18 18)">
          <circle class="flowquest-donutTrack" cx="18" cy="18" r="15.915" fill="none" stroke-width="4.5" />
          ${segments}
        </g>
      </svg>
    `;

    const legend = cats
      .map(cat => {
        const value = state.xpByCategory?.[cat.key] ?? 0;
        const pct = total > 0 ? Math.round((value / total) * 100) : 0;
        return `
          <div class="flowquest-donutLegendItem">
            <span class="flowquest-donutSwatch" style="background:${cat.color}"></span>
            <span class="flowquest-donutLegendPct">${pct}%</span>
            <span class="flowquest-donutLegendLabel">${escapeHtml(cat.label)}</span>
          </div>
        `;
      })
      .join('');

    return `
      <div class="flowquest-categoryChart" title="XP distribution across categories (global)">
        <div class="flowquest-donutWrap">
          ${donut}
          <span class="flowquest-donutCenter">XP</span>
        </div>
        <div class="flowquest-donutLegend">${legend}</div>
      </div>
    `;
  }

  private renderTabs(): string {
    const tabs: Array<{ id: SidebarTab; icon: string; label: string }> = [
      { id: 'quest', icon: '⭐', label: 'Quest' },
      { id: 'flowy', icon: '🤖', label: 'Flowy' },
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

    const missions = analysis?.missions ?? [];
    const completed = new Set(state.completedAwardKeys ?? []);
    const awardPrefix = notebookAwardPrefix(state.notebookPath);
    const isMissionClaimed = (missionId: string): boolean =>
      completed.has(`${awardPrefix}mission:${missionId}`);
    const openMissions = missions.filter(m => !isMissionClaimed(m.id));

    const missionHtml = missions
      .map(mission => this.renderMissionCard(mission, isMissionClaimed(mission.id)))
      .join('');

    const awardLogHtml = (state.awardLog ?? [])
      .slice(-8)
      .reverse()
      .map(
        entry => `
          <li class="flowquest-awardLogEntry">
            <span class="flowquest-awardPoints">+${entry.xp}</span>
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
              ${this._loadingNextSteps ? inlineSpinnerHtml('Thinking…') : '✨ Ask FlowQuest'}
            </button>
          </div>
          ${
            this._nextSteps
              ? `<div class="flowquest-block flowquest-md">${renderMarkdown(this._nextSteps)}</div>`
              : '<div class="flowquest-dim">Get three contextual next-step ideas grounded in your notebook.</div>'
          }
        </div>
      </section>
    `;
  }

  private renderMissionCard(mission: Mission, claimed: boolean): string {
    const points = mission.xp ?? 0;
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
          <span class="flowquest-missionXp">+${points} XP</span>
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
            data-category="${escapeHtml(mission.kind)}"
            data-points="${points}"
            data-label="${escapeHtml(mission.title)}"
            ${claimed ? 'disabled' : ''}
          >${claimed ? 'Claimed' : 'Claim +' + points}</button>
        </div>
      </li>
    `;
  }

  private renderFlowyTab(): string {
    const flowy = this._flowyQuiz;
    const generating = this._flowyGenerating;
    const hasNotebook = this._notebook.hasNotebook;

    const introCard = `
      <div class="flowquest-card flowquest-flowyIntro">
        <div class="flowquest-flowyAvatar">${this.flowyMark(56)}</div>
        <div>
          <div class="flowquest-cardTitle">Hi, I'm Flowy</div>
          <div class="flowquest-dim">
            I keep an eye on your notebook. I will occasionally quiz you to
            make sure you actually understand what you are doing.
          </div>
        </div>
      </div>
    `;

    const actionsCard = `
      <div class="flowquest-card">
        <div class="flowquest-cardHead">
          <div class="flowquest-cardTitle">Flowy actions</div>
        </div>
        <div class="flowquest-flowyActions">
          <button type="button" class="flowquest-btn flowquest-btn-primary"
            data-action="flowy-quiz-selection" ${generating || !hasNotebook ? 'disabled' : ''}>
            🎯 Quiz me on the active cell
          </button>
          <div class="flowquest-dim">
            Flowy reads your active cell (or the code you last pasted) and writes
            a fresh multiple-choice question about it. Correct answers earn XP.
          </div>
        </div>
      </div>
    `;

    let challengeCard = '';
    if (generating && !flowy) {
      challengeCard = `
        <div class="flowquest-card">
          ${thinkingHtml('Flowy is writing a question…')}
        </div>
      `;
    } else if (this._flowyError) {
      challengeCard = `
        <div class="flowquest-card">
          <div class="flowquest-inlineError">
            <div class="flowquest-inlineErrorHead">
              <span class="flowquest-inlineErrorIcon">⚠️</span>
              <span>${escapeHtml(this._flowyError)}</span>
            </div>
          </div>
        </div>
      `;
    } else if (flowy) {
      challengeCard = this.renderFlowyChallenge(flowy);
    }

    return `
      <section class="flowquest-tabPanel">
        ${introCard}
        ${actionsCard}
        ${challengeCard}
      </section>
    `;
  }

  private renderFlowyChallenge(flowy: FlowyQuiz): string {
    const quiz = flowy.quiz;
    const selected = flowy.selectedIndex;
    const locked = flowy.answeredCorrectly;
    const optionsHtml = quiz.options
      .map((option, idx) => {
        let optionClass = 'flowquest-quizOption';
        if (selected === idx) {
          optionClass += idx === quiz.correctIndex ? ' is-correct' : ' is-wrong';
        } else if (locked && idx === quiz.correctIndex) {
          optionClass += ' is-correct';
        }
        return `
          <li>
            <button type="button" class="${optionClass}" data-action="flowy-answer" data-index="${idx}" ${
              locked ? 'disabled' : ''
            }>
              <span class="flowquest-quizOptionLetter">${String.fromCharCode(65 + idx)}</span>
              <span class="flowquest-quizOptionText">${escapeHtml(option)}</span>
            </button>
          </li>
        `;
      })
      .join('');

    const feedback =
      selected !== null
        ? flowy.answeredCorrectly
          ? `<div class="flowquest-quizFeedback is-correct"><span class="flowquest-quizFeedbackIcon">✓</span><span><strong>Correct.</strong> ${escapeHtml(
              quiz.explanation
            )}</span></div>`
          : `<div class="flowquest-quizFeedback is-wrong"><span class="flowquest-quizFeedbackIcon">✗</span><span><strong>Not quite.</strong> ${escapeHtml(
              quiz.options[quiz.correctIndex] ?? ''
            )} is the right answer. ${escapeHtml(quiz.explanation)}</span></div>`
        : '';

    const xpLine = flowy.awardedXp
      ? `<div class="flowquest-quizXp">+${flowy.awardedXp} XP earned</div>`
      : '';

    return `
      <div class="flowquest-card">
        <div class="flowquest-cardHead">
          <div class="flowquest-cardTitle">${this.flowyMark(24)} Flowy's challenge</div>
        </div>
        <pre class="flowquest-flowySource">${escapeHtml(flowy.source)}</pre>
        <div class="flowquest-quizQuestion">${escapeHtml(quiz.question)}</div>
        <ul class="flowquest-quizOptions">${optionsHtml}</ul>
        ${feedback}
        ${xpLine}
        <div class="flowquest-actionsRow">
          <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="flowy-dismiss">Dismiss</button>
        </div>
      </div>
    `;
  }

  private renderChatTab(): string {
    const disabled = !this._status.configured || this._phase === 'loading';
    const configured = this._status.configured;
    const items = [...this._messages];
    if (this._phase === 'loading') {
      items.push({
        role: 'assistant',
        content: 'Thinking…',
        meta: 'Waiting for model response',
        includeInHistory: false
      });
    }

    // Only show real conversation turns in the thread; the canned welcome is
    // replaced by a friendlier Flowy empty-state below.
    const realTurns = items.filter(m => m.includeInHistory || m.meta === 'Waiting for model response');
    const hasConversation = realTurns.length > 0;

    const messagesHtml = realTurns
      .map(message => {
        const isUser = message.role === 'user';
        const isThinking =
          message.role === 'assistant' && message.meta === 'Waiting for model response';
        const bubbleContent = isThinking
          ? thinkingHtml('Thinking…')
          : isUser
            ? escapeHtml(message.content)
            : `<div class="flowquest-md">${renderMarkdown(message.content)}</div>`;
        return `
          <article class="flowquest-msg ${isUser ? 'is-user' : 'is-flowy'}">
            ${
              isUser
                ? ''
                : `<span class="flowquest-msgAvatar">${this.flowyMark(22)}</span>`
            }
            <div class="flowquest-msgBubble">${bubbleContent}</div>
          </article>
        `;
      })
      .join('');

    const emptyState = `
      <div class="flowquest-chatEmpty">
        <span class="flowquest-chatEmptyAvatar">${this.flowyMark(60)}</span>
        <div class="flowquest-chatEmptyTitle">Ask Flowy anything</div>
        <div class="flowquest-dim">
          I can see your whole notebook — every cell, its outputs, and which
          cell you're on right now. Ask away and I'll answer in full context.
        </div>
        <div class="flowquest-chatStarters">
          ${this.renderStarter('Explain the cell I’m on', 'starter-explain')}
          ${this.renderStarter('What should I do next?', 'starter-next')}
          ${this.renderStarter('Find problems in my notebook', 'starter-issues')}
        </div>
      </div>
    `;

    const banner = configured
      ? ''
      : `<div class="flowquest-chatNotice">
           ⚠️ No model configured yet.
           <button type="button" class="flowquest-linkBtn" data-action="open-settings">Open Settings</button>
         </div>`;

    return `
      <section class="flowquest-tabPanel flowquest-chatPanel">
        ${banner}
        <div class="flowquest-thread">
          ${hasConversation ? messagesHtml : emptyState}
        </div>

        <div class="flowquest-compose">
          ${this.renderContextChip()}
          <div class="flowquest-composeRow">
            <textarea
              class="flowquest-composeInput"
              data-field="prompt"
              rows="1"
              placeholder="Message Flowy…"
              ${disabled ? 'disabled' : ''}
            >${escapeHtml(this._prompt)}</textarea>
            <button type="button" class="flowquest-sendBtn" data-action="ask" title="Send" ${
              disabled ? 'disabled' : ''
            }>➤</button>
          </div>
          <div class="flowquest-composeFoot">
            <span class="flowquest-dim">${escapeHtml(this._meta || this._status.model || 'no model')}</span>
            ${
              hasConversation
                ? '<button type="button" class="flowquest-linkBtn" data-action="clear-chat">New chat</button>'
                : ''
            }
          </div>
        </div>
      </section>
    `;
  }

  private renderStarter(label: string, action: string): string {
    return `<button type="button" class="flowquest-starterChip" data-action="${action}">${escapeHtml(
      label
    )}</button>`;
  }

  /** Small Flowy mark for chat avatars / empty-state, reusing the sprite. */
  private flowyMark(size: number): string {
    return `<span class="flowquest-flowyMark">${renderFlowySvg('happy', {
      uid: `${this._flowyUid}-${size}`,
      width: size
    })}</span>`;
  }

  /** Compact, single-line context indicator — what Flowy will look at. */
  private renderContextChip(): string {
    const notebook = this._notebook;
    if (!notebook.hasNotebook) {
      return `
        <div class="flowquest-contextChip" title="Flowy automatically sees this context">
          <span class="flowquest-contextChipIcon">🗂️</span>
          <span class="flowquest-contextChipLabel">Workspace</span>
          <span class="flowquest-contextChipHint">no notebook</span>
        </div>
      `;
    }
    const cellNote =
      notebook.activeCellIndex >= 0
        ? `cell ${notebook.activeCellIndex + 1} active`
        : 'no active cell';
    return `
      <div class="flowquest-contextChip" title="Flowy sees your whole notebook plus which cell is active">
        <span class="flowquest-contextChipIcon">📓</span>
        <span class="flowquest-contextChipLabel">${escapeHtml(notebook.notebookName)}</span>
        <span class="flowquest-contextChipHint">${escapeHtml(
          `${notebook.cellCount} cells · ${cellNote}`
        )}</span>
      </div>
    `;
  }

  private bindHandlers(): void {
    const textarea = this.node.querySelector<HTMLTextAreaElement>('textarea[data-field="prompt"]');
    if (textarea) {
      textarea.oninput = event => {
        this._prompt = (event.currentTarget as HTMLTextAreaElement).value;
      };
      // Enter sends; Shift+Enter inserts a newline.
      textarea.onkeydown = event => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          void this.submitPrompt();
        }
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
        if (action === 'handbook') {
          this.callbacks.openHandbook();
          return;
        }
        if (action === 'analyze') {
          void this.callbacks.refreshAnalysis();
          return;
        }

        if (action === 'ask') {
          void this.submitPrompt();
          return;
        }
        if (action === 'clear-chat') {
          this._messages = [INITIAL_MESSAGE];
          this._phase = 'idle';
          this._meta = this._status.message;
          this.callbacks.saveChat([]);
          this.render();
          return;
        }
        if (action === 'claim') {
          const missionId = element.dataset.mission ?? '';
          const category = element.dataset.category ?? 'exploration';
          const points = Number(element.dataset.points ?? '0');
          const label = element.dataset.label ?? missionId;
          void this.claim(missionId, category, points, label);
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
        if (action === 'flowy-quiz-selection') {
          void this.startActiveCellQuiz();
          return;
        }
        if (action === 'flowy-answer') {
          const index = Number(element.dataset.index ?? '-1');
          if (index >= 0) {
            void this.answerFlowyQuiz(index);
          }
          return;
        }
        if (action === 'flowy-dismiss') {
          this._flowyQuiz = null;
          this._flowyError = null;
          this.render();
          return;
        }
        if (action === 'open-settings') {
          this.callbacks.openSettings('global');
          return;
        }
        if (action === 'starter-explain') {
          void this.askAboutActiveCell();
          return;
        }
        if (action === 'starter-next') {
          void this.submitPrompt(
            'Based on my current notebook, what should I work on next? Give me three concrete suggestions.'
          );
          return;
        }
        if (action === 'starter-issues') {
          void this.submitPrompt(
            'Look at my notebook and point out any problems, risks, or things I should double-check.'
          );
          return;
        }
      };
    });
  }

  private async claim(
    missionId: string,
    category: string,
    points: number,
    label: string
  ): Promise<void> {
    try {
      const response = await apiRequest<ClaimResponse>('piis-assistant/mission/claim', {
        method: 'POST',
        body: JSON.stringify({
          state: this.callbacks.getState(),
          notebookPath: this.callbacks.getNotebookPath(),
          missionId,
          category,
          xp: points,
          label
        })
      });
      if (response.outcome?.granted) {
        this.flashToast(`+${response.outcome.xpAwarded ?? 0} XP`);
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
        body: JSON.stringify({
          analysis: this._analysis,
          difficulty: this._questState?.difficulty
        })
      });
      this._nextSteps = response.suggestions;
    } catch (error) {
      this._nextSteps = `Could not load suggestions: ${(error as Error).message}`;
    } finally {
      this._loadingNextSteps = false;
      this.render();
    }
  }

  /**
   * Public entry point: Flowy caught a paste and the user tapped it. Open the
   * Flowy tab and generate a spontaneous quiz about the pasted code.
   */
  async startPasteQuiz(code: string): Promise<void> {
    this._tab = 'flowy';
    await this.generateFlowyQuiz(code, 'Pasted code');
  }

  /** Quiz the learner on the active cell's source (Flowy tab button). */
  private async startActiveCellQuiz(): Promise<void> {
    const source = this._notebook.activeCellSource;
    if (!source || !source.trim()) {
      this.flashToast('Focus a cell with code first.');
      return;
    }
    await this.generateFlowyQuiz(source, `Cell ${this._notebook.activeCellIndex + 1}`);
  }

  private async generateFlowyQuiz(code: string, sourceLabel: string): Promise<void> {
    this._flowyGenerating = true;
    this._flowyError = null;
    this._flowyQuiz = null;
    this.render();
    try {
      const quiz = await apiRequest<QuizContent>('piis-assistant/flowy/quiz', {
        method: 'POST',
        body: JSON.stringify({
          code,
          context: this._notebook.attachedPromptContext,
          difficulty: this._questState?.difficulty
        })
      });
      this._flowyQuiz = {
        challengeId: `flowy-${Date.now()}`,
        source: code.length > 600 ? `${code.slice(0, 600)}…` : code,
        quiz,
        selectedIndex: null,
        answeredCorrectly: false,
        awardedXp: 0
      };
    } catch (error) {
      this._flowyError = toFriendlyError(error).message;
    } finally {
      this._flowyGenerating = false;
      this.render();
    }
    void sourceLabel;
  }

  private async answerFlowyQuiz(selectedIndex: number): Promise<void> {
    const flowy = this._flowyQuiz;
    if (!flowy || flowy.answeredCorrectly) {
      return;
    }
    const correct = selectedIndex === flowy.quiz.correctIndex;
    flowy.selectedIndex = selectedIndex;
    flowy.answeredCorrectly = correct;
    this.render();
    try {
      const response = await apiRequest<ClaimResponse & { correct: boolean }>(
        'piis-assistant/flowy/quiz/answer',
        {
          method: 'POST',
          body: JSON.stringify({
            challengeId: flowy.challengeId,
            correct,
            notebookPath: this.callbacks.getNotebookPath()
          })
        }
      );
      if (response.outcome?.granted) {
        const awarded = response.outcome.xpAwarded ?? 0;
        flowy.awardedXp += awarded;
        this.flashToast(`+${awarded} XP · ${correct ? 'Flowy quiz correct' : 'Flowy quiz'}`);
      }
      this.callbacks.applyState(response.state);
    } catch (error) {
      this.flashToast(`Could not record answer: ${(error as Error).message}`);
    }
    this.render();
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
      this.persistChat();
    } catch (error) {
      this._phase = 'error';
      const friendly = toFriendlyError(error);
      this._messages.push({
        role: 'assistant',
        content: friendly.message,
        meta: friendly.kind === 'timeout' ? 'Timed out · try again' : 'Request failed',
        includeInHistory: false
      });
      this._meta = 'Open Settings to check the model endpoint, then retry.';
    }

    this.render();
  }

  private _analysis: AnalysisResponse | null = null;
  private _analyzing = false;
  private _loadingNextSteps = false;
  private _messages: ConversationMessage[] = [INITIAL_MESSAGE];
  private _chatNotebookPath = '';
  private _meta = 'Status has not been loaded yet.';
  private _nextSteps = '';
  private _notebook: NotebookContext = EMPTY_NOTEBOOK;
  private _phase: SidebarPhase = 'idle';
  private _prompt = '';
  private _renderedTab: SidebarTab | null = null;
  private _questState: QuestState | null = null;
  private _status: EndpointStatus = EMPTY_STATUS;
  private _tab: SidebarTab = 'quest';
  private _toast: string | null = null;
  private _flowyQuiz: FlowyQuiz | null = null;
  private _flowyGenerating = false;
  private _flowyError: string | null = null;
  private readonly _flowyUid = `fqs-${Math.random().toString(36).slice(2, 8)}`;
}

export type { FlatIssue };
