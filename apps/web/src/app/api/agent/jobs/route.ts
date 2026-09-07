import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError } from '@/lib/api';
import { requireWorkspaceAccess } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * Asking the agent to do something, and finding out what it has done.
 *
 * Note what this route does *not* do: it never contacts the agent. The worker
 * lives on another host with no inbound port, and the queue table is the whole
 * interface between them. Enqueuing is a database write that returns in
 * milliseconds whether the agent is up, down or mid-restart — so a VPS reboot
 * during month-end delays the work rather than losing the request.
 *
 * The enqueue deliberately runs through the *user's* client rather than the
 * service role. `enqueue_agent_job` is SECURITY DEFINER and re-checks
 * membership from `auth.uid()`, so routing the call through the signed-in
 * session means the database authorises it independently of this route having
 * got it right. `requireWorkspaceAccess` above is the other half of PRD
 * section 13's "RLS plus server-side authorization on every path".
 */

const KINDS = [
  'parse_workbook',
  'profile_dataset',
  'propose_cleaning',
  'apply_cleaning',
  'query_dataset',
  'reconcile_sources',
  'generate_report',
  'export_dataset',
  'categorize_dataset',
  // The whole of the simple path. Safe to expose: like every kind here it is
  // enqueued through `enqueue_agent_job`, which re-checks membership from
  // `auth.uid()`, and it can only ever act on a version the caller already has
  // access to. It applies its own change without a review step, which is the
  // point of it -- and it does so through `auto_approve_proposed_changes`, which
  // refuses anything at the blocking tier and writes its own audit action.
  'categorise_statement',
  // Normally chained by parse_workbook when a recipe matches the file's
  // signature, never asked for directly. It is allowed here for one case: a run
  // that stopped at needs_review has to be re-run once its deviations are
  // answered, and the worker has no notion of resuming a finished run. Safe to
  // expose because handle_replay_recipe resolves the recipe itself from the
  // version's signature and refuses with a readable message when none matches --
  // the caller cannot name a recipe, only a version they already have access to.
  'replay_recipe',
  // The connected-store path. Both are safe to expose ungated, and the reason
  // is worth stating because `kanban_report` below is not.
  //
  // The switch that matters for these lives on the agent host
  // (`HERMES_STORE_ENABLED`), and a worker that has not been switched on does
  // not announce them -- so the job sits `queued` and visible instead of being
  // claimed and failed. That is the designed behaviour, not a gap: "waiting for
  // an agent that reads stores" is a state a shop can see and an operator can
  // fix, and duplicating the flag here would only add a second place for the
  // two to disagree. The dashboard reads `agent_workers.capabilities` and says
  // so before anybody waits.
  //
  // Neither kind can reach data the caller does not already have. Both resolve
  // the connection from the *job row's* workspace, which `enqueue_agent_job`
  // checked against the caller's membership, and the worker refuses a payload
  // naming a connection from anywhere else.
  'sync_store',
  'store_financials',
  // Setting a store up. Reads the credential the caller just stored, works out
  // what it is, dials the shop's system once and reports whether it answered.
  // It writes no ledger and returns no credential material -- the verdict it
  // produces holds key names, masks and sentences, which is why it can go
  // straight onto the job row and into a browser.
  'test_store_connection',
] as const;

/**
 * Kinds a customer may ask for only once an operator has turned them on.
 *
 * `kanban_report` runs through the internal multi-agent board, which is a
 * different risk profile from every kind above it: the work happens in another
 * process, on another host, in a system with no tenancy of its own. The
 * database will happily enqueue it — `enqueue_agent_job` checks membership, not
 * policy — so the decision to expose it lives here, and it is off until
 * somebody sets the flag.
 *
 * The agent host has its own switch (`HERMES_KANBAN_ENABLED`). Two flags on two
 * hosts is deliberate: opening the customer path is a thing you do on purpose,
 * twice, rather than a thing that happens because one variable leaked into one
 * environment file.
 */
const GATED_KINDS = ['kanban_report'] as const;

/**
 * Read per request, not once at module load.
 *
 * A `const` at module scope is evaluated when the route module is first
 * imported, which a build is entitled to do — and an inlined `false` is a flag
 * that cannot be turned on by restarting the container with a different
 * environment. That is a bad property for the switch that opens a customer
 * path, and worse for the one that closes it again.
 */
