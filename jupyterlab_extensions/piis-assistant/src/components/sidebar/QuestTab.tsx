/**
 * Quest tab of the FlowQuest sidebar.
 *
 * Shows the active notebook summary, mission list, recent rewards, and
 * LLM-powered next-step suggestions.
 */

import { notebookAwardPrefix } from '../../api';
import type { AnalysisResponse, Mission, QuestState } from '../../types';
import type { FlowQuestStore } from '../../state';
import { Icon, Markdown, MissionCard, Spinner } from '../shared';

interface QuestTabProps {
  store: FlowQuestStore;
  state: QuestState;
  analysis: AnalysisResponse | null;
  analyzing: boolean;
  configured: boolean;
  callbacks: {
    refreshAnalysis: () => Promise<void>;
    focusCell: (index: number) => void;
    applyState: (state: QuestState) => void;
    getState: () => QuestState;
  };
  nextSteps: string;
  loadingNextSteps: boolean;
  onLoadNextSteps: () => void;
  onClaim: (mission: Mission) => void;
  claiming: Set<string>;
  claimErrors: Map<string, string>;
}

export function QuestTab({
  store,
  state,
  analysis,
  analyzing,
  configured,
  callbacks,
  nextSteps,
  loadingNextSteps,
  onLoadNextSteps,
  onClaim,
  claiming,
  claimErrors
}: QuestTabProps): JSX.Element {
  const notebookName = state.notebookPath
    ? state.notebookPath.split('/').pop() || state.notebookPath
    : 'No notebook open';
  const missions = analysis?.missions ?? [];
  const completed = new Set(state.completedAwardKeys ?? []);
  const awardPrefix = notebookAwardPrefix(state.notebookPath);
  const isClaimed = (id: string) => completed.has(`${awardPrefix}mission:${id}`);
  const openMissions = missions.filter(m => !isClaimed(m.id));

  const awardLog = (state.awardLog ?? [])
    .slice(-8)
    .reverse()
    .map((entry, idx) => (
      <li key={idx} className="flowquest-awardLogEntry">
        <span className="flowquest-awardPoints">+{entry.xp}</span>
        <span className="flowquest-awardLabel">{entry.label}</span>
      </li>
    ));

  return (
    <section className="flowquest-tabPanel">
      <div className="flowquest-card flowquest-notebookSummary">
        <div className="flowquest-cardHead">
          <div>
            <div className="flowquest-eyebrow">Notebook</div>
            <div className="flowquest-cardTitle">{notebookName}</div>
          </div>
          <button
            type="button"
            className="flowquest-btn flowquest-btn-primary"
            onClick={() => callbacks.refreshAnalysis()}
            disabled={analyzing}
          >
            {analyzing ? (
              'Scanning…'
            ) : (
              <>
                <Icon name="rescan" /> Re-scan
              </>
            )}
          </button>
        </div>
        <div className="flowquest-cardHead">
          <div className="flowquest-cardTitle">Missions</div>
          <div className="flowquest-dim">
            {missions.length} total · {openMissions.length} open
          </div>
        </div>
        {missions.length ? (
          <ul className="flowquest-missionList">
            {missions.map(mission => (
              <MissionCard
                key={mission.id}
                mission={mission}
                claimed={isClaimed(mission.id)}
                loading={claiming.has(mission.id)}
                error={claimErrors.get(mission.id) ?? null}
                onClaim={onClaim}
                onFocusCell={callbacks.focusCell}
              />
            ))}
          </ul>
        ) : (
          <div className="flowquest-dim">No missions yet. Run a scan to generate some.</div>
        )}
      </div>

      {awardLog.length > 0 && (
        <div className="flowquest-card">
          <div className="flowquest-cardHead">
            <div className="flowquest-cardTitle">Recent rewards</div>
          </div>
          <ul className="flowquest-awardLog">{awardLog}</ul>
        </div>
      )}

      <div className="flowquest-card">
        <div className="flowquest-cardHead">
          <div className="flowquest-cardTitle">What should I do next?</div>
          <button
            type="button"
            className="flowquest-btn"
            onClick={onLoadNextSteps}
            disabled={!analysis || loadingNextSteps || !configured}
          >
            {loadingNextSteps ? (
              <Spinner label="Thinking…" inline />
            ) : !configured ? (
              <>
                <Icon name="warn" /> Model needed
              </>
            ) : (
              <>
                <Icon name="sparkles" /> Ask FlowQuest
              </>
            )}
          </button>
        </div>
        {nextSteps ? (
          <div className="flowquest-block flowquest-md">
            <Markdown source={nextSteps} />
          </div>
        ) : !configured ? (
          <div className="flowquest-dim">Configure a model in Settings to get next-step ideas.</div>
        ) : (
          <div className="flowquest-dim">
            Get three contextual next-step ideas grounded in your notebook.
          </div>
        )}
      </div>
    </section>
  );
}
