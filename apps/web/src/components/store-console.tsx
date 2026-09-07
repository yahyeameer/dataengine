'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { isWorkerOnline, type EngineWorker } from '@/lib/agent';
import { needsCredentials, setupGuide, type SetupLanguage } from '@/lib/store-setup';

import {
  Badge,
  ErrorText,
  Field,
  Panel,
  StatusBadge,
  buttonClass,
  ghostButtonClass,
  inputClass,
  secondaryButtonClass,
  selectClass,
} from '@/components/ui';

/**
 * Connect a shop, sync it, read the report.
 *
 * The whole feature from a shopkeeper's side is three actions, and they happen
 * in that order the first time and then never again — after the first sync the
 * schedule does it. So the console is built around that sequence rather than
 * around the tables behind it: the connection form disappears once a store
 * exists, and what replaces it is the last report and the button that asks for
 * a new one.
 *
 * Nothing here talks to a shop's system. Every action is a row written through
 * an API route; the reading happens on the agent host, out of a queued job. That
 * is why a sync that takes four minutes against a slow QuickBooks does not hold
 * a browser open, and why closing the tab does not cancel it.
 */

export type StoreWorkspace = { id: string; name: string };

type Source = 'excel' | 'quickbooks' | 'odoo';

type Connection = {
  id: string;
  name: string;
  source: Source;
  status: string;
  dataset_id: string;
  config: Record<string, unknown> | null;
  base_currency: string;
  secondary_currency: string | null;
  secondary_rate: number | null;
  language: string;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
};

type SyncRun = {
  id: string;
  connection_id: string;
  status: string;
  window_start: string | null;
  window_end: string | null;
  entries_written: number | null;
  error: string | null;
  started_at: string;
  summary: Record<string, unknown> | null;
};

type Schedule = {
  id: string;
  connection_id: string;
  cadence: string;
  granularity: string;
  format: string;
  language: string;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
};

/** Only what liveness needs. The full row carries no customer data either. */
type Worker = EngineWorker & { capabilities: string[] | null };

type Job = {
  id: string;
  kind: string;
  status: string;
  error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
};

const SOURCE_LABELS: Record<Source, string> = {
  excel: 'A spreadsheet I upload',
  quickbooks: 'QuickBooks Online',
  odoo: 'Odoo',
};

const CADENCES = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
  { value: 'yearly', label: 'Every year' },
];

function money(value: unknown, currency: string): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  const negative = value < 0;
  const text = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: /^[A-Z]{3}$/.test(currency) ? currency : 'USD',
    currencyDisplay: 'narrowSymbol',
  }).format(Math.abs(value));
  // Parentheses for negatives, as a set of accounts writes them — and as the
  // agent's own reports do, so the screen and the document agree.
  return negative ? `(${text})` : text;
}

function percent(value: unknown): string {
  return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—';
}

function when(value: string | null): string {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'never' : date.toLocaleString();
}

