'use client';

import { useMemo, useState } from 'react';

import { DownloadButton } from '@/components/agent-panel';
import {
  Badge,
  EmptyState,
  SegmentedControl,
  StatusDot,
  Toolbar,
  ghostButtonClass,
  secondaryButtonClass,
} from '@/components/ui';
import type { DownloadableJob } from '@/lib/agent';
import {
  FAMILY_LABELS,
  OPERATION_STATUS_LABELS,
  formatRows,
  type Operation,
  type OperationFamily,
} from '@/lib/history';
import { formatBytes } from '@/lib/storage';

/**
 * Everything this workspace has had done to it, and the way back into any of
 * it.
 *
 * The problem this solves is not presentational. A categorisation wrote a
 * workbook to the `exports` bucket and handed the screen a job id; the screen
 * held that id in React state; leaving the page dropped it. The file was still
 * there and still signed on request, and there was no longer any way to name
 * it. Every row below is a job that was always in the database -- the recovery
 * is that they are now addressable.
 *
 * Rows carry only figures the job actually recorded. A `categorise_statement`
 * counts rows, categorised rows, flagged rows and the categories it used, so
 * those appear; an `apply_cleaning` counts none of them, so its row says the
 * operation, the file and the date and stops. Filling that gap with a zero
 * would make the two look like the same kind of record with a worse outcome.
 */

const FAMILY_ORDER: OperationFamily[] = [
  'categorisation',
  'cleaning',
  'analysis',
  'report',
  'export',
];

/** A status the reader can act on, in the palette the rest of the product uses. */
function toneFor(status: Operation['status']) {
  if (status === 'succeeded') return 'success' as const;
  if (status === 'failed') return 'danger' as const;
  if (status === 'running') return 'info' as const;
  if (status === 'cancelled') return 'neutral' as const;
  return 'warning' as const;
}

export function OperationHistory({
  operations,
  currentVersionNo = null,
}: {
  operations: Operation[];
  /** So a file made before the latest changes can say so, as it does elsewhere. */
  currentVersionNo?: number | null;
}) {
  const [family, setFamily] = useState<OperationFamily | 'all'>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  // Only the families this workspace has actually produced. A filter offering
  // "Reports" to a workspace that has never run one is a control that can only
  // ever empty the list.
  const families = useMemo(() => {
    const present = new Set(operations.map((operation) => operation.family));
    return FAMILY_ORDER.filter((candidate) => present.has(candidate));
  }, [operations]);

  const shown = useMemo(
    () => (family === 'all' ? operations : operations.filter((o) => o.family === family)),
    [operations, family],
  );

  if (operations.length === 0) {
    return (
      <EmptyState
        title="No operations yet"
        body="Every categorisation, cleaning run, analysis and export this workspace has done will be listed here, with the file it produced. Nothing expires, and a result stays downloadable after you leave the page."
      />
    );
  }

  return (
    <div>
      <Toolbar
        title="History"
        count={`${shown.length} of ${operations.length}`}
      >
        {families.length > 1 && (
          <SegmentedControl
            label="Filter history by operation type"
            value={family}
            onChange={setFamily}
            options={[
              { value: 'all' as const, label: 'All' },
              ...families.map((value) => ({ value, label: FAMILY_LABELS[value] })),
            ]}
          />
        )}
      </Toolbar>

      <ul className="divide-y divide-border-subtle overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-sm)]">
        {shown.map((operation) => (
          <OperationRow
            key={operation.id}
            operation={operation}
            open={openId === operation.id}
            onToggle={() => setOpenId(openId === operation.id ? null : operation.id)}
            currentVersionNo={currentVersionNo}
          />
        ))}
      </ul>
    </div>
  );
}

