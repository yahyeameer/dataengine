'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import {
  Badge,
  EmptyState,
  SegmentedControl,
  StatusDot,
  Toolbar,
  inputClassSm,
  secondaryButtonClass,
} from '@/components/ui';
import { formatMoney } from '@/lib/agent';
import { FAMILY_LABELS, type OperationFamily } from '@/lib/history';

/**
 * The firm's clients, as a worklist.
 *
 * It was a grid of cards, one per workspace, each repeating the same four
 * labels. A grid is the right shape for things you browse and the wrong one
 * for things you triage: cards force a fixed height on rows whose content is
 * not fixed, they put the figures at a different x-position in every column,
 * and at forty clients they turn "who is waiting on me" into a reading
 * exercise across three columns of near-identical boxes.
 *
 * A list puts every workspace's numbers in the same place, so the eye runs
 * down one column instead of around a grid, and it lets a row that needs a
 * decision be visibly taller and louder than one that does not. The sort is by
 * waiting work, as it was; what changed is that the ordering is now legible.
 *
 * Each row also says what the workspace has actually been used for -- how many
 * categorisations, analyses and reports it holds -- because "open the client
 * and find out" is the question this screen exists to answer in advance.
 */

export type WorkspaceRow = {
  id: string;
  name: string;
  clientName: string | null;
  createdAt: string;
  datasets: number;
  /** Jobs queued or running right now. */
  processing: number;
  /** Proposals pending a human decision. */
  waiting: number;
  /** The money those proposals touch, summed. */
  atStake: number;
  /**
   * "2 days ago", computed on the server.
   *
   * This is a client component, so a `Date.now()` here would be evaluated once
   * during SSR and again at hydration -- usually agreeing, and disagreeing
   * exactly when the render straddles midnight. The page has a clock; this
   * needs a string.
   */
  lastActivityLabel: string | null;
  lastOperationLabel: string | null;
  /** How many finished operations of each family this workspace holds. */
  families: Partial<Record<OperationFamily, number>>;
};

const FAMILY_ORDER: OperationFamily[] = [
  'categorisation',
  'cleaning',
  'analysis',
  'report',
  'export',
];

type Filter = 'all' | 'waiting' | 'running';

export function WorkspaceIndex({ workspaces }: { workspaces: WorkspaceRow[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const totals = useMemo(
    () => ({
      waiting: workspaces.filter((w) => w.waiting > 0).length,
      running: workspaces.filter((w) => w.processing > 0).length,
    }),
    [workspaces],
  );

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return workspaces.filter((workspace) => {
      if (filter === 'waiting' && workspace.waiting === 0) return false;
      if (filter === 'running' && workspace.processing === 0) return false;
      if (!needle) return true;
      return (
        workspace.name.toLowerCase().includes(needle) ||
        (workspace.clientName ?? '').toLowerCase().includes(needle)
      );
    });
  }, [workspaces, filter, query]);

  // The search box earns its place only once the list is long enough to need
  // it. Below that it is a control that can only ever hide rows the reader can
  // already see.
  const searchable = workspaces.length >= 8;

  return (
    <div>
      <Toolbar title="All clients" count={`${shown.length} of ${workspaces.length}`}>
        {searchable && (
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search clients…"
            aria-label="Search clients by name"
            className={`${inputClassSm} w-48`}
          />
        )}
        {(totals.waiting > 0 || totals.running > 0) && (
          <SegmentedControl
            label="Filter workspaces"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all' as const, label: 'All' },
              ...(totals.waiting > 0
                ? [{ value: 'waiting' as const, label: `Needs you (${totals.waiting})` }]
                : []),
              ...(totals.running > 0
                ? [{ value: 'running' as const, label: `Running (${totals.running})` }]
                : []),
            ]}
          />
        )}
      </Toolbar>

      {shown.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          body="No client workspace matches the filter you have applied. Clear it to see the rest of the firm."
        />
      ) : (
        <ul className="divide-y divide-border-subtle overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-sm)]">
          {shown.map((workspace) => (
            <WorkspaceRowItem key={workspace.id} workspace={workspace} />
          ))}
        </ul>
      )}
    </div>
  );
}

function WorkspaceRowItem({ workspace }: { workspace: WorkspaceRow }) {
  const waiting = workspace.waiting > 0;
  const last = workspace.lastActivityLabel;
  const families = FAMILY_ORDER.filter((family) => (workspace.families[family] ?? 0) > 0);

  return (
    <li className="row-hover">
      <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-5">
        {/* Identity. Given the width it needs, because the client's name is
            what the reader is looking for and everything else is qualifying it. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {workspace.processing > 0 && <StatusDot tone="info" live />}
            <Link
              href={`/app/workspaces/${workspace.id}`}
              className="truncate rounded-[var(--radius-sm)] text-[15px] font-medium tracking-tight outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
            >
              {workspace.name}
            </Link>
          </div>

          {workspace.clientName && (
            <p className="mt-0.5 truncate text-[13px] text-muted">{workspace.clientName}</p>
          )}

          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
            <span className="tabular">
              {workspace.datasets} dataset{workspace.datasets === 1 ? '' : 's'}
            </span>
            {last && (
              <>
                <span aria-hidden>·</span>
                <span>
                  {workspace.lastOperationLabel
                    ? `${workspace.lastOperationLabel} ${last}`
                    : `Active ${last}`}
                </span>
              </>
            )}
          </p>

          {/* What this client's workspace actually holds, so the reader knows
              what they will find before they open it. Only families with a
              real count appear. */}
          {families.length > 0 && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5">
              {families.map((family) => (
                <span
                  key={family}
                  className="rounded-[var(--radius-sm)] border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted"
                >
                  <span className="tabular font-medium text-foreground">
                    {workspace.families[family]}
                  </span>{' '}
                  {FAMILY_LABELS[family]}
                </span>
              ))}
            </p>
          )}
        </div>

        {/* The decision, if there is one. The only thing on the row allowed to
            carry the accent, because it is the only thing asking for an action. */}
        <div className="shrink-0 sm:w-44">
          {waiting ? (
            <div className="rounded-[var(--radius)] border border-accent/25 bg-accent-soft/50 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-accent">
                Waiting on you
              </p>
              <p className="mt-0.5 flex items-baseline gap-1.5 text-[13px]">
                <span className="tabular font-semibold">{workspace.waiting}</span>
                <span className="text-muted">
                  proposal{workspace.waiting === 1 ? '' : 's'}
                </span>
              </p>
              {workspace.atStake > 0 && (
                <p className="tabular mt-0.5 text-[12px] text-muted">
                  {formatMoney(workspace.atStake)}
                </p>
              )}
            </div>
          ) : workspace.processing > 0 ? (
            <Badge tone="info">
              <StatusDot tone="info" live />
              {workspace.processing} running
            </Badge>
          ) : (
            <p className="text-[13px] text-subtle">Nothing waiting</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Link href={`/app/workspaces/${workspace.id}`} className={secondaryButtonClass('sm')}>
            Open
          </Link>
        </div>
      </div>
    </li>
  );
}