export function StoreConsole({ workspaces }: { workspaces: StoreWorkspace[] }) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);

  /**
   * Fetch, without touching state.
   *
   * Split from applying the result so the effect below can drop a response that
   * arrived after the reader moved on. Two workspaces switched quickly would
   * otherwise race, and the slower request would win — painting one shop's
   * stores under the other one's name.
   */
  const fetchState = useCallback(async (id: string) => {
    const [stores, agent] = await Promise.all([
      fetch(`/api/stores?workspaceId=${id}`),
      fetch(`/api/agent/jobs?workspaceId=${id}`),
    ]);
    const storeData = await stores.json();
    if (!stores.ok) throw new Error(storeData.error ?? 'Could not load your stores');

    const agentData = agent.ok ? await agent.json() : { jobs: [] };
    return {
      connections: (storeData.connections ?? []) as Connection[],
      runs: (storeData.runs ?? []) as SyncRun[],
      schedules: (storeData.schedules ?? []) as Schedule[],
      jobs: ((agentData.jobs ?? []) as Job[]).filter((job) =>
        ['sync_store', 'store_financials', 'test_store_connection'].includes(job.kind),
      ),
      workers: (agentData.workers ?? []) as Worker[],
    };
  }, []);

  const apply = useCallback((state: Awaited<ReturnType<typeof fetchState>>) => {
    setConnections(state.connections);
    setRuns(state.runs);
    setSchedules(state.schedules);
    setJobs(state.jobs);
    setWorkers(state.workers);
    setSelectedId((current) =>
      current && state.connections.some((connection) => connection.id === current)
        ? current
        : (state.connections[0]?.id ?? null),
    );
    setError(null);
  }, []);

  /** For the handlers: refresh now, and surface a failure where the reader is. */
  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      apply(await fetchState(workspaceId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load your stores');
    }
  }, [workspaceId, fetchState, apply]);

  useEffect(() => {
    if (!workspaceId) return;
    let current = true;
    void (async () => {
      try {
        const state = await fetchState(workspaceId);
        if (current) apply(state);
      } catch (loadError) {
        if (current) {
          setError(loadError instanceof Error ? loadError.message : 'Could not load your stores');
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [workspaceId, fetchState, apply]);

  // Poll only while something is actually in flight. A dashboard that polls
  // forever is a dashboard that keeps a phone's radio awake all afternoon for
  // a shop that syncs once a week.
  const working = jobs.some((job) => job.status === 'queued' || job.status === 'running');
  useEffect(() => {
    if (!working) return;
    const interval = setInterval(() => void load(), 3000);
    return () => clearInterval(interval);
  }, [working, load]);

  /**
   * Can anything actually read a store right now?
   *
   * Derived from the workers' own heartbeats rather than from a flag this app
   * holds. The agent host decides whether store reading is switched on and
   * announces the answer every thirty seconds; a worker that does not announce
   * `sync_store` will never claim one, so the job would sit queued forever with
   * nothing to say why.
   */
  const syncingAvailable = useMemo(
    () =>
      workers.some(
        (worker) =>
          isWorkerOnline(worker.last_seen_at) &&
          (worker.capabilities ?? []).includes('sync_store'),
      ),
    [workers],
  );

  const selected = useMemo(
    () => connections.find((connection) => connection.id === selectedId) ?? null,
    [connections, selectedId],
  );

  async function enqueue(
    kind: 'sync_store' | 'store_financials' | 'test_store_connection',
    payload: Record<string, unknown>,
  ) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/agent/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, kind, payload }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not ask the agent to do that');
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const latestReport = jobs.find(
    (job) => job.kind === 'store_financials' && job.status === 'succeeded',
  );

  // Only for the store being looked at, and only the newest. A verdict from a
  // different shop's setup would be worse than none.
  const latestTest = jobs.find(
    (job) =>
      job.kind === 'test_store_connection' &&
      job.status === 'succeeded' &&
      (job.result as { connection_id?: string } | null)?.connection_id === selectedId,
  );

  return (
    <div className="flex flex-col gap-5">
      {workers.length > 0 && !syncingAvailable && (
        <div className="rounded-[var(--radius-lg)] border border-warning/25 bg-warning-soft px-4 py-3 text-sm text-warning">
          No agent on duty can read stores yet. You can still connect one — anything you ask for
          waits in the queue and runs as soon as an agent with store reading switched on comes
          online.
        </div>
      )}

      {workspaces.length > 1 && (
        <div className="max-w-sm">
          <Field label="Workspace">
            <select
              className={selectClass}
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      <Panel
        title="Your stores"
        description="Each one keeps its own ledger, so this month can be compared with last."
        action={
          <button
            type="button"
            className={connections.length ? secondaryButtonClass('sm') : buttonClass('sm')}
            onClick={() => setShowForm((open) => !open)}
          >
            {showForm ? 'Cancel' : 'Connect a store'}
          </button>
        }
      >
        {showForm && (
          <ConnectForm
            workspaceId={workspaceId}
            onDone={async (connectionId) => {
              setShowForm(false);
              // Test it straight away rather than waiting for the owner to
              // press something. The question they have at this moment is "did
              // that work", and the whole point of the job is that it can be
              // answered in seconds instead of at the first sync.
              if (connectionId) {
                await fetch('/api/agent/jobs', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    workspaceId,
                    kind: 'test_store_connection',
                    payload: { connection_id: connectionId },
                  }),
                }).catch(() => undefined);
                setSelectedId(connectionId);
              }
              await load();
            }}
          />
        )}

        {connections.length === 0 && !showForm && (
          <p className="text-sm text-muted">
            Nothing connected yet. Start with the spreadsheet you already keep — it needs no
            credentials and takes about a minute.
          </p>
        )}

        {connections.length > 0 && (
          <ul className="flex flex-col gap-2">
            {connections.map((connection) => (
              <li key={connection.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(connection.id)}
                  className={`flex w-full flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border px-4 py-3 text-left transition ${
                    connection.id === selectedId
                      ? 'border-accent/40 bg-accent-soft'
                      : 'border-border bg-surface-2 hover:border-border-strong'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{connection.name}</span>
                    <span className="block text-xs text-subtle">
                      {SOURCE_LABELS[connection.source]} · last read {when(connection.last_sync_at)}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {connection.status === 'error' ? (
                      <Badge tone="danger">Needs attention</Badge>
                    ) : connection.status === 'paused' ? (
                      <Badge tone="neutral">Paused</Badge>
                    ) : (
                      <Badge tone="success">Connected</Badge>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {selected && (
        <>
          {selected.last_sync_error && (
            <div className="rounded-[var(--radius-lg)] border border-danger/25 bg-danger-soft px-4 py-3 text-sm text-danger">
              The last read of {selected.name} failed: {selected.last_sync_error}
            </div>
          )}

          <Panel
            title={selected.name}
            description={`${SOURCE_LABELS[selected.source]} · reported in ${selected.base_currency}${
              selected.secondary_currency ? ` and ${selected.secondary_currency}` : ''
            }`}
            action={
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className={ghostButtonClass('sm')}
                  onClick={() =>
                    enqueue('test_store_connection', { connection_id: selected.id })
                  }
                >
                  Check connection
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={secondaryButtonClass('sm')}
                  onClick={() =>
                    enqueue('sync_store', {
                      connection_id: selected.id,
                      then_report: true,
                      cadence: 'monthly',
                    })
                  }
                >
                  Read my store now
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('sm')}
                  onClick={() =>
                    enqueue('store_financials', {
                      connection_id: selected.id,
                      cadence: 'monthly',
                      format: 'md',
                    })
                  }
                >
                  Report this month
                </button>
              </div>
            }
          >
            <div className="flex flex-wrap gap-2">
              {(['daily', 'weekly', 'monthly', 'yearly'] as const).map((cadence) => (
                <button
                  key={cadence}
                  type="button"
                  disabled={busy}
                  className={ghostButtonClass('sm')}
                  onClick={() =>
                    enqueue('store_financials', {
                      connection_id: selected.id,
                      cadence,
                      format: 'md',
                    })
                  }
                >
                  {cadence === 'daily'
                    ? 'Yesterday'
                    : cadence === 'weekly'
                      ? 'Last week'
                      : cadence === 'monthly'
                        ? 'Last month'
                        : 'Last year'}
                </button>
              ))}
            </div>

            <ScheduleRow
              connectionId={selected.id}
              schedules={schedules.filter((s) => s.connection_id === selected.id)}
              onSaved={load}
            />
          </Panel>

          {latestTest && <ConnectionVerdict job={latestTest} />}

          {latestReport && <ReportCard job={latestReport} />}

          <RunHistory runs={runs.filter((run) => run.connection_id === selected.id)} jobs={jobs} />
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ConnectForm({
  workspaceId,
  onDone,
}: {
  workspaceId: string;
  onDone: (connectionId: string | null) => Promise<void>;
}) {
  const [source, setSource] = useState<Source>('excel');
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<SetupLanguage>('en');
  const [baseCurrency, setBaseCurrency] = useState('USD');
  const [shillingRate, setShillingRate] = useState('');
  const [paste, setPaste] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const guide = setupGuide(source, language);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          name,
          source,
          // The settings a paste usually carries are left empty on purpose. The
          // connection test reads them out of what was pasted and fills them
          // in, so asking for them here would be asking twice for the same
          // thing — and getting a mismatch when the two disagree.
          config: {},
          baseCurrency: baseCurrency.toUpperCase(),
          // The shilling column appears only when a rate is given. A converted
          // figure with no stated rate is a number nobody can check.
          secondaryCurrency: shillingRate ? 'SOS' : null,
          secondaryRate: shillingRate ? Number(shillingRate) : null,
          language,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not connect that store');

      const connectionId: string = data.connection.id;

      if (needsCredentials(source) && paste.trim()) {
        const stored = await fetch(`/api/stores/${connectionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paste }),
        });
        if (!stored.ok) {
          const problem = await stored.json();
          throw new Error(
            problem.error ?? 'The store was created but its credentials were not saved.',
          );
        }
      }

      await onDone(connectionId);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-5 flex flex-col gap-4 border-b border-border-subtle pb-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What is this store called?">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Suuqa Hodan"
            required
            maxLength={200}
          />
        </Field>

        <Field label="Where do you keep your books?" hint={guide.summary}>
          <select
            className={selectClass}
            value={source}
            onChange={(event) => setSource(event.target.value as Source)}
          >
            {(Object.keys(SOURCE_LABELS) as Source[]).map((value) => (
              <option key={value} value={value}>
                {SOURCE_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Report language">
          <select
            className={selectClass}
            value={language}
            onChange={(event) => setLanguage(event.target.value as SetupLanguage)}
          >
            <option value="en">English</option>
            <option value="so">Soomaali</option>
          </select>
        </Field>

        <Field
          label="Main currency"
          hint="Most Somali wholesale and retail pricing is in dollars, so that is the default."
        >
          <input
            className={inputClass}
            value={baseCurrency}
            onChange={(event) => setBaseCurrency(event.target.value)}
            maxLength={5}
          />
        </Field>

        <Field
          label="Shillings to the dollar (optional)"
          hint="Give a rate and every figure is shown in shillings beside the dollar one. The rate and the date you set it appear in the report."
        >
          <input
            className={inputClass}
            value={shillingRate}
            onChange={(event) => setShillingRate(event.target.value)}
            inputMode="decimal"
            placeholder="570"
          />
        </Field>
      </div>

      {needsCredentials(source) && (
        <>
          {/*
            One box, not four. A shopkeeper does not have a "client secret" —
            they have whatever their accountant emailed them, and the agent is
            better at reading that than they are at taking it apart.
          */}
          <Field
            label="Paste what you were sent"
            hint="A file, an email, a few lines — whatever form it came in. The agent works out which value is which and tells you if anything is still missing. Nothing is shown again once it is saved."
          >
            <textarea
              className={`${inputClass} min-h-32 font-mono text-xs`}
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              placeholder={
                source === 'odoo'
                  ? 'Address: https://mystore.odoo.com\nDatabase: mystore\nUser: api@mystore.so\nAPI key: ...'
                  : '{\n  "clientId": "...",\n  "clientSecret": "...",\n  "refreshToken": "...",\n  "realmId": "..."\n}'
              }
              spellCheck={false}
            />
          </Field>

          <SetupHelp source={source} language={language} />
        </>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      <div>
        <button type="submit" className={buttonClass()} disabled={busy || !name}>
          {busy ? 'Connecting…' : needsCredentials(source) ? 'Connect and test' : 'Connect'}
        </button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Where to get the credentials, and what to send the person who has them.
 *
 * The copy button is the feature. Most shop owners did not set up their own
 * QuickBooks or Odoo, so the useful thing is not a better form — it is a
 * message they can forward to their accountant that names the four values in
 * the words that accountant will recognise, and says what the tool does and
 * does not do with them.
 */
function SetupHelp({ source, language }: { source: Source; language: SetupLanguage }) {
  const guide = setupGuide(source, language);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(guide.request);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard access is refused in some embedded browsers. The text is on
      // screen and selectable either way, so this is not worth an error.
      setOpen(true);
    }
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-border bg-surface-2 p-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 text-left text-sm font-medium"
      >
        <span>{language === 'so' ? 'Ma haysatid furayaasha?' : 'Don’t have these?'}</span>
        <span className="text-xs text-subtle">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-3 text-sm">
          <ol className="ml-4 list-decimal space-y-1.5 text-muted">
            {guide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>

          <div>
            <p className="text-sm font-medium">
              {language === 'so' ? 'Weydii' : 'Ask'}: <span className="font-normal text-muted">{guide.askWho}</span>
            </p>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] border border-border bg-surface p-3 text-xs leading-relaxed text-muted">
              {guide.request}
            </pre>
            <button type="button" onClick={copy} className={`${secondaryButtonClass('sm')} mt-2`}>
              {copied
                ? language === 'so'
                  ? 'La koobiyeeyay'
                  : 'Copied'
                : language === 'so'
                  ? 'Koobi codsiga'
                  : 'Copy this request'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ScheduleRow({
  connectionId,
  schedules,
  onSaved,
}: {
  connectionId: string;
  schedules: Schedule[];
  onSaved: () => Promise<void>;
}) {
  const existing = schedules.find((schedule) => schedule.enabled);
  const [cadence, setCadence] = useState(existing?.cadence ?? 'weekly');
  const [format, setFormat] = useState(existing?.format ?? 'pdf');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/stores/${connectionId}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cadence, format, enabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not save that schedule');
      await onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 border-t border-border-subtle pt-5">
      <p className="mb-3 text-sm font-medium">Send me a report on a schedule</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <Field label="How often">
            <select className={selectClass} value={cadence} onChange={(e) => setCadence(e.target.value)}>
              {CADENCES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="w-36">
          <Field label="As">
            <select className={selectClass} value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="pdf">PDF</option>
              <option value="xlsx">Excel</option>
              <option value="docx">Word</option>
              <option value="md">Plain text</option>
            </select>
          </Field>
        </div>
        <button type="button" className={buttonClass('sm')} disabled={busy} onClick={() => save(true)}>
          {existing ? 'Update' : 'Turn on'}
        </button>
        {existing && (
          <button
            type="button"
            className={ghostButtonClass('sm')}
            disabled={busy}
            onClick={() => save(false)}
          >
            Turn off
          </button>
        )}
      </div>
      {existing && (
        <p className="mt-2 text-xs text-subtle">
          Next report {when(existing.next_run_at)}. It covers the last complete{' '}
          {existing.cadence.replace('ly', '')} — never a period that is still running.
        </p>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * What the agent made of what you pasted.
 *
 * Three things, in this order: whether it connected and to whose company, what
 * it understood from the file, and what is still missing. The middle one is
 * there because a shop owner who pasted the wrong half of an email needs to see
 * that we read `clientId` and `realmId` and nothing else — a bare "failed"
 * leaves them with no idea which line was wrong.
 *
 * Everything shown here comes off the job result verbatim. It holds key names,
 * masks and sentences and no credential material at all, which is a property of
 * how the worker builds it rather than of this component remembering to strip
 * anything.
 */
function ConnectionVerdict({ job }: { job: Job }) {
  const result = (job.result ?? {}) as Record<string, unknown>;
  const ok = result.ok === true;
  const language = result.language === 'so' ? 'so' : 'en';

  const message = String(
    (language === 'so' ? result.message_so : result.message) ?? result.message ?? '',
  );
  const nextStep = String(
    (language === 'so' ? result.next_step_so : result.next_step) ?? result.next_step ?? '',
  );
  const understood = (result.understood ?? {}) as Record<string, string>;
  const masked = (result.masked ?? {}) as Record<string, string>;
  const missingLabels = Array.isArray(result.missing_labels)
    ? (result.missing_labels as Array<{ role: string; en: string; so: string }>)
    : [];
  const evidence = (result.evidence ?? {}) as Record<string, unknown>;

  if (!message) return null;

  return (
    <Panel title={ok ? 'Connection checked' : 'Connection not ready yet'}>
      <div
        className={`rounded-[var(--radius-md)] border px-4 py-3 text-sm ${
          ok
            ? 'border-success/25 bg-success-soft text-success'
            : 'border-warning/25 bg-warning-soft text-warning'
        }`}
      >
        {message}
      </div>

      {nextStep && <p className="mt-3 text-sm text-muted">{nextStep}</p>}

      {Object.keys(understood).length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-sm font-medium">What the agent read</p>
          <ul className="flex flex-col gap-1.5 text-sm">
            {Object.entries(understood).map(([role, key]) => (
              <li
                key={role}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border bg-surface-2 px-3 py-2"
              >
                <span className="text-muted">
                  {role.replace(/_/g, ' ')} <span className="text-subtle">← {key}</span>
                </span>
                <span className="tabular text-xs text-subtle">{masked[role]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {missingLabels.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-sm font-medium">Still needed</p>
          <ul className="ml-4 list-disc space-y-1 text-sm text-muted">
            {missingLabels.map((field) => (
              <li key={field.role}>{language === 'so' ? field.so : field.en}</li>
            ))}
          </ul>
        </div>
      )}

      {Array.isArray(result.unresolved) && (result.unresolved as string[]).length > 0 && (
        <p className="mt-3 text-xs text-subtle">
          Not recognised: {(result.unresolved as string[]).join(', ')}. If one of these is a value
          the agent needs, rename it or paste it on its own line with a label.
        </p>
      )}

      {ok && Object.keys(evidence).length > 0 && (
        <dl className="mt-4 grid gap-2 sm:grid-cols-3">
          {Object.entries(evidence)
            .filter(([, value]) => value !== '' && value !== null && value !== false)
            .map(([key, value]) => (
              <div key={key} className="rounded-[var(--radius-md)] border border-border bg-surface-2 p-3">
                <dt className="text-xs text-subtle">{key.replace(/_/g, ' ')}</dt>
                <dd className="mt-1 text-sm font-medium">{String(value)}</dd>
              </div>
            ))}
        </dl>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The five figures, and the findings under them.
 *
 * Read straight off the job result rather than recomputed here. The agent
 * computed them from the shop's own rows and put its working in the document;
 * a second implementation in the browser would eventually disagree with it, and
 * the one on screen would be the one nobody could trace.
 */
function ReportCard({ job }: { job: Job }) {
  const result = job.result ?? {};
  const figures = (result.figures ?? {}) as Record<string, unknown>;
  const period = (figures.period ?? {}) as Record<string, unknown>;
  const currency = typeof figures.currency === 'string' ? figures.currency : 'USD';
  const insights = Array.isArray(figures.insights) ? figures.insights : [];
  const window = (result.window ?? {}) as Record<string, string>;

  if (!period.label) return null;

  const rows: Array<[string, string, string | null]> = [
    ['Sales', money(period.revenue, currency), null],
    ['Cost of goods sold', money(period.cogs, currency), null],
    ['Gross profit', money(period.gross_profit, currency), percent(period.gross_margin)],
    ['Running costs', money(period.expenses, currency), null],
    [
      typeof period.net_profit === 'number' && period.net_profit < 0 ? 'Net loss' : 'Net profit',
      money(period.net_profit, currency),
      percent(period.net_margin),
    ],
  ];

  return (
    <Panel
      title={`Report · ${String(period.label)}`}
      description={
        window.start ? `Covering ${window.start} to ${window.end}` : undefined
      }
      action={
        typeof result.report_path === 'string' ? (
          // By job id, not by path. The download route resolves the object from
          // the job row it has already authorised, so a storage key never
          // travels through a URL a browser could edit.
          <a className={secondaryButtonClass('sm')} href={`/api/exports?jobId=${job.id}`}>
            Download
          </a>
        ) : null
      }
    >
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {rows.map(([label, value, note]) => (
          <div key={label} className="rounded-[var(--radius-md)] border border-border bg-surface-2 p-3">
            <dt className="text-xs text-subtle">{label}</dt>
            <dd className="tabular mt-1 text-lg font-semibold">{value}</dd>
            {note && note !== '—' && <dd className="text-xs text-subtle">{note}</dd>}
          </div>
        ))}
      </dl>

      {insights.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {insights.map((raw, index) => {
            const insight = raw as { code?: string; severity?: string; detail?: string };
            const tone =
              insight.severity === 'alert'
                ? 'border-danger/25 bg-danger-soft text-danger'
                : insight.severity === 'good'
                  ? 'border-success/25 bg-success-soft text-success'
                  : 'border-warning/25 bg-warning-soft text-warning';
            return (
              <li key={`${insight.code}-${index}`} className={`rounded-[var(--radius-md)] border px-3 py-2 text-sm ${tone}`}>
                {insight.detail}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * What the agent has read, including the attempts that failed.
 *
 * A failed sync leaves a row on purpose. "Last week is missing" and "last
 * Tuesday's read failed" look identical from a dashboard that only shows
 * successes, and only one of them is something the shop can fix.
 */
function RunHistory({ runs, jobs }: { runs: SyncRun[]; jobs: Job[] }) {
  const active = jobs.filter((job) => job.status === 'queued' || job.status === 'running');

  return (
    <Panel title="What the agent has read" description="Newest first, including anything that failed.">
      {active.length > 0 && (
        <ul className="mb-4 flex flex-col gap-2">
          {active.map((job) => (
            <li key={job.id} className="flex items-center gap-2 text-sm text-muted">
              <StatusBadge status={job.status} />
              {job.kind === 'sync_store'
                ? 'Reading your store'
                : job.kind === 'test_store_connection'
                  ? 'Checking the connection'
                  : 'Working out your figures'}
            </li>
          ))}
        </ul>
      )}

      {runs.length === 0 ? (
        <p className="text-sm text-muted">Nothing read yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {runs.map((run) => (
            <li
              key={run.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-border bg-surface-2 px-4 py-2.5 text-sm"
            >
              <span className="flex items-center gap-2">
                <StatusBadge status={run.status} />
                <span className="text-muted">
                  {run.window_start} → {run.window_end}
                </span>
              </span>
              <span className="text-subtle">
                {run.status === 'failed'
                  ? (run.error ?? 'failed')
                  : `${run.entries_written ?? 0} record(s) · ${when(run.started_at)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
