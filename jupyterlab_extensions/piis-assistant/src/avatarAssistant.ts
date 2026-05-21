/**
 * FlowQuest Avatar Assistant — a playful floating companion that lives in the
 * bottom-right corner of each notebook. It reacts to notebook state, shows
 * encouragement bubbles, and nudges the player toward the next goal.
 */

import type { NotebookPanel } from '@jupyterlab/notebook';

import { escapeHtml } from './api';
import type { AnalysisResponse, QuestState } from './types';

const HOST_CLASS = 'flowquest-avatarHost';

export type AvatarMood =
  | 'idle'
  | 'thinking'
  | 'happy'
  | 'celebrating'
  | 'concerned'
  | 'sleepy';

interface AvatarCallbacks {
  openSidebar: (tab?: 'quest' | 'workflow' | 'chat') => void;
  focusCell: (index: number) => void;
}

const MOOD_MESSAGES: Record<AvatarMood, string[]> = {
  idle: [
    'Ready for adventure! 🗺️',
    'Let\'s make this notebook shine ✨',
    'FlowQuest is online!',
    'Need a hint? Click me! 💡'
  ],
  thinking: [
    'Analyzing your notebook… 🔍',
    'Crunching the numbers… 🧮',
    'Let me think about this… 🤔',
    'Scanning cells… 📡'
  ],
  happy: [
    'Great progress! 🎉',
    'Your notebook looks healthy! 💚',
    'Keep up the good flow! 🌊',
    'You\'re on a roll! 🎲'
  ],
  celebrating: [
    'You did it! 🏆',
    'Notebook Health rising! 📈',
    'Victory dance! 💃',
    'Quest complete! ⭐'
  ],
  concerned: [
    'Something looks off here… 🧐',
    'Maybe check that cell? 🔧',
    'A little cleanup could help! 🧹',
    'Don\'t give up! 💪'
  ],
  sleepy: [
    'Zzz… waiting for action 😴',
    'Wake me when you code! ☕',
    'Just resting my bits… 💤'
  ]
};

const TIP_MESSAGES = [
  'Tip: Initialize to get your baseline score!',
  'Tip: Complete missions to boost Health.',
  'Tip: Reflection cells earn bonus XP.',
  'Tip: Try the quiz injections for extra points!',
  'Tip: A balanced notebook has many regions.',
  'Tip: Click the banner to see full stats.'
];

export class AvatarAssistant {
  private host: HTMLElement;
  private bubble: HTMLElement | null = null;
  private bubbleTimer: number | null = null;
  private mood: AvatarMood = 'idle';
  private state: QuestState | null = null;
  private tipIndex = 0;

  constructor(private panel: NotebookPanel, private callbacks: AvatarCallbacks) {
    this.host = document.createElement('div');
    this.host.className = HOST_CLASS;
    this.attach();
    this.render();
    this.panel.disposed.connect(() => this.dispose());
    this.panel.content.modelChanged.connect(() => this.attach());

    // Auto-show a tip every 45 seconds when idle
    this.startTipCycle();
  }

  update(_analysis: AnalysisResponse | null, state: QuestState | null): void {
    this.state = state;
    this.updateMood();
    this.render();
  }

  setThinking(thinking: boolean): void {
    this.setMood(thinking ? 'thinking' : this.inferMoodFromState());
  }

  flash(message: string, duration = 3500): void {
    this.showBubble(message, duration);
  }

