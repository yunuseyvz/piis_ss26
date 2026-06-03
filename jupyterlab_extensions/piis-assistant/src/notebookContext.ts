import { NotebookPanel } from '@jupyterlab/notebook';

import { clipText } from './api';
import type { NotebookContext } from './types';

export { EMPTY_QUEST_STATE } from './questState';

const NOTEBOOK_CONTEXT_LIMIT = 12000;

export const EMPTY_NOTEBOOK: NotebookContext = {
  hasNotebook: false,
  notebookName: 'No notebook selected',
  path: 'No notebook open',
  cellCount: 0,
  activeCellIndex: -1,
  activeCellType: 'none',
  activeCellSource: '',
  activeOutput: '',
  selectedOutput: '',
  kernelName: 'No kernel',
  kernelStatus: 'disconnected',
  contextMode: 'workspace',
  attachmentLabel: 'Workspace context attached',
  attachmentPreview:
    'Open a notebook to attach the active cell automatically. Until then, prompts only carry lightweight workspace context.',
  attachedPromptContext:
    'Workspace context: FlowQuest project. No notebook is currently open in JupyterLab.'
};

function serializeNotebook(panel: NotebookPanel, activeIndex: number): string {
  const model = panel.content.model;
  if (!model || model.cells.length === 0) {
    return 'Notebook has no cells.';
  }

  const chunks: string[] = [];
  let totalLength = 0;

  for (let index = 0; index < model.cells.length; index += 1) {
    const cell = model.cells.get(index);
    const source = clipText(cell.sharedModel.getSource(), 1600) || '[empty cell]';
    const marker = index === activeIndex ? '  ← active cell' : '';
    // Include the execution count for code cells so Flowy can reason about
    // run order / stale state.
    const exec =
      cell.type === 'code'
        ? (() => {
            const raw = (cell.sharedModel as unknown as { execution_count?: number | null })
              .execution_count;
            return typeof raw === 'number' ? ` [exec ${raw}]` : ' [not run]';
          })()
        : '';
    const block = `Cell ${index + 1} (${cell.type})${exec}${marker}\n${source}`;
    const extraLength = block.length + 2;

    if (totalLength + extraLength > NOTEBOOK_CONTEXT_LIMIT) {
      chunks.push('[Notebook context truncated]');
      break;
    }

    chunks.push(block);
    totalLength += extraLength;
  }

  return chunks.join('\n\n');
}

