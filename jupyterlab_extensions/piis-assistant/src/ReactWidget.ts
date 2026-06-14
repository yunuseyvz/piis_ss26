import { createRoot, type Root } from 'react-dom/client';
import { Widget } from '@lumino/widgets';

/**
 * Base class for React-backed UI components that are manually injected into the DOM.
 * Manages the React root and host element lifecycle.
 */
export abstract class ReactWidgetBase {
  protected host: HTMLElement;
  protected root: Root;

  constructor(hostElement?: HTMLElement) {
    this.host = hostElement ?? document.createElement('div');
    this.root = createRoot(this.host);
  }

  dispose(): void {
    this.root.unmount();
    this.host.remove();
  }

  protected abstract render(): void;
}

/**
 * Base class for React-backed Lumino Widgets (like the Sidebar).
 * Subclasses just need to implement `renderReact()`.
 */
export abstract class LuminoReactWidget extends Widget {
  protected root: Root;

  constructor(options?: Widget.IOptions) {
    super(options);
    this.root = createRoot(this.node);
  }

  dispose(): void {
    this.root.unmount();
    super.dispose();
  }

  protected abstract renderReact(): void;
}
