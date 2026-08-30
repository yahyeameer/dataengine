'use client';

import { useEffect, useRef, useState } from 'react';

import { createBrowserSupabase } from '@/lib/supabase/client';
import { ErrorText, buttonClass } from '@/components/ui';

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

  return (
    <section className="rounded-[var(--radius-lg)] border border-border px-4 py-3">
      <p className="text-sm font-medium">Ask about this workspace</p>
      <p className="mt-1 text-xs text-subtle">
        Goes to the Hermes agent, which reads the data directly. Answers can take a minute or
        two — you can leave this page and come back.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !busy) ask();
          }}
          disabled={busy}
          placeholder="e.g. what changed in the latest version?"
          className="min-w-64 flex-1 rounded border border-border px-2 py-1.5 text-xs  dark:bg-transparent"
        />
        <button
          type="button"
          onClick={ask}
          disabled={busy || !question.trim()}
          className={`${buttonClass} px-3 py-1.5 text-xs`}
        >
          {busy ? 'Sending…' : 'Ask'}
        </button>
      </div>

      <ErrorText>{error}</ErrorText>

      {pending ? (
        <div className="mt-3 rounded border border-border px-3 py-2">
          <p className="text-xs text-subtle">{pending.question}</p>

          {pending.status === 'pending' ? (
            <p className="mt-2 text-xs text-muted">Thinking…</p>
          ) : pending.status === 'failed' ? (
            <p className="mt-2 text-xs text-danger">
              {pending.error ?? 'The agent could not answer.'}
            </p>
          ) : (
            <p className="mt-2 whitespace-pre-wrap text-sm">{pending.answer}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