export function describeNotebook(panel: NotebookPanel | null): NotebookContext {
  if (!panel || !panel.content.model) {
    return EMPTY_NOTEBOOK;
  }

  const model = panel.content.model;
  const notebookName =
    panel.title.label || panel.context.path.split('/').pop() || 'Untitled notebook';
  const activeCell = panel.content.activeCell;
  const activeCellIndex = activeCell ? panel.content.activeCellIndex : -1;
  const activeCellType = activeCell?.model.type ?? 'none';
  const activeCellSource = activeCell
    ? clipText(activeCell.model.sharedModel.getSource(), 3000)
    : '';
  const activeOutput = activeCell
    ? clipText(
        activeCell.node.querySelector('.jp-OutputArea-output')?.textContent ?? '',
        1200
      )
    : '';

  let selectedOutput = '';
  const selection = window.getSelection();
  const selectionText = selection?.toString().trim() ?? '';
  const outputNode = activeCell?.node.querySelector('.jp-OutputArea-output');
  const anchorNode = selection?.anchorNode ?? null;
  const anchorElement =
    anchorNode instanceof Element
      ? anchorNode
      : anchorNode && 'parentElement' in anchorNode
        ? anchorNode.parentElement
        : null;

  if (selectionText && outputNode && anchorElement && outputNode.contains(anchorElement)) {
    selectedOutput = clipText(selectionText, 1200);
  }

  const notebookMeta = [
    `Notebook path: ${panel.context.path}`,
    `Notebook name: ${notebookName}`,
    `Cell count: ${model.cells.length}`,
    `Kernel: ${panel.sessionContext.kernelDisplayName || 'No kernel'} (${panel.sessionContext.session?.kernel?.status ?? 'disconnected'})`
  ];

  // Flowy always gets the full notebook ("Gesamtkontext"), with the active
  // cell clearly marked, plus the active cell's source/output called out
  // separately so the model can focus when the user asks about "this cell".
  const wholeNotebook = serializeNotebook(panel, activeCellIndex);
  const hasActiveCell = activeCellIndex >= 0;
  const outputCopy = selectedOutput || activeOutput;

  const activeSection: string[] = [];
  if (hasActiveCell) {
    activeSection.push(
      '',
      `Currently active cell: ${activeCellIndex + 1} (${activeCellType})`,
      'Active cell source:',
      activeCellSource || '[empty cell]'
    );
    if (outputCopy) {
      activeSection.push('', 'Active cell output preview:', outputCopy);
    }
  } else {
    activeSection.push('', 'No cell is currently focused.');
  }

  const attachedPromptContext = clipText(
    [
      ...notebookMeta,
      '',
      'Full notebook contents (the active cell is marked):',
      wholeNotebook,
      ...activeSection
    ].join('\n'),
    NOTEBOOK_CONTEXT_LIMIT
  );

  const attachmentLabel = hasActiveCell
    ? `Whole notebook + cell ${activeCellIndex + 1}`
    : 'Whole notebook attached';
  const attachmentPreview = hasActiveCell
    ? activeCellSource || outputCopy || '[empty cell]'
    : clipText(wholeNotebook, 1400);

  return {
    hasNotebook: true,
    notebookName,
    path: panel.context.path,
    cellCount: model.cells.length,
    activeCellIndex,
    activeCellType,
    activeCellSource,
    activeOutput,
    selectedOutput,
    kernelName: panel.sessionContext.kernelDisplayName || 'No kernel',
    kernelStatus: panel.sessionContext.session?.kernel?.status ?? 'disconnected',
    // Always whole-notebook context; the active cell is highlighted within it.
    contextMode: hasActiveCell ? 'active-cell' : 'whole-notebook',
    attachmentLabel,
    attachmentPreview,
    attachedPromptContext
  };
}

export interface AnalysisPayloadCell {
  cell_type: string;
  source: string;
  exec_count: number | null;
  id: string;
  has_output: boolean;
  has_plot: boolean;
}

export interface AnalysisPayload {
  notebookPath: string;
  cells: AnalysisPayloadCell[];
}

export function buildAnalysisPayload(panel: NotebookPanel): AnalysisPayload {
  const model = panel.content.model;
  const cells: AnalysisPayloadCell[] = [];

  if (model) {
    for (let index = 0; index < model.cells.length; index += 1) {
      const cell = model.cells.get(index);
      const shared = cell.sharedModel;
      const source = shared.getSource();

      const execCount = (() => {
        if (cell.type !== 'code') {
          return null;
        }
        const raw = (shared as unknown as { execution_count?: number | null }).execution_count;
        if (typeof raw === 'number') {
          return raw;
        }
        return null;
      })();

      // Detect existing outputs via the widget DOM (best-effort).
      const widget = panel.content.widgets[index];
      let hasOutput = false;
      let hasPlot = false;
      if (widget) {
        const outputArea = widget.node.querySelector('.jp-OutputArea-output');
        hasOutput = Boolean(outputArea && outputArea.textContent?.trim());
        hasPlot = Boolean(
          widget.node.querySelector('.jp-OutputArea-output img, .jp-OutputArea-output canvas, .jp-OutputArea-output svg')
        );
      }

      cells.push({
        cell_type: cell.type,
        source,
        exec_count: execCount,
        id: (shared as unknown as { id?: string }).id ?? `cell-${index}`,
        has_output: hasOutput,
        has_plot: hasPlot
      });
    }
  }

  return {
    notebookPath: panel.context.path,
    cells
  };
}
