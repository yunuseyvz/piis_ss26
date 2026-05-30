/**
 * Flowy — FlowQuest's playful floating companion that lives in the bottom-right
 * corner of each notebook. It reacts to notebook state, shows encouragement
 * bubbles, nudges the player toward the next goal, and — when it catches a big
 * paste — offers to quiz the learner on the code they just dropped in.
 */

import type { NotebookPanel } from '@jupyterlab/notebook';

import { escapeHtml } from './api';
import { renderFlowySvg } from './flowySprite';
import type { AnalysisResponse, QuestState } from './types';

const HOST_CLASS = 'flowquest-avatarHost';

export type AvatarMood =
  | 'idle'
  | 'thinking'
  | 'happy'
  | 'celebrating'
  | 'concerned'
  | 'angry'
  | 'suspicious'
  | 'sleepy';

export interface PastedSnippet {
  code: string;
  lineCount: number;
}

interface AvatarCallbacks {
  openSidebar: (tab?: 'quest' | 'flowy' | 'chat') => void;
  focusCell: (index: number) => void;
  /** Open the Flowy tab and kick off a spontaneous quiz about a snippet. */
  startPasteQuiz: (snippet: PastedSnippet) => void;
}

const MOOD_MESSAGES: Record<AvatarMood, string[]> = {
  idle: [
    'Ready for adventure! 🗺️',
    "Let's make this notebook shine ✨",
    "Hi, I'm Flowy!",
    'Need a hint? Tap me! 💡'
  ],
  thinking: [
    'Analyzing your notebook… 🔍',
    'Crunching the numbers… 🧮',
    'Let me think about this… 🤔',
    'Scanning cells… 📡'
  ],
  happy: [
    'Great progress! 🎉',
    'Your notebook is looking great! 💚',
    'Keep up the good flow! 🌊',
    "You're on a roll! 🎲"
  ],
  celebrating: [
    'You did it! 🏆',
    'XP rising! 📈',
    'Victory dance! 💃',
    'Level up vibes! ⭐'
  ],
  concerned: [
    'Something looks off here… 🧐',
    'Maybe check that cell? 🔧',
    'A little cleanup could help! 🧹',
    "Don't give up! 💪"
  ],
  angry: [
    'Hey! Did you just paste that?! 😤',
    'Pasting code without reading it? 🙄',
    'I saw that paste. Do you understand it? 🤨',
    'Whoa — big paste! Let me explain it first. 😠',
    'Copy-paste detected! Tap me to get quizzed. 😼'
  ],
  suspicious: [
    'Hmm… that was a chunky paste. 👀',
    'New code appeared out of nowhere… 🧐',
    'Want me to quiz you on what you pasted? 🤔'
  ],
  sleepy: [
    'Zzz… waiting for action 😴',
    'Wake me when you code! ☕',
    'Just resting my bits… 💤'
  ]
};

const TIP_MESSAGES = [
  'Tip: Complete missions to earn XP!',
  'Tip: Reflection cells earn bonus XP.',
  'Tip: Try the between-cell activities for extra XP!',
  'Tip: A balanced notebook has many regions.',
  "Tip: Paste code and I'll quiz you on it.",
  'Tip: Claim missions from the Quest tab.'
];

export class AvatarAssistant {
  private host: HTMLElement;
  /** Persistent scaffold pieces, built once. ``render()`` only swaps the SVG
   * inside ``visualLayer`` — it never touches the host, so transient bubbles
   * and XP pops (siblings of the visual) survive mood changes. */
  private avatarEl: HTMLElement | null = null;
  private visualLayer: HTMLElement | null = null;
  private bubble: HTMLElement | null = null;
  private bubbleTimer: number | null = null;
  private mood: AvatarMood = 'idle';
  private state: QuestState | null = null;
  private tipIndex = 0;
  /** When set, this mood overrides the state-derived mood until the timer
   * fires. Used for transient reactions like a paste. */
  private transientMood: AvatarMood | null = null;
  private transientTimer: number | null = null;
  private pasteListener: ((event: ClipboardEvent) => void) | null = null;
  /** The most recent significant paste, available for a tap-to-quiz. */
  private lastPaste: PastedSnippet | null = null;
  /** Unique suffix for SVG gradient ids so multiple open notebooks don't
   * cross-reference each other's <defs>. */
  private readonly uid = `fq-${Math.random().toString(36).slice(2, 8)}`;

