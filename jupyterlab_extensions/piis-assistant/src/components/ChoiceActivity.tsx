/**
 * React renderer for multiple-choice between-cell activities (quiz / predict).
 */

import { activityIcon, regionIcon } from '../icons';
import type { ActivityKind, CellAnalysis, InjectionPoint, QuizRecord } from '../types';
import { ErrorBlock, Icon, Spinner } from './shared';

interface ChoiceActivityProps {
  kind: ActivityKind;
  slot: InjectionPoint;
  record: QuizRecord | null;
  cells: CellAnalysis[];
  loading: boolean;
  error: { kind: string; message: string } | null;
  onGenerate: () => void;
  onAnswer: (index: number) => void;
  onDismiss: () => void;
}

const COPY: Record<
  ActivityKind,
  { eyebrow: string; introTitle: string; introBody: (topic: string) => string; cta: string }
> = {
  quiz: {
    eyebrow: 'FlowQuest · understanding check',
    introTitle: 'Test your understanding of this region',
    introBody: topic =>
      `One short multiple-choice question about ${topic}. +5 XP if you get it right.`,
    cta: 'Start the quiz'
  },
  predict: {
    eyebrow: 'FlowQuest · predict the result',
    introTitle: 'Predict what this cell produces',
    introBody: topic =>
      `Before you run it — what will happen? One multiple-choice prediction about ${topic}. +5 XP if you call it right.`,
    cta: 'Make a prediction'
  },
  teachback: {
    eyebrow: 'FlowQuest · checkpoint',
    introTitle: 'Checkpoint',
    introBody: () => 'Answer to earn XP.',
    cta: 'Start'
  }
};

