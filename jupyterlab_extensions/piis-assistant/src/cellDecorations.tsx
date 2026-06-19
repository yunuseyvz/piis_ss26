import { NotebookPanel } from '@jupyterlab/notebook';
import { Cell } from '@jupyterlab/cells';
import { FlowQuestStore } from './state';
import { CellPanel } from './components/CellPanel';
import { createRoot, Root } from 'react-dom/client';

export class CellDecorations {
  private panel: NotebookPanel;
  private store: FlowQuestStore;
  private host: HTMLElement | null = null;
  private root: Root | null = null;
  private activeCell: Cell | null = null;

  constructor(panel: NotebookPanel, store: FlowQuestStore) {
    this.panel = panel;
    this.store = store;

    this.panel.content.activeCellChanged.connect(this.onActiveCellChanged, this);

    // Trigger for the initial active cell if it exists
    if (this.panel.content.activeCell) {
      this.onActiveCellChanged(this.panel.content, this.panel.content.activeCell);
    }

    // Listen to state changes to re-render when analysis or endpoints change
    this.store.subscribe(() => {
      this.render();
    });
  }

  dispose(): void {
    this.panel.content.activeCellChanged.disconnect(this.onActiveCellChanged, this);
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
    if (this.host) {
      this.host.remove();
      this.host = null;
    }
  }

  private onActiveCellChanged(_sender: any, cell: Cell | null): void {
    this.activeCell = cell;
    if (!cell || cell.model.type === 'markdown') {
      this.removeHost();
      return;
    }
    this.attachToCell(cell);
    this.render();
  }

  private removeHost(): void {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
    if (this.host) {
      this.host.remove();
      this.host = null;
    }
  }

  private attachToCell(cell: Cell): void {
    this.removeHost();

    this.host = document.createElement('div');
    this.host.className = 'flowquest-cell-decorations-host';
    this.host.style.position = 'relative';
    this.host.style.height = '28px';
    this.host.style.zIndex = '10000';

    // Inject above the cell. We insert it at the top of the cell node.
    const node = cell.node;
    node.insertBefore(this.host, node.firstChild);

    this.root = createRoot(this.host);
  }

  private render(): void {
    if (!this.root || !this.activeCell) return;

    const path = this.panel.context.path;
    const slice = this.store.getNotebookSlice(path);
    const endpointStatus = this.store.getEndpointStatus();

    const model = this.panel.content.model;
    if (!model) return;

    let cellIndex = -1;
    for (let i = 0; i < model.cells.length; i++) {
      if (model.cells.get(i).id === this.activeCell.model.id) {
        cellIndex = i;
        break;
      }
    }
    if (cellIndex === -1) return;

    const cellAnalysis = slice.analysis?.cells.find(c => c.index === cellIndex);
    const region = cellAnalysis?.region ?? 'other';
    const cellSource = this.activeCell.model.sharedModel.getSource();

    // Use a unique key based on cell path + ID so React completely remounts state
    // when moving between cells, preventing lingering 'Explain' loading states
    const cellKey = `${path}:${this.activeCell.model.id}`;

    this.root.render(
      <CellPanel
        key={cellKey}
        store={this.store}
        notebookPath={path}
        cellIndex={cellIndex}
        cellSource={cellSource}
        region={region}
        configured={endpointStatus.configured}
      />
    );
  }
}
