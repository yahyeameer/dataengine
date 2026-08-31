import { NextResponse } from 'next/server';

import { handleRouteError } from '@/lib/api';
import { AuthzError, listMyOrganizations, requireApiUser } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * Where the categorise screen puts a file.
 *
 * The simple flow asks for one thing — drop a file — and every question it does
 * not ask has to be answered somewhere. This is that somewhere: it resolves the
 * workspace the upload will live in, creating one the first time if the caller
 * is allowed to, so the accountant never meets the word "workspace" on the way
 * to a categorised file.
 *
 * None of the isolation moves. The workspace is still resolved through the
 * caller's own RLS-bound client, `create_workspace` still checks the caller's
 * role in the database, and every route downstream still re-derives membership
 * from the workspace id this hands back. Simplifying the screen is not the same
 * as trusting the client, and the id returned here buys the caller nothing they
 * did not already have.
 *
 * A member with no workspace is a real state and is answered honestly rather
 * than with a failure: `create_workspace` is owner/admin only by design, so this
 * says who to ask instead of returning 403 to somebody who has done nothing
 * wrong.
 */

/** What a first workspace gets called. Never shown unless somebody goes looking. */
const DEFAULT_WORKSPACE_NAME = 'My files';

export async function POST() {
  try {
    await requireApiUser();
    const organizations = await listMyOrganizations();

    if (organizations.length === 0) {
      throw new AuthzError('No organisation yet', 403);
    }

    const { org, role } = organizations[0];
    const supabase = await createServerSupabase();

    // The most recently used workspace, so a returning customer keeps landing
    // in the same place and their files stay together.
    const { data: existing, error } = await supabase
      .from('workspaces')
      .select('id, name')
      .eq('org_id', org.id)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) {
      return NextResponse.json({ error: 'Could not open your workspace' }, { status: 500 });
    }

    if (existing && existing.length > 0) {
      return NextResponse.json({ workspaceId: existing[0].id, created: false });
    }

    if (role !== 'owner' && role !== 'admin') {
      // Not a permission to grant here — the database would refuse it too. Say
      // what would fix it rather than what failed.
      return NextResponse.json(
        {
          error:
            'There is no workspace set up for your organisation yet. An owner or admin can ' +
            'create one, then you can upload files here.',
        },
        { status: 403 },
      );
    }

    const { data: created, error: createError } = await supabase.rpc('create_workspace', {
      p_org_id: org.id,
      p_name: DEFAULT_WORKSPACE_NAME,
      p_client_name: undefined,
    });

    if (createError || !created) {
      return NextResponse.json({ error: 'Could not open your workspace' }, { status: 500 });
    }

    return NextResponse.json({ workspaceId: (created as { id: string }).id, created: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
