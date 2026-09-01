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

/* -------------------------------------------------------------------------- */
/* State 1 — upload                                                            */
/* -------------------------------------------------------------------------- */

import { motion, AnimatePresence } from 'framer-motion';
import { UploadCloud, FileSpreadsheet, CheckCircle2, AlertCircle, Loader2, Sparkles, Download, ArrowRight, ShieldCheck } from 'lucide-react';

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
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="mx-auto max-w-3xl"
    >
      <div className="text-center space-y-3">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-950/60 border border-cyan-500/30 text-cyan-300 text-xs font-semibold tracking-wide">
          <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
          <span>HMRC AI Tax Engine v2.4</span>
        </div>
        <h1 className="font-heading text-3xl sm:text-4xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-slate-100 via-cyan-100 to-teal-200">
          Categorise Your Bank Transactions
        </h1>
        <p className="mx-auto max-w-xl text-base text-slate-400 leading-relaxed">
          Upload any CSV or Excel statement. DataEngine instantly maps transactions to official HMRC categories with complete auditability.
        </p>
      </div>

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
        className={`relative mt-8 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-8 py-20 text-center transition-all duration-300 backdrop-blur-md overflow-hidden ${
          over
            ? 'border-cyan-400 bg-cyan-950/30 shadow-[0_0_40px_-5px_rgba(6,182,212,0.4)] scale-[1.01]'
            : 'border-slate-800 bg-slate-900/40 hover:border-cyan-500/50 hover:bg-slate-900/70 shadow-2xl'
        } ${busy ? 'pointer-events-none opacity-80' : ''}`}
      >
        {/* Subtle glowing mesh backdrop */}
        <div className="absolute inset-0 bg-gradient-to-tr from-cyan-500/10 via-transparent to-teal-500/10 opacity-50 pointer-events-none" />

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

        <div className="relative z-10 flex flex-col items-center">
          <div className="p-4 rounded-2xl bg-cyan-950/80 border border-cyan-500/40 text-cyan-400 shadow-lg shadow-cyan-950/50 mb-5 group-hover:scale-110 transition-transform duration-300">
            {busy ? (
              <Loader2 className="w-10 h-10 animate-spin text-cyan-400" />
            ) : (
              <UploadCloud className="w-10 h-10 text-cyan-400" />
            )}
          </div>

          <p className="font-heading text-lg font-bold text-slate-100">
            {busy ? `${busy} file...` : 'Drag & drop your bank statement here'}
          </p>

          {!busy ? (
            <>
              <p className="mt-1 text-sm text-slate-400">or click to browse from computer</p>
              <span className="mt-5 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-teal-500 px-5 py-2.5 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-500/20 hover:from-cyan-400 hover:to-teal-400 transition-all duration-200">
                <FileSpreadsheet className="w-4 h-4" />
                Select File
              </span>
              <p className="mt-6 text-xs text-slate-400 font-mono">
                Supports .CSV, .XLSX, .XLS up to {formatBytes(MAX_UPLOAD_BYTES)}
              </p>
            </>
          ) : null}
        </div>
      </label>

      {error ? (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4 flex items-center gap-3 rounded-xl border border-rose-500/30 bg-rose-950/40 px-4 py-3 text-sm text-rose-300 shadow-lg"
        >
          <AlertCircle className="w-5 h-5 shrink-0 text-rose-400" />
          <span>{error}</span>
        </motion.div>
      ) : null}

      <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4 text-left">
        <div className="p-4 rounded-xl border border-slate-800/80 bg-slate-900/30">
          <ShieldCheck className="w-5 h-5 text-cyan-400 mb-2" />
          <p className="text-xs font-semibold text-slate-200">Zero Overwrites</p>
          <p className="text-[11px] text-slate-400 mt-1">Source files remain untouched. Categories added as a new dataset.</p>
        </div>
        <div className="p-4 rounded-xl border border-slate-800/80 bg-slate-900/30">
          <Sparkles className="w-5 h-5 text-teal-400 mb-2" />
          <p className="text-xs font-semibold text-slate-200">HMRC Box Mappings</p>
          <p className="text-[11px] text-slate-400 mt-1">Direct SA103F tax categorization for instant self-assessment prep.</p>
        </div>
        <div className="p-4 rounded-xl border border-slate-800/80 bg-slate-900/30">
          <FileSpreadsheet className="w-5 h-5 text-indigo-400 mb-2" />
          <p className="text-xs font-semibold text-slate-200">Instant Export</p>
          <p className="text-[11px] text-slate-400 mt-1">Download ready-to-use Excel or CSV files in seconds.</p>
        </div>
      </div>
    </motion.div>
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
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      className="mx-auto max-w-xl text-center"
    >
      <div className="relative inline-flex items-center justify-center p-4 rounded-full bg-cyan-950/60 border border-cyan-500/40 text-cyan-400 mb-6 shadow-[0_0_30px_rgba(6,182,212,0.3)]">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>

      <h1 className="font-heading text-2xl font-bold tracking-tight text-slate-100">
        {active?.label ?? 'AI Processing Engine Active'}
      </h1>
      {filename ? <p className="mt-1 text-sm font-mono text-cyan-400/80">{filename}</p> : null}

      <div className="mt-8 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-2xl backdrop-blur-xl text-left">
        <ul className="space-y-3.5">
          {steps.map((step, idx) => (
            <motion.li
              key={step.label}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.05 }}
              className="flex items-center gap-3.5 text-sm"
            >
              <StepMark status={step.status} />
              <span
                className={`font-medium ${
                  step.status === 'waiting'
                    ? 'text-slate-400'
                    : step.status === 'active'
                      ? 'text-cyan-300 font-semibold'
                      : 'text-slate-200'
                }`}
              >
                {step.label}
              </span>
            </motion.li>
          ))}
        </ul>
      </div>

      <p className="mt-6 text-xs text-slate-400">
        {status?.state === 'working' && status.queued
          ? 'Queued in worker pool. Processing starts in a few seconds...'
          : 'Categorising transactions... You can keep this tab open.'}
      </p>
    </motion.div>
  );
}

