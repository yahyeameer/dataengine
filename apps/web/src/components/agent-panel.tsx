'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  type AgentJobKind,
  type AgentJobStatus,
  JOB_KIND_LABELS,
  formatAge,
  isTerminal,
  isWorkerOnline,
} from '@/lib/agent';
import type { Json } from '@/lib/database.types';
import { StatusBadge, buttonClass, secondaryButtonClass } from '@/components/ui';

type Job = {
  id: string;
  kind: AgentJobKind;
  status: AgentJobStatus;
  progress: Json;
  // Carries the artefact a finished job produced, if it produced one. The
  // download link reads only the filename from here -- the signed URL is
  // minted server-side from the job row, never from anything the client holds.
  result: Json;
  error: string | null;
  attempts: number;
  created_at: string;
  finished_at: string | null;
};

type Worker = {
  id: string;
  hostname: string | null;
  version: string | null;
  last_seen_at: string;
  jobs_claimed: number;
  metadata: Json;
};

/**
 * The agent's presence in the dashboard.
 *
 * Two jobs, and the first matters more than it looks. The agent runs on a
 * machine the accountant will never log into, so the *only* way they can tell
 * it is alive is this strip. When it goes quiet the panel says so in plain
 * words and says what the consequence is — work queues rather than runs —
 * because "offline" on its own invites a support call.
 *
 * Polling rather than realtime: one small request every few seconds, only
 * while something is actually running, is less machinery than a websocket
 * subscription and degrades to "the page is a bit stale" instead of to a
 * silent disconnection nobody notices.
 */

const IDLE_POLL_MS = 15_000;
const ACTIVE_POLL_MS = 2_000;

