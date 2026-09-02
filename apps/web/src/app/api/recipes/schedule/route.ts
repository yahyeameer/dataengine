import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError } from '@/lib/api';
import { requireWorkspaceAccess } from '@/lib/authz';
import { SCHEDULE_FREQUENCIES } from '@/lib/schedules';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * Turning a recipe's automation on, off, or onto a different cadence.
 *
 * The route validates shape and nothing else. Every rule that matters —
 * whether the caller may touch this recipe, whether the timezone exists, what
 * `next_run_at` becomes — is enforced by `upsert_recipe_schedule`, which is
 * SECURITY DEFINER and re-derives the caller from `auth.uid()`. That is
 * deliberate: the next occurrence of a monthly schedule in Africa/Nairobi is
 * calendar arithmetic, and a second implementation of it here would be a second
 * calendar to keep in step with the one the scheduler actually reads.
 *
 * So this route cannot set `next_run_at`, and there is no parameter for it.
 */

const upsertSchema = z.object({
  workspaceId: z.string().uuid(),
  recipeId: z.string().uuid(),
  enabled: z.boolean().default(true),
  frequency: z.enum(SCHEDULE_FREQUENCIES),
  dayOfMonth: z.number().int().min(1).max(31).nullish(),
  dayOfWeek: z.number().int().min(0).max(6).nullish(),
  hour: z.number().int().min(0).max(23).default(9),
  minute: z.number().int().min(0).max(59).default(0),
  // Not enumerated here. The database checks it against `pg_timezone_names`,
  // which is the only list that is certainly the same as the one the scheduler
  // computes with.
  timezone: z.string().min(1).max(64),
});

const deleteSchema = z.object({
  workspaceId: z.string().uuid(),
  recipeId: z.string().uuid(),
});

async function assertRecipeInWorkspace(workspaceId: string, recipeId: string) {
  await requireWorkspaceAccess(workspaceId);
  const supabase = await createServerSupabase();

  const { data: recipe } = await supabase
    .from('cleaning_recipes')
    .select('id, workspace_id')
    .eq('id', recipeId)
    .maybeSingle();

  if (!recipe || recipe.workspace_id !== workspaceId) return null;
  return supabase;
}

export async function POST(request: Request) {
  try {
    const body = upsertSchema.parse(await request.json());
    const supabase = await assertRecipeInWorkspace(body.workspaceId, body.recipeId);
    if (!supabase) return NextResponse.json({ error: 'Recipe not found' }, { status: 404 });

    const { data, error } = await supabase.rpc('upsert_recipe_schedule', {
      p_recipe_id: body.recipeId,
      p_enabled: body.enabled,
      p_frequency: body.frequency,
      p_day_of_month: body.dayOfMonth ?? undefined,
      p_day_of_week: body.dayOfWeek ?? undefined,
      p_hour: body.hour,
      p_minute: body.minute,
      p_timezone: body.timezone,
    });

    if (error) {
      // A rejected timezone is the caller's mistake, not a server fault, and
      // the database's message already names the value.
      const status = error.message.includes('not a known timezone') ? 400 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }

    return NextResponse.json({ schedule: data });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = deleteSchema.parse(await request.json());
    const supabase = await assertRecipeInWorkspace(body.workspaceId, body.recipeId);
    if (!supabase) return NextResponse.json({ error: 'Recipe not found' }, { status: 404 });

    const { data, error } = await supabase.rpc('delete_recipe_schedule', {
      p_recipe_id: body.recipeId,
    });

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ removed: data });
  } catch (error) {
    return handleRouteError(error);
  }
}
