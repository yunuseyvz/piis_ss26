/**
 * Lightweight, dependency-free animation helpers for FlowQuest surfaces.
 *
 * Because the sidebar and banner re-render by replacing their entire `innerHTML`
 * on every state change, freshly-inserted nodes have no "from" state for CSS
 * transitions to animate from. These helpers bridge that gap declaratively:
 *
 *   - Mark a meter fill with `data-fq-fill="<0-100>"` + `data-fq-key="<id>"`.
 *   - Mark a number with `data-fq-count="<n>"` + `data-fq-key="<id>"`.
 *
 * After each render, call {@link hydrateAnimations} on the new subtree. We
 * remember the last value per `data-fq-key` in a module-level store so the
 * animation runs from the previously displayed value to the new one (e.g. an XP
 * bar fills from where it was, a score counts up by the amount earned), and a
 * first appearance animates in from zero.
 *
 * Everything respects `prefers-reduced-motion`: animations collapse to an
 * instant assignment.
 */

/** Last displayed value per logical counter, surviving full re-renders. */
const lastValue = new Map<string, number>();

const COUNT_DURATION_MS = 720;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * Animate a meter fill width from its previously stored value to `target`%.
 * Falls back to an instant set when reduced motion is requested or the value is
 * unchanged. The element keeps whatever CSS `transition: width …` it declares.
 */
export function animateFill(el: HTMLElement, key: string, target: number): void {
  const clamped = Math.max(0, Math.min(100, target));
  const start = lastValue.get(key) ?? 0;
  lastValue.set(key, clamped);

  if (prefersReducedMotion() || start === clamped) {
    el.style.width = `${clamped}%`;
    return;
  }

  // Jump (without transition) to the start, force a reflow, then transition to
  // the target so the browser animates the delta.
  const prevTransition = el.style.transition;
  el.style.transition = 'none';
  el.style.width = `${start}%`;
  void el.offsetWidth;
  requestAnimationFrame(() => {
    el.style.transition = prevTransition;
    el.style.width = `${clamped}%`;
  });

  // Sweep the one-shot sheen only when the bar actually grows (XP gained).
  if (clamped > start) {
    el.classList.remove('is-charging');
    void el.offsetWidth;
    el.classList.add('is-charging');
    el.addEventListener(
      'animationend',
      () => el.classList.remove('is-charging'),
      { once: true }
    );
  }
}

/**
 * Count a number up (or down) from its previously stored value to `target`.
 * The element's text content is replaced each frame with the rounded value.
 */
export function animateCountUp(el: HTMLElement, key: string, target: number): void {
  const start = lastValue.get(key) ?? 0;
  lastValue.set(key, target);

  if (prefersReducedMotion() || start === target) {
    el.textContent = String(target);
    return;
  }

  const t0 = performance.now();
  const step = (now: number): void => {
    const progress = Math.min(1, (now - t0) / COUNT_DURATION_MS);
    const value = Math.round(start + (target - start) * easeOutCubic(progress));
    el.textContent = String(value);
    if (progress < 1) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}

/**
 * Scan a freshly-rendered subtree for animation markers and play them.
 * Safe to call on every render.
 */
export function hydrateAnimations(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-fq-fill]').forEach(el => {
    animateFill(el, el.dataset.fqKey ?? '', Number(el.dataset.fqFill ?? '0'));
  });
  root.querySelectorAll<HTMLElement>('[data-fq-count]').forEach(el => {
    animateCountUp(el, el.dataset.fqKey ?? '', Number(el.dataset.fqCount ?? '0'));
  });
}
