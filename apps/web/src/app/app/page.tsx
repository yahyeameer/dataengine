import Link from 'next/link';

import { CreateWorkspaceForm } from '@/components/create-workspace-form';
import { Card, EmptyState, PageHeader, StatusDot } from '@/components/ui';
import { requireCurrentOrg } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

export const metadata = { title: 'Workspaces · DataEngine' };

/**
 * The first screen after signing in.
 *
 * It answers one question — what is happening with my data — and it answers it
 * with counts that come from real rows. There are no invented metrics here: if
 * a workspace has no datasets it says so rather than showing a zero-value chart
 * to fill the space.
 *
 * Three queries, not one per workspace. A practice with forty clients would
 * otherwise pay forty round trips to render a list.
 */
export default async function AppHomePage() {
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

  const [{ data: datasets }, { data: activeJobs }] = await Promise.all([
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
  ]);

  const datasetCount = tally(datasets ?? [], (d) => d.workspace_id);
  const workingCount = tally(activeJobs ?? [], (j) => j.workspace_id);

  const canCreate = role === 'owner' || role === 'admin';
  const totalDatasets = (datasets ?? []).length;
  const totalWorking = (activeJobs ?? []).length;

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
              ? 'Create a workspace for the client whose monthly file you process by hand today. That recurring file is what DataEngine learns from.'
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
            <p className="mb-5 text-sm text-muted">
              <span className="font-medium text-foreground tabular">{totalDatasets}</span>{' '}
              dataset{totalDatasets === 1 ? '' : 's'} across{' '}
              <span className="font-medium text-foreground tabular">{workspaces.length}</span>{' '}
              workspace{workspaces.length === 1 ? '' : 's'}
              {totalWorking > 0 && (
                <>
                  {' · '}
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot tone="info" live />
                    <span className="tabular">{totalWorking}</span> processing now
                  </span>
                </>
              )}
              .
            </p>
          )}

          <ul className="grid gap-3 sm:grid-cols-2">
            {workspaces.map((workspace) => {
              const datasets = datasetCount.get(workspace.id) ?? 0;
              const working = workingCount.get(workspace.id) ?? 0;

              return (
                <li key={workspace.id}>
                  <Link
                    href={`/app/workspaces/${workspace.id}`}
                    className="group block h-full rounded-[var(--radius-lg)]"
                  >
                    <Card className="flex h-full flex-col p-5 transition-colors group-hover:border-accent/40">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium tracking-tight">{workspace.name}</p>
                          {workspace.client_name && (
                            <p className="mt-0.5 truncate text-sm text-muted">
                              {workspace.client_name}
                            </p>
                          )}
                        </div>
                        {working > 0 && (
                          <span
                            className="mt-1 shrink-0"
                            title={`${working} job${working === 1 ? '' : 's'} in progress`}
                          >
                            <StatusDot tone="info" live />
                          </span>
                        )}
                      </div>

                      <div className="mt-4 flex items-baseline gap-4 border-t border-border pt-3 text-xs text-subtle">
                        <span>
                          <span className="tabular font-medium text-muted">{datasets}</span>{' '}
                          dataset{datasets === 1 ? '' : 's'}
                        </span>
                        {working > 0 && (
                          <span className="text-info">
                            <span className="tabular font-medium">{working}</span> processing
                          </span>
                        )}
                        <span className="ml-auto">
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

function tally<T>(rows: T[], key: (row: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}