export function ChoiceActivity({
  kind,
  slot,
  record,
  cells,
  loading,
  error,
  onGenerate,
  onAnswer,
  onDismiss
}: ChoiceActivityProps): JSX.Element {
  const copy = COPY[kind] ?? COPY.quiz;
  const anchorCell = cells.find(c => c.cellId === slot.anchorCellId);
  const anchorLabel = anchorCell ? `Cell ${anchorCell.index + 1}` : 'anchor cell';
  const regionGlyph = regionIcon(slot.region);

  const status = record
    ? record.answeredCorrectly
      ? 'solved'
      : record.attempts > 0
        ? 'in-progress'
        : 'ready'
    : 'empty';

  return (
    <div className={`flowquest-questCellInner flowquest-questCellInner-${slot.region}`}>
      <header className={`flowquest-questCellHeader flowquest-questCellHeader-${slot.region}`}>
        <div className="flowquest-questCellHeaderTop">
          <span className="flowquest-questCellEyebrow">{copy.eyebrow}</span>
          <span className={`flowquest-questCellStatus flowquest-questCellStatus-${status}`}>
            {renderStatusLabel(status, record)}
          </span>
        </div>
        <div className="flowquest-questCellHeaderMain">
          <span
            className="flowquest-questCellMark"
            dangerouslySetInnerHTML={{ __html: activityIcon(kind) }}
          />
          <div className="flowquest-questCellHeaderTitle">
            <div className="flowquest-questCellRegion">
              <span className="flowquest-questCellRegionIcon">
                <span dangerouslySetInnerHTML={{ __html: regionGlyph }} />
              </span>
              <span>{slot.kindLabel || slot.region}</span>
            </div>
            <div className="flowquest-questCellAnchor">on {anchorLabel}</div>
          </div>
        </div>
      </header>

      <div className="flowquest-questCellBody">{renderBody()}</div>
    </div>
  );

  function renderBody(): JSX.Element {
    if (loading && !record) {
      return (
        <div className="flowquest-questCellLoadingPanel" role="status" aria-live="polite">
          <span className="flowquest-thinkingSpinner" />
          <div>
            <div className="flowquest-questCellLoadingTitle">Generating activity…</div>
            <div className="flowquest-questCellLoadingHint">
              Reading <strong>{anchorLabel}</strong> and the cells around it.
            </div>
          </div>
        </div>
      );
    }

    if (error) {
      return (
        <ErrorBlock
          error={error}
          onRetry={onGenerate}
          onDismiss={onDismiss}
          dismissLabel="Dismiss"
        />
      );
    }

    if (!record) {
      return (
        <>
          <div className="flowquest-questCellIntro">
            <div
              className="flowquest-questCellIntroIcon"
              dangerouslySetInnerHTML={{ __html: activityIcon(kind) }}
            />
            <div className="flowquest-questCellIntroBody">
              <div className="flowquest-questCellIntroTitle">{copy.introTitle}</div>
              <p dangerouslySetInnerHTML={{ __html: copy.introBody(slot.topic) }} />
            </div>
          </div>
          <div className="flowquest-actionsRow">
            <button
              type="button"
              className="flowquest-btn flowquest-btn-primary"
              onClick={onGenerate}
              disabled={loading}
            >
              {loading ? (
                <Spinner label="Generating…" inline />
              ) : (
                <>
                  <span dangerouslySetInnerHTML={{ __html: activityIcon(kind) }} /> {copy.cta}
                </>
              )}
            </button>
            <button type="button" className="flowquest-btn flowquest-btn-ghost" onClick={onDismiss}>
              Skip
            </button>
          </div>
        </>
      );
    }

    const quiz = record.quiz;
    const selected = record.selectedIndex;
    const locked = record.answeredCorrectly;

    return (
      <>
        <div className="flowquest-quizQuestion">{quiz.question}</div>
        <ul className="flowquest-quizOptions">
          {quiz.options.map((option, idx) => {
            let optionClass = 'flowquest-quizOption';
            if (selected === idx) {
              optionClass += idx === quiz.correctIndex ? ' is-correct' : ' is-wrong';
            } else if (locked && idx === quiz.correctIndex) {
              optionClass += ' is-correct';
            }
            return (
              <li key={idx}>
                <button
                  type="button"
                  className={optionClass}
                  disabled={locked}
                  onClick={() => onAnswer(idx)}
                >
                  <span className="flowquest-quizOptionLetter">{String.fromCharCode(65 + idx)}</span>
                  <span className="flowquest-quizOptionText">{option}</span>
                </button>
              </li>
            );
          })}
        </ul>

        {selected !== null && (
          <div className={`flowquest-quizFeedback ${record.answeredCorrectly ? 'is-correct' : 'is-wrong'}`}>
            <span className="flowquest-quizFeedbackIcon">
              <Icon name={record.answeredCorrectly ? 'check' : 'cross'} />
            </span>
            <span>
              <strong>{record.answeredCorrectly ? 'Correct.' : 'Not quite.'}</strong>{' '}
              {record.answeredCorrectly ? (
                quiz.explanation
              ) : (
                <>
                  {quiz.options[quiz.correctIndex] ?? ''} is the right answer. {quiz.explanation}
                </>
              )}
            </span>
          </div>
        )}

        {record.awardedXp > 0 && <div className="flowquest-quizXp">+{record.awardedXp} XP earned</div>}

        <div className="flowquest-actionsRow flowquest-actionsRow-quiz">
          <button type="button" className="flowquest-btn flowquest-btn-ghost" onClick={onGenerate}>
            <Icon name="refresh" /> New question
          </button>
          {!locked && (
            <button type="button" className="flowquest-btn flowquest-btn-ghost" onClick={onDismiss}>
              Hide
            </button>
          )}
        </div>
      </>
    );
  }
}

function renderStatusLabel(status: string, record: QuizRecord | null): JSX.Element {
  if (status === 'solved') {
    return (
      <>
        <Icon name="success" /> solved
      </>
    );
  }
  if (status === 'in-progress' && record) {
    return <>attempt {record.attempts}</>;
  }
  if (status === 'ready') {
    return (
      <>
        <Icon name="checkpoint" /> ready
      </>
    );
  }
  return (
    <>
      <Icon name="brand" /> checkpoint
    </>
  );
}
