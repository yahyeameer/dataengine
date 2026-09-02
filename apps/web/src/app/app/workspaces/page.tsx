import { CreateWorkspaceForm } from '@/components/create-workspace-form';
import { EmptyState, PageHeader, Stat } from '@/components/ui';
import { WorkspaceIndex, type WorkspaceRow } from '@/components/workspace-index';
import { requireCurrentOrg } from '@/lib/authz';
import {
  HISTORY_KINDS,
  OPERATION_FAMILY,
  OPERATION_LABELS,
  isHistoryKind,
  type OperationFamily,
} from '@/lib/history';
import { createServerSupabase } from '@/lib/supabase/server';

export const metadata = { title: 'Workspaces · DataEngine' };

/**
 * Every client, and what each one is waiting on.
 *
 * It answers one question — what is happening with my data — and it answers it
 * with counts that come from real rows. There are no invented metrics here: if
 * a workspace has no datasets it says so rather than showing a zero-value chart
 * to fill the space.
 *
 * Four queries for the whole list, not one per workspace. A practice with forty
 * clients would otherwise pay forty round trips to render a directory.
 */
export default async function WorkspacesPage() {
  const { org, role } = await requireCurrentOrg();
  const supabase = await createServerSupabase();

  // RLS scopes all of these to the caller's organizations; the explicit org
  // filter is the server-side half of the same check (section 13).
  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id, name, client_name, status, created_at')
    .eq('org_id', org.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Could not load workspaces: ${error.message}`);

  const ids = workspaces.map((w) => w.id);

  const [{ data: datasets }, { data: activeJobs }, { data: openChanges }, { data: history }] =
    await Promise.all([
      ids.length
        ? supabase.from('datasets').select('id, workspace_id').in('workspace_id', ids)
        : Promise.resolve({ data: [] as { id: string; workspace_id: string }[] }),
      ids.length
        ? supabase
            .from('agent_jobs')
            .select('id, workspace_id, status')
            .in('workspace_id', ids)
            .in('status', ['queued', 'running'])
        : Promise.resolve({ data: [] as { id: string; workspace_id: string; status: string }[] }),
      ids.length
        ? supabase
            .from('proposed_changes')
            .select('id, workspace_id, materiality_gbp')
            .in('workspace_id', ids)
            .eq('status', 'pending')
        : Promise.resolve(
            { data: [] as { id: string; workspace_id: string; materiality_gbp: number | null }[] },
          ),
      // What each workspace has actually been used for. The directory used to
      // say only that a workspace existed and how many datasets were in it,
      // which is true of an empty workspace and a workspace holding a year of
      // month-ends. Reading the finished operations tells the reader which one
      // they are looking at before they open it.
      ids.length
        ? supabase
            .from('agent_jobs')
            .select('workspace_id, kind, created_at')
            .in('workspace_id', ids)
            .in('kind', HISTORY_KINDS)
            .eq('status', 'succeeded')
            .order('created_at', { ascending: false })
            .limit(500)
        : Promise.resolve(
            { data: [] as { workspace_id: string; kind: string; created_at: string }[] },
          ),
    ]);

  const datasetCount = tally(datasets ?? [], (d) => d.workspace_id);
  const workingCount = tally(activeJobs ?? [], (j) => j.workspace_id);
  const pendingCount = tally(openChanges ?? [], (c) => c.workspace_id);
  const pendingValue = sumBy(
    openChanges ?? [],
    (c) => c.workspace_id,
    (c) => Math.abs(Number(c.materiality_gbp ?? 0)),
  );

  // Per workspace: how many operations of each family, and the most recent one.
  // The rows arrive newest first, so the first sighting of a workspace is its
  // latest activity and no date comparison is needed.
  const families = new Map<string, Partial<Record<OperationFamily, number>>>();
  const latest = new Map<string, { at: string; label: string }>();

  for (const job of history ?? []) {
    if (!isHistoryKind(job.kind)) continue;

    const counts = families.get(job.workspace_id) ?? {};
    const family = OPERATION_FAMILY[job.kind];
    counts[family] = (counts[family] ?? 0) + 1;
    families.set(job.workspace_id, counts);

    if (!latest.has(job.workspace_id)) {
      latest.set(job.workspace_id, { at: job.created_at, label: OPERATION_LABELS[job.kind] });
    }
  }

  const canCreate = role === 'owner' || role === 'admin';
  const totalDatasets = (datasets ?? []).length;
  const totalWorking = (activeJobs ?? []).length;
  const totalPending = (openChanges ?? []).length;

  // Waiting work first. A practice with forty clients should not have to read
  // forty rows to find the two that need an answer today.
  const rows: WorkspaceRow[] = [...workspaces]
    .sort((a, b) => (pendingCount.get(b.id) ?? 0) - (pendingCount.get(a.id) ?? 0))
    .map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      clientName: workspace.client_name,
      createdAt: workspace.created_at,
      datasets: datasetCount.get(workspace.id) ?? 0,
      processing: workingCount.get(workspace.id) ?? 0,
      waiting: pendingCount.get(workspace.id) ?? 0,
      atStake: pendingValue.get(workspace.id) ?? 0,
      lastActivityLabel: ago(latest.get(workspace.id)?.at ?? null),
      lastOperationLabel: latest.get(workspace.id)?.label ?? null,
      families: families.get(workspace.id) ?? {},
    }));

  return (
    <>
      <PageHeader
        eyebrow={org.name}
        title="Client workspaces"
        subtitle="One workspace per client. Data, recipes and the audit trail stay separate between them."
        action={canCreate ? <CreateWorkspaceForm orgId={org.id} /> : null}
      />

      {workspaces.length === 0 ? (
        <EmptyState
          title="Your firm is ready"
          body={
            canCreate
              ? 'Create a workspace for the client whose monthly file you process by hand today. DataEngine learns that workflow from the fixes you approve, then repeats it on next month’s file.'
              : 'An owner or admin of this firm needs to create the first workspace.'
          }
          steps={[
            'Upload the spreadsheet exactly as the client sends it',
            'DataEngine finds the real table and reports what is wrong with the data',
            'Review the proposed fixes and approve the ones you want',
            'Next month the same file is cleaned the same way, with only the differences surfaced',
          ]}
        />
      ) : (
        <>
          {/* A summary only once there is something to summarise. An empty stat
              row is decoration pretending to be information. */}
          {totalDatasets > 0 && (
            <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Clients" value={workspaces.length} />
              <Stat label="Datasets" value={totalDatasets} />
              <Stat
                label="Awaiting your decision"
                value={totalPending}
                tone={totalPending > 0 ? 'accent' : 'neutral'}
                hint={totalPending > 0 ? 'Across all clients' : undefined}
              />
              <Stat
                label="Processing now"
                value={totalWorking}
                hint={totalWorking > 0 ? 'Jobs queued or running' : undefined}
              />
            </div>
          )}

          <WorkspaceIndex workspaces={rows} />
        </>
      )}
    </>
  );
}

/**
 * "2 days ago", for a list that is scanned rather than audited.
 *
 * Computed here rather than in the list, which is a client component: a clock
 * read during SSR and again at hydration agrees almost always and disagrees
 * exactly when the two reads straddle midnight. The exact timestamp is on the
 * operation itself in the workspace.
 */
function ago(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const days = Math.floor((Date.now() - new Date(timestamp).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}

/** Counts rows per key. */
function tally<T>(rows: T[], key: (row: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** Sums a figure per key, for the money at stake behind each workspace. */
function sumBy<T>(
  rows: T[],
  key: (row: T) => string,
  value: (row: T) => number,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    totals.set(k, (totals.get(k) ?? 0) + value(row));
  }
  return totals;
}
