import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError } from '@/lib/api';
import { requireApiUser } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * Resolving a deviation raised by a recipe replay.
 *
 * Month one is the review queue: the agent proposes, the accountant decides.
 * Month two is this. The recipe runs on its own and reports only what it could
 * not handle -- a value it has never seen, a column that appeared, a total that
 * no longer reconciles -- and a run holding an unresolved `review` finding
 * writes no output version. So this route is the difference between a replay
 * that finishes and one that sits at needs_review forever.
 *
 * Shaped like /api/agent/changes deliberately. Authorisation lives entirely in
 * `resolve_deviation`, which looks the deviation up, resolves it to its
 * workspace and calls `has_workspace_access` itself. There is no workspace id
 * in the request to check against, because passing one would invite the
 * mismatch where a caller names workspace A and a deviation belonging to B --
 * and the RPC would then have to decide which to believe.
 *
 * One deviation per call rather than a group key. A proposed change is one
 * decision covering many rows; a deviation is already grouped when it is
 * created ("31 unknown suppliers is one screen, not 31"), so the id is the
 * unit and there is nothing to batch.
 */

const resolveSchema = z.object({
  deviationId: z.string().uuid(),
  // Exactly the enum the database accepts, minus 'pending' -- resolve_deviation
  // rejects that explicitly, and offering it here would be an error the user
  // discovers only after clicking.
  resolution: z.enum(['accepted', 'rejected', 'mapped', 'ignored']),
  // Required by the RPC for 'mapped' and meaningless otherwise. Not enforced
  // here: the database raises check_violation with a clearer sentence than a
  // schema refinement would, and it is the side that must be right.
  resolvedValue: z.string().min(1).max(500).nullish(),
  note: z.string().max(1000).nullish(),
});

export async function POST(request: Request) {
  try {
    const body = resolveSchema.parse(await request.json());

    await requireApiUser();
    const supabase = await createServerSupabase();

    const { data, error } = await supabase.rpc('resolve_deviation', {
      p_deviation_id: body.deviationId,
      p_resolution: body.resolution,
      p_resolved_value: body.resolvedValue ?? undefined,
      p_note: body.note ?? undefined,
    });

    if (error) {
      // insufficient_privilege covers both "not yours" and "does not exist",
      // and its message is already written not to distinguish the two.
      // check_violation is a real user error worth showing as 400 -- mapping
      // without a value, or mapping a finding that has no value to map.
      const status = error.code === '23514' || /cannot|needs the value|no source value/i.test(error.message)
        ? 400
        : 403;
      return NextResponse.json({ error: error.message }, { status });
    }

    return NextResponse.json({ deviation: data });
  } catch (error) {
    return handleRouteError(error);
  }
}
