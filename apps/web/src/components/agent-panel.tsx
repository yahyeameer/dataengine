'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  type AgentJobKind,
  type AgentJobStatus,
  type DownloadableJob,
  ENGINE_STATE_DETAIL,
  ENGINE_STATE_LABELS,
  type EngineState,
  JOB_KIND_LABELS,
  engineStateFor,
  exportVersionNo,
  formatAge,
  isTerminal,
  isWorkerOnline,
} from '@/lib/agent';
import type { Json } from '@/lib/database.types';
import { isDownloadable } from '@/lib/history';
import { useArtefactDownload } from '@/components/artefact-download';

export type { DownloadableJob };
import {
  Badge,
  StatusBadge,
  buttonClass,
  inputClassSm,
  secondaryButtonClass,
  selectClassSm,
} from '@/components/ui';

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
  // Four states, from the worker's own report. See engineStateFor: "connected
  // or offline" reported a worker running with no model behind it as healthy,
  // which is the one case where the indicator most needed to say something.
  const state = engineStateFor(workers);
  const recent = jobs.slice(0, 5);

  return (
    <section className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-xl backdrop-blur-xl">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border-subtle bg-background/50 px-5 py-3.5">
        <EngineDot state={state} busy={active > 0} />
        <span className="text-sm font-bold text-foreground">{ENGINE_STATE_LABELS[state]}</span>

        {state === 'connected' && isOnline ? (
          <span className="font-mono text-xs text-muted">
            {online[0].hostname ?? online[0].id}
            {online[0].version ? ` · v${online[0].version}` : ''}
            {describeModels(online[0].metadata)}
          </span>
        ) : (
          <span className="text-xs text-muted">{ENGINE_STATE_DETAIL[state]}</span>
        )}

        {active > 0 ? (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-accent bg-accent-soft px-2.5 py-1 rounded-full border border-accent/30">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
            <span className="font-mono font-bold">{active}</span> jobs active
          </span>
        ) : null}
      </div>

      {recent.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted">
          Nothing has run yet. Upload a file and choose Analyse to start.
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {recent.map((job) => (
            <li key={job.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-3.5 hover:bg-surface-2 transition-colors">
              <span className="text-sm font-semibold text-foreground">{JOB_KIND_LABELS[job.kind] ?? job.kind}</span>

              <JobStatus job={job} />

              <RelativeTime timestamp={job.finished_at ?? job.created_at} />

              {job.error ? (
                <p className="w-full text-xs leading-relaxed text-danger mt-1">{job.error}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );

}

/**
 * The state, as one dot.
 *
 * Colour carries the state and is never the only carrier -- the label beside it
 * says the same thing in words, because a green dot and an amber dot are the
 * same dot to a reader who cannot distinguish them.
 */
function EngineDot({ state, busy }: { state: EngineState; busy: boolean }) {
  const tone: Record<EngineState, string> = {
    connected: 'bg-success',
    degraded: 'bg-warning',
    offline: 'bg-danger',
    unknown: 'bg-subtle',
  };
  return (
    <span
      aria-hidden
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${tone[state]} ${
        state === 'connected' && busy ? 'pulse-dot' : ''
      }`}
    />
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
  const progress = (job.progress ?? {}) as Record<string, unknown>;
  const stage = typeof progress.stage === 'string' ? progress.stage : null;

  if (job.status === 'running') {
    // The worker reports which phase it is in on every lease renewal, so this
    // is the real stage rather than a spinner that means "something".
    return (
      <Badge tone="info">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current pulse-dot" />
        {stage ?? 'working'}…
      </Badge>
    );
  }

  if (job.status === 'queued') {
    // A job whose work is happening somewhere else — a report running on the
    // internal board — is handed back to the queue between checks so it does
    // not hold the worker. It is `queued` in the table and *working* in every
    // sense the accountant cares about, and it carries the stage that says so.
    //
    // Without this it read "queued" for ten minutes while four agents worked on
    // it, which is the indicator telling the opposite of the truth. A blocked
    // stage is called out separately: that one is waiting for a person, and
    // showing it as busy is how nobody notices.
    if (stage) {
      return stage === 'blocked' ? (
        <Badge tone="warning">needs attention</Badge>
      ) : (
        <Badge tone="info">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current pulse-dot" />
          {stage}…
        </Badge>
      );
    }

    return (
      <Badge tone={job.attempts > 0 ? 'warning' : 'neutral'}>
        {job.attempts > 0 ? `retrying · attempt ${job.attempts + 1}` : 'queued'}
      </Badge>
    );
  }

  // One status vocabulary across the product: the same word means the same
  // colour whether it appears on a job, an upload or a proposal.
  return <StatusBadge status={job.status} />;
}

/**
 * The filename a finished job produced, or null if it produced nothing.
 *
 * Only the name is taken from the result. The path is read again server-side
 * off the same row when the URL is signed, so nothing the browser holds decides
 * which object gets handed out.
 *
 * Whether there is a file at all is `isDownloadable`'s question, not this
 * function's. It used to keep its own two-kind list here -- `generate_report`
 * and `export_dataset` -- which is the same list `/api/exports` carried before
 * d46e35e taught the route that `categorise_statement` produces a workbook.
 * The route was fixed and this was not, so the button for the product's main
 * operation rendered as nothing at all: the file existed, the route would have
 * signed it, and no control was ever drawn to ask.
 */
function artefactName(job: DownloadableJob): string | null {
  if (!isDownloadable(job)) return null;

  const result = (job.result ?? {}) as Record<string, unknown>;
  const path =
    typeof result.export_path === 'string'
      ? result.export_path
      : typeof result.report_path === 'string'
        ? result.report_path
        : null;

  return path?.split('/').pop() ?? null;
}

/**
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

export function DownloadButton({
  job,
  currentVersionNo = null,
}: {
  job: DownloadableJob;
  /** The version the workspace is on now, so an older file can say so. */
  currentVersionNo?: number | null;
}) {
  const { busy, error, download } = useArtefactDownload(job.id);

  const name = artefactName(job);
  if (!name) return null;

  const versionNo = exportVersionNo(job);
  const superseded =
    versionNo !== null && currentVersionNo !== null && versionNo < currentVersionNo;

  return (
    <>
      <button
        type="button"
        onClick={download}
        disabled={busy}
        title={
          superseded
            ? `${name} — made from version ${versionNo}, before the changes in version ${currentVersionNo} were applied`
            : name
        }
        className={`${secondaryButtonClass('sm')} ${superseded ? 'opacity-60' : ''}`}
      >
        {busy
          ? 'Preparing…'
          : // The version is part of the label, not a tooltip. Two buttons
            // reading "Download Excel" are indistinguishable at the moment
            // somebody clicks one, which is the only moment that matters.
            `Download ${formatLabel(name)}${versionNo !== null ? ` · v${versionNo}` : ''}`}
      </button>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
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
  versionNo = null,
}: {
  workspaceId: string;
  datasetVersionId: string;
  /** Named on the control, because an export is of one version and no other. */
  versionNo?: number | null;
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
      <span className="text-[13px] font-medium text-muted">
        Export {versionNo !== null ? `v${versionNo}` : 'this version'} as
      </span>
      {(['xlsx', 'csv'] as const).map((format) => (
        <button
          key={format}
          type="button"
          onClick={() => requestExport(format)}
          disabled={busy !== null}
          className={secondaryButtonClass('sm')}
        >
          {busy === format ? 'Starting…' : format === 'xlsx' ? 'Excel' : 'CSV'}
        </button>
      ))}
      {error ? <span className="text-xs text-danger">{error}</span> : null}
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
 * Two vocabularies, and the choice between them is the useful part of this
 * control.
 *
 * **UK tax categories** are HMRC's SA103F boxes. The agent matches most of a
 * British bank statement from a rule table it ships with, and only asks the
 * model about what is left — so this option works on an agent host with no
 * model configured at all, and produces a column that maps onto a return rather
 * than onto somebody's ad-hoc grouping. It is the default because the product
 * is for UK accountants and a self-invented vocabulary is work they then have
 * to redo by hand.
 *
 * **Let the agent decide** is the old behaviour, kept for columns that are not
 * money: the model proposes the vocabulary as well as the assignments, and the
 * categories box narrows it to a closed list when a practice already has a chart
 * of accounts.
 */
const TAXONOMIES = [
  { value: 'uk_hmrc', label: 'UK tax categories (HMRC)' },
  { value: '', label: 'Let the agent decide' },
] as const;

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
  const [column, setColumn] = useState(() => bestColumnFor(columns));
  const [taxonomy, setTaxonomy] = useState<string>('uk_hmrc');
  const [categories, setCategories] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (columns.length === 0) return null;

  const hmrc = taxonomy === 'uk_hmrc';

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
          payload: {
            column,
            ...(taxonomy ? { taxonomy } : {}),
            // On the HMRC path the vocabulary is fixed and the worker ignores
            // this, so the box is repurposed as a hint rather than sent as a
            // list the server would only refuse.
            ...(hmrc
              ? categories.trim()
                ? { hint: categories.trim() }
                : {}
              : wanted.length > 0
                ? { categories: wanted }
                : {}),
          },
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
    <div>
      <p className="text-sm font-medium">Categorise a column</p>
      <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-subtle">
        The agent reads the column&rsquo;s distinct values — never the rows — and proposes a
        category for each. It arrives in the review queue as a change you approve.
      </p>

      {/* `grid` rather than `flex-wrap`. A native select sizes itself to its
          widest option and refuses to shrink, so with real column names in it
          this row stretched the whole page to 1,649px on a 1,440px screen.

          Two rows until there is genuinely room for four columns. Since the
          workspace page moved its machinery into a rail this block sits in a
          narrower column, and four across left the free-text field about
          150px wide — a box for a sentence, sized for a word. */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(0,12rem)_minmax(0,12rem)_minmax(0,1fr)_auto]">
        <select
          value={column}
          onChange={(event) => setColumn(event.target.value)}
          disabled={busy}
          aria-label="Column to categorise"
          className={selectClassSm}
        >
          {columns.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <select
          value={taxonomy}
          onChange={(event) => setTaxonomy(event.target.value)}
          disabled={busy}
          aria-label="Categories to use"
          className={selectClassSm}
        >
          {TAXONOMIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <input
          type="text"
          value={categories}
          onChange={(event) => setCategories(event.target.value)}
          disabled={busy}
          placeholder={
            hmrc
              ? 'What the business does (optional) — e.g. plumbing contractor'
              : 'Categories (optional, comma separated)'
          }
          aria-label={hmrc ? 'What the business does' : 'Categories'}
          className={inputClassSm}
        />

        <button
          type="button"
          onClick={categorize}
          disabled={busy || !column}
          className={buttonClass('sm')}
        >
          {busy ? 'Starting…' : 'Categorise'}
        </button>
      </div>

      <p className="mt-2.5 max-w-prose text-xs leading-relaxed text-subtle">
        {hmrc ? (
          <>
            Values are sorted into HMRC&rsquo;s self-employment boxes (SA103F) — travel, premises,
            office costs and the rest. Personal spending and transfers between the
            client&rsquo;s own accounts are labelled as such rather than deducted. Most of a UK
            bank statement is matched from rules, so this runs whether or not a model is
            connected.
          </>
        ) : (
          <>
            The agent proposes the vocabulary as well as the assignments. Naming the
            categories you want makes it a closed list — anything outside it is dropped rather
            than added. Needs a model.
          </>
        )}
      </p>

      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
    </div>
  );
}

/**
 * Which column the dropdown should open on.
 *
 * It used to open on the first column in the profile, which for a bank
 * statement is the date — so the obvious next click was to categorise a column
 * of dates. The description is what anybody categorising a statement means, and
 * it is worth two lines of guessing to land on it.
 */
function bestColumnFor(columns: string[]): string {
  const preferred = /^(transaction|description|details|narrative|payee|vendor|supplier|merchant|reference|memo|type)/i;
  return columns.find((name) => preferred.test(name)) ?? columns[0] ?? '';
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
        className={`${secondaryButtonClass('sm')}`}
      >
        {busy ? 'Starting…' : 'Analyse'}
      </button>
      {error ? <span className="ml-2 text-xs text-danger">{error}</span> : null}
    </span>
  );
}
