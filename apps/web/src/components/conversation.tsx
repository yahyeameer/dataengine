'use client';

import Link from 'next/link';
import { type Ref, useCallback, useEffect, useState } from 'react';

import { useArtefactDownload } from '@/components/artefact-download';
import { Mark } from '@/components/product-story';
import { ErrorText, buttonClass } from '@/components/ui';
import type { Turn } from '@/lib/conversation-history';
import { type Reference, referenceHref, splitReferences } from '@/lib/references';
import { createBrowserSupabase } from '@/lib/supabase/client';

/**
 * The parts a conversation with the agent is made of.
 *
 * The screen itself is `components/assistant-console`; this file is the round
 * trip, the turn, the answer renderer and the composer it assembles. They were
 * one component and one panel inside a workspace page until the history became
 * a screen of its own, and splitting them is what let the console reuse the
 * asking without reusing the layout.
 *
 * --- what this is, and what it is not --------------------------------------
 * It is one analyst working inside one client's books, not a general chat. It
 * reads this workspace and nothing else, it has no memory of other clients,
 * and every answer is about data the reader can see on the same screen. The
 * layout says so: answers are set as documents on the page rather than as
 * bubbles in a stream, because an accountant reads an answer about their books
 * the way they read a note from a colleague, not the way they read a text
 * message.
 *
 * --- the round trip ---------------------------------------------------------
 * Deliberately two halves, because the agent's gateway is fire-and-forget: the
 * POST records the question and returns an id, and the answer arrives later as
 * a database row. So this subscribes to that row rather than awaiting a
 * response -- which is also why a two-minute answer costs nothing here, where
 * a blocking request would have died at Vercel's 60-second ceiling.
 *
 * Realtime with a polling fallback, not because Realtime is unreliable, but
 * because the failure is silent: a dropped subscription looks exactly like an
 * agent still thinking, and the person waiting cannot tell the difference.
 *
 * --- why the history is server-rendered -------------------------------------
 * `hermes_answers` has held every question and answer since the feature
 * shipped, keyed to the workspace, and the panel used to render exactly one of
 * them: whichever the current React state was holding. Navigate away and a
 * conversation that was still in the database was gone from the product. The
 * turns below arrive as props from the page, so a refresh, a new tab and a
 * visit next week all show the same thread. The question row is written before
 * the agent is dispatched, so even a question still being thought about
 * survives a reload.
 */

/**
 * `Turn` itself lives in `lib/conversation-history`, with the grouping and
 * duplicate-matching that operate on it. This module is `'use client'`, and in
 * Next 16 every export of a client module is a client reference -- a server
 * page importing the shape from here would typecheck and throw at request time.
 */
export type { Turn };

const POLL_MS = 4000;
const GIVE_UP_MS = 5 * 60 * 1000;

/**
 * Openers, and every one of them is just a question.
 *
 * The agent takes free text about this workspace, so a suggestion is not a
 * feature claim -- it is a sentence the reader would otherwise have to think
 * of. Nothing here promises an action the product cannot perform: there is no
 * "build me a dashboard" among them, because there is no dashboard.
 */
export const SUGGESTIONS = [
  'What changed in the latest version?',
  'Summarise this dataset in a few lines.',
  'Which transactions look unusual?',
  'What is still waiting for my approval?',
];

/**
 * The conversation, as state.
 *
 * Extracted from the panel it was written inside, so the one implementation of
 * "ask, then wait for the row to settle" is not tied to a layout. The console
 * at /app/assistant is the only caller today and owns everything this hook does
 * not: which client is selected, the history list, and the deleting. The turns
 * are handed back rather than sealed in so it can -- removing a turn is the
 * console's business, and a hook that owned the array would have to grow an API
 * for it.
 */
