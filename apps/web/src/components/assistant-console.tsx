'use client';

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Check, Loader2, RotateCcw, Search, Trash2, X } from 'lucide-react';

import {
  Composer,
  ConversationTurn,
  EmptyConversation,
  SUGGESTIONS,
  useConversation,
} from '@/components/conversation';
import { Mark } from '@/components/product-story';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  ErrorText,
  SegmentedControl,
  dangerButtonClass,
  ghostButtonClass,
  inputClassSm,
  secondaryButtonClass,
  selectClassSm,
} from '@/components/ui';
import {
  FILTER_LABELS,
  FILTER_ORDER,
  type Grouping,
  type HistoryFilter,
  type Turn,
  type WorkspaceOption,
  filterCounts,
  filterTurns,
  formatTurnTime,
  groupTurns,
  redundantTurns,
  workspaceLabel,
} from '@/lib/conversation-history';
import type { Reference } from '@/lib/references';

/**
 * The assistant, as a room rather than a panel.
 *
 * --- why this screen exists -------------------------------------------------
 * The conversation used to be the seventh section of a workspace page, under
 * eight thousand pixels of machinery, holding whichever single turn React state
 * happened to have. Everything a person does with an assistant afterwards --
 * find what it told them last Tuesday, ask the same thing about a different
 * client, throw away the three attempts that came out wrong -- had nowhere to
 * happen. `hermes_answers` had every one of those turns the whole time.
 *
 * So: history on the left, one conversation on the right, and a client picker
 * on the composer rather than in the URL bar. The picker is the important part.
 * The agent reads one workspace and answers about that workspace, so which one
 * is the single most consequential thing on the screen and it sits directly
 * above the box where the question is typed, not three clicks back in a
 * navigation tree.
 *
 * --- what the left column is ------------------------------------------------
 * Not a list of chats. There are no chats -- `hermes_answers` records
 * question-and-answer pairs, and inventing threads to group them into would be
 * a fiction the database would contradict the moment two people used the same
 * workspace. It is the record, filed four honest ways: when, which client,
 * whether an answer came back, and whether the same question was asked twice.
 *
 * --- three kinds of gone ----------------------------------------------------
 * Removing a turn puts it in the trash and it can come back. Emptying the trash
 * deletes the row from Postgres and it cannot. The duplicate sweep is the
 * middle case people actually reach for: it removes the older copies of
 * repeated questions and keeps the newest of each, to the trash, so a
 * mis-press costs nothing.
 */

