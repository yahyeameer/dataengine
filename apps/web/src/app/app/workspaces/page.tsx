import Link from 'next/link';

import { CreateWorkspaceForm } from '@/components/create-workspace-form';
import { Card, EmptyState, Money, PageHeader, StatusDot } from '@/components/ui';
import { formatMoney } from '@/lib/agent';
import { requireCurrentOrg } from '@/lib/authz';
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
 * Three queries, not one per workspace. A practice with forty clients would
 * otherwise pay forty round trips to render a list.
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

  // Three queries for the whole list, not one per workspace, and the third is
  // the one that turns this page from a directory into a worklist. "Which
  // client is waiting on me, and for how much" is the question an accountant
  // opens this screen to answer; without it every card said only that a
  // workspace exists, which they already knew.
  const [{ data: datasets }, { data: activeJobs }, { data: openChanges }] = await Promise.all([
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
  ]);

  const datasetCount = tally(datasets ?? [], (d) => d.workspace_id);
  const workingCount = tally(activeJobs ?? [], (j) => j.workspace_id);
  const pendingCount = tally(openChanges ?? [], (c) => c.workspace_id);
  const pendingValue = sumBy(
    openChanges ?? [],
    (c) => c.workspace_id,
    (c) => Math.abs(Number(c.materiality_gbp ?? 0)),
  );

  const canCreate = role === 'owner' || role === 'admin';
  const totalDatasets = (datasets ?? []).length;
  const totalWorking = (activeJobs ?? []).length;
  const totalPending = (openChanges ?? []).length;

  // Waiting work first. A practice with forty clients should not have to read
  // forty cards to find the two that need an answer today.
  const sorted = [...workspaces].sort(
    (a, b) => (pendingCount.get(b.id) ?? 0) - (pendingCount.get(a.id) ?? 0),
  );

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
          {/* A summary only once there is something to summarise. An empty
              stat row is decoration pretending to be information. */}
          {totalDatasets > 0 && (
            <div className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-[var(--radius-lg)] border border-border bg-surface px-5 py-3.5 text-sm shadow-[var(--shadow-sm)]">
              <span className="text-muted">
                <span className="tabular font-medium text-foreground">{totalDatasets}</span>{' '}
                dataset{totalDatasets === 1 ? '' : 's'} across{' '}
                <span className="tabular font-medium text-foreground">{workspaces.length}</span>{' '}
                workspace{workspaces.length === 1 ? '' : 's'}
              </span>

              {totalPending > 0 && (
                <span className="flex items-center gap-1.5 text-muted">
                  <span aria-hidden className="h-1 w-1 rounded-full bg-border-strong" />
                  <span className="tabular font-medium text-foreground">{totalPending}</span>{' '}
                  awaiting your decision
                </span>
              )}

              {totalWorking > 0 && (
                <span className="flex items-center gap-1.5 text-muted">
                  <StatusDot tone="info" live />
                  <span className="tabular font-medium text-foreground">{totalWorking}</span>{' '}
                  processing now
                </span>
              )}
            </div>
          )}

          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {sorted.map((workspace) => {
              const datasets = datasetCount.get(workspace.id) ?? 0;
              const working = workingCount.get(workspace.id) ?? 0;
              const waiting = pendingCount.get(workspace.id) ?? 0;
              const atStake = pendingValue.get(workspace.id) ?? 0;

              return (
                <li key={workspace.id}>
                  <Link
                    href={`/app/workspaces/${workspace.id}`}
                    className="block h-full rounded-[var(--radius-lg)]"
                  >
                    <Card className="lift flex h-full flex-col p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-[15px] font-medium tracking-tight">
                            {workspace.name}
                          </p>
                          {workspace.client_name && (
                            <p className="mt-0.5 truncate text-sm text-muted">
                              {workspace.client_name}
                            </p>
                          )}
                        </div>
                        {working > 0 && (
                          <span
                            className="mt-1.5 shrink-0"
                            title={`${working} job${working === 1 ? '' : 's'} in progress`}
                          >
                            <StatusDot tone="info" live />
                          </span>
                        )}
                      </div>

                      {/* The reason to open this workspace rather than any
                          other. Given the room a decision deserves. */}
                      {waiting > 0 ? (
                        <div className="mt-4 rounded-[var(--radius)] border border-accent/25 bg-accent-soft/50 px-3.5 py-2.5">
                          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-accent">
                            Waiting on you
                          </p>
                          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm">
                            <span className="tabular font-semibold">{waiting}</span>
                            <span className="text-muted">
                              proposal{waiting === 1 ? '' : 's'}
                            </span>
                            {atStake > 0 && (
                              <span className="ml-auto">
                                <Money>{formatMoney(atStake)}</Money>
                              </span>
                            )}
                          </p>
                        </div>
                      ) : (
                        <p className="mt-4 rounded-[var(--radius)] border border-border bg-surface-2/50 px-3.5 py-2.5 text-[13px] text-subtle">
                          Nothing waiting on you.
                        </p>
                      )}

                      <div className="mt-auto flex items-baseline gap-4 pt-4 text-xs text-subtle">
                        <span>
                          <span className="tabular font-medium text-muted">{datasets}</span>{' '}
                          dataset{datasets === 1 ? '' : 's'}
                        </span>
                        {working > 0 && (
                          <span className="text-info">
                            <span className="tabular font-medium">{working}</span> processing
                          </span>
                        )}
                        <span className="ml-auto tabular">
                          {new Date(workspace.created_at).toLocaleDateString('en-GB', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </span>
                      </div>
                    </Card>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
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
function sumBy<T>(rows: T[], key: (row: T) => string, value: (row: T) => number): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    totals.set(k, (totals.get(k) ?? 0) + value(row));
  }
  return totals;
}