export function useConversation({
  workspaceId,
  initialTurns = [],
}: {
  /** Where the next question goes. Null on the console until a client is chosen. */
  workspaceId: string | null;
  initialTurns?: Turn[];
}) {
  const [turns, setTurns] = useState<Turn[]>(initialTurns);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Everything still being thought about, not just the first one. The console
  // can have a question outstanding on two clients at once -- ask about
  // Hendricks, switch to Aldridge, ask again -- and watching only the earliest
  // left the second answer to arrive on a page refresh.
  //
  // Derived rather than stored: two sources of truth for "is it working" is how
  // a spinner outlives the thing it was spinning for. Joined into a string so
  // the effect below re-runs when the *set* changes rather than on every render
  // that rebuilds an equal array.
  const pendingIds = turns.filter((turn) => turn.status === 'pending').map((t) => t.requestId);
  const pendingKey = pendingIds.join(',');

  /** The turn the composer reports on: the newest one still open. */
  const waitingFor =
    [...turns].reverse().find((turn) => turn.status === 'pending' && turn.workspaceId === workspaceId) ??
    null;

  const settle = useCallback((requestId: string, patch: Partial<Turn>) => {
    setTurns((current) =>
      current.map((turn) => (turn.requestId === requestId ? { ...turn, ...patch } : turn)),
    );
  }, []);

  useEffect(() => {
    const ids = pendingKey ? pendingKey.split(',') : [];
    if (ids.length === 0) return;

    const supabase = createBrowserSupabase();
    let cancelled = false;

    // Realtime's filter takes one value, so one channel per open question. In
    // practice that is one or two; the poll below is what makes the count not
    // matter.
    const channels = ids.map((requestId) =>
      supabase
        .channel(`hermes_answers:${requestId}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'hermes_answers',
            filter: `request_id=eq.${requestId}`,
          },
          (message) => {
            if (cancelled) return;
            const row = message.new as {
              answer: string | null;
              status: string;
              error: string | null;
            };
            settle(requestId, { answer: row.answer, status: row.status, error: row.error });
          },
        )
        .subscribe(),
    );

    // The fallback, in one query for all of them. Also covers the case where
    // the agent answered between the POST returning and the subscription being
    // established.
    const poll = setInterval(async () => {
      const { data } = await supabase
        .from('hermes_answers')
        .select('request_id, answer, status, error')
        .in('request_id', ids);

      if (cancelled || !data) return;
      for (const row of data) {
        if (row.status !== 'pending') {
          settle(row.request_id, { answer: row.answer, status: row.status, error: row.error });
        }
      }
    }, POLL_MS);

    const timeout = setTimeout(() => {
      if (cancelled) return;
      for (const requestId of ids) {
        settle(requestId, {
          status: 'failed',
          error: 'No answer after five minutes. The question is saved — try asking again.',
        });
      }
    }, GIVE_UP_MS);

    return () => {
      cancelled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      for (const channel of channels) supabase.removeChannel(channel);
    };
  }, [pendingKey, settle]);

  /**
   * Ask, optionally somewhere other than the current workspace.
   *
   * The override exists for the console's "ask this again" control, which
   * repeats a question from the history against the client it was originally
   * asked about rather than whichever one happens to be selected.
   */
  async function ask(text: string, target: string | null = workspaceId) {
    const trimmed = text.trim();
    if (!trimmed || busy || !target) return;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/hermes/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: target, question: trimmed }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not reach the agent');

      setTurns((current) => [
        ...current,
        {
          requestId: body.requestId as string,
          workspaceId: target,
          question: trimmed,
          answer: null,
          status: 'pending',
          error: null,
          createdAt: new Date().toISOString(),
          deletedAt: null,
        },
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reach the agent');
    } finally {
      setBusy(false);
    }
  }

  return { turns, setTurns, busy, error, setError, waitingFor, ask };
}

/**
 * Before the first question.
 *
 * Four openers rather than a blank box. The blank box is not neutral -- it
 * asks the reader to invent the product's capabilities from nothing, and the
 * usual result is one cautious question and no second one.
 */
export function EmptyConversation({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="py-4">
      <div className="flex items-center gap-2.5">
        <span className="text-accent">
          <Mark className="h-5 w-5" />
        </span>
        <p className="text-[15px] font-medium tracking-tight">
          What would you like to know about this data?
        </p>
      </div>

      <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-muted">
        DataEngine reads this workspace directly — its datasets, versions and the changes you
        have approved. Answers can take a minute or two, and you can leave the page while it
        works.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPick(suggestion)}
            className="cursor-pointer rounded-[var(--radius)] border border-border bg-surface-2 px-3 py-1.5 text-[13px] text-muted transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One question and what came back for it. */
export function ConversationTurn({
  turn,
  references,
  workspaceId,
}: {
  turn: Turn;
  references: Reference[];
  workspaceId: string;
}) {
  return (
    <div>
      {/* The question, marked as the reader's own words. Indented and quieter
          than the answer: it is the thing they already know, kept for context
          rather than for reading. */}
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-[var(--radius-lg)] rounded-br-[var(--radius-sm)] border border-border bg-surface-2 px-3.5 py-2.5 text-[13px] leading-relaxed text-muted">
          {turn.question}
        </p>
      </div>

      <div className="mt-3.5 flex gap-3">
        <span
          aria-hidden
          className={`mt-0.5 shrink-0 ${turn.status === 'pending' ? 'text-accent pulse-dot' : 'text-subtle'}`}
        >
          <Mark className="h-[18px] w-[18px]" />
        </span>

        <div className="min-w-0 flex-1">
          {turn.status === 'pending' ? (
            <Thinking />
          ) : turn.status === 'failed' ? (
            <p className="rounded-[var(--radius)] border border-danger/30 bg-danger-soft/40 px-3.5 py-2.5 text-[13px] leading-relaxed text-danger">
              {turn.error ?? 'The agent could not answer that one.'}
            </p>
          ) : (
            <div className="rise">
              <AnswerBody
                text={turn.answer ?? ''}
                references={references}
                workspaceId={workspaceId}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The processing state, in one honest sentence.
 *
 * There is exactly one thing the backend tells us here: `hermes_answers.status`
 * is pending until it is not. There are no stages behind it, so this shows no
 * stages -- a checklist of invented steps ticking themselves off would be a
 * more convincing lie than "Loading", not a better interface. The categorise
 * flow does show its steps, because the worker genuinely reports them.
 *
 * What it does show is that something is still happening: a pulsing mark, a
 * line of copy, and three shimmer bars sized like the prose that will replace
 * them. All of it stops when the row settles, and all of it is disabled under
 * `prefers-reduced-motion` by the global rule in globals.css.
 */
function Thinking() {
  return (
    <div role="status" aria-live="polite">
      <p className="flex items-center gap-2 text-[13px] font-medium text-accent">
        Analysing your data
        <span aria-hidden className="thinking-dots" />
      </p>
      <div className="mt-3 space-y-2" aria-hidden>
        <div className="skeleton h-3.5 w-full" />
        <div className="skeleton h-3.5 w-11/12" />
        <div className="skeleton h-3.5 w-2/3" />
      </div>
      <span className="sr-only">Waiting for an answer from the agent.</span>
    </div>
  );
}

/**
 * The answer, with the structure the model actually wrote.
 *
 * A deliberately small renderer: paragraphs, bullet and numbered lists, fenced
 * code blocks and inline code. No HTML is interpreted and nothing is injected
 * -- every node below is a React element built from plain text, so an answer
 * quoting a customer's spreadsheet cannot become markup.
 *
 * It stops well short of a markdown library on purpose. The agent writes prose
 * with the occasional list or table of figures; the parts of markdown it does
 * not write are parts this does not need to support, and every one of them is
 * a way for a stray asterisk in an account name to change how the answer
 * reads.
 */
function AnswerBody({
  text,
  references,
  workspaceId,
}: {
  text: string;
  references: Reference[];
  workspaceId: string;
}) {
  const blocks = parseBlocks(text);

  return (
    <div className="space-y-3 text-sm leading-relaxed">
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          return (
            <pre
              key={index}
              className="overflow-x-auto rounded-[var(--radius)] border border-border bg-surface-2 px-3.5 py-3 font-mono text-[12px] leading-relaxed text-muted"
            >
              <code>{block.lines.join('\n')}</code>
            </pre>
          );
        }

        if (block.type === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List
              key={index}
              className={`space-y-1.5 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'} marker:text-subtle`}
            >
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <Inline text={item} references={references} workspaceId={workspaceId} />
                </li>
              ))}
            </List>
          );
        }

        return (
          <p key={index}>
            <Inline text={block.text} references={references} workspaceId={workspaceId} />
          </p>
        );
      })}
    </div>
  );
}

