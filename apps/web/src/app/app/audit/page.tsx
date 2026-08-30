import { EmptyState, PageHeader, TableShell, Td, Th } from '@/components/ui';
import { requireCurrentOrg } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

export const metadata = { title: 'Activity · DataEngine' };

/**
 * The audit trail required by section 13. Append-only in the database, so what
 * is shown here is what happened -- there is no code path, including this
 * application's own, that can rewrite it.
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
      .limit(200),
    supabase.from('workspaces').select('id, name').eq('org_id', org.id),
  ]);

  if (error) throw new Error(`Could not load the audit log: ${error.message}`);

  const workspaceNames = new Map((workspaces ?? []).map((w) => [w.id, w.name]));

  return (
    <>
      <PageHeader
        eyebrow="System"
        title="Activity"
        subtitle="Every action, in order, with who did it and when. Entries cannot be edited or deleted."
      />

      {!entries || entries.length === 0 ? (
        <EmptyState
          title="No activity yet"
          body="Every upload, job and approval is recorded here the moment it happens, and nothing in this application can edit or remove an entry."
        />
      ) : (
        <TableShell>
          <thead className="border-b border-border bg-surface-2">
              <tr>
                <Th>When</Th>
                <Th>Action</Th>
                <Th>Workspace</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <Td className="whitespace-nowrap text-subtle tabular">
                    {new Date(entry.created_at).toLocaleString('en-GB')}
                  </Td>
                  <Td className="whitespace-nowrap font-medium">{entry.action}</Td>
                  <Td className="text-muted">
                    {entry.workspace_id ? workspaceNames.get(entry.workspace_id) ?? '—' : '—'}
                  </Td>
                  <Td>
                    <code className="break-all font-mono text-xs text-subtle">
                      {summarise(entry.metadata)}
                    </code>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
      )}
    </>
  );
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