export function AssistantConsole({
  workspaces,
  initialTurns,
  selectedWorkspaceId,
  references,
  focusRequestId,
}: {
  workspaces: WorkspaceOption[];
  /** Every turn this firm can see, across every client. */
  initialTurns: Turn[];
  selectedWorkspaceId: string | null;
  /**
   * The names in the selected workspace an answer might mention. Resolved on
   * the server for that one workspace rather than for all of them: the query
   * behind it reads a workspace's whole operation history, and a practice with
   * forty clients should not pay for thirty-nine it is not reading.
   */
  references: Reference[];
  focusRequestId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const { turns, setTurns, busy, error, waitingFor, ask } = useConversation({
    workspaceId: selectedWorkspaceId,
    initialTurns,
  });

  const [question, setQuestion] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [grouping, setGrouping] = useState<Grouping>('date');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingConfirm, setPendingConfirm] = useState<PermanentDelete | null>(null);
  const [working, setWorking] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  const counts = useMemo(() => filterCounts(turns), [turns]);
  const visible = useMemo(() => filterTurns(turns, filter, search), [turns, filter, search]);
  const groups = useMemo(
    () => groupTurns(visible, grouping, workspaces),
    [visible, grouping, workspaces],
  );

  // The conversation on the right: this client's live turns, oldest first, the
  // way a thread reads. The trash is not shown here at all -- a removed turn is
  // removed from the conversation, not merely from the index of it.
  const thread = useMemo(
    () =>
      turns
        .filter((turn) => turn.workspaceId === selectedWorkspaceId && !turn.deletedAt)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [turns, selectedWorkspaceId],
  );

  const sweepable = useMemo(
    () => redundantTurns(turns.filter((turn) => !turn.deletedAt)),
    [turns],
  );

  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;

  // New answers and new questions both belong at the bottom. Scrolling on the
  // count rather than on the array means switching clients lands at the foot of
  // that client's thread too, which is where the last thing said is.
  useEffect(() => {
    const element = threadRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [thread.length, selectedWorkspaceId]);

  // Arriving from a history click, or from a link in an answer.
  useEffect(() => {
    if (!focusRequestId) return;
    const target = document.getElementById(`turn-${focusRequestId}`);
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusRequestId]);

  // Notices are confirmations of something that already happened, so they get
  // out of the way on their own rather than waiting to be dismissed.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  function selectWorkspace(id: string, requestId?: string) {
    const params = new URLSearchParams({ w: id });
    if (requestId) params.set('t', requestId);
    router.replace(`${pathname}?${params}`, { scroll: false });
  }

  /**
   * Every deletion goes through here.
   *
   * Not optimistic. The row is the only copy, the round trip is a few hundred
   * milliseconds, and a list that removes an item and puts it back when the
   * server disagrees is a worse experience than one that takes a moment -- the
   * reader has already moved on and the row reappears behind them. The response
   * names the ids the server actually acted on, and only those are applied.
   */
  async function mutate(action: 'trash' | 'restore' | 'delete', requestIds: string[]) {
    if (requestIds.length === 0 || working) return;

    setWorking(true);
    setHistoryError(null);

    try {
      const response = await fetch('/api/hermes/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, requestIds }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not update the history');

      const touched: string[] = body.requestIds ?? [];
      const done = new Set(touched);

      setTurns((current) =>
        action === 'delete'
          ? current.filter((turn) => !done.has(turn.requestId))
          : current.map((turn) =>
              done.has(turn.requestId)
                ? { ...turn, deletedAt: action === 'trash' ? new Date().toISOString() : null }
                : turn,
            ),
      );

      setSelected((current) => {
        const next = new Set(current);
        for (const id of touched) next.delete(id);
        return next;
      });

      setNotice(describe(action, touched.length, body.skipped ?? 0));
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : 'Could not update the history');
    } finally {
      setWorking(false);
      setPendingConfirm(null);
    }
  }

  function toggle(requestId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(requestId)) next.delete(requestId);
      else next.add(requestId);
      return next;
    });
  }

  return (
    <div className="console-height flex flex-col gap-5 lg:flex-row">
      {/* ---------------------------------------------------------------- */}
      {/* The record                                                        */}
      {/* ---------------------------------------------------------------- */}
      <aside className="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-sm)] lg:w-[19rem]">
        <div className="border-b border-border-subtle px-4 py-3.5">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-subtle">
              History
            </h2>
            <span className="tabular text-[11px] text-subtle">
              {counts.all} {counts.all === 1 ? 'question' : 'questions'}
            </span>
          </div>

          <div className="relative mt-3">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle"
            />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search questions and answers"
              aria-label="Search the history"
              className={`${inputClassSm} w-full pl-8`}
            />
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {FILTER_ORDER.map((option) => (
              <FilterChip
                key={option}
                label={FILTER_LABELS[option]}
                count={counts[option]}
                active={filter === option}
                onClick={() => setFilter(option)}
              />
            ))}
          </div>

          <div className="mt-3">
            <SegmentedControl
              label="Group the history by"
              value={grouping}
              onChange={setGrouping}
              options={[
                { value: 'date', label: 'By date' },
                { value: 'client', label: 'By client' },
              ]}
            />
          </div>
        </div>

        {/* The bulk controls, and only the ones this view can actually do. */}
        <BulkBar
          filter={filter}
          selected={selected}
          visible={visible}
          sweepable={sweepable}
          working={working}
          onClearSelection={() => setSelected(new Set())}
          onTrash={(ids) => mutate('trash', ids)}
          onRestore={(ids) => mutate('restore', ids)}
          onConfirmDelete={(intent) => setPendingConfirm(intent)}
        />

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {groups.length === 0 ? (
            <p className="px-2 py-6 text-[13px] leading-relaxed text-subtle">
              {search.trim()
                ? `Nothing matching “${search.trim()}”.`
                : filter === 'trash'
                  ? 'The trash is empty. Removed questions wait here until you delete them for good.'
                  : filter === 'duplicates'
                    ? 'No question has been asked twice about the same client.'
                    : 'Questions you ask will be listed here, and stay there.'}
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.key} className="mb-1">
                <h3 className="flex items-baseline justify-between gap-2 px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">
                  <span className="truncate">{group.label}</span>
                  <span className="tabular shrink-0 font-normal">{group.count}</span>
                </h3>

                <ul>
                  {group.turns.map((turn) => (
                    <li key={turn.requestId}>
                      <HistoryRow
                        turn={turn}
                        workspaces={workspaces}
                        showClient={grouping === 'date'}
                        active={turn.requestId === focusRequestId}
                        checked={selected.has(turn.requestId)}
                        anySelected={selected.size > 0}
                        working={working}
                        onToggle={() => toggle(turn.requestId)}
                        onOpen={() => selectWorkspace(turn.workspaceId, turn.requestId)}
                        onTrash={() => mutate('trash', [turn.requestId])}
                        onRestore={() => mutate('restore', [turn.requestId])}
                        onDelete={() =>
                          setPendingConfirm({
                            requestIds: [turn.requestId],
                            title: 'Delete this question for good?',
                          })
                        }
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>

        {(historyError || notice) && (
          <div className="border-t border-border-subtle px-4 py-2.5">
            {historyError ? (
              <ErrorText>{historyError}</ErrorText>
            ) : (
              <p className="flex items-center gap-1.5 text-[12px] text-muted">
                <Check aria-hidden className="h-3.5 w-3.5 text-success" />
                {notice}
              </p>
            )}
          </div>
        )}
      </aside>

      {/* ---------------------------------------------------------------- */}
      {/* The conversation                                                  */}
      {/* ---------------------------------------------------------------- */}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-sm)]">
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-subtle px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={waitingFor ? 'text-accent pulse-dot' : 'text-subtle'}>
              <Mark className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold tracking-tight">
                {selectedWorkspace ? selectedWorkspace.name : 'Assistant'}
              </p>
              <p className="truncate text-[11px] text-subtle">
                {selectedWorkspace
                  ? `Reads ${selectedWorkspace.clientName ?? selectedWorkspace.name} and nothing else`
                  : 'Choose a client to ask about'}
              </p>
            </div>
          </div>

          <label className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">
              Client
            </span>
            <select
              value={selectedWorkspaceId ?? ''}
              onChange={(event) => selectWorkspace(event.target.value)}
              className={`${selectClassSm} min-w-[10rem]`}
              aria-label="Which client the assistant reads"
            >
              {!selectedWorkspaceId && <option value="">Choose a client…</option>}
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspaceLabel(workspace)}
                </option>
              ))}
            </select>
          </label>
        </header>

        <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {thread.length === 0 ? (
            <EmptyConversation
              onPick={(text) => {
                setQuestion(text);
                composerRef.current?.focus();
              }}
            />
          ) : (
            <ol className="space-y-7">
              {thread.map((turn) => (
                <li key={turn.requestId} id={`turn-${turn.requestId}`} className="scroll-mt-4">
                  <div
                    className={
                      turn.requestId === focusRequestId
                        ? 'rounded-[var(--radius-lg)] bg-accent-soft/40 p-3 -m-3 transition-colors'
                        : undefined
                    }
                  >
                    <ConversationTurn
                      turn={turn}
                      references={references}
                      workspaceId={turn.workspaceId}
                    />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* The openers stay reachable after the first question. On the panel
            they appeared once and were gone; here the reader is meant to keep
            going, and a second prompt is worth as much as the first. */}
        {thread.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t border-border-subtle px-5 pt-3">
            {SUGGESTIONS.slice(0, 3).map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => {
                  setQuestion(suggestion);
                  composerRef.current?.focus();
                }}
                className="cursor-pointer rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[12px] text-muted transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        {selectedWorkspaceId ? (
          <Composer
            ref={composerRef}
            value={question}
            onChange={setQuestion}
            onSubmit={() => {
              ask(question);
              setQuestion('');
            }}
            busy={busy}
            thinking={Boolean(waitingFor)}
            error={error}
          />
        ) : (
          <div className="border-t border-border bg-surface-2/40 px-5 py-4">
            <p className="text-[13px] leading-relaxed text-muted">
              {workspaces.length === 0
                ? 'Create a workspace for a client first. The assistant answers from a client’s own data, so it has nothing to read until there is one.'
                : 'Choose a client above and the composer opens. Every answer is about that client’s data only.'}
            </p>
            <ErrorText>{error}</ErrorText>
          </div>
        )}
      </section>

      <ConfirmPermanentDelete
        intent={pendingConfirm}
        working={working}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => pendingConfirm && mutate('delete', pendingConfirm.requestIds)}
      />
    </div>
  );
}

