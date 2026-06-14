import type { FlowQuestStore } from '../../state';
import type { QuestState, NotebookContext, FlowyQuiz } from '../../types';
import { ActiveCellSection } from './ActiveCellSection';

interface CellTabProps {
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

export function CellTab({
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
}: CellTabProps): JSX.Element {
  return (
    <section className="flowquest-tabPanel">
      <ActiveCellSection
        store={store}
        notebook={notebook}
        globalState={globalState}
        configured={configured}
        flowyQuiz={flowyQuiz}
        flowyGenerating={flowyGenerating}
        flowyError={flowyError}
        onStartActiveCellQuiz={onStartActiveCellQuiz}
        onAnswerFlowyQuiz={onAnswerFlowyQuiz}
        onDismissFlowyQuiz={onDismissFlowyQuiz}
      />
    </section>
  );
}
