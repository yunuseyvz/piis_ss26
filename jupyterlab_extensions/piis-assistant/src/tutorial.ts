/**
 * FlowQuest guided tour.
 *
 * A first-run, step-by-step walkthrough narrated by Flowy. It dims the page,
 * spotlights one surface at a time (the banner, a cell chip, the sidebar tabs,
 * …) and explains it in a small coach card anchored next to Flowy.
 *
 * It runs automatically the first time a user opens FlowQuest (a flag in
 * `localStorage` remembers that), and can be replayed any time from the
 * "Replay the guided tour" button in the handbook.
 *
 * The whole overlay is one self-contained DOM subtree appended to `body`; it is
 * fully removed on finish/skip so it never lingers to trap clicks. Like the
 * rest of the UI it is hand-rolled (innerHTML + `[data-action]` binding) and
 * escapes nothing dynamic because every string here is static, trusted copy.
 */

import { icon } from './icons';
import { renderFlowySvg, type FlowyMood } from './flowySprite';

/** localStorage key marking the tour as seen (so it auto-runs only once). */
const SEEN_KEY = 'flowquest:tutorialSeen:v1';

const HOST_CLASS = 'flowquest-tutorialHost';
const HIGHLIGHT_CLASS = 'flowquest-tutorialSpotlight';

/** Hooks the controller uses to drive the rest of the UI during the tour. */
export interface TutorialCallbacks {
  /** Bring the FlowQuest sidebar into view. */
  activateSidebar: () => void;
  /** Switch the sidebar to a given tab. */
  showTab: (tab: 'quest' | 'flowy' | 'chat') => void;
  /** Open the settings modal (global section). */
  openSettings: () => void;
}

interface TutorialStep {
  title: string;
  body: string;
  mood: FlowyMood;
  /** CSS selector of the element to spotlight (first match wins). */
  target?: string;
  /** Run before the step renders (e.g. open a sidebar tab). */
  before?: () => void;
}

export class TutorialController {
  private host: HTMLElement | null = null;
  private index = 0;
  private highlighted: HTMLElement | null = null;
  private readonly uid = `fqt-${Math.random().toString(36).slice(2, 8)}`;
  private readonly steps: TutorialStep[];

  constructor(private callbacks: TutorialCallbacks) {
    this.steps = this.buildSteps();
  }

  /** Whether the tour overlay is currently shown. */
  isOpen(): boolean {
    return this.host !== null;
  }

  /**
   * Start the tour automatically if the user has never seen it. Marks it as
   * seen immediately so it never reopens on its own, even if they skip.
   */
  maybeAutoStart(): void {
    let seen = false;
    try {
      seen = window.localStorage.getItem(SEEN_KEY) === '1';
    } catch {
      /* localStorage unavailable (private mode) — just show the tour. */
    }
    if (seen) {
      return;
    }
    this.markSeen();
    this.start();
  }

  /** Open the tour from the beginning. */
  start(): void {
    if (this.host) {
      this.close();
    }
    this.index = 0;
    this.host = document.createElement('div');
    this.host.className = HOST_CLASS;
    document.body.appendChild(this.host);
    this.renderStep();
  }

  /** Close and fully tear down the overlay. */
  close(): void {
    this.clearHighlight();
    this.host?.remove();
    this.host = null;
  }

  // ---- Steps --------------------------------------------------------------

  private buildSteps(): TutorialStep[] {
    return [
      {
        title: "Hi, I'm Flowy!",
        mood: 'happy',
        body: `Welcome to <strong>FlowQuest</strong> — your gamified notebook companion. I'll show you around in a few quick steps. You can skip any time.`
      },
      {
        title: 'Your heads-up display',
        mood: 'idle',
        target: '.flowquest-banner',
        body: `This banner sits at the top of every notebook. It shows your <strong>level</strong>, <strong>XP bar</strong>, open missions and the current difficulty.`
      },
      {
        title: 'Earn XP, level up',
        mood: 'celebrating',
        target: '.flowquest-banner .flowquest-levelMeter',
        body: `XP only ever grows — there's no way to lose progress. Earn it by exploring, understanding, tidying and reflecting on your notebook. The bar fills as you go.`
      },
      {
        title: 'Every cell has a chip',
        mood: 'idle',
        target: '.flowquest-chip',
        body: `Each cell gets a little chip showing its <strong>region</strong>, an issue dot and a mission star. Click a chip to open the inline panel with Explain &amp; Reflect actions.`
      },
      {
        title: 'The Quest tab',
        mood: 'happy',
        target: '.flowquest-shell',
        before: () => {
          this.callbacks.activateSidebar();
          this.callbacks.showTab('quest');
        },
        body: `Over here in the sidebar is your <strong>Quest</strong> log: your progression, the XP donut, missions to claim and suggested next steps.`
      },
      {
        title: "Flowy's quizzes",
        mood: 'suspicious',
        target: '.flowquest-tabs',
        before: () => {
          this.callbacks.activateSidebar();
          this.callbacks.showTab('flowy');
        },
        body: `Paste a chunk of code and I'll notice! The <strong>Flowy</strong> tab quizzes you on what you pasted, so you actually understand it.`
      },
      {
        title: 'Notebook-aware chat',
        mood: 'thinking',
        target: '.flowquest-tabs',
        before: () => {
          this.callbacks.activateSidebar();
          this.callbacks.showTab('chat');
        },
        body: `The <strong>Chat</strong> tab is an assistant that already knows your notebook's context — ask it about a cell, an error, or what to try next.`
      },
      {
        title: 'Connect a model',
        mood: 'idle',
        body: `The AI features (chat, explanations, quizzes) need an LLM endpoint. Add yours in <strong>Settings</strong>. Everything else — XP, missions, regions — works without one.`
      },
      {
        title: "You're all set!",
        mood: 'celebrating',
        body: `That's the tour! Start exploring your notebook to earn XP. You can replay this any time from the <strong>?</strong> handbook button. Happy questing!`
      }
    ];
  }

