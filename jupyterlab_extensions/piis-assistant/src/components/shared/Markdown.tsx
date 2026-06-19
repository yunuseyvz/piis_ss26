/**
 * React wrapper around the safe, escape-first Markdown renderer.
 *
 * The returned HTML is sanitized by `renderMarkdown` before insertion, so
 * passing model output or user text through this component is safe.
 */

import { renderMarkdown } from '../../markdown';

interface MarkdownProps {
  source: string;
  className?: string;
}

export function Markdown({ source, className = 'flowquest-md' }: MarkdownProps): JSX.Element {
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }}
    />
  );
}
