'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileSpreadsheet, Loader2, UploadCloud } from 'lucide-react';

import { createBrowserSupabase } from '@/lib/supabase/client';
import {
  ACCEPTED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  formatBytes,
  isAcceptedFilename,
  mimeForFilename,
} from '@/lib/storage';
import {
  ErrorText,
  KpiTile,
  RailSection,
  RightRail,
  StatusDot,
  buttonClass,
  secondaryButtonClass,
} from '@/components/ui';

/**
 * Upload, wait, download.
 *
 * That is the entire product from this screen, and everything the old workspace
 * page asked for — pick a workspace, name a dataset, press Analyse, read a
 * review queue, approve, apply, choose a format, find the right download — has
 * moved behind it. None of it was removed: it is all still on the workspace
 * page for anybody who wants to inspect a run. It is simply not the price of
 * getting a categorised file any more.
 *
 * Three states, one at a time, in one component. They share the upload id and
 * nothing else, and a state machine spread over three routes would have made
 * the browser's back button part of the design for no benefit.
 *
 * The upload path is the existing one, unchanged: reserve a signed URL, PUT the
 * bytes straight to storage, confirm. The bytes never pass through the Next
 * server, which is as true here as it was on the old form.
 *
 * --- on the layout ---------------------------------------------------------
 * The screen is a task column with a rail of context beside it, and the rail
 * does not move between the three states. It previously centred a 550px-tall
 * dropzone in an otherwise empty page and stacked three marketing cards under
 * it, which is the shape of a landing page: it told a first-time visitor what
 * the product was and told the accountant using it daily nothing at all. The
 * rail now carries the run — the same seven steps before, during and after,
 * so the reader can see what the engine is going to do before they commit a
 * client's file to it, and where it got to afterwards.
 */

type Step = { label: string; status: 'done' | 'active' | 'waiting' | 'failed' };

type Status =
  | { state: 'working'; filename: string; steps: Step[]; queued: boolean }
  | {
      state: 'ready';
      filename: string;
      steps: Step[];
      summary: {
        transactions: number;
        categorised: number;
        flagged: number;
        categories: number;
      };
      download: { jobId: string };
    }
  | { state: 'failed'; filename: string; steps: Step[]; message: string };

/**
 * Two seconds while something is running.
 *
 * The same cadence the agent panel uses. Fast enough that the checklist moves
 * while somebody is watching it, slow enough that a tab left open overnight is
 * not a problem.
 */
const POLL_MS = 2_000;

/**
 * What the engine will do, in the order it does it.
 *
 * Shown before anything is uploaded as well as during the run. The server
 * sends the same seven labels back with live statuses attached, so the reader
 * is watching the list they were shown rather than a different one.
 */
const PLANNED_STEPS: Step[] = [
  { label: 'File uploaded', status: 'waiting' },
  { label: 'Reading transaction data', status: 'waiting' },
  { label: 'Identifying transaction columns', status: 'waiting' },
  { label: 'Categorising with HMRC categories', status: 'waiting' },
  { label: 'Checking the results', status: 'waiting' },
  { label: 'Preparing your file', status: 'waiting' },
  { label: 'Ready to download', status: 'waiting' },
];

