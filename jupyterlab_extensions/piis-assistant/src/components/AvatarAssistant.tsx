/**
 * React floating Flowy avatar for each notebook.
 *
 * Reacts to notebook state, shows speech bubbles, nudges the player, and
 * catches large pastes so it can offer a quiz.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { renderFlowySvg, type FlowyMood } from '../flowySprite';
import { FlowQuestStore, useGlobalState } from '../state';

const MAX_BUBBLES = 3;

export type AvatarMood = FlowyMood;

export interface PastedSnippet {
  code: string;
  lineCount: number;
}

interface AvatarAssistantProps {
  panelNode: HTMLElement;
  store: FlowQuestStore;
  onOpenSidebar: (tab?: 'quest' | 'cell' | 'chat') => void;
  onFocusCell: (index: number) => void;
  onStartPasteQuiz: (snippet: PastedSnippet) => void;
}

export interface AvatarAssistantHandle {
  setThinking: (thinking: boolean) => void;
  flash: (message: string, duration?: number) => void;
  celebrateXp: (amount: number) => void;
}

interface Bubble {
  id: number;
  text: string;
  duration: number;
}

interface XpPop {
  id: number;
  amount: number;
}

const MOOD_MESSAGES: Record<AvatarMood, string[]> = {
  idle: [
    'Ready for adventure!',
    "Let's make this notebook shine",
    "Hi, I'm Flowy!",
    'Need a hint? Tap me!'
  ],
  thinking: [
    'Analyzing your notebook…',
    'Crunching the numbers…',
    'Let me think about this…',
    'Scanning cells…'
  ],
  happy: [
    'Great progress!',
    'Your notebook is looking great!',
    'Keep up the good flow!',
    "You're on a roll!"
  ],
  celebrating: [
    'You did it!',
    'XP rising!',
    'Victory dance!',
    'Level up vibes!'
  ],
  concerned: [
    'Something looks off here…',
    'Maybe check that cell?',
    'A little cleanup could help!',
    "Don't give up!"
  ],
  angry: [
    'Hey! Did you just paste that?!',
    'Pasting code without reading it?',
    'I saw that paste. Do you understand it?',
    'Whoa — big paste! Let me explain it first.',
    'Copy-paste detected! Tap me to get quizzed.'
  ],
  suspicious: [
    'Hmm… that was a chunky paste.',
    'New code appeared out of nowhere…',
    'Want me to quiz you on what you pasted?'
  ],
  sleepy: [
    'Zzz… waiting for action',
    'Wake me when you code!',
    'Just resting my bits…'
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

export const AvatarAssistant = forwardRef<AvatarAssistantHandle, AvatarAssistantProps>(
  function AvatarAssistant({ panelNode, store, onOpenSidebar, onStartPasteQuiz }, ref) {
    const state = useGlobalState(store);
    const [mood, setMood] = useState<AvatarMood>('idle');
    const [transientMood, setTransientMood] = useState<AvatarMood | null>(null);
    const transientTimer = useRef<number | null>(null);
    const [bubbles, setBubbles] = useState<Bubble[]>([]);
    const [xpPops, setXpPops] = useState<XpPop[]>([]);
    const [levelUpPop, setLevelUpPop] = useState<{ level: number } | null>(null);
    const [sparkles, setSparkles] = useState<Array<{ id: number; dx: string; dy: string }>>([]);
    const [lastPaste, setLastPaste] = useState<PastedSnippet | null>(null);
    const prevLevelRef = useRef(store.getGlobalState().level ?? 1);
    const bubbleIdRef = useRef(0);
    const xpIdRef = useRef(0);
    const tipIndexRef = useRef(0);
    const avatarRef = useRef<HTMLDivElement>(null);
    const visualRef = useRef<HTMLDivElement>(null);
    const uid = useRef(`fq-${Math.random().toString(36).slice(2, 8)}`).current;

    const inferMoodFromState = useCallback((): AvatarMood => {
      if (!state) return 'idle';
      const level = state.level ?? 1;
      const xp = state.xpTotal ?? 0;
      if (level >= 5) return 'celebrating';
      if (level >= 2) return 'happy';
      if (xp > 0) return 'idle';
      return 'sleepy';
    }, [state]);

    useEffect(() => {
      if (!transientMood) {
        setMood(inferMoodFromState());
      }
    }, [state, transientMood, inferMoodFromState]);

    const showBubble = useCallback((text: string, duration = 3500) => {
      const id = bubbleIdRef.current++;
      setBubbles(prev => {
        const next = [...prev, { id, text, duration }];
        while (next.length > MAX_BUBBLES) {
          next.shift();
        }
        return next;
      });
      window.setTimeout(() => {
        setBubbles(prev => prev.filter(b => b.id !== id));
      }, duration);
    }, []);

    const setTransient = useCallback(
      (nextMood: AvatarMood, duration: number) => {
        setTransientMood(nextMood);
        setMood(nextMood);
        if (transientTimer.current !== null) {
          window.clearTimeout(transientTimer.current);
        }
        transientTimer.current = window.setTimeout(() => {
          setTransientMood(null);
          transientTimer.current = null;
          setMood(inferMoodFromState());
        }, duration);
      },
      [inferMoodFromState]
    );

    const transientMoodRef = useRef(transientMood);
    useEffect(() => {
      transientMoodRef.current = transientMood;
    }, [transientMood]);

    useEffect(() => {
      if (!state) return;
      const currentLevel = state.level ?? 1;
      if (currentLevel > prevLevelRef.current) {
        prevLevelRef.current = currentLevel;
        
        setLevelUpPop({ level: currentLevel });
        setTransient('celebrating', 4000);
        
        const newSparkles = Array.from({ length: 14 }).map((_, i) => ({
          id: Date.now() + i,
          dx: `${Math.random() * 200 - 100}px`,
          dy: `${Math.random() * -160 - 20}px`
        }));
        setSparkles(newSparkles);
        
        if (avatarRef.current) {
          avatarRef.current.classList.remove('is-levelUp');
          void avatarRef.current.offsetWidth;
          avatarRef.current.classList.add('is-levelUp');
          window.setTimeout(() => {
            if (avatarRef.current) avatarRef.current.classList.remove('is-levelUp');
          }, 1200);
        }

        window.setTimeout(() => {
          setLevelUpPop(null);
          setSparkles([]);
        }, 3500);
      }
    }, [state?.level, setTransient]);

    const celebrateXp = useCallback(
      (amount: number) => {
        if (!amount || amount <= 0) return;

        const avatar = avatarRef.current;
        if (avatar) {
          avatar.classList.remove('is-xpGain');
          void avatar.offsetWidth;
          avatar.classList.add('is-xpGain');
          window.setTimeout(() => avatar.classList.remove('is-xpGain'), 750);
        }

        const id = xpIdRef.current++;
        setXpPops(prev => [...prev, { id, amount }]);
        window.setTimeout(() => {
          setXpPops(prev => prev.filter(p => p.id !== id));
        }, 1600);

        // B7 fix: read from ref to avoid capturing stale transientMood.
        if (!transientMoodRef.current) {
          setTransient('celebrating', 1400);
        }
      },
      [setTransient]
    );

    useImperativeHandle(ref, () => ({
      setThinking: (thinking: boolean) => {
        if (!transientMood) {
          setMood(thinking ? 'thinking' : inferMoodFromState());
        }
      },
      flash: (message: string, duration = 3500) => showBubble(message, duration),
      celebrateXp
    }));

    const reactToPaste = useCallback(
      (code: string, lineCount: number) => {
        const charCount = code.length;
        if (charCount < 40 && lineCount < 2) return;
        const big = charCount >= 200 || lineCount >= 6;
        setLastPaste({ code, lineCount });
        const nextMood: AvatarMood = big ? 'angry' : 'suspicious';
        const message = big
          ? pick([
              `That was ${lineCount} lines of pasted code! Tap me to get quizzed.`,
              'Big paste detected! Do you actually understand it? Tap me.',
              'Pasting AI code again? Tap me and I will quiz you on it.'
            ])
          : pick([
              'Hmm, a sneaky little paste. Tap me to get quizzed.',
              'New code appeared… tap me to test yourself.'
            ]);
        setTransient(nextMood, 8000);
        showBubble(message, 8000);
      },
      [setTransient, showBubble]
    );

    // Paste listener.
    useEffect(() => {
      const listener = (event: ClipboardEvent): void => {
        const text = event.clipboardData?.getData('text') ?? '';
        if (!text) return;
        const target = event.target as HTMLElement | null;
        const inEditor = Boolean(target?.closest('.jp-Cell .cm-editor, .jp-Cell .CodeMirror'));
        if (!inEditor) return;
        reactToPaste(text, text.split('\n').length);
      };
      panelNode.addEventListener('paste', listener, true);
      return () => panelNode.removeEventListener('paste', listener, true);
    }, [panelNode, reactToPaste]);

    // B6 fix: Tip cycle with a single interval and stable cleanup.
    // The old recursive setTimeout re-registered on every mood/transientMood
    // change, leaking timers exponentially.
    useEffect(() => {
      const handle = window.setInterval(() => {
        // Skip tips while Flowy is thinking or in a transient state.
        if (transientMoodRef.current) return;
        const tip = TIP_MESSAGES[tipIndexRef.current % TIP_MESSAGES.length];
        tipIndexRef.current += 1;
        showBubble(tip, 6000);
      }, 45000);
      return () => window.clearInterval(handle);
    }, [showBubble]);

    // Tilt tracking.
    useEffect(() => {
      const avatar = avatarRef.current;
      const visual = visualRef.current;
      if (!avatar || !visual) return;

      const maxTilt = 22;
      const onMove = (event: MouseEvent): void => {
        const rect = avatar.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const nx = Math.max(-1, Math.min(1, (event.clientX - cx) / (rect.width / 2)));
        const ny = Math.max(-1, Math.min(1, (event.clientY - cy) / (rect.height / 2)));
        const yaw = nx * maxTilt;
        const pitch = -ny * maxTilt;
        avatar.classList.add('is-tilting');
        visual.style.transform = `rotateX(${pitch.toFixed(2)}deg) rotateY(${yaw.toFixed(2)}deg)`;
      };
      const onLeave = (): void => {
        avatar.classList.remove('is-tilting');
        visual.style.transform = '';
      };

      avatar.addEventListener('mousemove', onMove);
      avatar.addEventListener('mouseleave', onLeave);
      return () => {
        avatar.removeEventListener('mousemove', onMove);
        avatar.removeEventListener('mouseleave', onLeave);
      };
    }, []);

    const handleClick = (): void => {
      if (lastPaste) {
        const snippet = lastPaste;
        setLastPaste(null);
        onStartPasteQuiz(snippet);
        showBubble("Let's see if you understand that paste!", 3200);
        setTransient('thinking', 2000);
        return;
      }
      onOpenSidebar('cell');
      showBubble(pick(MOOD_MESSAGES[mood]), 3200);
    };

    return (
      <div className="flowquest-avatarHost">
        <div className="flowquest-avatarBubbleStack">
          {bubbles.map(b => (
            <div key={b.id} className="flowquest-avatarBubble">
              <span className="flowquest-avatarBubbleText">{b.text}</span>
              <button
                className="flowquest-avatarBubbleClose"
                aria-label="Dismiss"
                onClick={() => setBubbles(prev => prev.filter(x => x.id !== b.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {xpPops.map(p => (
          <div key={p.id} className="flowquest-avatarXpPop is-animating">
            +{p.amount} XP
          </div>
        ))}

        {levelUpPop && (
          <div className="flowquest-levelUpPop is-animating">
            LEVEL UP! Lv {levelUpPop.level}
          </div>
        )}

        {sparkles.length > 0 && (
          <div className="flowquest-avatarSparkles">
            {sparkles.map(s => (
              <div
                key={s.id}
                className="flowquest-avatarSparkle"
                style={{ '--fq-spark-dx': s.dx, '--fq-spark-dy': s.dy } as React.CSSProperties}
              >
                ✦
              </div>
            ))}
          </div>
        )}

        <div
          className="flowquest-avatar"
          ref={avatarRef}
          data-mood={mood}
          title={`${state?.rankTitle ?? 'Notebook Novice'} — Lv ${state?.level ?? 1} · ${state?.xpTotal ?? 0} XP`}
          onClick={handleClick}
        >
          <div className="flowquest-avatarBody">
            <div
              className="flowquest-avatarVisual"
              ref={visualRef}
              dangerouslySetInnerHTML={{ __html: renderFlowySvg(mood, { uid }) }}
            />
          </div>
          <div className="flowquest-avatarRing" />
        </div>
      </div>
    );
  }
);

function pick(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)];
}

export type { AvatarAssistantProps };
