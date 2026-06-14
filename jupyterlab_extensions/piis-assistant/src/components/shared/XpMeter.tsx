/**
 * Animated level meter and XP count.
 *
 * Mirrors the legacy `data-fq-fill` / `data-fq-count` markers and hydrates
 * them through the shared animation helper so the bar fills and numbers count
 * up exactly as before.
 */

import { useLayoutEffect, useRef } from 'react';

import { hydrateAnimations } from '../../anim';

interface XpMeterProps {
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  xpToNextLevel: number;
  levelProgress: number;
  fillKey: string;
  showLabel?: boolean;
  className?: string;
}

export function XpMeter({
  level,
  xpIntoLevel,
  xpForNextLevel,
  xpToNextLevel,
  levelProgress,
  fillKey,
  showLabel = true,
  className = ''
}: XpMeterProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const progress = Math.max(0, Math.min(100, Math.round(levelProgress * 100)));

  useLayoutEffect(() => {
    if (ref.current) {
      hydrateAnimations(ref.current);
    }
  });

  return (
    <div className={className} ref={ref}>
      <div
        className="flowquest-levelMeter"
        title={`${xpIntoLevel} / ${xpForNextLevel} XP into level ${level}`}
      >
        <span
          className="flowquest-levelMeterFill"
          data-fq-fill={progress}
          data-fq-key={fillKey}
        />
      </div>
      {showLabel && (
        <div className="flowquest-levelMeterLabel">
          {xpToNextLevel > 0
            ? `${xpToNextLevel} XP to level ${level + 1}`
            : `Level ${level}`}
        </div>
      )}
    </div>
  );
}