export function CategoriseFlow() {
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/categorise/status?uploadId=${id}`, {
        cache: 'no-store',
      });
      if (!response.ok) return;
      setStatus((await response.json()) as Status);
    } catch {
      // A dropped poll is not worth showing. The next one is two seconds away,
      // and an error banner that appears whenever a laptop lid closes is noise.
    }
  }, []);

  useEffect(() => {
    if (!uploadId) return;
    if (status?.state === 'ready' || status?.state === 'failed') return;

    // The first poll goes through a timer rather than being called here.
    // Awaiting it in the effect body would be a synchronous setState path into a
    // cascading render, and the timer is the external system this effect is
    // subscribing to anyway.
    const first = setTimeout(() => void poll(uploadId), 0);
    const timer = setInterval(() => void poll(uploadId), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [uploadId, status?.state, poll]);

  async function upload(file: File) {
    setError(null);

    if (!isAcceptedFilename(file.name)) {
      setError(`We can read ${ACCEPTED_EXTENSIONS.join(', ')} files. This one is a different type.`);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(
        `This file is ${formatBytes(file.size)}. The largest we can take is ` +
          `${formatBytes(MAX_UPLOAD_BYTES)}.`,
      );
      return;
    }

    try {
      setUploading('Preparing');
      const started = await postJson('/api/categorise/start', {});
      const workspaceId = started.workspaceId as string;

      setUploading('Uploading');
      const signed = await postJson('/api/uploads/sign', {
        workspaceId,
        filename: file.name,
        byteSize: file.size,
        datasetId: null,
        // Named after the file, because the accountant is not being asked to
        // name anything. It only ever surfaces in the advanced view.
        datasetName: file.name.replace(/\.[^.]+$/, '').slice(0, 200) || 'Transactions',
      });

      // The storage client ignores its own contentType when the body is a Blob,
      // and Windows reports an empty type for .xlsx when the extension is not
      // registered — so the type is derived from the name, as on the old form.
      const body = new File([file], file.name, { type: mimeForFilename(file.name) });
      const supabase = createBrowserSupabase();
      const { error: uploadError } = await supabase.storage
        .from(signed.bucket as string)
        .uploadToSignedUrl(signed.storagePath as string, signed.token as string, body);

      if (uploadError) throw new Error(uploadError.message);

      setUploading('Starting');
      await postJson('/api/uploads/complete', {
        uploadId: signed.uploadId,
        workspaceId,
        sha256: await sha256Hex(file),
      });

      // `autopilot` is what tells the worker to categorise straight through
      // rather than stopping to build a review queue nobody on this screen is
      // going to open.
      await postJson('/api/agent/jobs', {
        workspaceId,
        kind: 'parse_workbook',
        rawUploadId: signed.uploadId,
        datasetId: signed.datasetId,
        payload: { autopilot: true },
      });

      setStatus(null);
      setUploadId(signed.uploadId as string);
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : "We couldn't start on that file. Please try again.",
      );
    } finally {
      setUploading(null);
    }
  }

  function reset() {
    setUploadId(null);
    setStatus(null);
    setError(null);
  }

  const steps = status?.steps ?? PLANNED_STEPS;
  const started = Boolean(uploadId);

  return (
    <RightRail
      railLabel="Run status"
      rail={
        <>
          <RailSection
            title="This run"
            hint={<RunState status={status} started={started} />}
          >
            <StepList steps={steps} dimmed={!started} />
          </RailSection>

          {status?.state === 'ready' && (
            <RailSection title="Result">
              <KpiTile label="Transactions read" value={num(status.summary.transactions)} />
              <KpiTile
                label="Auto-categorised"
                value={num(status.summary.categorised)}
                tone="success"
              />
              <KpiTile
                label="Flagged for review"
                value={num(status.summary.flagged)}
                tone={status.summary.flagged > 0 ? 'warning' : 'neutral'}
                hint={status.summary.flagged > 0 ? 'Needs your sign-off' : undefined}
              />
              <KpiTile label="Categories used" value={num(status.summary.categories)} />
            </RailSection>
          )}

          {/* Three claims that are load-bearing for an accountant deciding
              whether to put a client's book through this at all. They used to
              be three marketing cards under the fold; they belong beside the
              control that acts on them. */}
          <RailSection title="What this does">
            <dl className="space-y-3">
              <Guarantee term="Nothing is overwritten">
                Your file is stored as uploaded. Categories are written to a new
                dataset version beside it.
              </Guarantee>
              <Guarantee term="HMRC SA103F boxes">
                Transactions are mapped to the self-assessment categories, not to
                invented ones.
              </Guarantee>
              <Guarantee term="Every decision is logged">
                Each category carries the rule or model reply behind it, in the
                activity log.
              </Guarantee>
            </dl>
          </RailSection>
        </>
      }
    >
      {status?.state === 'ready' ? (
        <Result status={status} onAnother={reset} />
      ) : status?.state === 'failed' ? (
        <Failure status={status} onRetry={reset} />
      ) : started ? (
        <Working status={status} filename={status?.filename ?? null} />
      ) : (
        <Dropzone busy={uploading} error={error} onFile={upload} />
      )}
    </RightRail>
  );
}

/* -------------------------------------------------------------------------- */
/* The rail                                                                    */
/* -------------------------------------------------------------------------- */

function RunState({ status, started }: { status: Status | null; started: boolean }) {
  if (!started) return <span className="text-subtle">Not started</span>;
  if (status?.state === 'ready') return <span className="text-success">Done</span>;
  if (status?.state === 'failed') return <span className="text-danger">Failed</span>;
  if (status?.state === 'working' && status.queued)
    return <span className="text-warning">Queued</span>;
  return <span className="text-info">Running</span>;
}

/**
 * The seven steps, in one list, in every state.
 *
 * `dimmed` is the un-started reading of the same list: the steps are a plan
 * rather than a report, so they are quieter, but they are the same seven
 * labels in the same order and the reader is not shown a different thing once
 * the run begins.
 */
function StepList({ steps, dimmed = false }: { steps: Step[]; dimmed?: boolean }) {
  return (
    <ol className={dimmed ? 'opacity-55' : ''}>
      {steps.map((step) => (
        <li key={step.label} className="flex items-center gap-2.5 py-[5px] text-[13px]">
          <StepMark status={step.status} />
          <span
            className={
              step.status === 'active'
                ? 'font-medium text-foreground'
                : step.status === 'failed'
                  ? 'text-danger'
                  : step.status === 'done'
                    ? 'text-muted'
                    : 'text-subtle'
            }
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepMark({ status }: { status: Step['status'] }) {
  if (status === 'done') return <StatusDot tone="success" />;
  if (status === 'failed') return <StatusDot tone="danger" />;
  if (status === 'active') return <StatusDot tone="info" live />;
  // A ring rather than a filled dot: the step exists but has not happened.
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 shrink-0 rounded-full border border-border-strong"
    />
  );
}

function Guarantee({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[13px] font-medium text-foreground">{term}</dt>
      <dd className="mt-0.5 text-[12px] leading-relaxed text-subtle">{children}</dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* State 1 — upload                                                            */
/* -------------------------------------------------------------------------- */

function Dropzone({
  busy,
  error,
  onFile,
}: {
  busy: string | null;
  error: string | null;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div>
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-balance sm:text-[32px]">
        Categorise a bank statement
      </h1>
      <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-muted">
        Drop a CSV or Excel statement in. It comes back with an HMRC category
        against every transaction and the ones worth a second look flagged.
      </p>

      {/* The label is the control: clicking anywhere in the box opens the file
          picker, and the input inside it keeps the keyboard path — tab to it,
          space to open. A div with an onClick would have lost that. */}
      <label
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const file = event.dataTransfer.files?.[0];
          if (file && !busy) onFile(file);
        }}
        className={`mt-7 flex cursor-pointer flex-col items-center justify-center rounded-[var(--radius-lg)] border border-dashed px-8 py-14 text-center transition-[color,background-color,border-color,box-shadow] duration-[--duration] focus-within:border-accent focus-within:ring-2 focus-within:ring-[var(--accent-ring)] ${
          over
            ? 'border-accent bg-accent-soft'
            : 'border-border-strong bg-surface hover:border-accent/50'
        } ${busy ? 'pointer-events-none opacity-70' : ''}`}
      >
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          accept={ACCEPTED_EXTENSIONS.join(',')}
          disabled={Boolean(busy)}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onFile(file);
            event.target.value = '';
          }}
        />

        <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface-2 text-accent">
          {busy ? (
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          ) : (
            <UploadCloud className="h-5 w-5" aria-hidden />
          )}
        </span>

        <span className="text-[15px] font-medium">
          {busy ? `${busy} your file…` : 'Drop your statement here'}
        </span>

        {!busy && (
          <>
            <span className="mt-1 text-sm text-muted">or choose one from your device</span>
            <span className={`${buttonClass()} pointer-events-none mt-5`}>
              <FileSpreadsheet className="h-4 w-4" aria-hidden />
              Select file
            </span>
            <span className="mt-5 font-mono text-[11px] text-subtle">
              {ACCEPTED_EXTENSIONS.join(' · ')} · up to {formatBytes(MAX_UPLOAD_BYTES)}
            </span>
          </>
        )}
      </label>

      {error && <div className="mt-4"><ErrorText>{error}</ErrorText></div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* State 2 — processing                                                        */
/* -------------------------------------------------------------------------- */

function Working({ status, filename }: { status: Status | null; filename: string | null }) {
  const steps = status?.steps ?? PLANNED_STEPS;
  const active = steps.find((step) => step.status === 'active');
  const queued = status?.state === 'working' && status.queued;
  const done = steps.filter((step) => step.status === 'done').length;

  return (
    <div className="rise">
      {/* The same eyebrow shape the result state uses, with a live dot rather
          than a static one. It was the only one of the three states whose
          heading did not say, by itself, that anything was still moving --
          which on a slow run left a page that had genuinely stalled and a page
          that was working looking identical. */}
      <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-accent">
        <StatusDot tone={queued ? 'warning' : 'accent'} live />
        {queued ? 'Queued' : 'Working'}
      </p>
      <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-balance">
        {active?.label ?? 'Starting on your file'}
      </h1>
      {filename && <p className="mt-2 font-mono text-[13px] text-muted">{filename}</p>}

      {/* One bar, because there is one thing happening and its progress is
          genuinely known — the step list beside it is the detail. A spinner
          here would have said only "wait". */}
      <div className="mt-7 max-w-md">
        <div
          className="h-1 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
          aria-label="Categorisation progress"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-[--duration-slow] ease-[--ease-out]"
            style={{ width: `${Math.round((done / steps.length) * 100)}%` }}
          />
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          {queued
            ? 'Waiting for a free worker. This usually takes a few seconds.'
            : 'You can leave this page — the run carries on without the tab open, and the file will be waiting in the workspace.'}
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* State 3 — result                                                            */
/* -------------------------------------------------------------------------- */

function Result({
  status,
  onAnother,
}: {
  status: Extract<Status, { state: 'ready' }>;
  onAnother: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { summary } = status;

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/exports?jobId=${status.download.jobId}`, {
        cache: 'no-store',
      });
      const body = await response.json();
      if (!response.ok) throw new Error("We couldn't prepare that download. Please try again.");
      window.location.href = body.url as string;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rise">
      <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-success">
        <StatusDot tone="success" />
        Ready
      </p>
      <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-balance sm:text-[32px]">
        Your categorised statement is ready
      </h1>
      <p className="mt-2 font-mono text-[13px] text-muted">{status.filename}</p>

      {/* The sentence an accountant actually needs before they open the file:
          how much of it the engine was willing to decide on its own, and how
          much is coming back to them. */}
      <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-muted">
        {summary.categorised.toLocaleString('en-GB')} of{' '}
        {summary.transactions.toLocaleString('en-GB')} transactions were categorised across{' '}
        {summary.categories.toLocaleString('en-GB')}{' '}
        {summary.categories === 1 ? 'category' : 'categories'}.{' '}
        {summary.flagged > 0 ? (
          <>
            <span className="text-warning">
              {summary.flagged.toLocaleString('en-GB')}{' '}
              {summary.flagged === 1 ? 'transaction is' : 'transactions are'} flagged
            </span>{' '}
            for you to check in the workspace.
          </>
        ) : (
          'Nothing was flagged for review.'
        )}
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button type="button" onClick={download} disabled={busy} className={buttonClass()}>
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Download className="h-4 w-4" aria-hidden />
          )}
          {busy ? 'Preparing…' : 'Download Excel'}
        </button>

        <button type="button" onClick={onAnother} className={secondaryButtonClass()}>
          Categorise another file
        </button>
      </div>

      {error && <div className="mt-4 max-w-md"><ErrorText>{error}</ErrorText></div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Failure                                                                     */
/* -------------------------------------------------------------------------- */

function Failure({
  status,
  onRetry,
}: {
  status: Extract<Status, { state: 'failed' }>;
  onRetry: () => void;
}) {
  return (
    <div className="rise">
      <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-danger">
        <StatusDot tone="danger" />
        Failed
      </p>
      <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-balance">
        We couldn&rsquo;t finish that file
      </h1>
      <p className="mt-2 font-mono text-[13px] text-muted">{status.filename}</p>

      <dl className="mt-6 max-w-xl space-y-3 text-[15px] leading-relaxed">
        <div>
          <dt className="font-medium">What happened</dt>
          <dd className="text-muted">{status.message}</dd>
        </div>
        <div>
          <dt className="font-medium">What you can do</dt>
          <dd className="text-muted">
            Check the statement opens in Excel and has a header row with a date, a
            description and an amount. Then send it through again — nothing from this
            attempt was saved over your file.
          </dd>
        </div>
      </dl>

      <button type="button" onClick={onRetry} className={`${buttonClass()} mt-8`}>
        Try another file
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** Counts are read down a column in the rail, so they are tabular. */
function num(value: number) {
  return value.toLocaleString('en-GB');
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await response.json();
  if (!response.ok) {
    throw new Error(typeof parsed.error === 'string' ? parsed.error : '');
  }
  return parsed as Record<string, unknown>;
}

/**
 * SHA-256 of the file, computed in the browser.
 *
 * Not a security control — the client could send any string. It is the signal
 * for "this client re-sent last month's file", which the deviation engine reads.
 */
async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