function StepMark({ status }: { status: Step['status'] }) {
  if (status === 'done') {
    return (
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 border border-emerald-400/50 text-emerald-400">
        <CheckCircle2 className="w-3.5 h-3.5" />
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-rose-500/20 border border-rose-400/50 text-rose-400">
        <AlertCircle className="w-3.5 h-3.5" />
      </div>
    );
  }
  if (status === 'active') {
    return (
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-cyan-400/60 bg-cyan-950">
        <span className="h-2 w-2 rounded-full bg-cyan-400 animate-ping" />
      </div>
    );
  }
  return <div className="h-5 w-5 shrink-0 rounded-full border border-slate-800" />;
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
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="mx-auto max-w-2xl text-center"
    >
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/20 border border-emerald-400/40 text-emerald-400 shadow-[0_0_30px_rgba(16,185,129,0.3)] mb-4">
        <CheckCircle2 className="w-8 h-8" />
      </div>

      <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-100">
        Categorised Statement Ready
      </h1>
      <p className="mt-1.5 text-sm font-mono text-cyan-400">{status.filename}</p>

      {/* Modern Dashboard KPI Cards */}
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Figure value={summary.transactions} label="Transactions Read" />
        <Figure value={summary.categorised} label="Auto-Categorised" highlight />
        <Figure
          value={summary.flagged}
          label="Flagged for Review"
          hint={summary.flagged > 0 ? 'Requires human sign-off' : undefined}
        />
      </div>

      <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
        <button
          type="button"
          onClick={download}
          disabled={busy}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-teal-500 px-6 py-3 text-base font-semibold text-slate-950 shadow-lg shadow-cyan-500/25 hover:from-cyan-400 hover:to-teal-400 transition-all duration-200 cursor-pointer"
        >
          {busy ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Download className="w-5 h-5" />
          )}
          <span>{busy ? 'Preparing File...' : 'Download Categorised Excel'}</span>
        </button>

        <button
          type="button"
          onClick={onAnother}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-5 py-3 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-slate-100 transition-all cursor-pointer"
        >
          Categorise Another File
        </button>
      </div>

      {error ? <p className="mt-4 text-sm text-rose-400">{error}</p> : null}
    </motion.div>
  );
}

function Figure({ value, label, hint, highlight = false }: { value: number; label: string; hint?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-xl border p-5 text-left transition-all ${
      highlight 
        ? 'border-cyan-500/40 bg-cyan-950/30 shadow-[0_0_20px_-5px_rgba(6,182,212,0.2)]'
        : 'border-slate-800 bg-slate-900/40'
    }`}>
      <p className="font-mono text-3xl font-extrabold text-slate-100 tracking-tight">
        {value.toLocaleString('en-GB')}
      </p>
      <p className="mt-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      {hint ? <p className="mt-2 text-[11px] text-amber-400">{hint}</p> : null}
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
