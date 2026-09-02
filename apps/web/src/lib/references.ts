import type { Operation } from '@/lib/history';

/**
 * The things in an answer that are also things in the workspace.
 *
 * The agent replies in prose. When that prose says `Transactions_August.xlsx`,
 * the workspace usually holds the categorisation that produced it, the result
 * figures behind it and a signed download waiting on `/api/exports`. Leaving
 * the name as plain text makes the reader carry the id in their head down to
 * the history list and find it again by eye.
 *
 * So this matches names the workspace can actually resolve, and only those.
 * There is no attempt to guess at intent, no linkifying of every capitalised
 * word, and no invented destinations: a reference is emitted only when there
 * is a real row behind it and a real place for the click to go. Anything the
 * agent mentions that this cannot resolve stays exactly as it was written.
 */

export type Reference =
  | {
      type: 'operation';
      /** The literal text to match, and what the chip reads. */
      label: string;
      jobId: string;
      /** "Categorisation", "Report" -- what the chip says it will open. */
      operationLabel: string;
      downloadable: boolean;
    }
  | {
      type: 'dataset';
      label: string;
      datasetId: string;
    };

/**
 * Short names are not references.
 *
 * A dataset called "Q1" would otherwise turn every "q1" in an answer into a
 * link, and a four-character floor costs nothing real -- files and datasets
 * that people name are longer than that.
 */
const MIN_LABEL_LENGTH = 4;

/**
 * Builds the resolvable names for one workspace.
 *
 * Operations first and newest first, so that when two runs share a source
 * filename -- which is exactly what happens when somebody re-uploads last
 * month's statement -- the name resolves to the most recent one. A stale link
 * to a superseded result is the failure this ordering exists to avoid.
 */
export function buildReferences(
  operations: Operation[],
  datasets: { id: string; name: string }[],
): Reference[] {
  const byLabel = new Map<string, Reference>();

  for (const operation of operations) {
    for (const candidate of [operation.source]) {
      if (!candidate || candidate.length < MIN_LABEL_LENGTH) continue;
      const key = candidate.toLowerCase();
      if (byLabel.has(key)) continue;
      byLabel.set(key, {
        type: 'operation',
        label: candidate,
        jobId: operation.id,
        operationLabel: operation.label,
        downloadable: operation.downloadable,
      });
    }
  }

  for (const dataset of datasets) {
    if (!dataset.name || dataset.name.length < MIN_LABEL_LENGTH) continue;
    const key = dataset.name.toLowerCase();
    // An operation's own source filename wins. It is the more specific thing
    // and it has somewhere better to go.
    if (byLabel.has(key)) continue;
    byLabel.set(key, { type: 'dataset', label: dataset.name, datasetId: dataset.id });
  }

  return [...byLabel.values()];
}

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'reference'; text: string; reference: Reference };

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Splits prose into plain text and the references inside it.
 *
 * Longest label first, so `Transactions_August.xlsx` is matched whole rather
 * than being eaten by a dataset called `Transactions`. The boundary check is
 * done by hand rather than with `\b` because a filename ends in `.xlsx` and
 * `\b` sits in the wrong place around a dot -- what actually matters is that
 * the match is not glued to a neighbouring letter or digit, which is what
 * would make `Ledger` match inside `LedgerBackup`.
 */
export function splitReferences(text: string, references: Reference[]): Segment[] {
  if (references.length === 0 || text === '') return [{ type: 'text', text }];

  const ordered = [...references].sort((a, b) => b.label.length - a.label.length);
  const byLabel = new Map(ordered.map((reference) => [reference.label.toLowerCase(), reference]));
  const pattern = new RegExp(ordered.map((r) => escapeForRegex(r.label)).join('|'), 'gi');

  const segments: Segment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;

    const before = start > 0 ? text[start - 1] : '';
    const after = end < text.length ? text[end] : '';
    const glued = /[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after);

    const reference = byLabel.get(match[0].toLowerCase());
    if (glued || !reference) continue;

    if (start > cursor) segments.push({ type: 'text', text: text.slice(cursor, start) });
    // The matched text is kept as written, not replaced with the stored label:
    // the agent's capitalisation is what the reader is looking at.
    segments.push({ type: 'reference', text: match[0], reference });
    cursor = end;
  }

  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) });

  return segments;
}

/** Where a reference points, within the workspace it came from. */
export function referenceHref(reference: Reference, workspaceId: string): string {
  const base = `/app/workspaces/${workspaceId}`;
  return reference.type === 'operation'
    ? `${base}?op=${reference.jobId}#operation-${reference.jobId}`
    : `${base}?dataset=${reference.datasetId}#history`;
}