function OperationRow({
  operation,
  open,
  onToggle,
  currentVersionNo,
}: {
  operation: Operation;
  open: boolean;
  onToggle: () => void;
  currentVersionNo: number | null;
}) {
  const rows = formatRows(operation.rows);
  const detailId = `operation-${operation.id}`;

  // The job's own row, not a reconstruction of one. `DownloadButton` names the
  // file from the stored path, so a synthesised result would put an invented
  // filename under a real download. The route re-reads the job under the
  // caller's RLS and re-derives the path, so this carries a reference and never
  // an authorisation.
  const job: DownloadableJob = {
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    result: operation.result,
  };

  return (
    <li className="row-hover">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="text-sm font-medium">{operation.label}</span>
            <Badge tone={toneFor(operation.status)}>
              <StatusDot tone={toneFor(operation.status)} live={operation.status === 'running'} />
              {OPERATION_STATUS_LABELS[operation.status]}
            </Badge>
          </div>

          {operation.source && (
            <p className="mt-1 truncate font-mono text-[12px] text-muted" title={operation.source}>
              {operation.source}
            </p>
          )}

          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-subtle">
            <span className="tabular">{operation.createdLabel}</span>
            {rows && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular">{rows}</span>
              </>
            )}
            {operation.versionNo !== null && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular">v{operation.versionNo}</span>
              </>
            )}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={detailId}
            className={secondaryButtonClass('sm')}
          >
            {open ? 'Hide result' : 'View result'}
          </button>
          {operation.downloadable && (
            <DownloadButton job={job} currentVersionNo={currentVersionNo} />
          )}
        </div>
      </div>

      {open && (
        <div id={detailId} className="border-t border-border-subtle bg-surface-2/40 px-4 py-4">
          <OperationDetail operation={operation} />
        </div>
      )}
    </li>
  );
}

/**
 * The result, for somebody who has come back to it cold.
 *
 * Every entry here is conditional on the job having recorded the figure. That
 * is why this is a list of rendered facts rather than a fixed grid: a fixed
 * grid has to put something in every cell, and the something is always a dash
 * or a zero that reads as a measurement.
 */
function OperationDetail({ operation }: { operation: Operation }) {
  const facts: { label: string; value: string }[] = [];

  if (operation.source) facts.push({ label: 'Source file', value: operation.source });
  if (operation.rows !== null) {
    facts.push({ label: 'Rows', value: operation.rows.toLocaleString('en-GB') });
  }
  if (operation.categorised !== null) {
    facts.push({ label: 'Categorised', value: operation.categorised.toLocaleString('en-GB') });
  }
  if (operation.flagged !== null) {
    facts.push({ label: 'Flagged for review', value: operation.flagged.toLocaleString('en-GB') });
  }
  if (operation.versionNo !== null) {
    facts.push({ label: 'Version', value: `v${operation.versionNo}` });
  }
  if (operation.byteSize !== null) {
    facts.push({ label: 'File size', value: formatBytes(operation.byteSize) });
  }
  if (operation.finishedLabel) {
    facts.push({ label: 'Finished', value: operation.finishedLabel });
  }
  // Present only when a model actually answered. Its absence means the rule
  // engine did the work, which is a real difference in how the result was
  // reached and not a missing field.
  if (operation.modelUsed) facts.push({ label: 'Model', value: operation.modelUsed });

  return (
    <div className="space-y-4">
      {operation.status === 'failed' && operation.error && (
        <p className="rounded-[var(--radius)] border border-danger/30 bg-danger-soft/50 px-3.5 py-2.5 text-[13px] leading-relaxed text-danger">
          {operation.error}
        </p>
      )}

      {facts.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-5 gap-y-3.5 sm:grid-cols-3 lg:grid-cols-4">
          {facts.map((fact) => (
            <div key={fact.label} className="min-w-0">
              <dt className="text-[10px] font-medium uppercase tracking-[0.08em] text-subtle">
                {fact.label}
              </dt>
              <dd className="mt-1 truncate text-[13px]" title={fact.value}>
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {operation.categories && <CategoryList categories={operation.categories} />}

      {facts.length === 0 && !operation.categories && (
        <p className="text-[13px] leading-relaxed text-subtle">
          This operation recorded no figures beyond its outcome and the time it ran.
        </p>
      )}
    </div>
  );
}

/**
 * The categories the run actually used.
 *
 * Capped, with the remainder counted rather than hidden. A statement can touch
 * thirty HMRC categories and a wall of thirty pills is not a summary of
 * anything.
 */
function CategoryList({ categories }: { categories: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 8;
  const shown = expanded ? categories : categories.slice(0, LIMIT);
  const hidden = categories.length - shown.length;

  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-subtle">
        Categories used ({categories.length})
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {shown.map((category) => (
          <span
            key={category}
            className="rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-0.5 text-[12px] text-muted"
          >
            {category}
          </span>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className={ghostButtonClass('sm')}
          >
            {`Show ${hidden} more`}
          </button>
        )}
      </div>
    </div>
  );
}
