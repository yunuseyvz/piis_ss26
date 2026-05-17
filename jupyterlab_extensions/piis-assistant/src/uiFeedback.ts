/**
 * Shared UI feedback helpers — friendly error mapping, spinner / thinking
 * markup, retry-aware error blocks. Used by the cell decorations, quest
 * cells, settings panel, and sidebar so every surface looks the same when
 * the LLM is slow, dies, or rate-limits us.
 */

import { FlowquestApiError, escapeHtml } from './api';

export interface FriendlyError {
  kind: string;
  message: string;
}

export function toFriendlyError(error: unknown): FriendlyError {
  if (error instanceof FlowquestApiError) {
    return { kind: error.kind, message: error.message };
  }
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return { kind: 'other', message };
}

const ERROR_ICONS: Record<string, string> = {
  timeout: '⏱️',
  rate_limit: '🐌',
  auth: '🔐',
  network: '📡',
  http: '⚠️',
  other: '⚠️'
};

export function errorIcon(kind: string): string {
  return ERROR_ICONS[kind] ?? '⚠️';
}

/** Compact "thinking" indicator with three pulsing dots and a label. */
export function thinkingHtml(label: string): string {
  return `<div class="flowquest-thinking" role="status" aria-live="polite">
    <span class="flowquest-thinkingSpinner"></span>
    <span>${escapeHtml(label)}</span>
  </div>`;
}

/** Inline three-dot spinner suitable for inside a button. */
export function inlineSpinnerHtml(label: string): string {
  return `<span class="flowquest-spinnerInline">
    <span class="flowquest-spinnerDot"></span>
    <span class="flowquest-spinnerDot"></span>
    <span class="flowquest-spinnerDot"></span>
    <span>${escapeHtml(label)}</span>
  </span>`;
}

/** Block-level error message with an optional retry button and dismiss button. */
export function errorBlockHtml(
  err: FriendlyError,
  options: {
    retryAction?: string;
    dismissAction?: string;
    retryLabel?: string;
    dismissLabel?: string;
  } = {}
): string {
  const retry = options.retryAction
    ? `<button type="button" class="flowquest-btn flowquest-btn-primary" data-action="${escapeHtml(
        options.retryAction
      )}">↻ ${escapeHtml(options.retryLabel ?? 'Retry')}</button>`
    : '';
  const dismiss = options.dismissAction
    ? `<button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="${escapeHtml(
        options.dismissAction
      )}">${escapeHtml(options.dismissLabel ?? 'Dismiss')}</button>`
    : '';
  return `
    <div class="flowquest-inlineError">
      <div class="flowquest-inlineErrorHead">
        <span class="flowquest-inlineErrorIcon">${escapeHtml(errorIcon(err.kind))}</span>
        <span>${escapeHtml(err.message)}</span>
      </div>
      ${
        retry || dismiss
          ? `<div class="flowquest-actionsRow">${retry}${dismiss}</div>`
          : ''
      }
    </div>
  `;
}
