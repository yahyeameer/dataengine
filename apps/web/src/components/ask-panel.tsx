'use client';

import { useEffect, useRef, useState } from 'react';

import { createBrowserSupabase } from '@/lib/supabase/client';
import { ErrorText, buttonClass, inputClass } from '@/components/ui';

type Answer = {
  request_id: string;
  question: string;
  answer: string | null;
  status: string;
  error: string | null;
};

/**
 * Asking the agent a question about this workspace.
 *
 * The round trip is deliberately in two halves, because the agent's gateway is
 * fire-and-forget: the POST records the question and returns an id, and the
 * answer arrives later as a database row. So this subscribes to that row rather
 * than awaiting a response -- which is also why a two-minute answer costs
 * nothing here, where a blocking request would have died at Vercel's 60-second
 * ceiling.
 *
 * Realtime with a polling fallback, not because Realtime is unreliable, but
 * because the failure is silent: a dropped subscription looks exactly like an
 * agent still thinking, and the person waiting cannot tell the difference. The
 * poll is slow enough to be nearly free and guarantees the answer lands.
 */

const POLL_MS = 4000;
const GIVE_UP_MS = 5 * 60 * 1000;

export function AskPanel({ workspaceId }: { workspaceId: string }) {
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef<string | null>(null);

  useEffect(() => {
    const requestId = pending?.request_id;
    if (!requestId || pending?.status !== 'pending') return;

    const supabase = createBrowserSupabase();
    let cancelled = false;

    function settle(row: Answer) {
      if (cancelled || requestRef.current !== row.request_id) return;
      setPending(row);
    }

    const channel = supabase
      .channel(`hermes_answers:${requestId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'hermes_answers',
          filter: `request_id=eq.${requestId}`,
        },
        (message) => settle(message.new as Answer),
      )
      .subscribe();

    // The fallback. Also covers the case where the agent answered between the
    // POST returning and this subscription being established.
    const poll = setInterval(async () => {
      const { data } = await supabase
        .from('hermes_answers')
        .select('request_id, question, answer, status, error')
        .eq('request_id', requestId)
        .maybeSingle();
      if (data && data.status !== 'pending') settle(data as Answer);
    }, POLL_MS);

    const timeout = setTimeout(() => {
      if (cancelled) return;
      setPending((current) =>
        current && current.status === 'pending'
          ? { ...current, status: 'failed', error: 'No answer after five minutes.' }
          : current,
      );
    }, GIVE_UP_MS);

    return () => {
      cancelled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      supabase.removeChannel(channel);
    };
  }, [pending?.request_id, pending?.status]);

  async function ask() {
    const text = question.trim();
    if (!text) return;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/hermes/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, question: text }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not reach the agent');

      requestRef.current = body.requestId;
      setPending({
        request_id: body.requestId,
        question: text,
        answer: null,
        status: 'pending',
        error: null,
      });
      setQuestion('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reach the agent');
    } finally {
      setBusy(false);
    }
  }

  const thinking = pending?.status === 'pending';

  return (
    // Glass, deliberately. The design system reserves it for the surfaces that
    // float above the page rather than sit in it, and this is the one panel on
    // the workspace that is a conversation rather than a record. It was a bare
    // bordered box with a 12px input -- the least considered surface on a
    // screen whose whole premise is that there is an agent behind it.
    <section className="glass overflow-hidden rounded-[var(--radius-lg)] shadow-[var(--shadow)]">
      <div className="p-5">
        <div className="flex gap-2">
          <input
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy) ask();
            }}
            disabled={busy}
            placeholder="e.g. what changed in the latest version?"
            aria-label="Ask about this workspace"
            className={inputClass}
          />
          <button
            type="button"
            onClick={ask}
            disabled={busy || !question.trim()}
            className={`${buttonClass()} shrink-0`}
          >
            {busy ? 'Sending…' : 'Ask'}
          </button>
        </div>

        <p className="mt-2.5 text-xs leading-relaxed text-subtle">
          Answers come from the Hermes agent, which reads this workspace&rsquo;s data directly.
          They can take a minute or two — you can leave this page and come back.
        </p>

        <ErrorText>{error}</ErrorText>
      </div>

      {pending ? (
        <div className="border-t border-border bg-surface-2/40 px-5 py-4">
          <p className="text-[13px] font-medium text-muted">{pending.question}</p>

          {thinking ? (
            // A skeleton rather than the word "Thinking…". The answer is prose
            // of unknown length arriving up to two minutes later, and a line of
            // static text gives no sign that anything is still happening.
            <div className="mt-3 space-y-2" role="status" aria-label="Waiting for an answer">
              <div className="flex items-center gap-2 text-xs text-subtle">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent pulse-dot" />
                Working on it
              </div>
              <div className="skeleton h-3.5 w-full" />
              <div className="skeleton h-3.5 w-11/12" />
              <div className="skeleton h-3.5 w-2/3" />
            </div>
          ) : pending.status === 'failed' ? (
            <p className="mt-2.5 text-sm text-danger">
              {pending.error ?? 'The agent could not answer.'}
            </p>
          ) : (
            <p className="mt-2.5 whitespace-pre-wrap text-sm leading-relaxed">{pending.answer}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
