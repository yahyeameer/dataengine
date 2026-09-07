import { StoreConsole, type StoreWorkspace } from '@/components/store-console';
import { EmptyState, PageHeader } from '@/components/ui';
import { requireCurrentOrg } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

export const metadata = { title: 'Stores · DataEngine' };

/**
 * Connected shops and warehouses.
 *
 * The rest of this product is built for an accountant working through a
 * client's month. This screen is for the shopkeeper's own question — did I make
 * money this week — and it is deliberately a different shape: connect the system
 * you already use, and the agent reads it and answers, on a schedule, without
 * anybody uploading anything again.
 *
 * The page itself only resolves the workspaces. Everything else happens in the
 * client console beside it, because connecting, syncing and reporting are all
 * things a person does one after another and a full page reload between each
 * would make the whole flow feel like paperwork.
 *
 * Whether any agent can actually read a store is decided there too, not here.
 * It is a *derived* fact with a ninety-second shelf life — the agent host owns
 * the switch and announces what it can run on every heartbeat — so a verdict
 * rendered once on the server would be stale before the reader finished the
 * sentence. The console re-derives it from the same worker rows it already
 * polls.
 */
export default async function StoresPage() {
  const { org } = await requireCurrentOrg();
  const supabase = await createServerSupabase();

  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id, name, client_name')
    .eq('org_id', org.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Could not load workspaces: ${error.message}`);

  const rows: StoreWorkspace[] = (workspaces ?? []).map((workspace) => ({
    id: workspace.id,
    name: workspace.client_name || workspace.name,
  }));

  return (
    <>
      <PageHeader
        eyebrow="Retail and warehouse"
        title="Stores"
        subtitle="Connect the system your shop already uses — a spreadsheet, QuickBooks or Odoo — and get revenue, costs and profit for the day, week, month or year."
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No workspaces yet"
          body="A store connection belongs to a workspace. Create one first, then come back and point it at your shop’s system."
        />
      ) : (
        <StoreConsole workspaces={rows} />
      )}
    </>
  );
}
