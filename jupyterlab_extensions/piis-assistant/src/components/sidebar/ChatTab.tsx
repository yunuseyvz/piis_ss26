/**
 * Chat tab of the FlowQuest sidebar.
 *
 * Notebook-aware conversation with Flowy, including context chip, compose
 * input, and starter prompts.
 */

import { useEffect, useRef } from 'react';

import type { ConversationMessage, NotebookContext } from '../../types';
import { FlowyMark, Icon, Markdown, Spinner } from '../shared';

interface ChatTabProps {
  configured: boolean;
  notebook: NotebookContext;
  messages: ConversationMessage[];
  prompt: string;
  phase: 'idle' | 'loading' | 'error' | 'ready';
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  onStarter: (starter: 'explain' | 'next' | 'issues') => void;
}

export function ChatTab({
  configured,
  notebook,
  messages,
  prompt,
  phase,
  onPromptChange,
  onSubmit,
  onClear,
  onStarter
}: ChatTabProps): JSX.Element {
  const disabled = !configured || phase === 'loading';
  const threadRef = useRef<HTMLDivElement>(null);

  const items: ConversationMessage[] = [...messages];
  if (phase === 'loading') {
    items.push({
      role: 'assistant',
      content: 'Thinking…',
      meta: 'Waiting for model response',
      includeInHistory: false
    });
  }

  const realTurns = items.filter(
    m => m.includeInHistory || m.meta === 'Waiting for model response'
  );
  const hasConversation = realTurns.length > 0;

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [items.length, phase]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <section className="flowquest-tabPanel flowquest-chatPanel">
      <div className="flowquest-thread" ref={threadRef}>
        {hasConversation ? (
          realTurns.map((message, idx) => {
            const isUser = message.role === 'user';
            const isThinking =
              message.role === 'assistant' && message.meta === 'Waiting for model response';
            return (
              <article key={idx} className={`flowquest-msg ${isUser ? 'is-user' : 'is-flowy'}`}>
                {!isUser && (
                  <span className="flowquest-msgAvatar">
                    <FlowyMark mood="happy" size={22} />
                  </span>
                )}
                <div className="flowquest-msgBubble">
                  {isThinking ? (
                    <Spinner label="Thinking…" />
                  ) : isUser ? (
                    message.content
                  ) : (
                    <Markdown source={message.content} />
                  )}
                </div>
              </article>
            );
          })
        ) : (
          <ChatEmpty configured={configured} onStarter={onStarter} />
        )}
      </div>

      <div className="flowquest-compose">
        <ContextChip notebook={notebook} />
        <div className="flowquest-composeRow">
          <textarea
            className="flowquest-composeInput"
            rows={1}
            placeholder="Message Flowy…"
            disabled={disabled}
            value={prompt}
            onChange={e => onPromptChange(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            type="button"
            className="flowquest-sendBtn"
            title="Send"
            disabled={disabled}
            onClick={onSubmit}
          >
            <Icon name="send" />
          </button>
        </div>
        <div className="flowquest-composeFoot">
          {hasConversation && (
            <button type="button" className="flowquest-linkBtn" onClick={onClear}>
              New chat
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function ContextChip({ notebook }: { notebook: NotebookContext }): JSX.Element {
  if (!notebook.hasNotebook) {
    return (
      <div className="flowquest-contextChip" title="Flowy automatically sees this context">
        <span className="flowquest-contextChipIcon">
          <Icon name="contextWorkspace" />
        </span>
        <span className="flowquest-contextChipLabel">Workspace</span>
        <span className="flowquest-contextChipHint">no notebook</span>
      </div>
    );
  }

  const cellNote =
    notebook.activeCellIndex >= 0 ? `cell ${notebook.activeCellIndex + 1} active` : 'no active cell';

  return (
    <div
      className="flowquest-contextChip"
      title="Flowy sees your whole notebook plus which cell is active"
    >
      <span className="flowquest-contextChipIcon">
        <Icon name="contextNotebook" />
      </span>
      <span className="flowquest-contextChipLabel">{notebook.notebookName}</span>
      <span className="flowquest-contextChipHint">
        {notebook.cellCount} cells · {cellNote}
      </span>
    </div>
  );
}

function ChatEmpty({
  configured,
  onStarter
}: {
  configured: boolean;
  onStarter: (starter: 'explain' | 'next' | 'issues') => void;
}): JSX.Element {
  return (
    <div className="flowquest-chatEmpty">
      <span className="flowquest-chatEmptyAvatar">
        <FlowyMark mood="happy" size={60} />
      </span>
      <div className="flowquest-chatEmptyTitle">Ask Flowy anything</div>
      <div className="flowquest-dim">
        I can see your whole notebook — every cell, its outputs, and which cell you're on right
        now. Ask away and I'll answer in full context.
      </div>
      {configured ? (
        <div className="flowquest-chatStarters">
          <button
            type="button"
            className="flowquest-starterChip"
            onClick={() => onStarter('explain')}
          >
            Explain the cell I'm on
          </button>
          <button type="button" className="flowquest-starterChip" onClick={() => onStarter('next')}>
            What should I do next?
          </button>
          <button
            type="button"
            className="flowquest-starterChip"
            onClick={() => onStarter('issues')}
          >
            Find problems in my notebook
          </button>
        </div>
      ) : (
        <div className="flowquest-chatNotice">
          <Icon name="warn" /> Open Settings to connect a model endpoint first.
        </div>
      )}
    </div>
  );
}
