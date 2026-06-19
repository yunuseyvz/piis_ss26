/**
 * Friendly error block with optional retry/dismiss actions.
 */

import { toFriendlyError, type FriendlyError } from '../../uiFeedback';
import { Icon } from './Icon';

interface ErrorBlockProps {
  error: unknown;
  retryLabel?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  dismissLabel?: string;
  compact?: boolean;
}

export function ErrorBlock({
  error,
  retryLabel = 'Retry',
  onRetry,
  onDismiss,
  dismissLabel = 'Dismiss',
  compact = false
}: ErrorBlockProps): JSX.Element {
  const friendly: FriendlyError =
    error && typeof error === 'object' && 'kind' in error && 'message' in error
      ? (error as FriendlyError)
      : toFriendlyError(error);

  return (
    <div className={`flowquest-inlineError${compact ? ' flowquest-inlineError-compact' : ''}`}>
      <div className="flowquest-inlineErrorHead">
        <span className="flowquest-inlineErrorIcon">
          <Icon name={friendly.kind as never} />
        </span>
        <span>{friendly.message}</span>
      </div>
      {(onRetry || onDismiss) && (
        <div className="flowquest-actionsRow">
          {onRetry && (
            <button type="button" className="flowquest-btn flowquest-btn-primary" onClick={onRetry}>
              <Icon name="refresh" /> {retryLabel}
            </button>
          )}
          {onDismiss && (
            <button type="button" className="flowquest-btn flowquest-btn-ghost" onClick={onDismiss}>
              {dismissLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
