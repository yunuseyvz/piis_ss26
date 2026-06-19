/**
 * Number that animates from its previously displayed value on change.
 *
 * Uses the same `data-fq-count` / `data-fq-key` plumbing as the legacy code.
 */

import { useLayoutEffect, useRef } from 'react';

import { hydrateAnimations } from '../../anim';

interface AnimatedNumberProps {
  value: number;
  itemKey: string;
  className?: string;
}

export function AnimatedNumber({ value, itemKey, className = 'flowquest-num' }: AnimatedNumberProps): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (ref.current) {
      hydrateAnimations(ref.current);
    }
  });

  return (
    <span ref={ref} className={className} data-fq-count={value} data-fq-key={itemKey}>
      {value}
    </span>
  );
}
