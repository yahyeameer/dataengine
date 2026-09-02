import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError } from '@/lib/api';
import { requireApiUser } from '@/lib/authz';
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase/server';

/**
 * Removing turns from the assistant's history.
 *
 * `hermes_answers` grants `select` to members and nothing else, which was the
 * right shape while the table backed a read-only panel and is the reason this
 * route has to exist now that the history is something a person prunes. The
 * service role is the only thing that can write, and it bypasses RLS, so the
 * order below is the whole security story: prove access first, construct the
 * admin client second.
 *
 * --- how access is proved ---------------------------------------------------
 * Not by trusting a workspace id in the body. The rows are read back through
 * the *caller's* own client, so `hermes_answers_select_members` decides which
 * of the requested ids are theirs, and the admin client is then pointed at
 * exactly that set. A request id belonging to another firm is not refused with
 * a 403 -- it simply is not in the list that comes back, and nothing happens to
 * it. That also means the response cannot be used to discover whether a
 * stranger's request id exists.
 *
 * --- three actions, two of them reversible ----------------------------------
 *   trash    sets `deleted_at`. Out of the history, still in the table.
 *   restore  clears it again.
 *   delete   removes the row from Postgres. Not recoverable, and the only
 *            honest answer to "is it still on your server".
 *
 * The hard delete writes an `audit_logs` entry naming who removed how many
 * turns from which workspace. It carries no question or answer text: the
 * deletion was asked for because that text should stop existing, and an audit
 * trail keeping a copy would defeat the thing it was recording.
 */

const bodySchema = z.object({
  action: z.enum(['trash', 'restore', 'delete']),
  /**
   * Capped because this is a bulk control -- "clear 400 duplicates" is a real
   * press, and an unbounded `in (...)` from a browser is not something to
   * discover in production.
   */
  requestIds: z.array(z.string().min(8).max(200)).min(1).max(500),
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    const user = await requireApiUser();

    const supabase = await createServerSupabase();

    // RLS is the filter. Whatever comes back is a row this user may read, and
    // therefore a row this user may prune; whatever does not is silently not
    // acted on.
    const { data: owned, error: readError } = await supabase
      .from('hermes_answers')
      .select('request_id, workspace_id, status')
      .in('request_id', body.requestIds);

    if (readError) {
      return NextResponse.json({ error: readError.message }, { status: 500 });
    }

    const rows = owned ?? [];

    if (rows.length === 0) {
      return NextResponse.json({ affected: 0, requestIds: [] });
    }

    // A turn still being thought about is left alone. Its row is what the
    // browser's Realtime subscription is watching and what the agent is about
    // to write into: deleting it strands a spinner in one place and produces a
    // silent failed update in the other.
    const actionable = rows.filter((row) => row.status !== 'pending');
    const ids = actionable.map((row) => row.request_id);
    const skipped = rows.length - actionable.length;

    if (ids.length === 0) {
      return NextResponse.json(
        {
          affected: 0,
          requestIds: [],
          skipped,
          error: 'Still waiting for an answer. You can remove it once it settles.',
        },
        { status: 409 },
      );
    }

    const admin = createAdminSupabase();

    if (body.action === 'trash' || body.action === 'restore') {
      const { error } = await admin
        .from('hermes_answers')
        .update({ deleted_at: body.action === 'trash' ? new Date().toISOString() : null })
        .in('request_id', ids);

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      return NextResponse.json({ affected: ids.length, requestIds: ids, skipped });
    }

    const { error } = await admin.from('hermes_answers').delete().in('request_id', ids);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await recordPermanentDeletion(admin, user.id, actionable);

    return NextResponse.json({ affected: ids.length, requestIds: ids, skipped });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * The record that a deletion happened, without the thing that was deleted.
 *
 * One entry per workspace rather than per turn: forty rows saying the same
 * thing at the same second is not a more complete trail, it is a page of the
 * activity log nobody can read past. `audit_logs` is append-only in the
 * database, so this cannot be tidied away later either.
 *
 * Failures here are logged and swallowed. The rows are already gone by this
 * point, and answering 500 to a delete that succeeded would invite the customer
 * to press it again.
 */
async function recordPermanentDeletion(
  admin: ReturnType<typeof createAdminSupabase>,
  userId: string,
  rows: { request_id: string; workspace_id: string }[],
) {
  const byWorkspace = new Map<string, number>();
  for (const row of rows) {
    byWorkspace.set(row.workspace_id, (byWorkspace.get(row.workspace_id) ?? 0) + 1);
  }

  const { data: workspaces } = await admin
    .from('workspaces')
    .select('id, org_id')
    .in('id', [...byWorkspace.keys()]);

  const orgs = new Map((workspaces ?? []).map((workspace) => [workspace.id, workspace.org_id]));

  const entries = [...byWorkspace.entries()]
    .filter(([workspaceId]) => orgs.has(workspaceId))
    .map(([workspaceId, count]) => ({
      org_id: orgs.get(workspaceId)!,
      workspace_id: workspaceId,
      actor_user_id: userId,
      action: 'assistant_history.deleted',
      entity_type: 'hermes_answers',
      entity_id: null,
      metadata: { turns: count },
    }));

  if (entries.length === 0) return;

  const { error } = await admin.from('audit_logs').insert(entries);
  if (error) console.error('[api] could not record history deletion', error);
}
