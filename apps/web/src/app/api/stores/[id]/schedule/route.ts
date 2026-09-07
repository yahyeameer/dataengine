import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError } from '@/lib/api';
import { AuthzError, requireWorkspaceAccess } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * "Send me this report every week."
 *
 * The schedule is a row, not a cron on the agent host. The worker sweeps due
 * rows and enqueues the jobs, so a VPS that was down over the weekend fires the
 * missed report when it comes back rather than losing it — and two workers
 * cannot both send one shop the same weekly report, because advancing the clock
 * and enqueuing the job happen in one transaction.
 */

const CADENCES = ['daily', 'weekly', 'monthly', 'yearly'] as const;

const schema = z.object({
  // How often the report arrives, and what it covers: the last complete one.
  cadence: z.enum(CADENCES),
  // The buckets drawn inside it. A month cut into weeks is readable; a year cut
  // into days is not, which is why this is separate from the cadence.
  granularity: z.enum(CADENCES).optional(),
  format: z.enum(['md', 'pdf', 'docx', 'xlsx']).default('pdf'),
  language: z.enum(['en', 'so']).optional(),
  enabled: z.boolean().default(true),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = schema.parse(await request.json());

    const supabase = await createServerSupabase();
    const { data: connection, error: lookupError } = await supabase
      .from('store_connections')
      .select('id, workspace_id')
      .eq('id', id)
      .maybeSingle();

    if (lookupError) throw new AuthzError(`Store lookup failed: ${lookupError.message}`, 403);
    if (!connection) throw new AuthzError('Store connection not found', 404);
    await requireWorkspaceAccess(connection.workspace_id);

    const { data, error } = await supabase.rpc('set_store_report_schedule', {
      p_connection_id: id,
      p_cadence: body.cadence,
      p_granularity: body.granularity ?? undefined,
      p_format: body.format,
      p_language: body.language ?? undefined,
      p_enabled: body.enabled,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ schedule: data });
  } catch (error) {
    return handleRouteError(error);
  }
}
