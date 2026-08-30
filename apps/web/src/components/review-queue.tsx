'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  type ChangeConfidence,
  CONFIDENCE_LABELS,
  CONFIDENCE_ORDER,
  formatMoney,
  isAdvisory,
} from '@/lib/agent';
import type { Json } from '@/lib/database.types';
import {
  Badge,
  ErrorText,
  buttonClass,
  ghostButtonClass,
  secondaryButtonClass,
} from '@/components/ui';

export type ProposedChange = {
  id: string;
  group_key: string;
  step_type: string;
  column_name: string | null;
  title: string;
  rationale: string;
  confidence: ChangeConfidence;
  affected_rows: number;
  materiality_gbp: string | number | null;
  status: string;
  evidence: Json;
};

/**
 * The review queue (PRD section 5.2).
 *
 * Three rules from the spec are visible in this component, and each one is
 * there because the obvious alternative fails.
 *
 * **Ranked by money, not by row count.** One £40,000 unmatched transaction
 * outranks 200 whitespace fixes. The server orders by materiality; this only
 * has to not undo it.
 *
 * **Grouped.** One decision covers however many rows it covers. "Normalise 312
 * dates" is one row here with the detail behind a disclosure, not 312 rows.
 *
 * **Blocking items cannot be scrolled past.** A totals mismatch is rendered
 * first and separately, and the apply button stays disabled while one is still
 * pending. Section 5.3 calls this the difference between an automation tool and
 * a liability, and it is not something to leave to the reader's diligence.
 */
