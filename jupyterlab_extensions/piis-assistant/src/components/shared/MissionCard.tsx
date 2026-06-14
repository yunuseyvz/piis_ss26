/**
 * Shared mission card used in the sidebar Quest tab and the per-cell panel.
 */

import { categoryIcon } from '../../icons';
import type { Mission } from '../../types';
import { Icon } from './Icon';

interface MissionCardProps {
  mission: Mission;
  claimed: boolean;
  loading?: boolean;
  error?: string | null;
  onClaim?: (mission: Mission) => void;
  onFocusCell?: (index: number) => void;
}

export function MissionCard({
  mission,
  claimed,
  loading = false,
  error = null,
  onClaim,
  onFocusCell
}: MissionCardProps): JSX.Element {
  const points = mission.xp ?? 0;

  return (
    <li
      className={`flowquest-missionCard flowquest-mission-${mission.kind} ${
        claimed ? 'is-complete' : ''
      }`}
    >
      <div className="flowquest-missionHead">
        <span className="flowquest-missionKind">
          <span dangerouslySetInnerHTML={{ __html: categoryIcon(mission.kind) }} />{' '}
          {mission.kind}
        </span>
        <span className="flowquest-missionXp">+{points} XP</span>
      </div>
      <div className="flowquest-missionTitle">{mission.title}</div>
      <div className="flowquest-missionDesc">{mission.description}</div>
      {mission.cell_indices.length > 0 && (
        <div className="flowquest-missionTargets">
          Cells:{' '}
          {mission.cell_indices.map(i => (
            <button
              key={i}
              type="button"
              className="flowquest-chipMini"
              onClick={() => onFocusCell?.(i)}
            >
              #{i + 1}
            </button>
          ))}
        </div>
      )}
      <div className="flowquest-missionHint">{mission.completion_hint}</div>
      {error && (
        <div className="flowquest-inlineError flowquest-inlineError-compact">{error}</div>
      )}
      <div className="flowquest-missionActions">
        <button
          type="button"
          className="flowquest-btn flowquest-btn-primary"
          disabled={claimed || loading || !onClaim}
          onClick={() => onClaim?.(mission)}
        >
          {claimed ? (
            <>
              <Icon name="check" /> Claimed
            </>
          ) : loading ? (
            'Claiming…'
          ) : (
            `Claim +${points}`
          )}
        </button>
      </div>
    </li>
  );
}