export function AgentPanel({
  workspaceId,
  initialJobs,
  initialWorkers,
}: {
  workspaceId: string;
  initialJobs: Job[];
  initialWorkers: Worker[];
}) {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [workers, setWorkers] = useState<Worker[]>(initialWorkers);
  // Refreshing server components on every poll would refetch the whole page.
  // Only do it when a job actually reaches a terminal state, because that is
  // the only moment the server-rendered parts (versions, review queue) change.
  const previousActive = useRef(0);

  const active = jobs.filter((job) => !isTerminal(job.status)).length;

  const poll = useCallback(async () => {
    try {
      const response = await fetch(`/api/agent/jobs?workspaceId=${workspaceId}`, {
        cache: 'no-store',
      });
      if (!response.ok) return;

      const body = (await response.json()) as { jobs: Job[]; workers: Worker[] };
      setJobs(body.jobs);
      setWorkers(body.workers);

      const nowActive = body.jobs.filter((job) => !isTerminal(job.status)).length;
      if (previousActive.current > 0 && nowActive === 0) {
        router.refresh();
      }
      previousActive.current = nowActive;
    } catch {
      // A failed poll is not worth showing. The next one is two seconds away,
      // and an error banner that appears whenever a laptop lid closes is noise.
    }
  }, [router, workspaceId]);

  useEffect(() => {
    const interval = setInterval(poll, active > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(interval);
  }, [active, poll]);

  const online = workers.filter((worker) => isWorkerOnline(worker.last_seen_at));
  const isOnline = online.length > 0;
  const recent = jobs.slice(0, 5);

  return (
    <section className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-3">
        <span
          aria-hidden
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${
            isOnline ? 'bg-success' : 'bg-danger'
          } ${isOnline && active > 0 ? 'pulse-dot' : ''}`}
        />
        <span className="text-sm font-medium">
          {isOnline ? 'Engine connected' : 'Engine offline'}
        </span>

        {isOnline ? (
          <span className="font-mono text-xs text-subtle">
            {online[0].hostname ?? online[0].id}
            {online[0].version ? ` · v${online[0].version}` : ''}
            {describeModels(online[0].metadata)}
          </span>
        ) : (
          <span className="text-xs text-muted">
            Nothing will run until it reconnects. Anything you ask for is queued and
            picked up automatically.
          </span>
        )}

        {active > 0 ? (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-info">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-info pulse-dot" />
            <span className="tabular font-medium">{active}</span> running
          </span>
        ) : null}
      </div>

      {recent.length === 0 ? (
        <p className="px-4 py-3.5 text-sm text-muted">
          Nothing has run yet. Upload a file and choose Analyse to start.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {recent.map((job) => (
            <li key={job.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
              <span className="text-sm font-medium">{JOB_KIND_LABELS[job.kind] ?? job.kind}</span>

              <JobStatus job={job} />

              <DownloadButton job={job} />

              <RelativeTime timestamp={job.finished_at ?? job.created_at} />

              {job.error ? (
                <p className="w-full text-xs text-danger">{job.error}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A relative timestamp, rendered only after mount.
 *
 * "21s ago" cannot be server-rendered. The server computes it, the client
 * computes it a moment later and gets "20s ago", and React treats the
 * difference as a corrupted tree -- it throws away the server HTML and
 * remounts the whole subtree. The fix is not to suppress the warning but to
 * not render a moving value until there is a client to own it.
 */
const TICK_MS = 30_000;

function subscribeToClock(onChange: () => void) {
  const id = setInterval(onChange, TICK_MS);
  return () => clearInterval(id);
}

/**
 * The current time, bucketed, or null on the server.
 *
 * `useSyncExternalStore` rather than a mounted flag in an effect: the server
 * snapshot is explicitly null, which is exactly the "there is no clock here"
 * semantics this needs, and it re-renders on its own so an age of "2m ago"
 * does not sit there reading "20s ago" until the next poll.
 *
 * The snapshot is bucketed to the tick interval because it has to be stable
 * between changes -- returning Date.now() would report a new value on every
 * read and re-render forever.
 */
function useClientClock(): number | null {
  return useSyncExternalStore(
    subscribeToClock,
    () => Math.floor(Date.now() / TICK_MS),
    () => null,
  );
}

function RelativeTime({ timestamp }: { timestamp: string | null }) {
  const clock = useClientClock();

  if (!timestamp) return null;

  return (
    <span
      className="ml-auto text-xs text-subtle tabular"
      title={clock === null ? undefined : new Date(timestamp).toLocaleString('en-GB')}
    >
      {clock === null ? '' : formatAge(timestamp)}
    </span>
  );
}

/**
 * Whether the agent can write explanations, or is running on rules alone.
 *
 * Worth surfacing: with no API key configured the proposals are identical and
 * only the prose is plainer, so an accountant seeing terse wording should be
 * able to tell that from a fault.
 */
function describeModels(metadata: Json): string {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  return metadata.llm_enabled ? ' · explanations on' : ' · rules only';
}

function JobStatus({ job }: { job: Job }) {
  if (job.status === 'running') {
    // The worker reports which phase it is in on every lease renewal, so this
    // is the real stage rather than a spinner that means "something".
    const progress = (job.progress ?? {}) as Record<string, unknown>;
    const stage = typeof progress.stage === 'string' ? progress.stage : 'working';
    return (
      <span className="rounded bg-blue-500/15 px-2 py-0.5 text-xs text-blue-700 dark:text-blue-300">
        {stage}…
      </span>
    );
  }

  if (job.status === 'queued') {
    return (
      <span className="rounded bg-surface-2 px-2 py-0.5 font-mono text-xs text-muted">
        {job.attempts > 0 ? `retrying (attempt ${job.attempts + 1})` : 'queued'}
      </span>
    );
  }

  // One status vocabulary across the product: the same word means the same
  // colour whether it appears on a job, an upload or a proposal.
  return <StatusBadge status={job.status} />;
}

/**
 * The minimum a download control needs. Declared separately from Job so the
 * page can hand over its own server-fetched rows without the two queries having
 * to agree on every column.
 */
export type DownloadableJob = {
  id: string;
  kind: AgentJobKind;
  status: AgentJobStatus;
  result: Json;
};

/** The kinds that leave a file behind in the exports bucket. */
const DOWNLOADABLE_KINDS = new Set<AgentJobKind>(['generate_report', 'export_dataset']);

/**
 * The filename a finished job produced, or null if it produced nothing.
 *
 * Only the name is taken from the result. The path is read again server-side
 * off the same row when the URL is signed, so nothing the browser holds decides
 * which object gets handed out.
 */
function artefactName(job: DownloadableJob): string | null {
  if (job.status !== 'succeeded' || !DOWNLOADABLE_KINDS.has(job.kind)) return null;

  const result = (job.result ?? {}) as Record<string, unknown>;
  const path =
    typeof result.export_path === 'string'
      ? result.export_path
      : typeof result.report_path === 'string'
        ? result.report_path
        : null;

  return path?.split('/').pop() ?? null;
}

export /**
 * "Download Excel" beats "Download" the moment there are two of them.
 *
 * A workspace that has exported both formats renders two identical buttons
 * otherwise, and the only way to tell them apart is to hover for the tooltip.
 */
function formatLabel(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'xlsx') return 'Excel';
  if (extension === 'csv') return 'CSV';
  if (extension === 'md') return 'report';
  return extension.toUpperCase();
}

export function DownloadButton({ job }: { job: DownloadableJob }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = artefactName(job);
  if (!name) return null;

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/exports?jobId=${job.id}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not prepare the download');

      // The signed URL carries its own Content-Disposition, so navigating to it
      // saves the file rather than replacing the page. The link is good for a
      // minute, which is why it is minted on click rather than on render.
      window.location.href = body.url as string;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not prepare the download');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={download}
        disabled={busy}
        title={name}
        className={`${secondaryButtonClass} px-2.5 py-1 text-xs`}
      >
        {busy ? 'Preparing…' : `Download ${formatLabel(name)}`}
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </>
  );
}

/**
 * Ask the agent to write the cleaned version out as a file.
 *
 * Two formats rather than one, because they fail differently. csv opens
 * anywhere and loses every type on the way in -- an account code of 0041
 * arrives as 41. xlsx keeps the types the parser worked out, which is what
 * anyone reconciling against their own spreadsheet actually needs.
 */
export function ExportButton({
  workspaceId,
  datasetVersionId,
}: {
  workspaceId: string;
  datasetVersionId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function requestExport(format: 'xlsx' | 'csv') {
    setBusy(format);
    setError(null);
    try {
      const response = await fetch('/api/agent/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          kind: 'export_dataset',
          datasetVersionId,
          payload: { format },
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not start the export');
      // The panel above picks the job up on its next poll and shows the
      // download link when it finishes.
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the export');
    } finally {
      setBusy(null);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted">Export cleaned data</span>
      {(['xlsx', 'csv'] as const).map((format) => (
        <button
          key={format}
          type="button"
          onClick={() => requestExport(format)}
          disabled={busy !== null}
          className={`${secondaryButtonClass} px-2.5 py-1 text-xs`}
        >
          {busy === format ? 'Starting…' : format === 'xlsx' ? 'Excel' : 'CSV'}
        </button>
      ))}
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

/**
 * Ask the agent to sort a column's values into categories.
 *
 * The one place in the product where the model decides rather than describes,
 * so it is also the one place where the safety story has to be visible: the job
 * writes a *proposal*. It lands in the review queue below with everything else,
 * gets approved by the same click, and is written into a new version by the
 * same apply. Nothing appears in anyone's data because a model thought it
 * should.
 *
 * The categories box is optional and worth more than it looks. Left empty the
 * model invents a vocabulary, which is fine for a first look and wrong for a
 * practice that already has a chart of accounts. Filled in, it is a closed list
 * -- the worker drops any category outside it rather than quietly adding a
 * fourteenth.
 */
export function CategorizeButton({
  workspaceId,
  datasetVersionId,
  columns,
}: {
  workspaceId: string;
  datasetVersionId: string;
  columns: string[];
}) {
  const router = useRouter();
  const [column, setColumn] = useState(columns[0] ?? '');
  const [categories, setCategories] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (columns.length === 0) return null;

  async function categorize() {
    setBusy(true);
    setError(null);
    try {
      const wanted = categories
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

      const response = await fetch('/api/agent/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          kind: 'categorize_dataset',
          datasetVersionId,
          payload: { column, ...(wanted.length > 0 ? { categories: wanted } : {}) },
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not start categorising');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start categorising');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3.5">
      <p className="text-sm font-medium">Categorise a column</p>
      <p className="mt-1 text-xs text-subtle">
        The agent reads the column&rsquo;s distinct values — never the rows — and proposes a
        category for each. It arrives in the review queue as a change you approve.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={column}
          onChange={(event) => setColumn(event.target.value)}
          disabled={busy}
          className="rounded-[var(--radius)] border border-border bg-surface px-2 py-1 text-xs"
        >
          {columns.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <input
          type="text"
          value={categories}
          onChange={(event) => setCategories(event.target.value)}
          disabled={busy}
          placeholder="Categories (optional, comma separated)"
          className="min-w-56 flex-1 rounded-[var(--radius)] border border-border bg-surface px-2 py-1 text-xs"
        />

        <button
          type="button"
          onClick={categorize}
          disabled={busy || !column}
          className={`${buttonClass} px-3 py-1.5 text-xs`}
        >
          {busy ? 'Starting…' : 'Categorise'}
        </button>
      </div>

      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

/**
 * The button that starts everything: turn a stored upload into a parsed,
 * profiled, reviewed dataset.
 *
 * One click enqueues one job. The worker chains the rest, so the accountant
 * does not have to know that "analyse" is three steps.
 */
export function AnalyseButton({
  workspaceId,
  uploadId,
  datasetId,
  className = '',
}: {
  workspaceId: string;
  uploadId: string;
  datasetId: string | null;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyse() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/agent/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          kind: 'parse_workbook',
          rawUploadId: uploadId,
          datasetId,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not start the agent');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the agent');
    } finally {
      setBusy(false);
    }
  }

  if (!datasetId) {
    return (
      <span className="text-xs text-subtle" title="Attach this upload to a dataset first">
        no dataset
      </span>
    );
  }

  return (
    <span className={className}>
      <button
        type="button"
        onClick={analyse}
        disabled={busy}
        className={`${secondaryButtonClass} px-2.5 py-1 text-xs`}
      >
        {busy ? 'Starting…' : 'Analyse'}
      </button>
      {error ? <span className="ml-2 text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
