import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError } from '@/lib/api';
import { AuthzError, requireWorkspaceAccess } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * Changing one store's settings, and storing its credentials.
 *
 * The credential path is the reason this file is separate from the collection
 * route. `set_store_connection_secret` puts the value into Supabase Vault and
 * returns nothing; there is deliberately no route anywhere that reads a stored
 * credential back, so a secret entered here can be replaced but never
 * retrieved. The dashboard shows whether one is set, and that is all it can
 * know.
 *
 * Neither the credential nor any part of it is logged, and the route replies
 * with an acknowledgement rather than an echo of what it stored.
 *
 * PUT accepts a *paste* as well as named fields, and that is the important
 * shape. A shopkeeper does not have a client secret; they have whatever their
 * accountant emailed them. This route does not try to understand it -- it
 * stores it and lets the worker's `test_store_connection` job work it out,
 * which keeps the parsing beside the connectors that need it and keeps a
 * decomposed credential out of this process entirely.
 */

const settingsSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(['active', 'paused']).optional(),
  secondaryCurrency: z.string().regex(/^[A-Za-z]{3,5}$/).nullable().optional(),
  secondaryRate: z.number().positive().nullable().optional(),
  language: z.enum(['en', 'so']).optional(),
  weekStart: z.number().int().min(0).max(6).optional(),
  columnMap: z.record(z.string(), z.string().max(200)).optional(),
  // Stock, cash, receivables and short-term debts, for the zakat estimate. The
  // agent will not compute one without them, and will not guess from profit.
  balances: z
    .object({
      inventory_value: z.number().nonnegative().nullable().optional(),
      cash: z.number().nonnegative().nullable().optional(),
      receivables: z.number().nonnegative().nullable().optional(),
      short_term_liabilities: z.number().nonnegative().nullable().optional(),
    })
    .optional(),
});

/**
 * Prove the caller may touch this connection before anything else happens.
 *
 * The RPCs re-check membership themselves, so this is the second opinion rather
 * than the only one -- but reading the row through the user's client first is
 * what turns "someone else's connection id" into a 404 instead of a database
 * error that confirms the id is real.
 */
async function connectionFor(id: string) {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from('store_connections')
    .select('id, workspace_id, source, config')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new AuthzError(`Store lookup failed: ${error.message}`, 403);
  if (!data) throw new AuthzError('Store connection not found', 404);

  await requireWorkspaceAccess(data.workspace_id);
  return { connection: data, supabase };
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = settingsSchema.parse(await request.json());
    const { connection, supabase } = await connectionFor(id);

    // The column map lives inside `config`, which is replaced wholesale by the
    // RPC. Merging here rather than there keeps the database function from
    // having to know the shape of a source's settings.
    const config =
      body.columnMap === undefined
        ? undefined
        : {
            ...((connection.config as Record<string, unknown>) ?? {}),
            column_map: body.columnMap,
          };

    const { data, error } = await supabase.rpc('update_store_connection', {
      p_connection_id: id,
      p_name: body.name ?? undefined,
      p_config: (config ?? undefined) as never,
      p_status: body.status ?? undefined,
      p_secondary_currency: body.secondaryCurrency ?? undefined,
      p_secondary_rate: body.secondaryRate ?? undefined,
      p_language: body.language ?? undefined,
      p_week_start: body.weekStart ?? undefined,
      p_balances: (body.balances ?? undefined) as never,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ connection: data });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * The credential shapes, per source.
 *
 * QuickBooks needs the three values its OAuth app issues; Odoo needs one API
 * key. They are validated for shape and never for content -- whether a key
 * works is answered by the first sync, in a job, with a message the shop can
 * read.
 */
const credentialSchema = z.union([
  // What a shop actually has: the file, the email, the four lines their
  // integrator sent. Stored as pasted and read by the worker, which is the only
  // place that knows what an Odoo credential looks like -- and the only place
  // that should, since parsing it here would mean the Next server holding a
  // decomposed credential in memory for no reason.
  z.object({ paste: z.string().min(1).max(20_000) }),
  z.object({
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().min(1).max(500),
    refreshToken: z.string().min(1).max(2000),
  }),
  z.object({ apiKey: z.string().min(1).max(2000) }),
]);

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = credentialSchema.parse(await request.json());
    const { connection, supabase } = await connectionFor(id);

    if (connection.source === 'excel') {
      return NextResponse.json(
        {
          error:
            'A spreadsheet store reads files you have already uploaded, so it needs no credentials.',
        },
        { status: 400 },
      );
    }

    // A paste goes to the vault exactly as typed; the structured forms are
    // normalised here because they already are structured. Either way the
    // worker's `test_store_connection` job reads it, works out what it is,
    // and writes back a canonical form -- so a shop that pasted an email and
    // one that filled in boxes end up storing the same shape.
    const secret =
      'paste' in body
        ? body.paste
        : JSON.stringify(
            'apiKey' in body
              ? { api_key: body.apiKey }
              : {
                  client_id: body.clientId,
                  client_secret: body.clientSecret,
                  refresh_token: body.refreshToken,
                },
          );

    const { error } = await supabase.rpc('set_store_connection_secret', {
      p_connection_id: id,
      p_secret: secret,
    });

    if (error) {
      // The message from a Vault that is switched off is the one thing worth
      // passing through verbatim, because it names the fix. Everything else
      // collapses, because a database message about a secrets function is not
      // something to hand a browser.
      const missingVault = error.message.includes('Vault');
      return NextResponse.json(
        { error: missingVault ? error.message : 'Could not store those credentials.' },
        { status: missingVault ? 503 : 400 },
      );
    }

    // An acknowledgement, never an echo.
    return NextResponse.json({ ok: true, hasCredentials: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
