/**
 * Tiny, dependency-free Markdown → HTML renderer for Flowy's chat replies.
 *
 * Safety first: the input is HTML-escaped *before* any markdown transform runs,
 * so model output can never inject live markup. We then re-introduce a small,
 * fixed set of formatting tags. This intentionally supports only the subset an
 * LLM chat reply needs — headings, bold/italic, inline + fenced code, links,
 * bullet/numbered lists, blockquotes, and paragraphs.
 */

import { escapeHtml } from './api';

interface CodeBlock {
  placeholder: string;
  html: string;
}

/** Render a Markdown string to a safe HTML string. */
export function renderMarkdown(input: string): string {
  if (!input || !input.trim()) {
    return '';
  }

  // 1. Escape everything up front so no raw HTML survives.
  let text = escapeHtml(input.replace(/\r\n/g, '\n'));

  // 2. Pull fenced code blocks out so their contents aren't touched by the
  //    inline/block passes, then restore them at the end.
  const codeBlocks: CodeBlock[] = [];
  text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const placeholder = `\u0000CODEBLOCK${codeBlocks.length}\u0000`;
    const langClass = lang ? ` data-lang="${lang}"` : '';
    const body = code.replace(/\n$/, '');
    codeBlocks.push({
      placeholder,
      html: `<pre class="flowquest-mdCode"${langClass}><code>${body}</code></pre>`
    });
    return placeholder;
  });

  // 3. Block-level parse, line by line, grouping lists and blockquotes.
  const lines = text.split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let inQuote = false;
  let paragraph: string[] = [];

  const closeList = (): void => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeQuote = (): void => {
    if (inQuote) {
      out.push('</blockquote>');
      inQuote = false;
    }
  };
  const flushParagraph = (): void => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Blank line — paragraph / block separator.
    if (!line.trim()) {
      flushParagraph();
      closeList();
      closeQuote();
      continue;
    }

    // Code-block placeholder on its own line.
    if (/^\u0000CODEBLOCK\d+\u0000$/.test(line.trim())) {
      flushParagraph();
      closeList();
      closeQuote();
      out.push(line.trim());
      continue;
    }

    // Headings: # … ######
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      closeQuote();
      const level = heading[1].length;
      out.push(`<h${level} class="flowquest-mdH">${inline(heading[2])}</h${level}>`);
      continue;
    }

    // Horizontal rule.
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph();
      closeList();
      closeQuote();
      out.push('<hr class="flowquest-mdHr" />');
      continue;
    }

    // Blockquote.
    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      closeList();
      if (!inQuote) {
        out.push('<blockquote class="flowquest-mdQuote">');
        inQuote = true;
      }
      out.push(`<p>${inline(quote[1])}</p>`);
      continue;
    }
    closeQuote();

    // Unordered list item.
    const ulItem = /^[-*+]\s+(.*)$/.exec(line);
    if (ulItem) {
      flushParagraph();
      if (listType !== 'ul') {
        closeList();
        out.push('<ul class="flowquest-mdList">');
        listType = 'ul';
      }
      out.push(`<li>${inline(ulItem[1])}</li>`);
      continue;
    }

    // Ordered list item.
    const olItem = /^\d+[.)]\s+(.*)$/.exec(line);
    if (olItem) {
      flushParagraph();
      if (listType !== 'ol') {
        closeList();
        out.push('<ol class="flowquest-mdList">');
        listType = 'ol';
      }
      out.push(`<li>${inline(olItem[1])}</li>`);
      continue;
    }

    // Plain text — accumulate into the current paragraph or current list item.
    if (listType) {
      const lastLine = out.pop()!;
      out.push(lastLine.replace(/<\/li>$/, ` ${inline(line.trim())}</li>`));
    } else {
      paragraph.push(line.trim());
    }
  }

  flushParagraph();
  closeList();
  closeQuote();

  let html = out.join('\n');

  // 4. Restore the fenced code blocks.
  for (const block of codeBlocks) {
    html = html.replace(block.placeholder, block.html);
  }

  return html;
}

/** Inline-level markdown: code spans, bold, italic, strikethrough, links. */
function inline(text: string): string {
  let result = text;

  // Inline code spans first (so their contents escape the other rules).
  const codeSpans: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_m, code: string) => {
    const placeholder = `\u0001CODE${codeSpans.length}\u0001`;
    codeSpans.push(`<code class="flowquest-mdInlineCode">${code}</code>`);
    return placeholder;
  });

  // Links: [text](url) — only allow http(s)/mailto to avoid javascript: URIs.
  result = result.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, label: string, url: string) => {
      if (!/^(https?:\/\/|mailto:)/i.test(url)) {
        return `${label} (${url})`;
      }
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
  );

  // Bold then italic. Use non-greedy matches.
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  result = result.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  result = result.replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');
  result = result.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Restore inline code spans.
  codeSpans.forEach((span, i) => {
    result = result.replace(`\u0001CODE${i}\u0001`, span);
  });

  return result;
}
