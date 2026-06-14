/**
 * Main React application for the FlowQuest sidebar.
 *
 * Subscribes to the `FlowQuestStore` for global progression and per-notebook
 * state. All mutations go through the store; this component is a pure view
 * with local state for transient UI (active tab, chat composer, Flowy
 * quizzes, toasts, etc.).
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react';

import { apiRequest } from '../api';
import { EMPTY_NOTEBOOK } from '../notebookContext';
import { useGlobalState, useNotebookState, useEndpointStatus } from '../state';
import type { FlowQuestStore } from '../state';
import type {
  ConversationMessage,
  FlowyQuiz,
  Mission,
  NextStepsResponse,
  NotebookContext,
  QuizContent,
  SidebarTab,
  MissionKind
} from '../types';
import { toFriendlyError } from '../uiFeedback';

import { AnimatedNumber, CategoryChart, Icon, XpMeter } from './shared';
import { ChatTab } from './sidebar/ChatTab';
import { QuestTab } from './sidebar/QuestTab';
import { CellTab } from './sidebar/CellTab';

const MESSAGE_HISTORY_LIMIT = 10;



const INITIAL_MESSAGE: ConversationMessage = {
  role: 'assistant',
  content:
    'Welcome to FlowQuest! Complete missions, answer quizzes, and collect XP to level up your notebook.',
  meta: 'FlowQuest ready',
  includeInHistory: false
};

export interface SidebarAppProps {
  store: FlowQuestStore;
  callbacks: {
    refreshAnalysis: () => Promise<void>;
    focusCell: (index: number) => void;
    applyState: (state: import('../types').QuestState) => void;
    getState: () => import('../types').QuestState;
    getNotebookPath: () => string;
    openSettings: (tab?: 'global' | 'notebook') => void;
    openHandbook: () => void;
    saveChat: (messages: ConversationMessage[]) => void;
  };
  notebook: NotebookContext;
  notebookPath: string;
}

export interface AutoCheckNotification {
  id: string;
  awardKey: string;
  category: MissionKind;
  xp: number;
  label: string;
}

export interface SidebarAppHandle {
  showTab: (tab: SidebarTab) => void;
  flashToast: (message: string) => void;
  askAboutActiveCell: () => Promise<void>;
  explainSelectedOutput: () => Promise<void>;
  startPasteQuiz: (code: string) => Promise<void>;
  isConfigured: () => boolean;
  getMessages: () => ConversationMessage[];
  showAutoChecks: (checks: Array<{ awardKey: string; category: MissionKind; xp: number; label: string }>) => void;
}

export const SidebarApp = forwardRef<SidebarAppHandle, SidebarAppProps>(
  function SidebarApp(
    { store, callbacks, notebook, notebookPath },
    ref
  ) {
    const globalState = useGlobalState(store);

    const slice = useNotebookState(store, notebookPath);
    const analysis = slice.analysis;
    const analyzing = slice.analyzing;
    const questState = slice.state;
    const savedChat = slice.chat;

    const [tab, setTab] = useState<SidebarTab>('quest');
    const status = useEndpointStatus(store);
    const [toast, setToast] = useState<string | null>(null);
    const toastTimer = useRef<number | null>(null);
    const renderedTabRef = useRef<SidebarTab | null>(null);

    const [autoChecks, setAutoChecks] = useState<AutoCheckNotification[]>([]);

    const [messages, setMessages] = useState<ConversationMessage[]>(
      savedChat.length ? [...savedChat] : [INITIAL_MESSAGE]
    );

    // C2 fix: reset the chat state when the active notebook changes.
    const prevPathRef = useRef(notebookPath);
    useEffect(() => {
      if (prevPathRef.current !== notebookPath) {
        prevPathRef.current = notebookPath;
        setMessages(savedChat.length ? [...savedChat] : [INITIAL_MESSAGE]);
        setPhase('idle');
      }
    }, [notebookPath, savedChat]);
    const [prompt, setPrompt] = useState('');
    const [phase, setPhase] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');

    const [flowyQuiz, setFlowyQuiz] = useState<FlowyQuiz | null>(null);
    const [flowyGenerating, setFlowyGenerating] = useState(false);
    const [flowyError, setFlowyError] = useState<string | null>(null);

    const [nextSteps, setNextSteps] = useState('');
    const [loadingNextSteps, setLoadingNextSteps] = useState(false);

    const [claiming, setClaiming] = useState<Set<string>>(new Set());
    const [claimErrors, setClaimErrors] = useState<Map<string, string>>(new Map());

    // Load endpoint status once on mount.
    useEffect(() => {
      void store.checkEndpointStatus();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const flashToast = useCallback((message: string) => {
      setToast(message);
      if (toastTimer.current !== null) {
        window.clearTimeout(toastTimer.current);
      }
      toastTimer.current = window.setTimeout(() => {
        setToast(null);
        toastTimer.current = null;
      }, 3200);
    }, []);

    const showTab = useCallback((next: SidebarTab) => setTab(next), []);

    const showAutoChecks = useCallback((checks: Array<{ awardKey: string; category: MissionKind; xp: number; label: string }>) => {
      if (!checks.length) return;
      const newChecks = checks.map(c => ({ ...c, id: Math.random().toString(36).substring(2, 9) }));
      setAutoChecks(prev => [...prev, ...newChecks]);
      window.setTimeout(() => {
        setAutoChecks(prev => prev.filter(p => !newChecks.find(n => n.id === p.id)));
      }, 5500);
    }, []);

    useImperativeHandle(ref, () => ({
      showTab,
      flashToast,
      askAboutActiveCell: () => askAboutActiveCell(),
      explainSelectedOutput: () => explainSelectedOutput(),
      startPasteQuiz: (code: string) => startPasteQuiz(code),
      isConfigured: () => status.configured,
      getMessages: () => messages,
      showAutoChecks
    }));

    const onClaim = async (mission: Mission) => {
      const id = mission.id;
      setClaiming(prev => new Set([...prev, id]));
      setClaimErrors(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      try {
        const response = await store.claimMission({
          notebookPath: callbacks.getNotebookPath(),
          missionId: id,
          category: mission.kind,
          xp: mission.xp,
          label: mission.title
        });
        if (response.outcome?.granted) {
          flashToast(`+${response.outcome.xpAwarded ?? 0} XP`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not claim';
        setClaimErrors(prev => new Map([...prev, [id, message]]));
      } finally {
        setClaiming(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    };

    const loadNextSteps = async () => {
      if (!analysis) return;
      setLoadingNextSteps(true);
      try {
        const response: NextStepsResponse = await store.loadNextSteps(analysis);
        setNextSteps(response.suggestions);
      } catch (error) {
        setNextSteps(`Could not load suggestions: ${(error as Error).message}`);
      } finally {
        setLoadingNextSteps(false);
      }
    };

    const historyPayload = (): Array<{ role: 'user' | 'assistant'; content: string }> =>
      messages
        .filter(m => m.includeInHistory)
        .slice(-MESSAGE_HISTORY_LIMIT)
        .map(m => ({ role: m.role, content: m.content }));

    async function submitPromptInternal(overridePrompt?: string): Promise<void> {
      const text = (overridePrompt ?? prompt).trim();
      if (!text) {
        setPhase('error');
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            content: 'Enter a prompt before sending a request.',
            meta: 'Prompt validation',
            includeInHistory: false
          }
        ]);
        return;
      }

      const context = notebook;
      setMessages(prev => [
        ...prev,
        {
          role: 'user',
          content: text,
          meta: context.attachmentLabel,
          includeInHistory: true
        }
      ]);
      setPhase('loading');

      try {
        const response = await apiRequest<{ response: string; model: string }>(
          'piis-assistant/chat',
          {
            method: 'POST',
            body: JSON.stringify({
              prompt: text,
              history: historyPayload(),
              notebook: context
            })
          }
        );
        setPhase('ready');
        // C3 fix: use functional update consistently to avoid stale-closure
        // message duplication. The user message was already pushed above, so
        // we only append the assistant reply here.
        setMessages(prev => {
          const updated = [
            ...prev,
            {
              role: 'assistant' as const,
              content: response.response,
              meta: `Model: ${response.model}`,
              includeInHistory: true
            }
          ];
          callbacks.saveChat(updated);
          return updated;
        });
        if (!overridePrompt) {
          setPrompt('');
        }
      } catch (error) {
        setPhase('error');
        const friendly = toFriendlyError(error);
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            content: friendly.message,
            meta: friendly.kind === 'timeout' ? 'Timed out · try again' : 'Request failed',
            includeInHistory: false
          }
        ]);
      }
    }
    const submitPrompt = submitPromptInternal;
    void submitPrompt;

    async function askAboutActiveCell(): Promise<void> {
      setTab('chat');
      const promptText =
        notebook.contextMode === 'active-cell'
          ? 'Explain the attached active cell and tell me what I should inspect next.'
          : 'Explain the attached notebook context and tell me what I should inspect next.';
      await submitPromptInternal(promptText);
    }

    async function explainSelectedOutput(): Promise<void> {
      setTab('chat');
      const outputText = notebook.selectedOutput || notebook.activeOutput;
      if (!outputText) {
        setPhase('error');
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            content:
              'Select some output text, or focus a cell that already has output, before using the output explanation action.',
            meta: 'Output context required',
            includeInHistory: false
          }
        ]);
        return;
      }
      await submitPromptInternal(
        'Explain the attached output in context and tell me what conclusion I should draw next.'
      );
    }

    async function startActiveCellQuiz(): Promise<void> {
      const source = notebook.activeCellSource;
      if (!source || !source.trim()) {
        flashToast('Focus a cell with code first.');
        return;
      }
      await generateFlowyQuiz(source);
    }

    async function generateFlowyQuiz(code: string): Promise<void> {
      setFlowyGenerating(true);
      setFlowyError(null);
      setFlowyQuiz(null);
      try {
        const quiz = await apiRequest<QuizContent>('piis-assistant/flowy/quiz', {
          method: 'POST',
          body: JSON.stringify({
            code,
            context: notebook.attachedPromptContext,
            difficulty: globalState.difficulty
          })
        });
        setFlowyQuiz({
          challengeId: `flowy-${Date.now()}`,
          source: code.length > 600 ? `${code.slice(0, 600)}…` : code,
          quiz,
          selectedIndex: null,
          answeredCorrectly: false,
          awardedXp: 0
        });
      } catch (error) {
        setFlowyError(toFriendlyError(error).message);
      } finally {
        setFlowyGenerating(false);
      }
    }

    async function startPasteQuiz(code: string): Promise<void> {
      setTab('cell');
      await generateFlowyQuiz(code);
    }

    const answerFlowyQuiz = async (selectedIndex: number) => {
      if (!flowyQuiz || flowyQuiz.answeredCorrectly) return;
      const correct = selectedIndex === flowyQuiz.quiz.correctIndex;
      const updated: FlowyQuiz = {
        ...flowyQuiz,
        selectedIndex,
        answeredCorrectly: correct
      };
      setFlowyQuiz(updated);
      try {
        const response = await store.answerFlowyQuiz({
          challengeId: flowyQuiz.challengeId,
          correct,
          notebookPath: callbacks.getNotebookPath()
        });
        if (response.outcome?.granted) {
          const awarded = response.outcome.xpAwarded ?? 0;
          setFlowyQuiz(prev => (prev ? { ...prev, awardedXp: prev.awardedXp + awarded } : prev));
          flashToast(`+${awarded} XP · ${correct ? 'Flowy quiz correct' : 'Flowy quiz'}`);
          if (correct) {
            window.setTimeout(() => {
              setFlowyQuiz(null);
              setFlowyError(null);
            }, 1200);
          }
        }
      } catch (error) {
        flashToast(`Could not record answer: ${(error as Error).message}`);
      }
    };

    const clearChat = () => {
      setMessages([INITIAL_MESSAGE]);
      setPhase('idle');
      callbacks.saveChat([]);
    };

    const onChatStarter = (starter: 'explain' | 'next' | 'issues') => {
      const prompts: Record<typeof starter, string> = {
        explain: "Explain the cell I'm on",
        next: 'What should I do next?',
        issues: 'Find problems in my notebook'
      };
      void submitPromptInternal(prompts[starter]);
    };

    const tabs: Array<{ id: SidebarTab; icon: 'quest' | 'chat' | 'flowy'; label: string }> = [
      { id: 'quest', icon: 'quest', label: 'Quest' },
      { id: 'cell', icon: 'flowy', label: 'Cell' },
      { id: 'chat', icon: 'chat', label: 'Chat' }
    ];
    const activeIndex = Math.max(0, tabs.findIndex(t => t.id === tab));

    const statusClass = status.configured ? 'is-live' : 'is-missing';
    const bodyRef = useRef<HTMLDivElement>(null);
    const sameTab = renderedTabRef.current === tab;

    useEffect(() => {
      renderedTabRef.current = tab;
    }, [tab]);

    return (
      <div className="flowquest-shell">

        <header className="flowquest-header">
          <div className="flowquest-brand">
            <span className="flowquest-brandMark">
              <Icon name="brand" size={18} />
            </span>
            <div className="flowquest-brandCopy">
              <div className="flowquest-brandTitle">FlowQuest</div>
              <div className="flowquest-brandSubtitle">
                Lv {globalState.level} · {globalState.rankTitle}
              </div>
            </div>
          </div>
          <div className="flowquest-headerMeta">
            <span className={`flowquest-pill ${statusClass}`}>
              {status.configured ? 'LLM ready' : 'LLM not configured'}
            </span>
            <span className="flowquest-pill flowquest-pill-xp" title="Total XP">
              <span className="flowquest-xpIcon"><Icon name="star" size={12} /></span>
              <AnimatedNumber value={globalState.xpTotal} itemKey="sidebar:xp" /> XP
            </span>
            <div className="flowquest-headerActions">
              <button
                type="button"
                className="flowquest-btn-action"
                onClick={callbacks.openHandbook}
                title="Open the FlowQuest handbook"
              >
                <Icon name="handbook" size={14} />
              </button>
              <button
                type="button"
                className="flowquest-btn-action"
                onClick={() => callbacks.openSettings('global')}
                title="Settings"
              >
                <Icon name="settings" size={14} />
              </button>
            </div>
          </div>
          <XpMeter
            level={globalState.level}
            xpIntoLevel={globalState.xpIntoLevel}
            xpForNextLevel={globalState.xpForNextLevel}
            xpToNextLevel={globalState.xpToNextLevel}
            levelProgress={globalState.levelProgress}
            fillKey="sidebar:level"
          />
          <CategoryChart state={globalState} />
        </header>

        <nav className="flowquest-tabs" role="tablist" style={{ '--fq-tab-index': activeIndex } as React.CSSProperties}>
          {tabs.map(t => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`flowquest-tab ${tab === t.id ? 'is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <span className="flowquest-tabIcon">
                <Icon name={t.icon} />
              </span>
              <span>{t.label}</span>
            </button>
          ))}
          <span className="flowquest-tabIndicator" aria-hidden="true" />
        </nav>

        <div className={`flowquest-body${sameTab ? '' : ' is-enter'}`} ref={bodyRef}>
          {tab === 'quest' && (
            <QuestTab
              store={store}
              state={questState}
              analysis={analysis}
              analyzing={analyzing}
              configured={status.configured}
              callbacks={{
                refreshAnalysis: callbacks.refreshAnalysis,
                focusCell: callbacks.focusCell,
                applyState: callbacks.applyState,
                getState: callbacks.getState
              }}
              nextSteps={nextSteps}
              loadingNextSteps={loadingNextSteps}
              onLoadNextSteps={loadNextSteps}
              onClaim={onClaim}
              claiming={claiming}
              claimErrors={claimErrors}
            />
          )}
          {tab === 'cell' && (
            <CellTab
              store={store}
              notebook={notebook}
              globalState={globalState}
              configured={status.configured}
              flowyQuiz={flowyQuiz}
              flowyGenerating={flowyGenerating}
              flowyError={flowyError}
              onStartActiveCellQuiz={startActiveCellQuiz}
              onAnswerFlowyQuiz={answerFlowyQuiz}
              onDismissFlowyQuiz={() => {
                setFlowyQuiz(null);
                setFlowyError(null);
              }}
            />
          )}
          {tab === 'chat' && (
            <ChatTab
              configured={status.configured}
              notebook={notebook}
              messages={messages}
              prompt={prompt}
              phase={phase}
              onPromptChange={setPrompt}
              onSubmit={() => void submitPromptInternal()}
              onClear={clearChat}
              onStarter={onChatStarter}
            />
          )}
        </div>

        {autoChecks.length > 0 && (
          <div className="flowquest-autoCheckStack">
            {autoChecks.map(check => (
              <div key={check.id} className="flowquest-autoCheckToast is-animating">
                <Icon name="star" size={14} className="flowquest-autoCheckIcon" />
                <div className="flowquest-autoCheckContent">
                  <span className="flowquest-autoCheckLabel">{check.label}</span>
                  <span className="flowquest-autoCheckXp">+{check.xp} XP</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {toast && (
          <div className="flowquest-toast">
            {toast}
          </div>
        )}
      </div>
    );
  }
);

// Suppress unused import warning when needed.
void EMPTY_NOTEBOOK;