type PermanentDelete = { requestIds: string[]; title: string };

/** What just happened, in the past tense, with the count the server reported. */
function describe(action: 'trash' | 'restore' | 'delete', count: number, skipped: number) {
  const noun = count === 1 ? 'question' : 'questions';
  const tail = skipped > 0 ? ` ${skipped} still waiting for an answer was left alone.` : '';

  if (action === 'trash') return `${count} ${noun} moved to the trash.${tail}`;
  if (action === 'restore') return `${count} ${noun} restored.${tail}`;
  return `${count} ${noun} deleted from the database.${tail}`;
}

// -----------------------------------------------------------------------------

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`cursor-pointer rounded-full border px-2.5 py-1 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] ${
        active
          ? 'border-accent/40 bg-accent-soft font-medium text-accent'
          : 'border-border text-muted hover:border-border-strong hover:text-foreground'
      }`}
    >
      {label}
      {count > 0 && <span className="tabular ml-1.5 opacity-70">{count}</span>}
    </button>
  );
}

/**
 * What can be done to the list currently on screen.
 *
 * Shown only when there is something to do. A permanently-visible row of
 * disabled bulk buttons trains people to ignore the strip, and then the one
 * time it matters -- the trash, where the only irreversible control in the
 * product lives -- it is furniture.
 */
