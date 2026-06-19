/**
 * Shared utility functions used across multiple FlowQuest components.
 *
 * Extracted here to avoid duplication between SidebarApp, SettingsModal,
 * CellPanel, OpenActivity, questCells, etc.
 */

/**
 * Format a Unix timestamp as a relative time string (e.g. "3s ago", "2m ago").
 */
export function formatRelative(ts: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Stop keyboard event propagation so JupyterLab doesn't intercept
 * keystrokes in text inputs / textareas injected inside notebooks.
 */
export function stopKeyboardPropagation(event: React.KeyboardEvent): void {
  event.stopPropagation();
}

/**
 * Stop all interactive event propagation from injected DOM elements
 * so JupyterLab's own handlers don't steal focus / selection.
 */
export function containEvent(event: Event): void {
  event.stopPropagation();
}
