import { useState } from 'react';
import type { FlowQuestStore } from '../state';
import { regionIcon } from '../icons';
import { Icon, Spinner, ErrorBlock } from './shared';
import { toFriendlyError } from '../uiFeedback';

interface CellPanelProps {
  store: FlowQuestStore;
  notebookPath: string;
  cellIndex: number;
  cellSource: string;
  region: string;
  configured: boolean;
}

type PanelMode = 'explain' | 'reflect' | null;

export function CellPanel({
  store,
  notebookPath,
  cellIndex,
  cellSource,
  region,
  configured
}: CellPanelProps): JSX.Element {
  const [mode, setMode] = useState<PanelMode>(null);

  const [explainLoading, setExplainLoading] = useState(false);
  const [explainText, setExplainText] = useState<string | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);

  const [reflectLoading, setReflectLoading] = useState(false);
  const [reflectPrompt, setReflectPrompt] = useState<string | null>(null);
  const [reflectError, setReflectError] = useState<string | null>(null);
  const [reflectAnswer, setReflectAnswer] = useState('');
  const [reflectSubmitted, setReflectSubmitted] = useState(false);

  const regionGlyph = regionIcon(region);

  const runExplain = async () => {
    setExplainLoading(true);
    setExplainError(null);
    try {
      const response = await store.explainCell({
        notebookPath,
        cell: { index: cellIndex, region, source: cellSource }
      });
      setExplainText(response.explanation);
    } catch (err) {
      setExplainError(toFriendlyError(err).message);
    } finally {
      setExplainLoading(false);
    }
  };

  const runReflect = async () => {
    setReflectLoading(true);
    setReflectError(null);
    setReflectAnswer('');
    setReflectSubmitted(false);
    try {
      const response = await store.reflectPrompt({
        cell: { index: cellIndex, region, source: cellSource },
        difficulty: 'medium'
      });
      setReflectPrompt(response.question);
    } catch (err) {
      setReflectError(toFriendlyError(err).message);
    } finally {
      setReflectLoading(false);
    }
  };

  const submitReflection = async () => {
    if (!reflectAnswer.trim()) return;
    setReflectLoading(true);
    setReflectError(null);
    try {
      await store.reflectAnswer({
        notebookPath,
        cellIndex,
        text: reflectAnswer
      });
      setReflectSubmitted(true);
    } catch (err) {
      setReflectError(toFriendlyError(err).message);
    } finally {
      setReflectLoading(false);
    }
  };

  const activateMode = (next: PanelMode) => {
    if (!configured) return;
    setMode(next);
    if (next === 'explain' && !explainText && !explainLoading) {
      runExplain();
    } else if (next === 'reflect' && !reflectPrompt && !reflectLoading) {
      runReflect();
    }
  };

  const dismiss = () => {
    setMode(null);
    setExplainText(null);
    setExplainError(null);
    setReflectPrompt(null);
    setReflectError(null);
    setReflectAnswer('');
    setReflectSubmitted(false);
  };

  return (
    <div className={`flowquest-cellPanel flowquest-cellPanel-region-${region}`}>
      <div className="flowquest-cellPanelHead">
        <div className="flowquest-cellPanelHeadLeft">
          <span className="flowquest-cellPanelBadge">{cellIndex + 1}</span>
          <span className="flowquest-cellPanelRegion">
            <span
              className="flowquest-cellPanelRegionIcon"
              dangerouslySetInnerHTML={{ __html: regionGlyph }}
            />
            <span className="flowquest-cellPanelRegionLabel">{region}</span>
          </span>
        </div>
        <div className="flowquest-cellPanelHeadRight">
          {!mode && configured && (
            <>
              <button type="button" className="flowquest-btn flowquest-btn-ghost" style={{ fontSize: '12px', padding: '2px 8px' }} onClick={() => activateMode('explain')}>
                <Icon name="explain" size={12} />
              </button>
              <button type="button" className="flowquest-btn flowquest-btn-ghost" style={{ fontSize: '12px', padding: '2px 8px' }} onClick={() => activateMode('reflect')}>
                <Icon name="reflect" size={12} />
              </button>
            </>
          )}
          {mode && (
            <button type="button" className="flowquest-btn flowquest-btn-ghost" style={{ fontSize: '12px', padding: '2px 8px' }} onClick={dismiss}>
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
      </div>

      {mode && (
        <div className="flowquest-cellPanelInner">
          {mode === 'explain' && (
            <div className="flowquest-cellSection">
              {explainLoading && <Spinner label="Analyzing this cell..." />}
              {explainError && <ErrorBlock error={explainError} onRetry={runExplain} />}
              {explainText && (
                <div className="flowquest-block flowquest-md">
                  {explainText}
                </div>
              )}
            </div>
          )}

          {mode === 'reflect' && (
            <div className="flowquest-cellSection">
              {reflectLoading && <Spinner label="Thinking of a question..." />}
              {reflectError && <ErrorBlock error={reflectError} onRetry={runReflect} />}

              {reflectPrompt && !reflectSubmitted && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--jp-ui-font-color0)', lineHeight: 1.5 }}>{reflectPrompt}</div>
                  <textarea
                    className="flowquest-textarea"
                    value={reflectAnswer}
                    onChange={e => setReflectAnswer(e.target.value)}
                    placeholder="Type your reflection here..."
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="flowquest-btn flowquest-btn-primary"
                      onClick={submitReflection}
                      disabled={!reflectAnswer.trim() || reflectLoading}
                      style={{ fontSize: '12px', padding: '4px 14px' }}
                    >
                      Submit Reflection
                    </button>
                  </div>
                </div>
              )}

              {reflectSubmitted && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--fq-success)', fontWeight: 600, fontSize: '12px' }}>
                  <Icon name="success" size={12} /> Reflection saved! (+XP)
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
