import { NotebookPanel } from '@jupyterlab/notebook';

import { clipText } from './api';
import type { NotebookContext } from './types';

export { EMPTY_QUEST_STATE } from './questStore';

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

function serializeNotebook(panel: NotebookPanel): string {
  const model = panel.content.model;
  if (!model || model.cells.length === 0) {
    return 'Notebook has no cells.';
  }

  const chunks: string[] = [];
  let totalLength = 0;

  for (let index = 0; index < model.cells.length; index += 1) {
    const cell = model.cells.get(index);
    const source = clipText(cell.sharedModel.getSource(), 1600) || '[empty cell]';
    const block = `Cell ${index + 1} (${cell.type})\n${source}`;
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

  const wholeNotebook = serializeNotebook(panel);
  const hasActiveContext =
    activeCellIndex >= 0 && Boolean(activeCellSource || selectedOutput || activeOutput);

  if (hasActiveContext) {
    const outputCopy = selectedOutput || activeOutput;
    const attachedPromptContext = [
      ...notebookMeta,
      `Active cell: ${activeCellIndex + 1} (${activeCellType})`,
      '',
      'Active cell source:',
      activeCellSource || '[empty cell]'
    ];

    if (outputCopy) {
      attachedPromptContext.push('', 'Active output preview:', outputCopy);
    }

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
      contextMode: 'active-cell',
      attachmentLabel: `Cell ${activeCellIndex + 1} attached automatically`,
      attachmentPreview: activeCellSource || outputCopy || '[empty cell]',
      attachedPromptContext: clipText(
        attachedPromptContext.join('\n'),
        NOTEBOOK_CONTEXT_LIMIT
      )
    };
  }

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
    contextMode: 'whole-notebook',
    attachmentLabel: 'Whole notebook attached automatically',
    attachmentPreview: clipText(wholeNotebook, 1400),
    attachedPromptContext: clipText(
      [...notebookMeta, '', 'Notebook contents:', wholeNotebook].join('\n'),
      NOTEBOOK_CONTEXT_LIMIT
    )
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
