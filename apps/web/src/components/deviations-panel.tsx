'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { formatMoney } from '@/lib/agent';
import type { Json } from '@/lib/database.types';
import {
  Badge,
  ErrorText,
  Fact,
  Money,
  buttonClass,
  inputClassSm,
  secondaryButtonClass,
} from '@/components/ui';

export type Deviation = {
  id: string;
  type: string;
  severity: string;
  title: string;
  detail: string | null;
  column_name: string | null;
  source_value: string | null;
  suggested_value: string | null;
  affected_rows: number;
  materiality_gbp: string | number | null;
  resolution: string;
  evidence: Json;
};

export type RecipeRun = {
  id: string;
  status: string;
  dataset_version_in: string;
  rows_processed: number | null;
  rows_matched: number | null;
  auto_corrections: number | null;
  automation_rate: string | number | null;
  invariant_status: string | null;
};

/**
 * Month two's review surface.
 *
 * The review queue handles month one: the agent proposes, the accountant
 * decides, and a version is written. This is the other half. A replay runs the
 * saved recipe against a new file and reports only what it could not handle --
 * and a run holding an unresolved `review` finding writes no output version at
 * all. Before this existed, that state was invisible: the job said "succeeded"
 * (it had; it finished and stopped to ask something), the dashboard showed
 * nothing, and the accountant had no way to learn that 186 rows were sitting
 * behind one question about one column.
 *
 * So the panel leads with what the replay *did* -- rows matched, corrections
 * applied, invariants passed -- before what it wants. A screen that opens with
 * a problem reads as a failure; this run was a success that needs one answer.
 *
 * Resolving does not resume anything on its own. The worker has no notion of a
 * suspended job: a run is a row, and a finished row stays finished. Replaying
 * again is therefore an explicit action, and saying so plainly is better than a
 * spinner that waits for something nobody queued.
 */

const SEVERITY_LABELS: Record<string, string> = {
  block: 'Blocks the run',
  review: 'Needs your decision',
  auto: 'Handled automatically',
};

const SEVERITY_TONE: Record<string, 'danger' | 'warning' | 'success'> = {
  block: 'danger',
  review: 'warning',
  auto: 'success',
};

const TYPE_LABELS: Record<string, string> = {
  unmapped_value: 'A value the recipe has never seen',
  ambiguous_match: 'Close to something known, not close enough to assume',
  new_column: 'The file grew a column',
  missing_column: 'The file lost a column a step needs',
  type_drift: 'A column changed what kind of thing it holds',
  invariant_failure: 'The run looks wrong in aggregate',
  step_failed: 'A step could not run',
};

