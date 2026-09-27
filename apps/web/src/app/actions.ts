'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireUser } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * Server actions for the two entity types a user creates by hand.
 *
 * Both delegate to SECURITY DEFINER RPCs rather than inserting directly. The
 * reason is audit integrity (section 13): the RPC writes the entity and its
 * audit row in one transaction, so there is no window in which the workspace
 * exists but the record of who created it does not.
 */

export type ActionState = { error: string | null };

const orgSchema = z.object({
  name: z.string().trim().min(2, 'Give the firm a name').max(200),
});

const workspaceSchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().trim().min(2, 'Give the workspace a name').max(200),
  clientName: z.string().trim().max(200).optional(),
  // What this client's books are already in. Not a conversion rate and nothing
  // converts: it is what the materiality figures on the review queue get
  // labelled with, so a shop keeping dollars stops being told its proposals are
  // worth pounds.
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, like USD')
    .optional(),
});

/** "Hendricks & Co." -> "hendricks-co". Uniqueness is the database's job. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  return base.length >= 2 ? base : `org-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createOrganization(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireUser();

  const parsed = orgSchema.safeParse({ name: formData.get('name') });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const supabase = await createServerSupabase();

  // Retry once on a slug collision: two firms called "Smith & Co" is ordinary,
  // and the user should not have to care that slugs exist.
  let slug = slugify(parsed.data.name);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error } = await supabase.rpc('create_organization', {
      p_name: parsed.data.name,
      p_slug: slug,
    });

    if (!error) redirect('/app');

    if (error.code === '23505' && attempt === 0) {
      slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
      continue;
    }

    return { error: `Could not create organization: ${error.message}` };
  }

  return { error: 'Could not create organization' };
}

export async function createWorkspace(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireUser();

  const parsed = workspaceSchema.safeParse({
    orgId: formData.get('orgId'),
    name: formData.get('name'),
    clientName: formData.get('clientName') || undefined,
    currency: formData.get('currency') || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const supabase = await createServerSupabase();

  const { error } = await supabase.rpc('create_workspace', {
    p_org_id: parsed.data.orgId,
    p_name: parsed.data.name,
    p_client_name: parsed.data.clientName ?? undefined,
    p_currency: parsed.data.currency ?? undefined,
  });

  if (error) {
    return { error: `Could not create workspace: ${error.message}` };
  }

  revalidatePath('/app');
  return { error: null };
}
