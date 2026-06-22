/**
 * React renderer for open-ended between-cell activities.
 */

import { useEffect, useRef, useState } from 'react';

import { activityIcon, regionIcon } from '../icons';
import type { CellAnalysis, InjectionPoint, QuizRecord } from '../types';
import { ErrorBlock, Icon, Spinner } from './shared';

interface OpenActivityProps {
  slot: InjectionPoint;
  record: QuizRecord | null;
  cells: CellAnalysis[];
  loading: boolean;
  error: { kind: string; message: string } | null;
  onGenerate: () => void;
  onSubmit: (answer: string) => void;
  onDismiss: () => void;
  onDraftChange: (answer: string) => void;
}

export function OpenActivity({
  slot,
  record,
  cells,
  loading,
  error,
  onGenerate,
  onSubmit,
  onDismiss,
  onDraftChange
}: OpenActivityProps): JSX.Element {
  const anchorCell = cells.find(c => c.cellId === slot.anchorCellId);
  const anchorLabel = anchorCell ? `Cell ${anchorCell.index + 1}` : 'anchor cell';
  const regionGlyph = regionIcon(slot.region);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [draft, setDraft] = useState('');

  const isDocument = slot.kind === 'document';
  const iconKind = isDocument ? 'document' : 'teachback';

  const verdict = record?.openVerdict ?? null;
  const passed = Boolean(verdict?.passed);
  const status = !record ? 'empty' : passed ? 'solved' : record.attempts > 0 ? 'in-progress' : 'ready';

  useEffect(() => {
    setDraft(record?.openAnswer ?? '');
  }, [record?.open?.prompt, record?.openAnswer]);

  return (
    <div className={`flowquest-questCellInner flowquest-questCellInner-${slot.region}`}>
      <header className={`flowquest-questCellHeader flowquest-questCellHeader-${slot.region}`}>
        <div className="flowquest-questCellHeaderTop">
          <span className="flowquest-questCellEyebrow">
            FlowQuest · {isDocument ? 'documentation' : 'teach it back'}
          </span>
          <span className={`flowquest-questCellStatus flowquest-questCellStatus-${status}`}>
            {statusLabel(status, record, iconKind)}
          </span>
        </div>

        <div className="flowquest-questCellHeaderMain">
          <span
            className="flowquest-questCellMark"
            dangerouslySetInnerHTML={{ __html: activityIcon(iconKind) }}
          />
          <div className="flowquest-questCellHeaderTitle">
            <div className="flowquest-questCellRegion">
              <span className="flowquest-questCellRegionIcon">
                <span dangerouslySetInnerHTML={{ __html: regionGlyph }} />
              </span>
              <span>{slot.kindLabel || openActivityTitle(slot.kind)}</span>
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
            <div className="flowquest-questCellLoadingTitle">Preparing a prompt…</div>
            <div className="flowquest-questCellLoadingHint">
              Reading <strong>{anchorLabel}</strong>.
            </div>
          </div>
        </div>
      );
    }

    if (error) {
      return <ErrorBlock error={error} onRetry={onGenerate} onDismiss={onDismiss} dismissLabel="Dismiss" />;
    }

    if (!record || !record.open) {
      return (
        <>
          <div className="flowquest-questCellIntro">
            <div
              className="flowquest-questCellIntroIcon"
              dangerouslySetInnerHTML={{ __html: activityIcon(iconKind) }}
            />
            <div className="flowquest-questCellIntroBody">
              <div className="flowquest-questCellIntroTitle">{openActivityTitle(slot.kind)}</div>
              <p>
                {isDocument ? (
                  <>
                    FlowQuest will ask you to write documentation for <strong>{slot.topic}</strong>. Your answer is
                    graded by the assistant. <strong>+8 XP</strong> on a pass.
                  </>
                ) : (
                  <>
                    FlowQuest will ask you to teach back <strong>{slot.topic}</strong>. Your answer is
                    graded by the assistant. <strong>+8 XP</strong> on a pass.
                  </>
                )}
              </p>
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
                'Preparing…'
              ) : (
                <>
                  <span dangerouslySetInnerHTML={{ __html: activityIcon(iconKind) }} /> Get my prompt
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

    const open = record.open;
    const grading = loading && Boolean(record.open);

    return (
      <>
        <div className="flowquest-quizQuestion">{open.prompt}</div>

        {open.hint && !passed && (
          <div className="flowquest-questCellHint">
            <Icon name="hint" /> {open.hint}
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="flowquest-textarea"
          rows={isDocument ? 5 : 3}
          disabled={passed}
          placeholder={
            isDocument
              ? 'Write documentation for this notebook step…'
              : 'Explain in a sentence or two…'
          }
          value={draft}
          onChange={e => {
            const next = e.target.value;
            setDraft(next);
            onDraftChange(next);
          }}
          onMouseDown={stopPropagation}
          onClick={stopPropagation}
          onDoubleClick={stopPropagation}
          onKeyDown={stopPropagation}
          onKeyPress={stopPropagation}
          onKeyUp={stopPropagation}
        />

        {verdict && (
          <div className={`flowquest-quizFeedback ${passed ? 'is-correct' : 'is-wrong'}`}>
            <span className="flowquest-quizFeedbackIcon">
              <Icon name={passed ? 'check' : 'cross'} />
            </span>
            <span>
              <strong>
                {passed ? `Passed · ${verdict.score}/100.` : 'Not yet.'}
              </strong>{' '}
              {verdict.feedback}
            </span>
          </div>
        )}

        {record.awardedXp > 0 && <div className="flowquest-quizXp">+{record.awardedXp} XP earned</div>}

        <div className="flowquest-actionsRow">
          {passed ? (
            <button type="button" className="flowquest-btn flowquest-btn-ghost" onClick={onGenerate}>
              <Icon name="refresh" /> New prompt
            </button>
          ) : (
            <>
              <button
                type="button"
                className="flowquest-btn flowquest-btn-primary"
                onClick={() => onSubmit(draft)}
                disabled={grading}
              >
                {grading ? <Spinner label="Grading…" inline /> : 'Submit answer'}
              </button>
              <button type="button" className="flowquest-btn flowquest-btn-ghost" onClick={onDismiss}>
                Hide
              </button>
            </>
          )}
        </div>
      </>
    );
  }
}

function openActivityTitle(kind: string): string {
  if (kind === 'document') {
    return 'Write documentation';
  }
  return 'Explain it in your own words';
}

function statusLabel(
  status: string,
  record: QuizRecord | null,
  iconKind: 'teachback' | 'document'
): JSX.Element {
  if (status === 'solved') {
    return (
      <>
        <Icon name="success" /> passed
      </>
    );
  }

  if (status === 'in-progress' && record) {
    return <>attempt {record.attempts}</>;
  }

  if (status === 'ready') {
    return (
      <>
        <span dangerouslySetInnerHTML={{ __html: activityIcon(iconKind) }} /> ready
      </>
    );
  }

  return (
    <>
      <Icon name="brand" /> checkpoint
    </>
  );
}

function stopPropagation(
  event:
    | React.KeyboardEvent<HTMLTextAreaElement>
    | React.MouseEvent<HTMLTextAreaElement>
): void {
  event.stopPropagation();
}