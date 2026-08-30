'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { formatMoney } from '@/lib/agent';
import type { Json } from '@/lib/database.types';
import { ErrorText, buttonClass, secondaryButtonClass } from '@/components/ui';

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

  return (
    <section className="overflow-hidden rounded-[var(--radius-lg)] border border-warning/30 bg-warning-soft/40">
      <div className="border-b border-warning/20 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
          Replay paused — {pending.length} question{pending.length === 1 ? '' : 's'}
        </h2>
        <p className="mt-1 text-xs text-muted">
          The saved recipe ran against this file and handled{' '}
          {run.rows_matched ?? 0} of {run.rows_processed ?? 0} rows on its own
          {run.auto_corrections ? `, correcting ${run.auto_corrections}` : ''}
          {run.invariant_status ? ` · checks ${run.invariant_status}` : ''}. It stopped before
          writing a cleaned version because of the following. Nothing has been changed yet.
        </p>
      </div>

      <div className="px-4 pt-3">
        <ErrorText>{error}</ErrorText>
      </div>

      <ul className="divide-y divide-warning/15">
        {pending.map((deviation) => (
          <li key={deviation.id} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm font-medium">{deviation.title}</span>
              <span className="rounded bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
                {SEVERITY_LABELS[deviation.severity] ?? deviation.severity}
              </span>
              {deviation.affected_rows > 0 ? (
                <span className="text-xs text-subtle">{deviation.affected_rows} rows</span>
              ) : null}
              {deviation.materiality_gbp ? (
                <span className="text-xs text-subtle">
                  {formatMoney(deviation.materiality_gbp)}
                </span>
              ) : null}
            </div>

            <p className="mt-1 text-xs text-muted">
              {TYPE_LABELS[deviation.type] ?? deviation.type}
              {deviation.column_name ? ` · ${deviation.column_name}` : ''}
            </p>

            {deviation.detail ? (
              <p className="mt-1 text-xs text-muted">{deviation.detail}</p>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={`${buttonClass} px-2.5 py-1 text-xs`}
                disabled={busy !== null}
                onClick={() => resolve(deviation, 'accepted')}
                title="This is fine as it is. The run may continue."
              >
                {busy === deviation.id + 'accepted' ? '…' : 'Accept'}
              </button>
              <button
                type="button"
                className={`${secondaryButtonClass} px-2.5 py-1 text-xs`}
                disabled={busy !== null}
                onClick={() => resolve(deviation, 'rejected')}
                title="This is wrong. Recorded against the run."
              >
                Reject
              </button>
              <button
                type="button"
                className={`${secondaryButtonClass} px-2.5 py-1 text-xs`}
                disabled={busy !== null}
                onClick={() => resolve(deviation, 'ignored')}
                title="A one-off. Do not learn anything from it."
              >
                Ignore
              </button>

              {/*
                Map is the resolution that teaches: it writes the value into the
                workspace's mapping table so next month's file resolves it with
                no question asked. It is only offered where there is a value to
                map -- the RPC refuses a deviation whose source_value is null,
                and a button that always fails is worse than no button.
              */}
              {deviation.source_value ? (
                <span className="inline-flex items-center gap-1">
                  <span className="text-xs text-subtle">map “{deviation.source_value}” to</span>
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
                    className="w-40 rounded border border-border px-2 py-1 text-xs  dark:bg-transparent"
                  />
                  <button
                    type="button"
                    className={`${secondaryButtonClass} px-2.5 py-1 text-xs`}
                    disabled={
                      busy !== null ||
                      !(mapping[deviation.id] ?? deviation.suggested_value ?? '').trim()
                    }
                    onClick={() => resolve(deviation, 'mapped')}
                    title="Teaches the workspace, so next month resolves it silently"
                  >
                    Map
                  </button>
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3 border-t border-warning/20 px-4 py-3">
        {pending.length === 0 ? (
          <>
            <p className="text-sm">All questions answered.</p>
            <button
              type="button"
              className={`${buttonClass} ml-auto px-3 py-1.5 text-xs`}
              disabled={busy !== null}
              onClick={replayAgain}
            >
              {busy === 'replay' ? 'Starting…' : 'Replay again'}
            </button>
            <p className="w-full text-xs text-subtle">
              Replaying re-runs the recipe over the same file. Your answers are remembered, so
              the findings you resolved will not stop it a second time, and a cleaned version is
              written.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted">
            {blocking.length > 0
              ? 'A blocking finding has to be answered before the run can go anywhere.'
              : 'Answer these, then replay to finish the run and write a cleaned version.'}
          </p>
        )}
      </div>
    </section>
  );
}