  dispose(): void {
    if (this.bubbleTimer !== null) {
      window.clearTimeout(this.bubbleTimer);
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

  private updateMood(): void {
    this.setMood(this.inferMoodFromState());
  }

  private inferMoodFromState(): AvatarMood {
    const state = this.state;
    if (!state) {
      return 'idle';
    }
    if (state.won) {
      return 'celebrating';
    }
    const health = state.healthScore ?? 0;
    if (health >= 80) {
      return 'happy';
    }
    if (health >= 40) {
      return 'idle';
    }
    if (health > 0) {
      return 'concerned';
    }
    return 'sleepy';
  }

  private startTipCycle(): void {
    const cycle = (): void => {
      if (this.mood === 'thinking') {
        // Don't interrupt thinking with tips
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

  private render(): void {
    const mood = this.mood;
    const state = this.state;
    const health = state?.healthScore ?? 0;
    const rank = state?.rankTitle ?? 'Notebook Novice';

    this.host.innerHTML = `
      <div class="flowquest-avatar" data-mood="${mood}" title="${escapeHtml(rank)} — ${health} HP">
        <div class="flowquest-avatarBody">
          ${this.renderAvatarSvg(mood)}
        </div>
        <div class="flowquest-avatarRing"></div>
      </div>
    `;

    const avatar = this.host.querySelector('.flowquest-avatar');
    if (avatar) {
      avatar.addEventListener('click', () => {
        this.callbacks.openSidebar('quest');
        this.showBubble(this.randomMessageFor(mood), 3000);
      });
    }
  }

  private randomMessageFor(mood: AvatarMood): string {
    const pool = MOOD_MESSAGES[mood];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private renderAvatarSvg(mood: AvatarMood): string {
    // A cute round companion with expressive eyes that change per mood
    const eyeOffset = mood === 'concerned' ? '2' : mood === 'sleepy' ? '0' : '0';
    const eyeRx = mood === 'sleepy' ? '3' : '4';
    const eyeRy = mood === 'sleepy' ? '1' : '4';
    const mouthPath = this.mouthPathFor(mood);
    const blushOpacity = mood === 'happy' || mood === 'celebrating' ? '0.35' : '0';
    const starOpacity = mood === 'celebrating' ? '1' : '0';
    const thinkOpacity = mood === 'thinking' ? '1' : '0';
    const bodyFill = this.bodyFillFor(mood);

    return `
      <svg viewBox="0 0 64 64" width="56" height="56" class="flowquest-avatarSvg">
        <defs>
          <radialGradient id="fq-avatarGrad" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stop-color="${bodyFill.light}"/>
            <stop offset="100%" stop-color="${bodyFill.dark}"/>
          </radialGradient>
        </defs>
        <!-- Body -->
        <circle cx="32" cy="32" r="28" fill="url(#fq-avatarGrad)" stroke="#111" stroke-width="2.5"/>
        <!-- Blush -->
        <ellipse cx="18" cy="38" rx="5" ry="3" fill="#ff5b8d" opacity="${blushOpacity}"/>
        <ellipse cx="46" cy="38" rx="5" ry="3" fill="#ff5b8d" opacity="${blushOpacity}"/>
        <!-- Eyes -->
        <ellipse cx="22" cy="28" rx="${eyeRx}" ry="${eyeRy}" fill="#111" transform="translate(0, ${eyeOffset})"/>
        <ellipse cx="42" cy="28" rx="${eyeRx}" ry="${eyeRy}" fill="#111" transform="translate(0, ${eyeOffset})"/>
        <!-- Mouth -->
        <path d="${mouthPath}" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round"/>
        <!-- Thinking indicator -->
        <g opacity="${thinkOpacity}">
          <circle cx="52" cy="14" r="3" fill="#4dc6ff"/>
          <circle cx="58" cy="8" r="2" fill="#4dc6ff"/>
          <circle cx="62" cy="2" r="1.5" fill="#4dc6ff"/>
        </g>
        <!-- Celebration stars -->
        <g opacity="${starOpacity}">
          <path d="M8 8 L10 14 L16 16 L10 18 L8 24 L6 18 L0 16 L6 14 Z" fill="#ffd24a"/>
          <path d="M56 4 L57.5 8 L62 9 L57.5 10 L56 14 L54.5 10 L50 9 L54.5 8 Z" fill="#ff5b8d"/>
          <path d="M52 52 L53 55 L56 56 L53 57 L52 60 L51 57 L48 56 L51 55 Z" fill="#7be495"/>
        </g>
      </svg>
    `;
  }

  private mouthPathFor(mood: AvatarMood): string {
    switch (mood) {
      case 'happy':
        return 'M 20 40 Q 32 50 44 40';
      case 'celebrating':
        return 'M 18 42 Q 32 54 46 42';
      case 'concerned':
        return 'M 22 44 Q 32 38 42 44';
      case 'sleepy':
        return 'M 24 42 Q 32 42 40 42';
      case 'thinking':
        return 'M 26 42 Q 32 46 38 40';
      case 'idle':
      default:
        return 'M 22 42 Q 32 46 42 42';
    }
  }

  private bodyFillFor(mood: AvatarMood): { light: string; dark: string } {
    switch (mood) {
      case 'happy':
        return { light: '#7be495', dark: '#4dc6ff' };
      case 'celebrating':
        return { light: '#ffd24a', dark: '#ff5b8d' };
      case 'concerned':
        return { light: '#ffaa3b', dark: '#ff5b5b' };
      case 'sleepy':
        return { light: '#b48bff', dark: '#7a5fb8' };
      case 'thinking':
        return { light: '#4dc6ff', dark: '#2a8fcc' };
      case 'idle':
      default:
        return { light: '#f0f4ff', dark: '#c8d4f8' };
    }
  }
}