type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; lines: string[] };

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
      list = null;
    }
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (code) {
        blocks.push({ type: 'code', lines: code });
        code = null;
      } else {
        flushParagraph();
        flushList();
        code = [];
      }
      continue;
    }

    if (code) {
      code.push(line);
      continue;
    }

    const trimmed = line.trim();

    if (trimmed === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);

    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      const item = bullet ? bullet[1] : numbered![2];
      if (list && list.ordered === ordered) {
        list.items.push(item);
      } else {
        flushList();
        list = { ordered, items: [item] };
      }
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  if (code) blocks.push({ type: 'code', lines: code });
  flushParagraph();
  flushList();

  return blocks;
}

/**
 * Inline emphasis: `code` and **bold**, and nothing else.
 *
 * Figures are what the reader is scanning for, and the agent marks the ones it
 * considers load-bearing. Rendering those two and leaving every other
 * character alone is the whole of it.
 */
function Inline({
  text,
  references,
  workspaceId,
}: {
  text: string;
  references: Reference[];
  workspaceId: string;
}) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);

  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return (
            <code
              key={index}
              className="rounded-[var(--radius-sm)] border border-border bg-surface-2 px-1 py-0.5 font-mono text-[12px] text-foreground"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return (
            <strong key={index} className="font-semibold text-foreground">
              {part.slice(2, -2)}
            </strong>
          );
        }
        // Only plain prose is searched for names the workspace can resolve.
        // Code spans are left exactly as written -- a column called
        // `Transactions_August.xlsx` inside backticks is being quoted, not
        // linked to.
        return (
          <Referenced
            key={index}
            text={part}
            references={references}
            workspaceId={workspaceId}
          />
        );
      })}
    </>
  );
}

