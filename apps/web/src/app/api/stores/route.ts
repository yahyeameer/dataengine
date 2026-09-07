import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError } from '@/lib/api';
import { requireWorkspaceAccess } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * Connecting a shop, and seeing what the agent has read from it.
 *
 * Every write here runs through the *user's* RLS-bound client rather than the
 * service role, because `create_store_connection` is SECURITY DEFINER and
 * re-checks membership from `auth.uid()` itself. So the database authorises the
 * call independently of this route having got it right, which is the same
 * "RLS plus server-side authorization on every path" discipline the rest of the
 * app follows -- see PRD section 13.
 *
 * Note what this route never does: it never contacts the shop's system. Adding
 * a connection is a database write. The reading happens on the agent host, out
 * of a queued job, so a QuickBooks outage delays a sync rather than failing a
 * form submission.
 */

/**
 * What each source is allowed to carry in `config`, and nothing else.
 *
 * A permissive `z.record()` here would let a customer's settings blob become an
 * open channel into the worker: it is read on the agent host, and the Odoo
 * connector turns part of it into an outbound HTTP request. Naming the fields
 * means a key nobody designed for cannot arrive at all -- and the URL is
 * checked again on the worker before anything is fetched, because a check in
 * one process is not a check.
 */
const configSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('excel'),
    config: z
      .object({
        sheet: z.string().max(200).optional(),
        uploadId: z.string().uuid().optional(),
        // Role → column name. The worker detects this on the first sync and
        // reports what it found; saving it here is how a shop stops it being
        // re-guessed every month.
        columnMap: z.record(z.string(), z.string().max(200)).optional(),
      })
      .default({}),
  }),
  z.object({
    source: z.literal('quickbooks'),
    config: z.object({
      realmId: z.string().min(1).max(64),
      sandbox: z.boolean().optional(),
    }),
  }),
  z.object({
    source: z.literal('odoo'),
    config: z.object({
      baseUrl: z.string().url().max(500),
      database: z.string().min(1).max(200),
      username: z.string().min(1).max(200),
    }),
  }),
]);

const createSchema = z
  .object({
    workspaceId: z.string().uuid(),
    name: z.string().min(1).max(200),
    baseCurrency: z.string().regex(/^[A-Za-z]{3,5}$/).default('USD'),
    secondaryCurrency: z.string().regex(/^[A-Za-z]{3,5}$/).nullish(),
    secondaryRate: z.number().positive().nullish(),
    language: z.enum(['en', 'so']).default('en'),
    // Monday 0 … Sunday 6. Saturday by default: the working week here runs
    // Saturday to Thursday, so a Monday-start week splits it in two and every
    // week-on-week comparison compares six trading days against five.
    weekStart: z.number().int().min(0).max(6).default(5),
  })
  .and(configSchema);

/** snake_case for the database, which is what the worker reads. */
function toConfig(source: string, config: Record<string, unknown>) {
  if (source === 'odoo') {
    return {
      base_url: config.baseUrl,
      database: config.database,
      username: config.username,
    };
  }
  if (source === 'quickbooks') {
    return { realm_id: config.realmId, sandbox: config.sandbox ?? false };
  }
  return {
    ...(config.sheet ? { sheet: config.sheet } : {}),
    ...(config.uploadId ? { upload_id: config.uploadId } : {}),
    ...(config.columnMap ? { column_map: config.columnMap } : {}),
  };
}

export async function POST(request: Request) {
  try {
    const body = createSchema.parse(await request.json());

    await requireWorkspaceAccess(body.workspaceId);
    const supabase = await createServerSupabase();

    const { data, error } = await supabase.rpc('create_store_connection', {
      p_workspace_id: body.workspaceId,
      p_name: body.name,
      p_source: body.source,
      p_config: toConfig(body.source, body.config) as never,
      p_base_currency: body.baseCurrency.toUpperCase(),
      p_secondary_currency: body.secondaryCurrency?.toUpperCase() ?? undefined,
      p_secondary_rate: body.secondaryRate ?? undefined,
      p_language: body.language,
      p_week_start: body.weekStart,
    });

    if (error) {
      // A duplicate name inside one workspace is the ordinary collision here,
      // and it is the caller's to fix rather than a server fault.
      const status = error.code === '23505' ? 409 : 400;
      const message =
        status === 409
          ? 'A store with that name already exists in this workspace.'
          : error.message;
      return NextResponse.json({ error: message }, { status });
    }

    return NextResponse.json({ connection: data });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    await requireWorkspaceAccess(workspaceId);
    const supabase = await createServerSupabase();

    // Three reads rather than one join. RLS applies to each independently, so
    // there is no way for a widened join to leak a row a policy would have
    // refused on its own.
    const [connections, runs, schedules] = await Promise.all([
      supabase
        .from('store_connections')
        .select(
          'id, name, source, status, dataset_id, config, base_currency, secondary_currency, secondary_rate, rate_as_of, language, week_start, balances, last_sync_at, last_sync_status, last_sync_error, created_at',
        )
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: true }),
      supabase
        .from('store_sync_runs')
        .select(
          'id, connection_id, status, window_start, window_end, entries_written, summary, error, started_at, finished_at, dataset_version_id',
        )
        .eq('workspace_id', workspaceId)
        .order('started_at', { ascending: false })
        .limit(20),
      supabase
        .from('store_report_schedules')
        .select(
          'id, connection_id, cadence, granularity, format, language, enabled, next_run_at, last_run_at, last_job_id',
        )
        .eq('workspace_id', workspaceId),
    ]);

    const failure = connections.error ?? runs.error ?? schedules.error;
    if (failure) {
      return NextResponse.json({ error: failure.message }, { status: 500 });
    }

    return NextResponse.json({
      connections: connections.data ?? [],
      runs: runs.data ?? [],
      schedules: schedules.data ?? [],
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