function BulkBar({
  filter,
  selected,
  visible,
  sweepable,
  working,
  onClearSelection,
  onTrash,
  onRestore,
  onConfirmDelete,
}: {
  filter: HistoryFilter;
  selected: Set<string>;
  visible: Turn[];
  sweepable: Turn[];
  working: boolean;
  onClearSelection: () => void;
  onTrash: (ids: string[]) => void;
  onRestore: (ids: string[]) => void;
  onConfirmDelete: (intent: PermanentDelete) => void;
}) {
  const chosen = visible.filter((turn) => selected.has(turn.requestId)).map((t) => t.requestId);
  const inTrash = filter === 'trash';

  if (chosen.length > 0) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-surface-2/50 px-3 py-2.5">
        <span className="tabular mr-auto text-[12px] font-medium">
          {chosen.length} selected
        </span>

        {inTrash ? (
          <button
            type="button"
            disabled={working}
            onClick={() => onRestore(chosen)}
            className={ghostButtonClass('sm')}
          >
            <RotateCcw aria-hidden className="mr-1 h-3.5 w-3.5" />
            Restore
          </button>
        ) : (
          <button
            type="button"
            disabled={working}
            onClick={() => onTrash(chosen)}
            className={ghostButtonClass('sm')}
          >
            <Trash2 aria-hidden className="mr-1 h-3.5 w-3.5" />
            Remove
          </button>
        )}

        <button
          type="button"
          disabled={working}
          onClick={() =>
            onConfirmDelete({
              requestIds: chosen,
              title: `Delete ${chosen.length} ${chosen.length === 1 ? 'question' : 'questions'} for good?`,
            })
          }
          className={dangerButtonClass('sm')}
        >
          Delete for good
        </button>

        <button type="button" onClick={onClearSelection} className={ghostButtonClass('sm')}>
          <X aria-hidden className="h-3.5 w-3.5" />
          <span className="sr-only">Clear the selection</span>
        </button>
      </div>
    );
  }

  if (filter === 'duplicates' && sweepable.length > 0) {
    return (
      <div className="border-b border-border-subtle bg-surface-2/50 px-3 py-2.5">
        <p className="text-[12px] leading-relaxed text-muted">
          {sweepable.length} older {sweepable.length === 1 ? 'copy' : 'copies'} of a repeated
          question. The most recent of each is kept.
        </p>
        <button
          type="button"
          disabled={working}
          onClick={() => onTrash(sweepable.map((turn) => turn.requestId))}
          className={`${secondaryButtonClass('sm')} mt-2 w-full`}
        >
          {working ? (
            <Loader2 aria-hidden className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 aria-hidden className="mr-1.5 h-3.5 w-3.5" />
          )}
          Remove the older copies
        </button>
      </div>
    );
  }

  if (inTrash && visible.length > 0) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-surface-2/50 px-3 py-2.5">
        <button
          type="button"
          disabled={working}
          onClick={() => onRestore(visible.map((turn) => turn.requestId))}
          className={`${ghostButtonClass('sm')} mr-auto`}
        >
          <RotateCcw aria-hidden className="mr-1 h-3.5 w-3.5" />
          Restore all
        </button>
        <button
          type="button"
          disabled={working}
          onClick={() =>
            onConfirmDelete({
              requestIds: visible.map((turn) => turn.requestId),
              title: `Empty the trash — delete ${visible.length} ${visible.length === 1 ? 'question' : 'questions'} for good?`,
            })
          }
          className={dangerButtonClass('sm')}
        >
          Empty the trash
        </button>
      </div>
    );
  }

  return null;
}