  constructor(private panel: NotebookPanel, private callbacks: AvatarCallbacks) {
    this.host = document.createElement('div');
    this.host.className = HOST_CLASS;
    this.buildScaffold();
    this.attach();
    this.render();
    this.panel.disposed.connect(() => this.dispose());
    this.panel.content.modelChanged.connect(() => this.attach());
    this.installPasteListener();

    // Auto-show a tip every 45 seconds when idle
    this.startTipCycle();
  }

  update(_analysis: AnalysisResponse | null, state: QuestState | null): void {
    this.state = state;
    this.updateMood();
    this.render();
  }

  setThinking(thinking: boolean): void {
    // A transient reaction (e.g. anger about a paste) takes priority.
    if (this.transientMood) {
      return;
    }
    this.setMood(thinking ? 'thinking' : this.inferMoodFromState());
  }

  flash(message: string, duration = 3500): void {
    this.showBubble(message, duration);
  }

  /**
   * Play a celebratory XP-gain animation: the avatar pops, a floating "+N XP"
   * label rises, and a few sparkles burst around it. Briefly switches to a
   * happy/celebrating mood. Safe to call rapidly (each call is independent).
   */
  celebrateXp(amount: number): void {
    if (!amount || amount <= 0) {
      return;
    }
    const avatar = this.avatarEl;
    if (avatar) {
      avatar.classList.remove('is-xpGain');
      // Force reflow so the animation can retrigger on rapid gains.
      void avatar.offsetWidth;
      avatar.classList.add('is-xpGain');
      window.setTimeout(() => avatar.classList.remove('is-xpGain'), 750);
    }

    // Floating "+N XP" label.
    const pop = document.createElement('div');
    pop.className = 'flowquest-avatarXpPop';
    pop.textContent = `+${amount} XP`;
    this.host.appendChild(pop);
    requestAnimationFrame(() => pop.classList.add('is-animating'));
    window.setTimeout(() => pop.remove(), 1600);

    // Sparkle burst.
    const sparkleLayer = document.createElement('div');
    sparkleLayer.className = 'flowquest-avatarSparkles';
    const glyphs = ['✦', '✧', '⭐', '✨', '💫'];
    const count = 6;
    for (let i = 0; i < count; i += 1) {
      const spark = document.createElement('span');
      spark.className = 'flowquest-avatarSparkle';
      spark.textContent = glyphs[i % glyphs.length];
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
      const dist = 26 + Math.random() * 18;
      spark.style.setProperty('--fq-spark-dx', `${Math.cos(angle) * dist}px`);
      spark.style.setProperty('--fq-spark-dy', `${Math.sin(angle) * dist - 10}px`);
      spark.style.animationDelay = `${i * 30}ms`;
      sparkleLayer.appendChild(spark);
    }
    this.host.appendChild(sparkleLayer);
    window.setTimeout(() => sparkleLayer.remove(), 1100);

    // A short happy mood bump (unless an angry/suspicious reaction is active).
    if (!this.transientMood) {
      this.setTransientMood('celebrating', 1400);
    }
    // Note: we intentionally do NOT also pop a speech bubble here — the
    // floating "+N XP" label above is the XP feedback. A bubble would render
    // in the same spot and overlap it.
  }