export function DeviationsPanel({
  workspaceId,
  run,
  deviations,
}: {
  workspaceId: string;
  run: RecipeRun;
  deviations: Deviation[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});

  const pending = deviations.filter((deviation) => deviation.resolution === 'pending');
  const blocking = pending.filter((deviation) => deviation.severity === 'block');

  // Whether anything is actually being asked. The header used to read
  // "Replay paused — 0 questions" once the last one was answered: a warning
  // heading, styled as a problem, announcing the absence of a problem. A run
  // with nothing outstanding is not paused; it is waiting to be re-run.
  const answered = pending.length === 0;

  async function resolve(deviation: Deviation, resolution: string) {
    setBusy(deviation.id + resolution);
    setError(null);
    try {
      const response = await fetch('/api/agent/deviations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviationId: deviation.id,
          resolution,
          resolvedValue: resolution === 'mapped' ? (mapping[deviation.id] ?? '') : undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not record that decision');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not record that decision');
    } finally {
      setBusy(null);
    }
  }

  async function replayAgain() {
    setBusy('replay');
    setError(null);
    try {
      const response = await fetch('/api/agent/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          kind: 'replay_recipe',
          datasetVersionId: run.dataset_version_in,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not start the replay');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the replay');
    } finally {
      setBusy(null);
    }
  }

  const matched = run.rows_matched ?? 0;
  const processed = run.rows_processed ?? 0;

  return (
    <section
      className={`overflow-hidden rounded-[var(--radius-lg)] border bg-surface shadow-[var(--shadow-sm)] ${
        answered ? 'border-border' : 'border-warning/35'
      }`}
    >
      <div
        className={`border-b px-5 py-4 ${
          answered ? 'border-border bg-surface-2/50' : 'border-warning/20 bg-warning-soft/50'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold tracking-tight">
              {answered
                ? 'Replay ready to finish'
                : `Replay paused — ${pending.length} question${pending.length === 1 ? '' : 's'}`}
            </h2>
            <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted">
              {answered
                ? 'Every question this run raised has an answer recorded. Replaying now re-runs the saved recipe over the same file and writes a cleaned version.'
                : 'The saved recipe ran against this file and stopped before writing a cleaned version, because of the following. Nothing has been changed yet.'}
            </p>
          </div>

          {/* What the replay managed on its own, before what it wants. */}
          <div className="flex shrink-0 flex-wrap items-end gap-x-6 gap-y-3">
            <Fact label="Rows handled">
              <span className="tabular">
                {matched.toLocaleString('en-GB')}
                <span className="text-subtle"> / {processed.toLocaleString('en-GB')}</span>
              </span>
            </Fact>
            {run.auto_corrections ? (
              <Fact label="Corrected">
                <span className="tabular">{run.auto_corrections.toLocaleString('en-GB')}</span>
              </Fact>
            ) : null}
            {run.invariant_status ? (
              <Fact label="Checks">
                <span className="tabular">{run.invariant_status}</span>
              </Fact>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <div className="px-5 pt-4">
          <ErrorText>{error}</ErrorText>
        </div>
      ) : null}

      {pending.length > 0 ? (
        <ul className="divide-y divide-border-subtle">
          {pending.map((deviation) => (
            <li key={deviation.id} className="row-hover px-5 py-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
                <span className="text-[15px] font-medium leading-snug tracking-tight">
                  {deviation.title}
                </span>
                <Badge tone={SEVERITY_TONE[deviation.severity] ?? 'neutral'}>
                  {SEVERITY_LABELS[deviation.severity] ?? deviation.severity}
                </Badge>
              </div>

              <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted">
                {TYPE_LABELS[deviation.type] ?? deviation.type}
                {deviation.detail ? ` — ${deviation.detail}` : ''}
              </p>

              {(deviation.affected_rows > 0 ||
                deviation.materiality_gbp ||
                deviation.column_name) && (
                <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-3">
                  {deviation.materiality_gbp ? (
                    <Fact label="Affected">
                      <Money>{formatMoney(deviation.materiality_gbp)}</Money>
                    </Fact>
                  ) : null}
                  {deviation.affected_rows > 0 ? (
                    <Fact label="Rows">
                      <span className="tabular">
                        {deviation.affected_rows.toLocaleString('en-GB')}
                      </span>
                    </Fact>
                  ) : null}
                  {deviation.column_name ? (
                    <Fact label="Column">
                      <span className="font-mono text-[12px]">{deviation.column_name}</span>
                    </Fact>
                  ) : null}
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={buttonClass('sm')}
                  disabled={busy !== null}
                  onClick={() => resolve(deviation, 'accepted')}
                  title="This is fine as it is. The run may continue."
                >
                  {busy === deviation.id + 'accepted' ? 'Recording…' : 'Accept'}
                </button>
                <button
                  type="button"
                  className={secondaryButtonClass('sm')}
                  disabled={busy !== null}
                  onClick={() => resolve(deviation, 'rejected')}
                  title="This is wrong. Recorded against the run."
                >
                  Reject
                </button>
                <button
                  type="button"
                  className={secondaryButtonClass('sm')}
                  disabled={busy !== null}
                  onClick={() => resolve(deviation, 'ignored')}
                  title="A one-off. Do not learn anything from it."
                >
                  Ignore
                </button>
              </div>

              {/*
                Map is the resolution that teaches: it writes the value into the
                workspace's mapping table so next month's file resolves it with
                no question asked. It is only offered where there is a value to
                map -- the RPC refuses a deviation whose source_value is null,
                and a button that always fails is worse than no button.

                Given its own row rather than trailing the others inline. It is
                the answer with a consequence beyond this run, and as an inline
                run of "map ... to [input] [Map]" it wrapped into three pieces
                on anything narrower than a laptop.
              */}
              {deviation.source_value ? (
                <div className="mt-3 rounded-[var(--radius)] border border-border bg-surface-2/60 px-3.5 py-3">
                  <p className="text-[13px] text-muted">
                    Or teach the workspace: map{' '}
                    <span className="font-mono text-[12px] text-foreground">
                      “{deviation.source_value}”
                    </span>{' '}
                    to a canonical value and next month resolves it without asking.
                  </p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={mapping[deviation.id] ?? deviation.suggested_value ?? ''}
                      onChange={(event) =>
                        setMapping((current) => ({
                          ...current,
                          [deviation.id]: event.target.value,
                        }))
                      }
                      placeholder="canonical value"
                      aria-label={`Canonical value for ${deviation.source_value}`}
                      className={`${inputClassSm} w-56 flex-none`}
                    />
                    <button
                      type="button"
                      className={secondaryButtonClass('sm')}
                      disabled={
                        busy !== null ||
                        !(mapping[deviation.id] ?? deviation.suggested_value ?? '').trim()
                      }
                      onClick={() => resolve(deviation, 'mapped')}
                      title="Teaches the workspace, so next month resolves it silently"
                    >
                      {busy === deviation.id + 'mapped' ? 'Saving…' : 'Map'}
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div
        className={`flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4 ${
          pending.length > 0 ? 'border-t border-border' : ''
        }`}
      >
        {answered ? (
          <>
            {/* The header above already says every question has an answer, so
                this row is the action and the consequence, not a second
                announcement of the same fact. */}
            <p className="max-w-prose text-xs leading-relaxed text-subtle">
              Your answers are remembered, so the findings you resolved will not stop the run a
              second time.
            </p>
            <button
              type="button"
              className={`${buttonClass('sm')} ml-auto`}
              disabled={busy !== null}
              onClick={replayAgain}
            >
              {busy === 'replay' ? 'Starting…' : 'Replay again'}
            </button>
          </>
        ) : (
          <p className="text-xs leading-relaxed text-subtle">
            {blocking.length > 0
              ? 'A blocking finding has to be answered before the run can go anywhere.'
              : 'Answer these, then replay to finish the run and write a cleaned version.'}
          </p>
        )}
      </div>
    </section>
  );
}
