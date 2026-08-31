'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { createBrowserSupabase } from '@/lib/supabase/client';
import {
  ACCEPTED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  formatBytes,
  isAcceptedFilename,
  mimeForFilename,
} from '@/lib/storage';
import { buttonClass, secondaryButtonClass } from '@/components/ui';

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

  if (uploadId && status?.state === 'ready') {
    return <Result status={status} onAnother={reset} />;
  }

  if (uploadId && status?.state === 'failed') {
    return <Failure status={status} onRetry={reset} />;
  }

  if (uploadId) {
    return <Working status={status} filename={status?.filename ?? null} />;
  }

  return <Dropzone busy={uploading} error={error} onFile={upload} />;
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
    <div className="mx-auto max-w-2xl">
      <h1 className="text-center text-[26px] font-semibold tracking-tight">
        Categorise your transactions
      </h1>
      <p className="mx-auto mt-2 max-w-lg text-center text-[15px] leading-relaxed text-muted">
        Drop a bank statement or transaction export. DataEngine reads it, sorts every
        transaction into HMRC categories and gives you back a spreadsheet.
      </p>

      {/* A label rather than a div with a click handler: it is a real file input
          underneath, so the keyboard and the screen reader get the control they
          expect and the drop target is the same element either way. */}
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
        className={`mt-8 flex cursor-pointer flex-col items-center justify-center rounded-[var(--radius-lg)] border-2 border-dashed px-6 py-16 text-center transition-colors ${
          over ? 'border-accent bg-accent-soft/40' : 'border-border bg-surface hover:bg-surface-2/60'
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

        <p className="text-[15px] font-medium">
          {busy ? `${busy}…` : 'Drop your bank statement here'}
        </p>
        {!busy ? (
          <>
            <p className="mt-1 text-sm text-subtle">or</p>
            <span className={`${buttonClass('sm')} mt-3`}>Choose a file</span>
            <p className="mt-4 text-xs text-subtle">
              CSV · XLSX · XLS · up to {formatBytes(MAX_UPLOAD_BYTES)}
            </p>
          </>
        ) : null}
      </label>

      {error ? (
        <p className="mt-4 rounded-[var(--radius)] border border-danger/30 bg-danger-soft/40 px-4 py-3 text-sm leading-relaxed text-danger">
          {error}
        </p>
      ) : null}

      <p className="mt-6 text-center text-xs leading-relaxed text-subtle">
        Your file is stored exactly as it arrives and is never changed. Categories are added
        alongside your data in a new copy.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* State 2 — processing                                                        */
/* -------------------------------------------------------------------------- */

function Working({ status, filename }: { status: Status | null; filename: string | null }) {
  const steps = status?.steps ?? [
    { label: 'File uploaded', status: 'done' as const },
    { label: 'Reading transaction data', status: 'active' as const },
    { label: 'Identifying transaction columns', status: 'waiting' as const },
    { label: 'Categorising with HMRC categories', status: 'waiting' as const },
    { label: 'Checking the results', status: 'waiting' as const },
    { label: 'Preparing your file', status: 'waiting' as const },
    { label: 'Ready to download', status: 'waiting' as const },
  ];

  const active = steps.find((step) => step.status === 'active');

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-center text-[26px] font-semibold tracking-tight">
        {active?.label ?? 'Working on your file'}
      </h1>
      {filename ? (
        <p className="mt-2 text-center text-sm text-muted">{filename}</p>
      ) : null}

      <ul className="mt-8 space-y-1 rounded-[var(--radius-lg)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-3 py-1.5">
            <StepMark status={step.status} />
            <span
              className={`text-sm ${
                step.status === 'waiting'
                  ? 'text-subtle'
                  : step.status === 'active'
                    ? 'font-medium'
                    : 'text-muted'
              }`}
            >
              {step.label}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-5 text-center text-xs leading-relaxed text-subtle">
        {status?.state === 'working' && status.queued
          ? 'Waiting for a free slot. This usually starts within a few seconds.'
          : 'This usually takes under a minute. You can leave this page open.'}
      </p>
    </div>
  );
}

/**
 * The state of one step, as a shape and not only as a colour.
 *
 * A tick, a pulsing dot and an empty circle read as three different things in
 * greyscale, which a green/grey pair does not.
 */
function StepMark({ status }: { status: Step['status'] }) {
  if (status === 'done') {
    return (
      <span
        aria-hidden
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success text-[10px] font-bold text-white"
      >
        ✓
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span
        aria-hidden
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-danger text-[10px] font-bold text-white"
      >
        !
      </span>
    );
  }
  if (status === 'active') {
    return (
      <span
        aria-hidden
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-info"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-info pulse-dot" />
      </span>
    );
  }
  return (
    <span aria-hidden className="h-4 w-4 shrink-0 rounded-full border-2 border-border-subtle" />
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
      // The job id came from the status of *this* upload, and the route re-reads
      // the path off that job server-side. There is no list of past exports on
      // this screen and no way for it to name one.
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
    <div className="mx-auto max-w-2xl text-center">
      <span
        aria-hidden
        className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-success text-lg font-bold text-white"
      >
        ✓
      </span>

      <h1 className="mt-5 text-[26px] font-semibold tracking-tight">
        Your categorised file is ready
      </h1>
      <p className="mt-2 text-sm text-muted">{status.filename}</p>

      <div className="mt-8 grid gap-px overflow-hidden rounded-[var(--radius-lg)] border border-border bg-border sm:grid-cols-3">
        <Figure value={summary.transactions} label="transactions read" />
        <Figure value={summary.categorised} label="categorised" />
        <Figure
          value={summary.flagged}
          label="flagged for review"
          hint={
            summary.flagged > 0
              ? 'The description did not show a business purpose, so nothing was claimed for these.'
              : undefined
          }
        />
      </div>

      <button
        type="button"
        onClick={download}
        disabled={busy}
        className={`${buttonClass()} mt-8 w-full sm:w-auto`}
      >
        {busy ? 'Preparing…' : 'Download categorised file'}
      </button>

      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}

      <p className="mt-6 text-xs leading-relaxed text-subtle">
        Your file now has HMRC Category, HMRC Box and Confidence columns beside the original
        data. Nothing that was in the file has been changed.
      </p>

      <button type="button" onClick={onAnother} className={`${secondaryButtonClass('sm')} mt-6`}>
        Categorise another file
      </button>
    </div>
  );
}

function Figure({ value, label, hint }: { value: number; label: string; hint?: string }) {
  return (
    <div className="bg-surface px-5 py-5">
      <p className="tabular text-[26px] font-semibold leading-none tracking-tight">
        {value.toLocaleString('en-GB')}
      </p>
      <p className="mt-1.5 text-[13px] text-muted">{label}</p>
      {hint ? <p className="mt-2 text-[11px] leading-relaxed text-subtle">{hint}</p> : null}
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
    <div className="mx-auto max-w-2xl text-center">
      <h1 className="text-[26px] font-semibold tracking-tight">We couldn&rsquo;t finish that file</h1>
      <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-muted">
        {status.message}
      </p>
      <p className="mt-2 text-sm text-subtle">{status.filename}</p>

      <button type="button" onClick={onRetry} className={`${buttonClass()} mt-8`}>
        Try another file
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

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
