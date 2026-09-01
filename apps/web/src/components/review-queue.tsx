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
  ErrorText,
  Fact,
  Money,
  buttonClass,
  disclosureClass,
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
 *
 * The presentation earns its keep on the same grounds. The queue used to render
 * each proposal as a title over four lines of grey prose with the amount at
 * risk set at twelve pixels beside the column name -- so a £13m merge and a
 * whitespace trim were the same shape, and the axis the whole queue is sorted
 * on was the least visible thing in the row. Materiality now leads, in a
 * column that lines up down the list, and the decision controls sit under the
 * text on a narrow screen instead of crushing it into a ribbon.
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

  // Nothing left to decide. The heading used to promise a decision and then
  // show only an "N approved" footer, so a reviewer who had finished was told
  // they still owed an answer.
  const settled = pending.length === 0;

  return (
    <section>
      <header className="mb-4">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold tracking-tight">
              {settled ? 'Reviewed' : 'Needs your decision'}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              {settled
                ? 'Every proposal on this version has an answer recorded against it.'
                : 'DataEngine proposed these. Nothing changes until you approve it.'}
            </p>
          </div>

          {/* The two numbers that decide whether this is worth opening now.
              Set as figures rather than as a sentence, because the amount at
              risk is the reason the queue is ordered the way it is. */}
          {!settled && (
            <div className="flex shrink-0 items-center gap-5">
              <Fact label="To review">
                <span className="tabular font-semibold">{pending.length}</span>
              </Fact>
              {atStake > 0 && (
                <Fact label="Affected">
                  <Money size="lg">{formatMoney(atStake)}</Money>
                </Fact>
              )}
            </div>
          )}
        </div>
      </header>

      <ErrorText>{error}</ErrorText>

      {blocking.length > 0 ? (
        <div className="mb-5 overflow-hidden rounded-[var(--radius-lg)] border border-danger/30 bg-danger-soft/40">
          <div className="border-b border-danger/20 px-5 py-3">
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-danger">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-danger" />
              Blocks the run — resolve before applying anything
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              A blocking finding carries no change to apply; it is a question. Either answer
              clears the block and both are recorded in the audit log — the difference is what
              you are on record as having decided.
            </p>
          </div>
          <ul className="divide-y divide-danger/15">
            {blocking.map((change) => (
              <ChangeRow key={change.id} change={change} busy={busy} onDecide={decide} />
            ))}
          </ul>
        </div>
      ) : null}

      {reviewable.length > 0 ? (
        <>
          <ul className="divide-y divide-border-subtle overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-sm)]">
            {reviewable.map((change) => (
              <ChangeRow key={change.id} change={change} busy={busy} onDecide={decide} />
            ))}
          </ul>

          {reviewable.length > 1 ? (
            // Bulk approval used to be a 12px ghost link floating under the
            // list with no container -- the least prominent control on the
            // screen doing the widest-reaching thing on it. It now sits in a
            // bar that says what it covers and what it excludes.
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-lg)] border border-border bg-surface-2/60 px-4 py-3">
              <p className="text-[13px] text-muted">
                Approving in bulk records the same decision against each of these{' '}
                <span className="tabular font-medium text-foreground">{reviewable.length}</span>{' '}
                proposals.
                {blocking.length > 0 ? ' Blocking findings are not included.' : ''}
              </p>
              <button
                type="button"
                className={`${ghostButtonClass()} ml-auto`}
                disabled={busy !== null}
                onClick={() => decide(reviewable.map((change) => change.group_key), true)}
              >
                {busy === reviewable.map((c) => c.group_key).join(',') + 'true'
                  ? 'Recording…'
                  : `Approve all ${reviewable.length}`}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {approved.length > 0 ? (
        <div
          className={`${
            reviewable.length > 0 || blocking.length > 0 ? 'mt-5' : ''
          } rounded-[var(--radius-lg)] border border-border bg-surface px-5 py-4 shadow-[var(--shadow-sm)]`}
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <p className="text-sm">
              {approvedTransforms.length > 0 ? (
                <>
                  <span className="tabular font-medium">{approvedTransforms.length}</span> change
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
                  <span className="tabular font-medium">{approvedAdvisories.length}</span> review
                  item{approvedAdvisories.length === 1 ? '' : 's'} acknowledged.
                </>
              )}
            </p>
            <button
              type="button"
              className={`${buttonClass('sm')} ml-auto`}
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
          </div>

          <p className="mt-3 border-t border-border-subtle pt-3 text-xs leading-relaxed text-subtle">
            {blocking.length > 0 ? (
              <span className="text-danger">
                The blocking issue above has to be approved or rejected first.
              </span>
            ) : approvedTransforms.length === 0 ? (
              // Without this the reviewer approves a review item, presses apply,
              // and gets a run that changes nothing -- which reads as a failure
              // rather than as the correct outcome.
              <>
                Review items record that you have seen a finding. They do not change the data, so
                there is nothing to apply and no new version is written. The finding stays visible
                on this version.
              </>
            ) : (
              <>
                Nothing is overwritten. Applying writes a new dataset version whose parent is this
                one, so the current figures stay available.
              </>
            )}
          </p>
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
  const blocking = change.confidence === 'low';
  const deciding = busy?.startsWith(change.group_key) ?? false;

  return (
    <li className="group px-5 py-4 transition-colors hover:bg-surface">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${
              blocking 
                ? 'bg-danger-soft text-danger border border-danger/30' 
                : 'bg-accent-soft text-accent border border-accent/30'
            }`}>
              {CONFIDENCE_LABELS[change.confidence]}
            </span>
            {change.column_name ? (
              <span className="font-mono text-xs text-muted bg-background px-2 py-0.5 rounded border border-border">
                col: {change.column_name}
              </span>
            ) : null}
          </div>

          <p className="font-heading text-base font-bold text-foreground leading-snug">
            {change.title}
          </p>

          <p className="mt-1.5 max-w-prose text-sm text-muted leading-relaxed">
            {change.rationale}
          </p>

          <div className="mt-3.5 flex flex-wrap items-center gap-6 text-xs text-muted">
            {money !== '—' ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Impact:</span>
                <span className="font-mono text-sm font-extrabold text-accent">{money}</span>
              </div>
            ) : null}

            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Rows:</span>
              <span className="font-mono font-medium text-foreground">{change.affected_rows.toLocaleString('en-GB')}</span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2.5 lg:pt-0.5">
          <button
            type="button"
            className={`${secondaryButtonClass('sm')} cursor-pointer`}
            disabled={busy !== null}
            onClick={() => onDecide([change.group_key], false)}
          >
            {blocking ? 'Not an issue' : 'Reject'}
          </button>
          <button
            type="button"
            className={`${buttonClass('sm')} cursor-pointer`}
            disabled={busy !== null}
            onClick={() => onDecide([change.group_key], true)}
          >
            {deciding ? 'Recording…' : blocking ? 'Reviewed, continue' : 'Approve'}
          </button>
        </div>
      </div>

      {hasEvidence(change.evidence) ? (
        <div className="mt-3.5 pt-2 border-t border-border/40">
          <button
            type="button"
            className={`${disclosureClass} cursor-pointer`}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <span className={`inline-block transition-transform duration-200 ${open ? 'rotate-90' : ''}`}>
              ›
            </span>
            {open ? 'Hide Audit Evidence' : 'Inspect Raw Evidence Payload'}
          </button>
          {open ? (
            <pre className="mt-2.5 max-h-64 overflow-auto rounded-[var(--radius)] border border-border bg-background p-4 font-mono text-[11px] leading-relaxed text-muted">
              {JSON.stringify(change.evidence, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