export function ReviewQueue({
  workspaceId,
  datasetVersionId,
  changes,
}: {
  workspaceId: string;
  datasetVersionId: string;
  changes: ProposedChange[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-sorted here rather than trusted from the server. The tier ordering is
  // the one thing in this component that must not silently depend on how the
  // Postgres enum happens to be declared.
  const ordered = [...changes].sort((a, b) => {
    const tier =
      CONFIDENCE_ORDER.indexOf(a.confidence) - CONFIDENCE_ORDER.indexOf(b.confidence);
    if (tier !== 0) return tier;
    return Math.abs(Number(b.materiality_gbp ?? 0)) - Math.abs(Number(a.materiality_gbp ?? 0));
  });

  const pending = ordered.filter((change) => change.status === 'pending');
  const approved = ordered.filter((change) => change.status === 'approved');
  // Split the approved set the way apply_cleaning does: an advisory moves no
  // data, so a set with none of the former has nothing to apply.
  const approvedTransforms = approved.filter((change) => !isAdvisory(change.step_type));
  const approvedAdvisories = approved.filter((change) => isAdvisory(change.step_type));
  const blocking = pending.filter((change) => change.confidence === 'low');
  const reviewable = pending.filter((change) => change.confidence !== 'low');

  async function decide(groupKeys: string[], approve: boolean) {
    setBusy(groupKeys.join(',') + String(approve));
    setError(null);
    try {
      const response = await fetch('/api/agent/changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetVersionId, groupKeys, approve }),
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

  async function apply() {
    setBusy('apply');
    setError(null);
    try {
      const response = await fetch('/api/agent/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          kind: 'apply_cleaning',
          datasetVersionId,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not start the run');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the run');
    } finally {
      setBusy(null);
    }
  }

  if (changes.length === 0) return null;

  const atStake = pending.reduce(
    (total, change) => total + Math.abs(Number(change.materiality_gbp ?? 0)),
    0,
  );

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Needs your decision</h2>
          <p className="mt-0.5 text-sm text-muted">
            DataEngine proposed these. Nothing changes until you approve it.
          </p>
        </div>
        {pending.length > 0 ? (
          <p className="text-sm text-muted">
            <span className="tabular font-medium text-foreground">{pending.length}</span> to
            review
            {atStake > 0 ? (
              <>
                {' · '}
                <span className="tabular font-medium text-foreground">
                  {formatMoney(atStake)}
                </span>{' '}
                affected
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      <ErrorText>{error}</ErrorText>

      {blocking.length > 0 ? (
        <div className="mb-4 overflow-hidden rounded-[var(--radius-lg)] border border-danger/30 bg-danger-soft/40">
          <p className="flex items-center gap-2 border-b border-danger/20 px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-danger">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-danger" />
            Blocks the run — resolve before applying anything
          </p>
          <p className="px-4 pt-3 text-sm text-muted">
            A blocking finding carries no change to apply; it is a question. Either answer
            clears the block and both are recorded in the audit log — the difference is what
            you are on record as having decided.
          </p>
          <ul className="mt-2 divide-y divide-danger/15">
            {blocking.map((change) => (
              <ChangeRow
                key={change.id}
                change={change}
                busy={busy}
                onDecide={decide}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {reviewable.length > 0 ? (
        <ul className="divide-y divide-border overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface">
          {reviewable.map((change) => (
            <ChangeRow key={change.id} change={change} busy={busy} onDecide={decide} />
          ))}
        </ul>
      ) : null}

      {reviewable.length > 1 ? (
        <button
          type="button"
          className={`${ghostButtonClass} mt-2 text-xs`}
          disabled={busy !== null}
          onClick={() => decide(reviewable.map((change) => change.group_key), true)}
        >
          Approve all {reviewable.length} reviewable changes
        </button>
      ) : null}

      {approved.length > 0 ? (
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3.5">
          <p className="text-sm">
            {approvedTransforms.length > 0 ? (
              <>
                {approvedTransforms.length} change
                {approvedTransforms.length === 1 ? '' : 's'} approved and ready to apply
                {approvedAdvisories.length > 0
                  ? `, plus ${approvedAdvisories.length} review item${
                      approvedAdvisories.length === 1 ? '' : 's'
                    }`
                  : ''}
                .
              </>
            ) : (
              <>
                {approvedAdvisories.length} review item
                {approvedAdvisories.length === 1 ? '' : 's'} acknowledged.
              </>
            )}
          </p>
          <button
            type="button"
            className={`${buttonClass} ml-auto px-3 py-1.5 text-xs`}
            disabled={busy !== null || blocking.length > 0 || approvedTransforms.length === 0}
            onClick={apply}
            title={
              blocking.length > 0
                ? 'A blocking issue is still unresolved'
                : approvedTransforms.length === 0
                  ? 'Review items record a decision; they do not change the data'
                  : 'Writes a new version; the current one is left untouched'
            }
          >
            {busy === 'apply' ? 'Starting…' : 'Apply and create a new version'}
          </button>
          {blocking.length > 0 ? (
            <p className="w-full text-xs text-red-700 dark:text-red-300">
              The blocking issue above has to be approved or rejected first.
            </p>
          ) : approvedTransforms.length === 0 ? (
            // Without this the reviewer approves a review item, presses apply,
            // and gets a run that changes nothing -- which reads as a failure
            // rather than as the correct outcome.
            <p className="w-full text-xs text-subtle">
              Review items record that you have seen a finding. They do not change the data,
              so there is nothing to apply and no new version is written. The finding stays
              visible on this version.
            </p>
          ) : (
            <p className="w-full text-xs text-subtle">
              Nothing is overwritten. Applying writes a new dataset version whose parent is
              this one, so the current figures stay available.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function hasEvidence(evidence: Json): boolean {
  return (
    !!evidence &&
    typeof evidence === 'object' &&
    !Array.isArray(evidence) &&
    Object.keys(evidence).length > 0
  );
}

function ChangeRow({
  change,
  busy,
  onDecide,
}: {
  change: ProposedChange;
  busy: string | null;
  onDecide: (groupKeys: string[], approve: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const money = formatMoney(change.materiality_gbp);
  // A blocking finding has no operation behind it -- "Approve" and "Reject"
  // both simply clear the block, so labelling them that way asks the reader to
  // approve something that does not exist.
  const blocking = change.confidence === 'low';

  return (
    <li className="px-4 py-4 transition-colors hover:bg-surface-2/60">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          {/* The recommendation. What DataEngine proposes, in the words the
              rule engine chose -- first and largest, because it is the thing
              being decided. */}
          <p className="font-medium tracking-tight">{change.title}</p>

          {/* Why. Full contrast rather than dimmed: this is the reasoning an
              accountant is being asked to accept, and reasoning printed at
              70% opacity reads as small print. */}
          <p className="mt-1 text-sm leading-relaxed text-muted">{change.rationale}</p>

          {/* Impact. A metric strip rather than a sentence, so the numbers can
              be compared down the column without being read. */}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            <Badge tone={blocking ? 'danger' : 'neutral'}>
              {CONFIDENCE_LABELS[change.confidence]}
            </Badge>
            <span className="text-subtle">
              <span className="tabular font-medium text-muted">{change.affected_rows}</span> row
              {change.affected_rows === 1 ? '' : 's'}
            </span>
            {money !== '—' ? (
              <span className="text-subtle">
                <span className="tabular font-medium text-muted">{money}</span> affected
              </span>
            ) : null}
            {change.column_name ? (
              <span className="font-mono text-[11px] text-subtle">{change.column_name}</span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className={`${secondaryButtonClass} px-3 py-1.5 text-xs`}
            disabled={busy !== null}
            onClick={() => onDecide([change.group_key], false)}
            title={
              blocking
                ? 'Records that you do not accept this finding, and clears the block'
                : 'Leave the data as it is'
            }
          >
            {blocking ? 'Not an issue' : 'Reject'}
          </button>
          <button
            type="button"
            className={`${buttonClass} px-3 py-1.5 text-xs`}
            disabled={busy !== null}
            onClick={() => onDecide([change.group_key], true)}
            title={
              blocking
                ? 'Records that you have investigated and accepted this, and clears the block'
                : 'Apply this change when the run goes ahead'
            }
          >
            {blocking ? 'Reviewed, continue' : 'Approve'}
          </button>
        </div>
      </div>

      {hasEvidence(change.evidence) ? (
        <div className="mt-3">
          <button
            type="button"
            className="text-xs font-medium text-accent transition-opacity hover:opacity-70"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Hide evidence' : 'Show evidence'}
          </button>
          {open ? (
            // Raw evidence, deliberately. Section 7's promise is that a number
            // can be traced, and a curated summary of the evidence is the thing
            // the accountant would have to take on trust.
            <pre className="mt-2 max-h-64 overflow-auto rounded-[var(--radius)] border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-muted">
              {JSON.stringify(change.evidence, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
