import { EmptyState, PageHeader, TableShell, Td, Th, tableBodyClass } from '@/components/ui';
import { requireCurrentOrg } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

export const metadata = { title: 'Activity · DataEngine' };

const LIMIT = 200;

/**
 * The audit trail required by section 13. Append-only in the database, so what
 * is shown here is what happened -- there is no code path, including this
 * application's own, that can rewrite it.
 *
 * Two hundred rows is a long table, and it was being rendered as one: every row
 * repeated the full date, the workspace name wrapped inside a squeezed column
 * so each row stood a hundred pixels tall, and the header scrolled away after
 * the first screen of a page twenty-two thousand pixels long. The content is
 * unchanged; what changed is that it can now be read.
 */
export default async function AuditPage() {
  const { org } = await requireCurrentOrg();
  const supabase = await createServerSupabase();

  const [{ data: entries, error }, { data: workspaces }] = await Promise.all([
    supabase
      .from('audit_logs')
      .select('id, action, entity_type, entity_id, workspace_id, actor_user_id, metadata, created_at')
      .eq('org_id', org.id)
      .order('created_at', { ascending: false })
      .limit(LIMIT),
    supabase.from('workspaces').select('id, name').eq('org_id', org.id),
  ]);

  if (error) throw new Error(`Could not load the audit log: ${error.message}`);

  const workspaceNames = new Map((workspaces ?? []).map((w) => [w.id, w.name]));
  const rows = entries ?? [];

  return (
    <>
      <PageHeader
        eyebrow="System"
        title="Activity"
        subtitle="Every action, in order, with who did it and when. Entries cannot be edited or deleted."
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No activity yet"
          body="Every upload, job and approval is recorded here the moment it happens, and nothing in this application can edit or remove an entry."
        />
      ) : (
        <>
          <p className="mb-3 text-[13px] text-subtle">
            Showing the{' '}
            <span className="tabular font-medium text-muted">{rows.length}</span> most recent
            {rows.length === LIMIT ? ' of this organisation’s entries' : ' entries'}, newest
            first.
          </p>

          <TableShell stickyHead minWidth="46rem">
            <thead>
              <tr>
                <Th className="w-[8.5rem]">When</Th>
                <Th className="w-[15rem]">Action</Th>
                <Th className="w-[11rem]">Workspace</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody className={tableBodyClass}>
              {rows.map((entry, i) => {
                const at = new Date(entry.created_at);
                // The date is printed only where it changes. Two hundred rows
                // from the same afternoon repeated "30/08/2026," two hundred
                // times, which is two hundred lines of noise in the column the
                // eye scans first.
                const previous = i > 0 ? new Date(rows[i - 1].created_at) : null;
                const newDay =
                  !previous || previous.toDateString() !== at.toDateString();

                return (
                  <tr key={entry.id}>
                    <Td className="whitespace-nowrap tabular">
                      {newDay && (
                        <span className="mr-2 font-medium">
                          {at.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                        </span>
                      )}
                      <span className={newDay ? 'text-subtle' : 'text-muted'}>
                        {at.toLocaleTimeString('en-GB', {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <span className="font-medium">{describeAction(entry.action)}</span>
                    </Td>
                    <Td className="text-muted">
                      <span className="block truncate" title={
                        entry.workspace_id
                          ? (workspaceNames.get(entry.workspace_id) ?? undefined)
                          : undefined
                      }>
                        {entry.workspace_id
                          ? (workspaceNames.get(entry.workspace_id) ?? '—')
                          : '—'}
                      </span>
                    </Td>
                    <Td>
                      <code className="font-mono text-[11px] leading-relaxed text-subtle">
                        {summarise(entry.metadata)}
                      </code>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        </>
      )}
    </>
  );
}

/**
 * The action, in words rather than in dots.
 *
 * `agent.changes.proposed` is the name of an event in a database column, and
 * an accountant reading their own audit trail should not have to parse one.
 * Anything not in this map falls back to the raw string with the separators
 * softened, so a new event type is legible on the day it ships rather than on
 * the day somebody remembers to add it here.
 */
const ACTION_LABELS: Record<string, string> = {
  'organization.created': 'Organisation created',
  'workspace.created': 'Workspace created',
  'dataset.created': 'Dataset created',
  'dataset.version.created': 'Version written',

  'upload.signed': 'Upload started',
  'upload.stored': 'File stored',
  'upload.completed': 'File stored',
  'upload.failed': 'Upload failed',

  'agent.job.enqueued': 'Job queued',
  'agent.job.claimed': 'Job started',
  'agent.job.succeeded': 'Job finished',
  'agent.job.failed': 'Job failed',
  'agent.job.retried': 'Job retried',
  'agent.job.retrying': 'Job retrying',
  'agent.job.cancelled': 'Job cancelled',
  'agent.analysis.ran': 'Analysis ran',

  'agent.changes.proposed': 'Changes proposed',
  'agent.changes.approved': 'Changes approved',
  'agent.changes.rejected': 'Changes rejected',
  'agent.deviation.resolved': 'Deviation resolved',
  'deviation.resolved': 'Deviation resolved',

  'recipe.created': 'Recipe saved',
  'recipe.version.created': 'Recipe version saved',
  'recipe.version.edited': 'Recipe version edited',

  'export.signed': 'Export downloaded',
  'hermes.ask': 'Question asked',
  'hermes.chat': 'Question asked',
};

/**
 * A replay's outcome is written as `recipe.run.<status>`, so the statuses
 * cannot all be enumerated above without this page having to be edited every
 * time the worker gains one.
 */
const RUN_STATUS_LABELS: Record<string, string> = {
  started: 'Replay started',
  succeeded: 'Replay finished',
  needs_review: 'Replay stopped for review',
  blocked: 'Replay blocked',
  failed: 'Replay failed',
};

function describeAction(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;

  if (action.startsWith('recipe.run.')) {
    const status = action.slice('recipe.run.'.length);
    return RUN_STATUS_LABELS[status] ?? `Replay ${status.replace(/_/g, ' ')}`;
  }

  // Anything genuinely new stays legible on the day it ships rather than on
  // the day somebody remembers to add it here.
  return action.replace(/\./g, ' · ').replace(/_/g, ' ');
}

/**
 * Metadata is free-form jsonb; show the fields a human actually scans for.
 *
 * A whitelist rather than a dump. Some of these payloads carry the whole
 * evidence tree behind a proposal, and a log line that wraps over six rows is
 * one nobody reads — which defeats the point of having a log.
 */
const INTERESTING_KEYS = [
  // Week 1: organizations, workspaces, uploads.
  'name',
  'original_filename',
  'client_name',
  'slug',
  'byte_size',
  'reason',
  // The agent.
  'kind',
  'version_no',
  'row_count',
  'count',
  'attempt',
  'worker',
  'group_keys',
  'model',
  'question',
  'error',
];

function summarise(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object') return '—';

  const record = metadata as Record<string, unknown>;

  const parts = INTERESTING_KEYS.filter(
    (key) => record[key] !== undefined && record[key] !== null,
  ).map((key) => {
    const value = record[key];
    // An approval can cover a dozen groups. The count is what is scannable;
    // the group names are in the proposals themselves.
    if (Array.isArray(value)) {
      return value.length <= 3
        ? `${key}=${value.join(',')}`
        : `${key}=${value.length} groups`;
    }
    return `${key}=${String(value)}`;
  });

  return parts.length > 0 ? parts.join('  ') : '—';
}
