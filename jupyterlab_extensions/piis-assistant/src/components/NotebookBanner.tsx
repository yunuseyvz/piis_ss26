/**
 * React HUD banner rendered at the top of each notebook.
 */

import { notebookAwardPrefix } from '../api';
import { difficultyIcon } from '../icons';
import { FlowQuestStore, type NotebookSlice } from '../state';
import { AnimatedNumber, Icon, XpMeter } from './shared';

interface NotebookBannerProps {
  store: FlowQuestStore;
  notebookPath: string;
  useGlobalStateHook: (store: FlowQuestStore) => import('../types').QuestState;
  useNotebookStateHook: (store: FlowQuestStore, path: string) => NotebookSlice;
  onOpenSidebar: (tab?: 'quest' | 'chat') => void;
  onRescan: () => void;
  onOpenSettings: (tab?: 'global' | 'notebook') => void;
  onOpenHandbook: () => void;
}

export function NotebookBanner({
  store,
  notebookPath,
  useGlobalStateHook,
  useNotebookStateHook,
  onOpenSidebar,
  onRescan,
  onOpenSettings,
  onOpenHandbook
}: NotebookBannerProps): JSX.Element {
  const state = useGlobalStateHook(store);
  const slice = useNotebookStateHook(store, notebookPath);
  const analysis = slice.analysis;
  const analyzing = slice.analyzing;
  const mergedState = slice.state;

  const xp = state.xpTotal ?? 0;
  const level = state.level ?? 1;
  const rank = state.rankTitle ?? 'Notebook Novice';
  const toNext = state.xpToNextLevel ?? 0;

  const missions = slice.missions ?? [];
  const completedSet = new Set(mergedState.completedAwardKeys ?? []);
  const awardPrefix = notebookAwardPrefix(mergedState.notebookPath);
  const openMissionCount = missions.filter(
    (m: import('../types').Mission) => !completedSet.has(`${awardPrefix}mission:${m.id}`)
  ).length;
  const quizCount = (analysis?.injectionPoints ?? []).length;

  const difficulty = mergedState.difficulty ?? 'medium';

  return (
    <div className="flowquest-bannerInner">
      <button type="button" className="flowquest-bannerBrand" onClick={() => onOpenSidebar()}>
        <span className="flowquest-bannerMark">
          <Icon name="brand" size={20} />
        </span>
        <span className="flowquest-bannerBrandText">
          <span className="flowquest-bannerTitle">FlowQuest</span>
          <span className="flowquest-bannerSub">{rank}</span>
        </span>
      </button>

      <button
        type="button"
        className="flowquest-bannerLevel"
        onClick={() => onOpenSidebar('quest')}
        title={`${xp} XP total`}
      >
        <span className="flowquest-bannerLevelTop">
          <span className="flowquest-bannerLevelBadge">Lv {level}</span>
          <span className="flowquest-pill flowquest-pill-xp">
            <span className="flowquest-xpIcon"><Icon name="star" size={12} /></span>
            <AnimatedNumber value={xp} itemKey="banner:xp" /> XP
          </span>
        </span>
        <XpMeter
          level={level}
          xpIntoLevel={state.xpIntoLevel}
          xpForNextLevel={state.xpForNextLevel}
          xpToNextLevel={toNext}
          levelProgress={state.levelProgress}
          fillKey="banner:level"
          showLabel={false}
        />
        <span className="flowquest-bannerLevelFoot">
          {toNext > 0 ? `${toNext} XP to level ${level + 1}` : `Level ${level}`}
        </span>
      </button>

      <button
        type="button"
        className="flowquest-bannerMissions"
        onClick={() => onOpenSidebar('quest')}
        title="Open Quest tab"
      >
        <span className="flowquest-bannerMissionsLabel">Missions</span>
        <span className="flowquest-bannerMissionsValue">{openMissionCount}</span>
        <span className="flowquest-bannerMissionsFoot">
          {missions.length} total · {quizCount} quiz{quizCount === 1 ? '' : 'zes'}
        </span>
      </button>

      <div className="flowquest-headerActions">
        <button
          type="button"
          className="flowquest-bannerDifficulty"
          onClick={() => onOpenSettings('notebook')}
          title="Difficulty — click to change"
        >
          <span dangerouslySetInnerHTML={{ __html: difficultyIcon(difficulty) }} />{' '}
          {difficultyLabelFor(difficulty)}
        </button>
        <button
          type="button"
          className="flowquest-btn-action"
          onClick={onOpenHandbook}
          title="FlowQuest handbook"
        >
          <Icon name="handbook" size={14} />
        </button>
        <button
          type="button"
          className="flowquest-btn-action"
          onClick={() => onOpenSettings('global')}
          title="FlowQuest settings"
        >
          <Icon name="settings" size={14} />
        </button>
        <button
          type="button"
          className="flowquest-btn-action"
          onClick={onRescan}
          title="Generate missions"
          disabled={analyzing}
        >
          <Icon name={analyzing ? 'hint' : 'rescan'} size={14} />
        </button>
        <button
          type="button"
          className="flowquest-btn-action"
          onClick={() => onOpenSidebar()}
          title="Open FlowQuest sidebar"
        >
          <Icon name="open" size={14} />
        </button>
      </div>
    </div>
  );
}

function difficultyLabelFor(value: string): string {
  const normalized = (value || '').toLowerCase();
  if (normalized === 'easy') return 'easy';
  if (normalized === 'hard') return 'hard';
  return 'medium';
}
