/**
 * Donut chart of XP distribution across the four FlowQuest categories.
 */

import type { MissionKind, QuestState } from '../../types';

const CATS: Array<{ key: MissionKind; label: string; color: string }> = [
  { key: 'exploration', label: 'Exploration', color: 'var(--fq-exploration)' },
  { key: 'understanding', label: 'Understanding', color: 'var(--fq-understanding)' },
  { key: 'stabilization', label: 'Stabilization', color: 'var(--fq-stabilization)' },
  { key: 'reflection', label: 'Reflection', color: 'var(--fq-reflection)' }
];

interface CategoryChartProps {
  state: QuestState;
}

export function CategoryChart({ state }: CategoryChartProps): JSX.Element {
  const total = CATS.reduce((sum, cat) => sum + (state.xpByCategory?.[cat.key] ?? 0), 0);

  let cumulative = 0;
  const segments: JSX.Element[] = [];
  CATS.forEach(cat => {
    const value = state.xpByCategory?.[cat.key] ?? 0;
    const pct = total > 0 ? (value / total) * 100 : 0;
    if (pct > 0) {
      segments.push(
        <circle
          key={cat.key}
          className="flowquest-donutSeg"
          cx="18"
          cy="18"
          r="15.915"
          fill="none"
          stroke={cat.color}
          strokeWidth="4.5"
          strokeDasharray={`${pct.toFixed(2)} ${(100 - pct).toFixed(2)}`}
          strokeDashoffset={(-cumulative).toFixed(2)}
        />
      );
      cumulative += pct;
    }
  });

  return (
    <div className="flowquest-categoryChart" title="XP distribution across categories (global)">
      <div className="flowquest-donutWrap">
        <svg className="flowquest-donut" viewBox="0 0 36 36" role="img" aria-label="XP by category">
          <g transform="rotate(-90 18 18)">
            <circle
              className="flowquest-donutTrack"
              cx="18"
              cy="18"
              r="15.915"
              fill="none"
              strokeWidth="4.5"
            />
            {segments}
          </g>
        </svg>
        <span className="flowquest-donutCenter">XP</span>
      </div>
      <div className="flowquest-donutLegend">
        {CATS.map(cat => {
          const value = state.xpByCategory?.[cat.key] ?? 0;
          const pct = total > 0 ? Math.round((value / total) * 100) : 0;
          return (
            <div key={cat.key} className="flowquest-donutLegendItem">
              <span className="flowquest-donutSwatch" style={{ background: cat.color }} />
              <span className="flowquest-donutLegendPct">{pct}%</span>
              <span className="flowquest-donutLegendLabel">{cat.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
