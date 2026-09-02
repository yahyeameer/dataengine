import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';

import { createAdminSupabase, createServerSupabase } from '@/lib/supabase/server';
import type { Database } from '@/lib/database.types';

export type OrgRole = Database['public']['Enums']['org_role'];

/**
 * PRD section 13 asks for "tenant isolation via Supabase RLS plus server-side
 * authorization on every path". This module is that second half.
 *
 * RLS alone would be enough to keep two accounting firms apart on read paths,
 * but the upload route has to hold the service-role key in order to mint signed
 * upload URLs -- and the service role bypasses RLS. So on that path these
 * checks are not defence in depth, they are the only defence. Treat them
 * accordingly: check first, construct the admin client second.
 */

export class AuthzError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 404,
  ) {
    super(message);
    this.name = 'AuthzError';
  }
}

/** The signed-in user, or null. */
export async function getUser(): Promise<User | null> {
  const supabase = await createServerSupabase();
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}

/** The signed-in user, or a redirect to /login. For pages. */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect('/login');
  return user;
}

/** The signed-in user, or an AuthzError. For route handlers. */
export async function requireApiUser(): Promise<User> {
  const user = await getUser();
  if (!user) throw new AuthzError('Not authenticated', 401);
  return user;
}

export type WorkspaceContext = {
  user: User;
  workspaceId: string;
  orgId: string;
  role: OrgRole;
};

/**
 * Resolves a workspace and proves the caller belongs to the organization that
 * owns it.
 *
 * The lookup runs through the *user's* RLS-bound client rather than the admin
 * client on purpose: if the policy would not return this workspace, the caller
 * has no business with it, and we get a second opinion from the database for
 * free. A workspace that exists but belongs to another tenant is reported as
 * 404, not 403, so the API does not confirm that someone else's workspace id
 * is real.
 */
export async function requireWorkspaceAccess(workspaceId: string): Promise<WorkspaceContext> {
  const user = await requireApiUser();
  const supabase = await createServerSupabase();

  const { data: workspace, error } = await supabase
    .from('workspaces')
    .select('id, org_id, status')
    .eq('id', workspaceId)
    .maybeSingle();

  if (error) throw new AuthzError(`Workspace lookup failed: ${error.message}`, 403);
  if (!workspace) throw new AuthzError('Workspace not found', 404);

  const { data: membership, error: membershipError } = await supabase
    .from('organization_members')
    .select('role')
    .eq('org_id', workspace.org_id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (membershipError || !membership) {
    throw new AuthzError('Not a member of the owning organization', 403);
  }

  if (workspace.status !== 'active') {
    throw new AuthzError('Workspace is archived', 403);
  }

  return { user, workspaceId: workspace.id, orgId: workspace.org_id, role: membership.role };
}

export type OrgContext = { user: User; orgId: string; role: OrgRole };

/**
 * Proves the caller is an owner or admin of one organization.
 *
 * Branding is what every client sees on every document the firm sends, so it
 * sits at the same level as creating a billable workspace rather than at member
 * level. The membership row is read through the caller's own RLS-bound client,
 * so a caller who cannot see the organization gets the same answer as one who
 * is not in it -- 404, never a 403 that confirms the id is real.
 */
export async function requireOrgAdmin(orgId: string): Promise<OrgContext> {
  const user = await requireApiUser();
  const supabase = await createServerSupabase();

  const { data: membership, error } = await supabase
    .from('organization_members')
    .select('role, org_id')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) throw new AuthzError(`Organization lookup failed: ${error.message}`, 403);
  if (!membership) throw new AuthzError('Organization not found', 404);
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw new AuthzError('Only an owner or admin may change this', 403);
  }

  return { user, orgId: membership.org_id, role: membership.role };
}

/**
 * The caller's organizations, most recent first. A user with none is sent to
 * /onboarding; a user with several sees the first until multi-org switching
 * arrives.
 */
export async function listMyOrganizations() {
  const supabase = await createServerSupabase();

  const { data, error } = await supabase
    .from('organization_members')
    .select('role, organizations (id, name, slug, created_at)')
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Could not load organizations: ${error.message}`);

  return (data ?? [])
    .filter((row) => row.organizations !== null)
    .map((row) => ({ role: row.role, org: row.organizations! }));
}

/** The caller's current organization, or a redirect to onboarding. */
export async function requireCurrentOrg() {
  await requireUser();
  const orgs = await listMyOrganizations();
  if (orgs.length === 0) redirect('/onboarding');
  return orgs[0];
}

/**
 * Admin client, handed out only after an access check has already run. Taking
 * the proven context as an argument makes the ordering visible at every call
 * site rather than relying on the author remembering it.
 */
export function adminFor(_context: WorkspaceContext | OrgContext) {
  return createAdminSupabase();
}
