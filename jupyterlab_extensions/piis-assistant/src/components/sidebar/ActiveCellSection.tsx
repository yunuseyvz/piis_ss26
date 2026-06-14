import { useState, useEffect } from 'react';
import type { FlowyQuiz, QuestState, NotebookContext } from '../../types';
import type { FlowQuestStore } from '../../state';
import { Icon, Markdown, Spinner, ErrorBlock } from '../shared';
import { regionIcon } from '../../icons';
import { toFriendlyError } from '../../uiFeedback';

interface ActiveCellSectionProps {
  store: FlowQuestStore;
  notebook: NotebookContext;
  globalState: QuestState;
  configured: boolean;
  flowyQuiz: FlowyQuiz | null;
  flowyGenerating: boolean;
  flowyError: string | null;
  onStartActiveCellQuiz: () => void;
  onAnswerFlowyQuiz: (index: number) => void;
  onDismissFlowyQuiz: () => void;
}

export function ActiveCellSection({
  store,
  notebook,
  globalState,
  configured,
  flowyQuiz,
  flowyGenerating,
  flowyError,
  onStartActiveCellQuiz,
  onAnswerFlowyQuiz,
  onDismissFlowyQuiz
}: ActiveCellSectionProps): JSX.Element {
  const [activeMode, setActiveMode] = useState<'explain' | 'reflect' | 'quiz' | null>(null);

  const [explainLoading, setExplainLoading] = useState(false);
  const [explainText, setExplainText] = useState<string | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);

  const [reflectLoading, setReflectLoading] = useState(false);
  const [reflectPrompt, setReflectPrompt] = useState<string | null>(null);
  const [reflectError, setReflectError] = useState<string | null>(null);
  const [reflectAnswer, setReflectAnswer] = useState('');
  const [reflectSubmitted, setReflectSubmitted] = useState(false);

  useEffect(() => {
    if (flowyQuiz || flowyGenerating) {
      setActiveMode('quiz');
    }
  }, [flowyQuiz, flowyGenerating]);

  const hasActiveCell = notebook.activeCellIndex >= 0;
  
  if (!hasActiveCell) {
    return (
      <div className="flowquest-card">
        <div className="flowquest-dim" style={{ textAlign: 'center', padding: '12px 0' }}>
          Select a cell in your notebook to interact with it here.
        </div>
      </div>
    );
  }

  // Find analysis for active cell
  const slice = store.getNotebookSlice(globalState.notebookPath);
  const cellAnalysis = slice.analysis?.cells.find(c => c.index === notebook.activeCellIndex);
  const region = cellAnalysis?.region ?? 'other';
  const issues = cellAnalysis?.issues ?? [];
  const regionGlyph = regionIcon(region);

  const runExplain = async () => {
    setExplainLoading(true);
    setExplainError(null);
    try {
      const response = await store.explainCell({
        notebookPath: globalState.notebookPath,
        cell: {
          index: notebook.activeCellIndex,
          region,
          source: notebook.activeCellSource
        }
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
        cell: {
          index: notebook.activeCellIndex,
          region,
          source: notebook.activeCellSource
        },
        difficulty: globalState.difficulty
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
        notebookPath: globalState.notebookPath,
        cellIndex: notebook.activeCellIndex,
        text: reflectAnswer
      });
      setReflectSubmitted(true);
    } catch (err) {
      setReflectError(toFriendlyError(err).message);
    } finally {
      setReflectLoading(false);
    }
  };

  const handleModeChange = (mode: 'explain' | 'reflect' | 'quiz') => {
    setActiveMode(mode);
    if (mode === 'explain' && !explainText && !explainLoading && !explainError) {
      runExplain();
    } else if (mode === 'reflect' && !reflectPrompt && !reflectLoading && !reflectError) {
      runReflect();
    } else if (mode === 'quiz' && !flowyQuiz && !flowyGenerating && !flowyError) {
      onStartActiveCellQuiz();
    }
  };

  const renderModeButton = (mode: 'explain' | 'reflect' | 'quiz', label: string, icon: string, color: string) => {
    const isActive = activeMode === mode;
    return (
      <button
        type="button"
        onClick={() => handleModeChange(mode)}
        disabled={!configured}
        style={{
          flex: 1,
          padding: '8px 12px',
          borderRadius: '20px',
          border: `1.5px solid ${color}`,
          background: isActive ? color : 'transparent',
          color: isActive ? '#fff' : color,
          fontWeight: isActive ? 700 : 600,
          cursor: configured ? 'pointer' : 'not-allowed',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          transition: 'all 0.2s ease',
          opacity: configured ? 1 : 0.5
        }}
      >
        <Icon name={icon as any} /> {label}
      </button>
    );
  };

  return (
    <div className="flowquest-activeCellSection">
      <div className="flowquest-card" style={{ padding: '0', overflow: 'hidden' }}>
        {/* Header without Flowy */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--fq-surface-2)', padding: '12px 16px', borderBottom: 'var(--fq-border)' }}>
          <span dangerouslySetInnerHTML={{ __html: regionGlyph }} style={{ display: 'flex', color: `var(--fq-region-${region})` }} />
          <div className="flowquest-cardTitle" style={{ fontSize: '15px', margin: 0 }}>
            Cell {notebook.activeCellIndex + 1}
          </div>
        </div>

        <div style={{ padding: '16px' }}>
          {issues.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontWeight: 700, fontSize: '11px', textTransform: 'uppercase', marginBottom: '8px', color: 'var(--fq-warn)' }}>
                Issues Detected
              </div>
              <ul className="flowquest-issueList" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {issues.map((issue, idx) => (
                  <li key={idx} className={`flowquest-inlineError flowquest-inlineError-compact`}>
                    <div className="flowquest-inlineErrorHead">
                      <span className="flowquest-inlineErrorIcon">
                        <Icon name={issue.severity === 'error' ? 'error' : issue.severity === 'warn' ? 'warn' : 'info'} />
                      </span>
                      <span className="flowquest-issueBody">
                        <strong>{issue.kind.replace(/_/g, ' ')}: </strong>
                        <span>{issue.message}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Action Row - Mode Toggles */}
          <div className="flowquest-actionsRow" style={{ display: 'flex', gap: '8px', marginBottom: activeMode ? '16px' : '0' }}>
            {renderModeButton('explain', 'Explain', 'explain', 'var(--fq-accent)')}
            {renderModeButton('reflect', 'Reflect', 'reflect', 'var(--fq-reflection)')}
            {renderModeButton('quiz', 'Quiz me', 'quiz', 'var(--fq-exploration)')}
          </div>

          {/* Dynamic Content Area - Only shows active mode */}
          {activeMode === 'explain' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {explainLoading && <Spinner label="Analyzing this cell..." />}
              {explainError && <ErrorBlock error={explainError} onRetry={runExplain} />}
              
              {explainText && (
                <div className="flowquest-block flowquest-md" style={{ borderLeft: '4px solid var(--fq-accent)', background: 'var(--fq-surface)', margin: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--fq-accent)', marginBottom: '8px', fontSize: '11px', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Icon name="explain" /> Explanation
                  </div>
                  <Markdown source={explainText} />
                </div>
              )}
            </div>
          )}

          {activeMode === 'reflect' && (() => {
            const cellReflections = globalState.reflections
              .filter(r => r.cellIndex === notebook.activeCellIndex)
              .sort((a, b) => b.ts - a.ts);

            const formatTime = (ts: number) => {
              const d = new Date(ts * 1000);
              const now = Date.now();
              const diffMs = now - d.getTime();
              const diffMin = Math.floor(diffMs / 60000);
              if (diffMin < 1) return 'just now';
              if (diffMin < 60) return `${diffMin}m ago`;
              const diffH = Math.floor(diffMin / 60);
              if (diffH < 24) return `${diffH}h ago`;
              const diffD = Math.floor(diffH / 24);
              if (diffD < 7) return `${diffD}d ago`;
              return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            };

            return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {reflectLoading && <Spinner label="Thinking of a question..." />}
              {reflectError && <ErrorBlock error={reflectError} onRetry={runReflect} />}
              
              {reflectPrompt && !reflectSubmitted && (
                <div className="flowquest-block" style={{ borderLeft: '4px solid var(--fq-reflection)', background: 'var(--fq-surface)', margin: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--fq-reflection)', marginBottom: '8px', fontSize: '11px', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Icon name="reflect" /> Reflection Prompt
                  </div>
                  <div style={{ fontWeight: 600, marginBottom: '12px', fontSize: '13px', color: 'var(--jp-ui-font-color0)' }}>{reflectPrompt}</div>
                  <textarea
                    className="flowquest-textarea"
                    value={reflectAnswer}
                    onChange={e => setReflectAnswer(e.target.value)}
                    placeholder="Type your reflection here..."
                    style={{ marginBottom: '12px' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="flowquest-btn flowquest-btn-primary"
                      onClick={submitReflection}
                      disabled={!reflectAnswer.trim() || reflectLoading}
                    >
                      Submit Reflection
                    </button>
                  </div>
                </div>
              )}
              
              {reflectSubmitted && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div className="flowquest-block flowquest-success" style={{ borderLeft: '4px solid var(--fq-success)', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, margin: 0 }}>
                    <Icon name="success" /> Reflection saved! (+XP)
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="flowquest-btn flowquest-btn-ghost"
                      style={{ fontSize: '12px' }}
                      onClick={() => {
                        setReflectPrompt(null);
                        setReflectSubmitted(false);
                        setReflectAnswer('');
                        runReflect();
                      }}
                    >
                      <Icon name="reflect" /> Reflect again
                    </button>
                  </div>
                </div>
              )}

              {/* Saved reflections for this cell */}
              {cellReflections.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ fontWeight: 700, fontSize: '11px', textTransform: 'uppercase', color: 'var(--fq-reflection)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Icon name="reflect" /> Your Reflections ({cellReflections.length})
                  </div>
                  {cellReflections.map((r, idx) => (
                    <div
                      key={`${r.ts}-${idx}`}
                      className="flowquest-block"
                      style={{
                        margin: 0,
                        borderLeft: '3px solid var(--fq-reflection)',
                        background: 'var(--fq-surface)',
                        padding: '10px 14px',
                      }}
                    >
                      <div style={{ fontSize: '13px', color: 'var(--jp-ui-font-color0)', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {r.text}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--jp-ui-font-color2)', marginTop: '6px', textAlign: 'right' }}>
                        {formatTime(r.ts)}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Show prompt button when no active prompt and no loading */}
              {!reflectPrompt && !reflectLoading && !reflectError && !reflectSubmitted && cellReflections.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="flowquest-btn flowquest-btn-ghost"
                    style={{ fontSize: '12px' }}
                    onClick={runReflect}
                  >
                    <Icon name="reflect" /> New reflection prompt
                  </button>
                </div>
              )}
            </div>
            );
          })()}

          {activeMode === 'quiz' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {flowyGenerating && !flowyQuiz && <Spinner label="Writing a quiz..." />}
              {flowyError && <ErrorBlock error={flowyError} onRetry={onStartActiveCellQuiz} />}
              
              {flowyQuiz && (
                <div className="flowquest-block flowquest-md" style={{ borderLeft: '4px solid var(--fq-exploration)', background: 'var(--fq-surface)', margin: 0, paddingBottom: '16px' }}>
                  <div style={{ fontWeight: 700, color: 'var(--fq-exploration)', marginBottom: '12px', fontSize: '11px', textTransform: 'uppercase', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Icon name="quiz" /> Challenge
                    </div>
                    <button type="button" className="flowquest-btn-clear" onClick={() => { onDismissFlowyQuiz(); setActiveMode(null); }}>
                      <Icon name="close" />
                    </button>
                  </div>
                  
                  <div style={{ fontSize: '13px', marginBottom: '16px' }}>
                    <Markdown source={flowyQuiz.quiz.question} />
                  </div>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {flowyQuiz.quiz.options.map((opt: string, idx: number) => {
                      const isSelected = flowyQuiz.selectedIndex === idx;
                      const hasAnswered = flowyQuiz.selectedIndex !== null;
                      const isCorrect = isSelected && flowyQuiz.answeredCorrectly;
                      const isWrong = isSelected && !flowyQuiz.answeredCorrectly;
                      
                      let btnClass = 'flowquest-btn flowquest-btn-ghost';
                      let btnStyle: React.CSSProperties = { 
                        textAlign: 'left', 
                        height: 'auto', 
                        padding: '12px 16px', 
                        display: 'block',
                        whiteSpace: 'normal', 
                        fontWeight: 'normal',
                        fontSize: '13px',
                        lineHeight: 1.5,
                        opacity: hasAnswered && !isSelected ? 0.6 : 1
                      };
                      
                      if (isCorrect) {
                        btnStyle.borderColor = 'var(--fq-success)';
                        btnStyle.background = 'color-mix(in srgb, var(--fq-success) 12%, transparent)';
                        btnStyle.color = 'var(--jp-ui-font-color0)';
                      } else if (isWrong) {
                        btnStyle.borderColor = 'var(--fq-danger)';
                        btnStyle.background = 'color-mix(in srgb, var(--fq-danger) 12%, transparent)';
                      }

                      return (
                        <button
                          key={idx}
                          type="button"
                          className={btnClass}
                          style={btnStyle}
                          onClick={() => onAnswerFlowyQuiz(idx)}
                          disabled={hasAnswered}
                        >
                          <Markdown source={opt} />
                        </button>
                      );
                    })}
                  </div>
                  {flowyQuiz.awardedXp > 0 && (
                    <div style={{ marginTop: '16px', color: 'var(--fq-success)', fontWeight: 800, textAlign: 'center', fontSize: '14px', background: 'color-mix(in srgb, var(--fq-success) 12%, transparent)', padding: '12px', borderRadius: 'var(--fq-radius-sm)' }}>
                      Spot on! +{flowyQuiz.awardedXp} XP
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