/**
 * One turn in the record.
 *
 * The question is the title, because that is what a person remembers writing.
 * Under it is the first line of the answer, which is the thing that tells them
 * whether this is the one they are looking for without opening it.
 */
function HistoryRow({
  turn,
  workspaces,
  showClient,
  active,
  checked,
  anySelected,
  working,
  onToggle,
  onOpen,
  onTrash,
  onRestore,
  onDelete,
}: {
  turn: Turn;
  workspaces: WorkspaceOption[];
  showClient: boolean;
  active: boolean;
  checked: boolean;
  anySelected: boolean;
  working: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const client = workspaces.find((workspace) => workspace.id === turn.workspaceId);
  const preview = (turn.answer ?? turn.error ?? '').replace(/\s+/g, ' ').trim();

  return (
    <div
      className={`group relative rounded-[var(--radius)] px-2 py-2 transition-colors ${
        active ? 'bg-accent-soft' : 'hover:bg-surface-2'
      }`}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={`Select “${turn.question.slice(0, 60)}”`}
          className={`mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--accent)] transition-opacity ${
            checked || anySelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
          }`}
        />

        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
        >
          <p className="line-clamp-2 text-[13px] font-medium leading-snug">{turn.question}</p>

          {preview && (
            <p className="mt-0.5 line-clamp-1 text-[12px] leading-snug text-subtle">{preview}</p>
          )}

          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-subtle">
            {turn.status === 'pending' && (
              <span className="font-medium text-accent">Still working</span>
            )}
            {turn.status === 'failed' && <span className="font-medium text-danger">No answer</span>}
            {showClient && client && <span className="truncate">{client.name}</span>}
            <span className="tabular ml-auto shrink-0">{formatTurnTime(turn.createdAt)}</span>
          </p>
        </button>
      </div>

      {/* Row actions, revealed on hover and always reachable from the keyboard
          -- focus-within keeps them on screen while they are being tabbed
          through, which `opacity-0 group-hover` alone does not. */}
      <div className="pointer-events-none absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        {turn.deletedAt ? (
          <IconAction label="Restore" disabled={working} onClick={onRestore}>
            <RotateCcw aria-hidden className="h-3.5 w-3.5" />
          </IconAction>
        ) : (
          <IconAction label="Remove from history" disabled={working} onClick={onTrash}>
            <Trash2 aria-hidden className="h-3.5 w-3.5" />
          </IconAction>
        )}
        <IconAction label="Delete for good" disabled={working} danger onClick={onDelete}>
          <X aria-hidden className="h-3.5 w-3.5" />
        </IconAction>
      </div>
    </div>
  );
}

function IconAction({
  label,
  danger = false,
  disabled,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`cursor-pointer rounded-[var(--radius-sm)] border border-border bg-surface p-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] disabled:cursor-not-allowed disabled:opacity-50 ${
        danger ? 'text-subtle hover:border-danger/40 hover:text-danger' : 'text-subtle hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The one confirmation in this screen, for the one thing that cannot be undone.
 *
 * It says what will be gone and where from, because "are you sure" is not a
 * question anybody can answer. Removing to the trash asks nothing -- it is
 * reversible, and a product that confirms both makes the reader stop reading
 * either.
 */
function ConfirmPermanentDelete({
  intent,
  working,
  onCancel,
  onConfirm,
}: {
  intent: PermanentDelete | null;
  working: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={Boolean(intent)} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <div>
          <h2 className="font-heading text-lg font-semibold tracking-tight">
            {intent?.title ?? 'Delete for good?'}
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            This removes the row from the database. The question, the answer and anything either
            of them quoted stop existing on the server — there is no undo and no copy kept.
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            The activity log records that you deleted{' '}
            {intent?.requestIds.length === 1 ? 'a question' : 'these questions'} and when, without
            the text.
          </p>
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={secondaryButtonClass('sm')}>
            Keep them
          </button>
          <button
            type="button"
            disabled={working}
            onClick={onConfirm}
            className={dangerButtonClass('sm')}
          >
            {working && <Loader2 aria-hidden className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Delete permanently
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