/**
 * Prose, with the names this workspace can resolve made into controls.
 *
 * A reference is rendered as a link to the thing itself -- the operation's own
 * row in the history, or the history filtered to that dataset -- and, when the
 * operation left a file behind, a download beside it that goes through the
 * same signed-URL route as every other download in the product.
 *
 * Everything else stays text. The matcher only emits a reference when a real
 * row backs it, so an answer that mentions a file nobody uploaded reads as an
 * ordinary sentence rather than as a dead link.
 */
function Referenced({
  text,
  references,
  workspaceId,
}: {
  text: string;
  references: Reference[];
  workspaceId: string;
}) {
  const segments = splitReferences(text, references);

  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <ReferenceChip
            key={index}
            text={segment.text}
            reference={segment.reference}
            workspaceId={workspaceId}
          />
        ),
      )}
    </>
  );
}

function ReferenceChip({
  text,
  reference,
  workspaceId,
}: {
  text: string;
  reference: Reference;
  workspaceId: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <Link
        href={referenceHref(reference, workspaceId)}
        title={
          reference.type === 'operation'
            ? `Open this ${reference.operationLabel.toLowerCase()} in the history below`
            : 'Show everything run on this dataset'
        }
        className="rounded-[var(--radius-sm)] border-b border-dotted border-accent/50 font-medium text-accent underline-offset-2 transition-colors hover:border-solid hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
      >
        {text}
      </Link>
      {reference.type === 'operation' && reference.downloadable && (
        <InlineDownload jobId={reference.jobId} />
      )}
    </span>
  );
}

/**
 * The download, at the size of a footnote.
 *
 * It sits inside a sentence, so it cannot be a button-shaped button; what it
 * still has to be is a real control with the states one needs -- hover, focus,
 * a disabled-and-working state while the URL is signed, and somewhere for the
 * failure to go.
 */
function InlineDownload({ jobId }: { jobId: string }) {
  const { busy, error, download } = useArtefactDownload(jobId);

  return (
    <>
      <button
        type="button"
        onClick={download}
        disabled={busy}
        title="Download the file this produced"
        aria-label="Download the file this produced"
        className="cursor-pointer rounded-[var(--radius-sm)] px-1 text-[11px] font-medium text-subtle transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? 'preparing…' : 'download'}
      </button>
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </>
  );
}

/**
 * The composer.
 *
 * A textarea rather than an input, because "what changed between version 3 and
 * version 4, and which of those touched an account over ten thousand pounds"
 * is a reasonable question and a single-line box hides all but the last few
 * words of it. Enter sends and Shift+Enter opens a line, which is the
 * convention every messaging tool has taught, and the hint under the box says
 * so rather than leaving it to be discovered.
 */
export function Composer({
  ref,
  value,
  onChange,
  onSubmit,
  busy,
  thinking,
  error,
}: {
  ref: Ref<HTMLTextAreaElement>;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  thinking: boolean;
  error: string | null;
}) {
  const empty = value.trim() === '';

  return (
    <div className="border-t border-border bg-surface-2/40 px-5 py-4">
      <div className="flex items-end gap-2.5">
        <textarea
          ref={ref}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          rows={1}
          disabled={busy}
          placeholder="Ask anything about this dataset…"
          aria-label="Ask about this workspace"
          className="max-h-40 min-h-[2.5rem] w-full flex-1 resize-y rounded-[var(--radius)] border border-border bg-surface px-3 py-2.5 text-sm leading-relaxed text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-subtle focus:border-accent focus:ring-2 focus:ring-[var(--accent-ring)] disabled:cursor-not-allowed disabled:opacity-45"
        />

        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || empty}
          className={`${buttonClass()} shrink-0`}
        >
          {busy ? 'Sending…' : 'Ask'}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="text-[11px] text-subtle">
          <kbd className="font-mono">Enter</kbd> to send · <kbd className="font-mono">Shift</kbd>
          {' + '}
          <kbd className="font-mono">Enter</kbd> for a new line
        </p>
        {thinking && (
          <p className="text-[11px] text-subtle">
            Working on your last question — you can leave this page.
          </p>
        )}
      </div>

      <ErrorText>{error}</ErrorText>
    </div>
  );
}