  /**
   * React to a paste into a notebook cell. The avatar nudges the user to
   * actually understand the code rather than blindly running it, and stashes
   * the snippet so a tap (or the Flowy tab) can quiz them on it.
   */
  reactToPaste(code: string, lineCount: number): void {
    const charCount = code.length;
    // Ignore trivial pastes (a variable name, a url, a number).
    if (charCount < 40 && lineCount < 2) {
      return;
    }
    const big = charCount >= 200 || lineCount >= 6;
    this.lastPaste = { code, lineCount };
    const mood: AvatarMood = big ? 'angry' : 'suspicious';
    const message = big
      ? this.pick([
          `That was ${lineCount} lines of pasted code! 😤 Tap me to get quizzed.`,
          'Big paste detected! Do you actually understand it? 🤨 Tap me.',
          'Pasting AI code again? 😠 Tap me and I will quiz you on it.'
        ])
      : this.pick([
          'Hmm, a sneaky little paste. 👀 Tap me to get quizzed.',
          'New code appeared… 🧐 tap me to test yourself.'
        ]);
    this.setTransientMood(mood, 8000);
    this.showBubble(message, 8000);
  }

  dispose(): void {
    if (this.bubbleTimer !== null) {
      window.clearTimeout(this.bubbleTimer);
    }
    if (this.transientTimer !== null) {
      window.clearTimeout(this.transientTimer);
    }
    if (this.pasteListener) {
      this.panel.content.node.removeEventListener('paste', this.pasteListener, true);
      this.pasteListener = null;
    }
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
    if (this.host.parentElement === cellsContainer) {
      return;
    }
    if (this.host.parentElement) {
      this.host.remove();
    }
    cellsContainer.appendChild(this.host);
  }

  private setMood(mood: AvatarMood): void {
    if (this.mood === mood) {
      return;
    }
    this.mood = mood;
    this.render();
  }

  /** Apply a short-lived mood that overrides the state-derived one. */
  private setTransientMood(mood: AvatarMood, duration: number): void {
    this.transientMood = mood;
    this.setMood(mood);
    if (this.transientTimer !== null) {
      window.clearTimeout(this.transientTimer);
    }
    this.transientTimer = window.setTimeout(() => {
      this.transientMood = null;
      this.transientTimer = null;
      this.setMood(this.inferMoodFromState());
    }, duration);
  }

  private updateMood(): void {
    if (this.transientMood) {
      return;
    }
    this.setMood(this.inferMoodFromState());
  }

  private pick(pool: string[]): string {
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * Listen for paste events anywhere inside the notebook. CodeMirror swallows
   * paste in the cell editor, so we listen in the capture phase on the
   * notebook node to see it first.
   */
  private installPasteListener(): void {
    const listener = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData('text') ?? '';
      if (!text) {
        return;
      }
      // Only react to pastes that land inside a cell editor.
      const target = event.target as HTMLElement | null;
      const inEditor = Boolean(target?.closest('.jp-Cell .cm-editor, .jp-Cell .CodeMirror'));
      if (!inEditor) {
        return;
      }
      const lineCount = text.split('\n').length;
      this.reactToPaste(text, lineCount);
    };
    this.pasteListener = listener;
    // Capture phase so we observe it before CodeMirror consumes it.
    this.panel.content.node.addEventListener('paste', listener, true);
  }

  private inferMoodFromState(): AvatarMood {
    const state = this.state;
    if (!state) {
      return 'idle';
    }
    const level = state.level ?? 1;
    const xp = state.xpTotal ?? 0;
    if (level >= 5) {
      return 'celebrating';
    }
    if (level >= 2) {
      return 'happy';
    }
    if (xp > 0) {
      return 'idle';
    }
    return 'sleepy';
  }

  private startTipCycle(): void {
    const cycle = (): void => {
      // Don't interrupt thinking or a transient reaction with tips.
      if (this.mood === 'thinking' || this.transientMood) {
        window.setTimeout(cycle, 15000);
        return;
      }
      const tip = TIP_MESSAGES[this.tipIndex % TIP_MESSAGES.length];
      this.tipIndex += 1;
      this.showBubble(tip, 6000);
      window.setTimeout(cycle, 45000);
    };
    window.setTimeout(cycle, 20000);
  }

