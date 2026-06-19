/**
 * Shared mission card used in the sidebar Quest tab and the per-cell panel.
 */

import { categoryIcon } from '../../icons';
import type { Mission } from '../../types';
import { Icon } from './Icon';

interface MissionCardProps {
  mission: Mission;
  claimed: boolean;
  checking?: boolean;
  checkResult?: { passed: boolean; feedback: string } | null;
  onCheck?: (mission: Mission) => void;
  onFocusCell?: (index: number) => void;
}

export function MissionCard({
  mission,
  claimed,
  checking = false,
  checkResult = null,
  onCheck,
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
      {checkResult && (
        <div className={`flowquest-missionFeedback ${checkResult.passed ? 'is-pass' : 'is-fail'}`}>
          {checkResult.feedback}
        </div>
      )}
      <div className="flowquest-missionActions">
        <button
          type="button"
          className="flowquest-btn flowquest-btn-primary"
          disabled={claimed || checking || !onCheck}
          onClick={() => onCheck?.(mission)}
        >
          {claimed ? (
            <>
              <Icon name="check" /> Complete
            </>
          ) : checking ? (
            'Checking…'
          ) : checkResult && !checkResult.passed ? (
            'Check again'
          ) : (
            'Check'
          )}
        </button>
      </div>
    </li>
  );
}
