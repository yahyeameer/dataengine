import Link from 'next/link';

import { CreateWorkspaceForm } from '@/components/create-workspace-form';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requireCurrentOrg } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

export const metadata = { title: 'Workspaces · AI Data Operations' };

export default async function AppHomePage() {
  const { org, role } = await requireCurrentOrg();
  const supabase = await createServerSupabase();

  // RLS scopes this to the caller's organizations; the explicit org filter is
  // the server-side half of the same check (section 13).
  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id, name, client_name, status, created_at')
    .eq('org_id', org.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Could not load workspaces: ${error.message}`);

  const canCreate = role === 'owner' || role === 'admin';

  return (
    <>
      <PageHeader
        title="Client workspaces"
        subtitle="One workspace per client. Data, recipes and the audit trail stay separate between them."
        action={canCreate ? <CreateWorkspaceForm orgId={org.id} /> : null}
      />

      {workspaces.length === 0 ? (
        <EmptyState
          title="No client workspaces yet"
          body={
            canCreate
              ? 'Create one for the client whose monthly file you process by hand today. That recurring file is what the product learns from.'
              : 'An owner or admin of this firm needs to create the first workspace.'
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <Link href={`/app/workspaces/${workspace.id}`} className="block">
                <Card className="transition-colors hover:border-black/30 dark:hover:border-white/35">
                  <p className="font-medium">{workspace.name}</p>
                  {workspace.client_name ? (
                    <p className="mt-0.5 text-sm opacity-70">{workspace.client_name}</p>
                  ) : null}
                  <p className="mt-3 text-xs opacity-50">
                    Created {new Date(workspace.created_at).toLocaleDateString('en-GB')}
                  </p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