  // ---- Rendering ----------------------------------------------------------

  private renderStep(): void {
    if (!this.host) {
      return;
    }
    const step = this.steps[this.index];
    step.before?.();

    // Defer one frame so any tab switch above has laid out before we measure
    // and spotlight the target.
    requestAnimationFrame(() => {
      if (!this.host) {
        return;
      }
      this.clearHighlight();
      const target = step.target
        ? document.querySelector<HTMLElement>(step.target)
        : null;
      if (target) {
        target.classList.add(HIGHLIGHT_CLASS);
        this.highlighted = target;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      this.paint(step, Boolean(target));
    });
  }

  private paint(step: TutorialStep, hasTarget: boolean): void {
    if (!this.host) {
      return;
    }
    const isFirst = this.index === 0;
    const isLast = this.index === this.steps.length - 1;
    const dots = this.steps
      .map(
        (_s, i) =>
          `<span class="flowquest-tutorialDot ${i === this.index ? 'is-active' : ''}"></span>`
      )
      .join('');

    this.host.innerHTML = `
      <div class="flowquest-tutorialBackdrop"></div>
      <div class="flowquest-tutorialCard flowquest ${hasTarget ? 'has-target' : 'is-centered'}" role="dialog" aria-modal="true" aria-label="FlowQuest guided tour">
        <button type="button" class="flowquest-tutorialClose" data-action="skip" title="Skip the tour">${icon(
          'close'
        )}</button>
        <div class="flowquest-tutorialFlowy">${renderFlowySvg(step.mood, {
          uid: this.uid,
          width: 72
        })}</div>
        <div class="flowquest-tutorialBody">
          <div class="flowquest-tutorialStepNo">Step ${this.index + 1} of ${this.steps.length}</div>
          <h2 class="flowquest-tutorialTitle">${step.title}</h2>
          <p class="flowquest-tutorialText">${step.body}</p>
          <div class="flowquest-tutorialDots">${dots}</div>
          <div class="flowquest-tutorialActions">
            <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="skip">${
              isLast ? 'Close' : 'Skip'
            }</button>
            <div class="flowquest-tutorialNav">
              ${
                isFirst
                  ? ''
                  : `<button type="button" class="flowquest-btn" data-action="back">Back</button>`
              }
              <button type="button" class="flowquest-btn flowquest-btn-primary" data-action="next">${
                isLast ? 'Done' : 'Next'
              }</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.host.querySelectorAll<HTMLElement>('[data-action]').forEach(element => {
      element.onclick = event => {
        event.stopPropagation();
        const action = element.dataset.action;
        if (action === 'skip') {
          this.finish();
        } else if (action === 'back') {
          this.go(-1);
        } else if (action === 'next') {
          if (this.index === this.steps.length - 1) {
            this.finish();
          } else {
            this.go(1);
          }
        }
      };
    });
  }

  // ---- Navigation ---------------------------------------------------------

  private go(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= this.steps.length) {
      return;
    }
    this.index = next;
    this.renderStep();
  }

  private finish(): void {
    this.markSeen();
    this.close();
  }

  private clearHighlight(): void {
    if (this.highlighted) {
      this.highlighted.classList.remove(HIGHLIGHT_CLASS);
      this.highlighted = null;
    }
  }

  private markSeen(): void {
    try {
      window.localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* ignore — tour just won't be remembered */
    }
  }
}
