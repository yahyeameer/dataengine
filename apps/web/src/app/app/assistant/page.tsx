import { AssistantConsole } from '@/components/assistant-console';
import { EmptyState, PageHeader } from '@/components/ui';
import { requireCurrentOrg } from '@/lib/authz';
import type { Turn, WorkspaceOption } from '@/lib/conversation-history';
import { HISTORY_KINDS, type HistoryJobRow, toOperations } from '@/lib/history';
import { buildReferences } from '@/lib/references';
import { createServerSupabase } from '@/lib/supabase/server';

export const metadata = { title: 'Assistant · DataEngine' };

/**
 * How far back the console reads.
 *
 * Far enough that "what did it tell me about the August file" is answerable
 * months later, and bounded because this is one query for the whole firm rather
 * than one per client. A practice that gets past this has outgrown a list and
 * wants a search over the table, which is a different screen.
 */
const HISTORY_LIMIT = 400;

/**
 * The assistant, and everything it has ever been asked.
 *
 * --- why the whole firm, not one workspace ----------------------------------
 * The conversation used to be a section inside a client, which made the history
 * a per-client thing and made "when did I last ask about a VAT code, and which
 * client was that" unanswerable. The rows were never per-client in any way that
 * mattered: `hermes_answers` is one table, RLS scopes it to the firm, and the
 * workspace is a column on it. Reading it whole and filing it in the browser is
 * one query and a much better question to be able to ask.
 *
 * --- what is read per workspace, and why ------------------------------------
 * `references` -- the file and dataset names an answer may mention, turned into
 * links to the rows behind them. Building those needs a workspace's operation
 * history, so it is done for the *selected* workspace only. Doing it for all of
 * them would be forty extra queries to resolve names in one conversation.
 */
export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const query = await searchParams;
  const requestedWorkspaceId = typeof query.w === 'string' ? query.w : null;
  const focusRequestId = typeof query.t === 'string' ? query.t : null;

  const { org } = await requireCurrentOrg();
  const supabase = await createServerSupabase();

  const { data: workspaceRows } = await supabase
    .from('workspaces')
    .select('id, name, client_name')
    .eq('org_id', org.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  const workspaces: WorkspaceOption[] = (workspaceRows ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    clientName: row.client_name,
  }));

  const workspaceIds = workspaces.map((workspace) => workspace.id);

  // RLS already scopes this to the caller's firm; the explicit filter is the
  // server-side half of the same check, as on every other read here. Removed
  // turns are included -- the trash view is what they are for, and the console
  // is what decides which views show them.
  const { data: answers } = workspaceIds.length
    ? await supabase
        .from('hermes_answers')
        .select('request_id, workspace_id, question, answer, status, error, created_at, deleted_at')
        .in('workspace_id', workspaceIds)
        .order('created_at', { ascending: false })
        .limit(HISTORY_LIMIT)
    : { data: [] };

  const turns: Turn[] = (answers ?? []).map((row) => ({
    requestId: row.request_id,
    workspaceId: row.workspace_id,
    question: row.question,
    answer: row.answer,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }));

  // Which client is on screen. An explicit `?w=` wins; failing that, the one
  // the last question was about, because that is what somebody returning to
  // this screen was in the middle of. A brand new firm falls through to the
  // first workspace, and a firm with none falls through to null.
  const lastUsed = turns.find((turn) => !turn.deletedAt)?.workspaceId ?? null;
  const selectedWorkspaceId =
    (requestedWorkspaceId && workspaceIds.includes(requestedWorkspaceId)
      ? requestedWorkspaceId
      : null) ??
    (lastUsed && workspaceIds.includes(lastUsed) ? lastUsed : null) ??
    workspaceIds[0] ??
    null;

  const references = selectedWorkspaceId
    ? await referencesFor(supabase, selectedWorkspaceId)
    : [];

  return (
    <div>
      <PageHeader
        eyebrow={org.name}
        title="Assistant"
        subtitle="Ask about a client's data in plain English. Every question and answer is kept here, and yours to delete."
      />

      {workspaces.length === 0 ? (
        <EmptyState
          title="Nothing to ask about yet"
          body="The assistant answers from one client's own data — its files, versions and the changes you have approved. Create a workspace and upload a file, and it has something to read."
          steps={[
            'Create a workspace for a client',
            'Upload the file they send you',
            'Come back here and ask what changed',
          ]}
        />
      ) : (
        <AssistantConsole
          workspaces={workspaces}
          initialTurns={turns}
          selectedWorkspaceId={selectedWorkspaceId}
          references={references}
          focusRequestId={focusRequestId}
        />
      )}
    </div>
  );
}

/**
 * The names in a workspace an answer is allowed to turn into a link.
 *
 * Same construction as the workspace page uses, from the same two tables, so a
 * reference in an answer and the row it points at cannot disagree between the
 * two screens.
 */
async function referencesFor(
  supabase: Awaited<ReturnType<typeof createServerSupabase>>,
  workspaceId: string,
) {
  const [{ data: historyJobs }, { data: datasets }] = await Promise.all([
    supabase
      .from('agent_jobs')
      .select(
        'id, kind, status, result, error, created_at, finished_at, dataset_id, dataset_version_id',
      )
      .eq('workspace_id', workspaceId)
      .in('kind', HISTORY_KINDS)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.from('datasets').select('id, name').eq('workspace_id', workspaceId),
  ]);

  const datasetNames = new Map((datasets ?? []).map((dataset) => [dataset.id, dataset.name]));
  const operations = toOperations((historyJobs ?? []) as HistoryJobRow[], datasetNames);

  return buildReferences(operations, datasets ?? []);
}