  private showBubble(text: string, duration: number): void {
    if (this.bubbleTimer !== null) {
      window.clearTimeout(this.bubbleTimer);
    }
    this.removeBubble();

    const bubble = document.createElement('div');
    bubble.className = 'flowquest-avatarBubble';
    bubble.innerHTML = `<span class="flowquest-avatarBubbleText">${escapeHtml(text)}</span>
      <button class="flowquest-avatarBubbleClose" aria-label="Dismiss">×</button>`;
    this.host.appendChild(bubble);
    this.bubble = bubble;

    // Animate in
    requestAnimationFrame(() => {
      bubble.classList.add('is-visible');
    });

    const closeBtn = bubble.querySelector('.flowquest-avatarBubbleClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', e => {
        e.stopPropagation();
        this.removeBubble();
      });
    }

    this.bubbleTimer = window.setTimeout(() => {
      this.removeBubble();
    }, duration);
  }

  private removeBubble(): void {
    if (this.bubble) {
      this.bubble.classList.remove('is-visible');
      window.setTimeout(() => {
        this.bubble?.remove();
        this.bubble = null;
      }, 250);
    }
  }

  /** Build the persistent DOM scaffold once. Bubbles and XP pops are appended
   * to the host as siblings of the avatar so they survive mood re-renders. */
  private buildScaffold(): void {
    const avatar = document.createElement('div');
    avatar.className = 'flowquest-avatar';
    avatar.dataset.mood = this.mood;

    const body = document.createElement('div');
    body.className = 'flowquest-avatarBody';

    const visual = document.createElement('div');
    visual.className = 'flowquest-avatarVisual';
    body.appendChild(visual);

    const ring = document.createElement('div');
    ring.className = 'flowquest-avatarRing';

    avatar.appendChild(body);
    avatar.appendChild(ring);
    this.host.appendChild(avatar);

    this.avatarEl = avatar;
    this.visualLayer = visual;

    avatar.addEventListener('click', () => {
      // If Flowy just caught a paste, tapping kicks off a spontaneous quiz
      // about that code. Otherwise open the Flowy tab for its actions.
      if (this.lastPaste) {
        const snippet = this.lastPaste;
        this.lastPaste = null;
        this.callbacks.startPasteQuiz(snippet);
        this.showBubble("Let's see if you understand that paste! 🧠", 3200);
        this.setTransientMood('thinking', 2000);
        return;
      }
      this.callbacks.openSidebar('flowy');
      this.showBubble(this.randomMessageFor(this.mood), 3200);
    });
  }

  private render(): void {
    const mood = this.mood;
    const state = this.state;
    const level = state?.level ?? 1;
    const xp = state?.xpTotal ?? 0;
    const rank = state?.rankTitle ?? 'Notebook Novice';

    const avatar = this.avatarEl;
    const visual = this.visualLayer;
    if (!avatar || !visual) {
      return;
    }

    avatar.dataset.mood = mood;
    avatar.title = `${rank} — Lv ${level} · ${xp} XP`;

    // Crossfade: keep the outgoing sprite, fade in the new one on top, then
    // drop the old one. This makes mood changes smooth instead of a hard cut.
    const incoming = document.createElement('div');
    incoming.className = 'flowquest-avatarSprite is-entering';
    incoming.innerHTML = renderFlowySvg(mood, { uid: this.uid });

    const previous = Array.from(
      visual.querySelectorAll<HTMLElement>('.flowquest-avatarSprite')
    );
    visual.appendChild(incoming);

    // Next frame: reveal the incoming sprite and fade the old ones out.
    requestAnimationFrame(() => {
      incoming.classList.remove('is-entering');
      previous.forEach(node => {
        node.classList.add('is-leaving');
        window.setTimeout(() => node.remove(), 320);
      });
    });
  }

  private randomMessageFor(mood: AvatarMood): string {
    const pool = MOOD_MESSAGES[mood];
    return pool[Math.floor(Math.random() * pool.length)];
  }

}