function allowedKinds(): readonly string[] {
  return process.env.KANBAN_BRIDGE_ENABLED === 'true'
    ? [...KINDS, ...GATED_KINDS]
    : KINDS;
}

const createSchema = z.object({
  workspaceId: z.string().uuid(),
  kind: z.enum([...KINDS, ...GATED_KINDS]),
  datasetId: z.string().uuid().nullish(),
  datasetVersionId: z.string().uuid().nullish(),
  rawUploadId: z.string().uuid().nullish(),
  payload: z.record(z.string(), z.unknown()).nullish(),
});

export async function POST(request: Request) {
  try {
    const body = createSchema.parse(await request.json());

    if (!allowedKinds().includes(body.kind)) {
      // 404 rather than 403: a kind that is not switched on is not a permission
      // the caller could be granted, and saying "forbidden" invites them to ask
      // who can grant it.
      return NextResponse.json({ error: `Unknown job kind ${body.kind}` }, { status: 404 });
    }

    await requireWorkspaceAccess(body.workspaceId);
    const supabase = await createServerSupabase();

    const { data, error } = await supabase.rpc('enqueue_agent_job', {
      p_workspace_id: body.workspaceId,
      p_kind: body.kind,
      p_payload: (body.payload ?? {}) as never,
      p_dataset_id: body.datasetId ?? undefined,
      p_dataset_version_id: body.datasetVersionId ?? undefined,
      p_raw_upload_id: body.rawUploadId ?? undefined,
      // A question typed into the dashboard is someone waiting at a screen.
      // A parse is a background chore. Ordering the queue by that difference
      // costs one number here and is the whole reason the column exists.
      // A question typed into the dashboard is someone waiting at a screen; a
      // store sync is a background chore that can take minutes against somebody
      // else's API, and putting it ahead of interactive work would make the
      // assistant feel broken every time a shop refreshed.
      // A connection test is somebody sitting at a setup screen watching a
      // spinner, so it goes near the front with the typed questions.
      p_priority:
        body.kind === 'query_dataset' || body.kind === 'test_store_connection'
          ? 10
          : body.kind === 'sync_store'
            ? 120
            : 100,
    });

    if (error) {
      // `enqueue_agent_job` throttles per user and raises SQLSTATE PT429 --
      // PostgREST's convention for "answer with this HTTP status". Surfacing it
      // as 400 would tell an accountant their request was malformed when the
      // truth is that it was fine and they should wait; the message already
      // carries the number of seconds.
      if (error.code === 'PT429') {
        return NextResponse.json({ error: error.message }, { status: 429 });
      }
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // The row is left `queued`, and that is the whole handoff. A worker polling
    // `claim_agent_job` picks it up on its next pass.
    //
    // This route used to push the job to the agent's webhook gateway before
    // returning, and the push began by claiming the row. That claim was the
    // bug: `claim_agent_job` only considers jobs that are `queued` or whose
    // lease has lapsed, so a job claimed here was invisible to the worker for
    // the life of its lease -- and when the push then failed, the job was
    // marked failed and non-retryable, so no worker ever saw it at all.
    //
    // `lib/hermes-dispatch.ts` and `claim_agent_job_by_id` are both still here
    // and both still correct. Nothing calls them, which is the point: Hermes
    // does the thinking, but it is reached from the worker over its API server,
    // not from a request handler over a webhook.
    return NextResponse.json({ job: data });
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

    const { data: jobs, error } = await supabase
      .from('agent_jobs')
      .select(
        'id, kind, status, progress, error, result, attempts, max_attempts, dataset_id, dataset_version_id, created_at, started_at, finished_at',
      )
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Liveness travels with the job list so the panel needs one request per
    // poll rather than two. Reading every worker row is cheap — there is one
    // per agent host, and the table carries no customer data.
    const { data: workers } = await supabase
      .from('agent_workers')
      .select('id, hostname, version, last_seen_at, jobs_claimed, metadata')
      .order('last_seen_at', { ascending: false })
      .limit(5);

    return NextResponse.json({ jobs: jobs ?? [], workers: workers ?? [] });
  } catch (error) {
    return handleRouteError(error);
  }
}
