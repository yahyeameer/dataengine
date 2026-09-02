import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError } from '@/lib/api';
import { requireWorkspaceAccess } from '@/lib/authz';
import { validateReportConfig } from '@/lib/recipes';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * The Recipes screen's write path.
 *
 * Every action is one RPC, and every RPC re-checks workspace access from
 * `auth.uid()` rather than trusting this route — so a recipe id belonging to
 * another tenant answers "not found" from the database, not from a check here
 * that could be forgotten. `requireWorkspaceAccess` above it is the second lock
 * PRD section 13 asks for, not the only one.
 *
 * Note what is *not* here: a way to write arbitrary steps. `newVersion` takes a
 * step list, and it is validated against the operations the cleaning engine
 * actually implements before it can be stored — a recipe references approved
 * operations and never carries code.
 */

const describeSchema = z.object({
  action: z.literal('describe'),
  workspaceId: z.string().uuid(),
  recipeId: z.string().uuid(),
  name: z.string().min(1).max(200).nullish(),
  description: z.string().max(1000).nullish(),
});

const enableSchema = z.object({
  action: z.literal('setEnabled'),
  workspaceId: z.string().uuid(),
  recipeId: z.string().uuid(),
  enabled: z.boolean(),
  reason: z.string().max(300).nullish(),
});

const duplicateSchema = z.object({
  action: z.literal('duplicate'),
  workspaceId: z.string().uuid(),
  recipeId: z.string().uuid(),
  name: z.string().min(1).max(200).nullish(),
  targetWorkspaceId: z.string().uuid().nullish(),
});

const newVersionSchema = z.object({
  action: z.literal('newVersion'),
  workspaceId: z.string().uuid(),
  recipeId: z.string().uuid(),
  steps: z.array(z.record(z.string(), z.unknown())).max(60).nullish(),
  reportConfig: z
    .object({
      formats: z.array(z.string()).min(1).max(4),
      title: z.string().max(200).nullish(),
    })
    .nullish(),
  changeNote: z.string().max(300).nullish(),
});

const bodySchema = z.discriminatedUnion('action', [
  describeSchema,
  enableSchema,
  duplicateSchema,
  newVersionSchema,
]);

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    await requireWorkspaceAccess(body.workspaceId);

    // A recipe may only be acted on from the workspace that owns it. Without
    // this, a caller who is a member of two workspaces could name one they can
    // reach and a recipe from the other; the RPCs would still refuse, but the
    // refusal would be a database exception rather than a clear 404.
    const supabase = await createServerSupabase();
    const { data: recipe } = await supabase
      .from('cleaning_recipes')
      .select('id, workspace_id')
      .eq('id', body.recipeId)
      .maybeSingle();

    if (!recipe || recipe.workspace_id !== body.workspaceId) {
      return NextResponse.json({ error: 'Recipe not found' }, { status: 404 });
    }

    if (body.action === 'describe') {
      const { data, error } = await supabase.rpc('describe_recipe', {
        p_recipe_id: body.recipeId,
        p_name: body.name ?? undefined,
        p_description: body.description ?? undefined,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ recipe: data });
    }

    if (body.action === 'setEnabled') {
      const { data, error } = await supabase.rpc('set_recipe_enabled', {
        p_recipe_id: body.recipeId,
        p_enabled: body.enabled,
        p_reason: body.reason ?? undefined,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ recipe: data });
    }

    if (body.action === 'duplicate') {
      if (body.targetWorkspaceId) await requireWorkspaceAccess(body.targetWorkspaceId);
      const { data, error } = await supabase.rpc('duplicate_recipe', {
        p_recipe_id: body.recipeId,
        p_name: body.name ?? undefined,
        p_target_workspace_id: body.targetWorkspaceId ?? undefined,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ recipe: data });
    }

    // newVersion. Editing a recipe never mutates one: recipe_versions is
    // immutable and historical runs point at it, so every change is a new
    // version and the run that happened last month keeps saying what it did.
    let reportConfig: Record<string, unknown> | undefined;
    if (body.reportConfig) {
      const checked = validateReportConfig(body.reportConfig);
      if (!checked.ok) return NextResponse.json({ error: checked.reason }, { status: 400 });
      reportConfig = checked.config;
    }

    const { data, error } = await supabase.rpc('update_recipe_definition', {
      p_recipe_id: body.recipeId,
      p_steps: body.steps ? (body.steps as never) : undefined,
      p_report_config: reportConfig ? (reportConfig as never) : undefined,
      p_change_note: body.changeNote ?? undefined,
    });

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ version: data });
  } catch (error) {
    return handleRouteError(error);
  }
}
