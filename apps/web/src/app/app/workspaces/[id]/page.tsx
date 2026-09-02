import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AgentPanel } from '@/components/agent-panel';
import { CleanedDataCard } from '@/components/cleaned-data-card';
import {
  DeviationsPanel,
  type Deviation,
  type RecipeRun,
} from '@/components/deviations-panel';
import { OperationHistory } from '@/components/operation-history';
import { ReviewQueue, type ProposedChange } from '@/components/review-queue';
import { UploadPanel } from '@/components/upload-panel';
import { WorkspaceFiles } from '@/components/workspace-files';
import {
  Card,
  EmptyState,
  PageHeader,
  SectionHeading,
  TabBar,
  secondaryButtonClass,
} from '@/components/ui';
import { type DownloadableJob, exportVersionNo, isAdvisory } from '@/lib/agent';
import { HISTORY_KINDS, type HistoryJobRow, isDownloadable, toOperations } from '@/lib/history';
import { requireCurrentOrg } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * One client, in three screens rather than one.
 *
 * --- what was wrong ---------------------------------------------------------
 * The ordering was right and the layout still buried it. Eight full-width
 * sections stacked into nine thousand pixels, so the queue that needed a
 * decision and the engine log that explained it were never on screen together,
 * and finding last month's export meant scrolling past everything the product
 * does. Moving two of them into a right rail helped and did not fix it: the
 * page still asked the reader to hold four unrelated jobs in their head.
 *
 * They are not one job. "Is anything waiting on me", "what files has this
 * client sent" and "where is the thing I ran in July" are three questions
 * answered from three different parts of the database, and a person arrives
 * with exactly one of them. So they are three tabs, each about a screen tall.
 *
 * --- why the tab is in the URL ----------------------------------------------
 * `?tab=` rather than React state, because a tab that cannot be linked to
 * cannot be arrived at. An answer in the assistant references an operation, and
 * that reference has to land on the tab holding it -- which is why `?op=` and
 * `?dataset=` below select History without being asked to.
 *
 * --- what left this page ----------------------------------------------------
 * The conversation. It is a whole screen of its own at /app/assistant now, with
 * the history that had nowhere to go while it was a section here.
 */

const TABS = ['overview', 'data', 'history'] as const;
type Tab = (typeof TABS)[number];

export default async function WorkspacePage({
  params,
  searchParams,
}: PageProps<'/app/workspaces/[id]'>) {
  const { id } = await params;

  // `?op=` and `?dataset=` are how a result becomes addressable: a reference in
  // an answer, a bookmark and a link sent to a colleague all reopen the same
  // row. Both are read as plain strings and only ever compared against rows
  // this workspace already returned, so an id from a stranger's URL matches
  // nothing rather than fetching anything.
  const query = await searchParams;
  const openOperationId = typeof query.op === 'string' ? query.op : null;
  const datasetFilterId = typeof query.dataset === 'string' ? query.dataset : null;

  // An operation reference selects the tab that holds operations. Without this
  // every link out of an answer landed on Overview with its target three tabs
  // away and no sign that anything had been asked for.
  const requestedTab = typeof query.tab === 'string' ? query.tab : null;
  const tab: Tab = TABS.includes(requestedTab as Tab)
    ? (requestedTab as Tab)
    : openOperationId || datasetFilterId
      ? 'history'
      : 'overview';

  const { org } = await requireCurrentOrg();
  const supabase = await createServerSupabase();

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, name, client_name, org_id')
    .eq('id', id)
    .maybeSingle();

  // RLS already hides other tenants' workspaces, so a miss here is a 404 rather
  // than a 403 -- the API should not confirm that someone else's id is real.
  if (!workspace || workspace.org_id !== org.id) notFound();

  const [
    { data: datasets },
    { data: uploads },
    { data: jobs },
    { data: workers },
    { data: historyJobs },
  ] = await Promise.all([
    supabase
      .from('datasets')
      .select('id, name, source_signature')
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: true }),
    supabase
      .from('raw_uploads')
      .select('id, original_filename, byte_size, status, created_at, sha256, dataset_id')
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('agent_jobs')
      .select('id, kind, status, progress, result, error, attempts, created_at, finished_at')
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('agent_workers')
      .select('id, hostname, version, last_seen_at, jobs_claimed, metadata')
      .order('last_seen_at', { ascending: false })
      .limit(5),
    // History, read separately from the live job feed above it. That one is the
    // last twenty of everything including the plumbing, refreshed every few
    // seconds for the panel that shows what is running; this is the operations
    // an accountant would recognise, reaching far enough back to find last
    // month's categorisation. Different questions, different depths, and
    // merging them would compromise both.
    supabase
      .from('agent_jobs')
      .select(
        'id, kind, status, result, error, created_at, finished_at, dataset_id, dataset_version_id',
      )
      .eq('workspace_id', workspace.id)
      .in('kind', HISTORY_KINDS)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  // Month two's open question, if there is one.
  //
  // A replay that meets something it cannot handle finishes as needs_review and
  // writes no output version. That state used to be invisible: the job reported
  // success, because it had succeeded -- it ran, and stopped to ask.
  const { data: runs } = await supabase
    .from('recipe_runs')
    .select(
      'id, status, dataset_version_in, rows_processed, rows_matched, auto_corrections, automation_rate, invariant_status',
    )
    .eq('workspace_id', workspace.id)
    .in('status', ['needs_review', 'blocked'])
    .order('started_at', { ascending: false })
    .limit(1);

  const openRun = (runs?.[0] ?? null) as RecipeRun | null;
  let runDeviations: Deviation[] = [];

  if (openRun) {
    const { data: found } = await supabase
      .from('deviations')
      .select(
        'id, type, severity, title, detail, column_name, source_value, suggested_value, affected_rows, materiality_gbp, resolution, evidence',
      )
      .eq('run_id', openRun.id)
      // Severity ascending puts 'block' first: the enum is declared
      // auto -> review -> block, so descending would bury the one that stops
      // everything underneath the ones that merely ask.
      .order('severity', { ascending: false })
      .order('materiality_gbp', { ascending: false, nullsFirst: false });

    runDeviations = (found ?? []) as Deviation[];
  }

  const datasetNames = new Map((datasets ?? []).map((d) => [d.id, d.name]));
  const operations = toOperations((historyJobs ?? []) as HistoryJobRow[], datasetNames);
  const datasetIds = (datasets ?? []).map((d) => d.id);

  // The review queue belongs to a version, not to the workspace, so find the
  // most recent version that still has something to decide. Anything older has
  // either been dealt with or superseded by a re-analysis.
  let reviewVersionId: string | null = null;
  let changes: ProposedChange[] = [];
  let latestVersion: { id: string; version_no: number; row_count: number | null } | null = null;
  let awaitingApply = 0;

  if (datasetIds.length > 0) {
    const { data: versions } = await supabase
      .from('dataset_versions')
      .select('id, version_no, row_count, dataset_id, created_at')
      .in('dataset_id', datasetIds)
      .order('created_at', { ascending: false })
      .limit(1);

    latestVersion = versions?.[0] ?? null;

    const { data: openChanges } = await supabase
      .from('proposed_changes')
      .select(
        'id, group_key, step_type, column_name, title, rationale, confidence, affected_rows, materiality_gbp, status, evidence, dataset_version_id, created_at',
      )
      .eq('workspace_id', workspace.id)
      .in('status', ['pending', 'approved'])
      // Descending, because the enum is declared high -> medium -> low and the
      // queue has to lead with the blocking items. It matters beyond
      // presentation: with the limit below, ascending would be the order that
      // truncates away the blockers.
      .order('confidence', { ascending: false })
      .order('materiality_gbp', { ascending: false, nullsFirst: false })
      .limit(100);

    if (openChanges && openChanges.length > 0) {
      // The newest proposal decides which version the queue is showing, not
      // whichever one happened to sort first. The order above is confidence
      // then materiality, because that is the order a reviewer should read the
      // list in -- taking `[0].dataset_version_id` from it meant the *version*
      // was chosen by confidence too, and a categorisation just proposed
      // against the current version was filtered out of its own queue.
      reviewVersionId = openChanges.reduce((newest, change) =>
        change.created_at > newest.created_at ? change : newest,
      ).dataset_version_id;

      changes = openChanges.filter((change) => change.dataset_version_id === reviewVersionId);

      // Counted across every open version, not just the one on screen. A
      // proposal leaves this set the moment apply_cleaning marks it applied, so
      // anything still `approved` is a decision that has been made and has not
      // reached the data. Advisories are excluded because they never do.
      awaitingApply = openChanges.filter(
        (change) => change.status === 'approved' && !isAdvisory(change.step_type),
      ).length;
    }
  }

  // Column names for the categorise control, from the profile the agent wrote
  // when it measured this version. Read here rather than from the Parquet
  // because the page has no business downloading a dataset to draw a dropdown.
  let profileColumns: string[] = [];
  if (latestVersion) {
    const { data: profile } = await supabase
      .from('dataset_profiles')
      .select('columns')
      .eq('dataset_version_id', latestVersion.id)
      .maybeSingle();

    const raw = (profile?.columns ?? []) as unknown;
    if (Array.isArray(raw)) {
      profileColumns = raw
        .map((entry) =>
          entry && typeof entry === 'object' && 'name' in entry
            ? String((entry as { name: unknown }).name)
            : '',
        )
        // __source_row and the __raw_ shadows are machinery; nobody categorises them.
        .filter((name) => name && !name.startsWith('__'));
    }
  }

  // Files the agent has already written and nobody has been able to find. One
  // definition of "this job left a file", shared with the download control and
  // matching the kinds `/api/exports` will actually sign.
  const readyDownloads = (jobs ?? []).filter((job) => isDownloadable(job)) as DownloadableJob[];
  const latestVersionNo = latestVersion?.version_no ?? null;

  const currentDownloads = readyDownloads.filter((job) => {
    const versionNo = exportVersionNo(job);
    return versionNo === null || latestVersionNo === null || versionNo >= latestVersionNo;
  });
  const supersededDownloads = readyDownloads.filter((job) => !currentDownloads.includes(job));

  const decisions = (reviewVersionId && changes.length > 0 ? changes.length : 0) + (openRun ? 1 : 0);

  // A workspace nobody has uploaded to yet is a different screen. Tabs on it
  // would be three empty rooms and a locked front door.
  const isNew = (uploads ?? []).length === 0 && (jobs ?? []).length === 0;

  const href = (next: Tab) => `/app/workspaces/${workspace.id}?tab=${next}`;

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title={workspace.name}
        subtitle={workspace.client_name ?? 'Client workspace'}
        action={
          !isNew ? (
            <Link
              href={`/app/assistant?w=${workspace.id}`}
              className={secondaryButtonClass('sm')}
            >
              Ask about this client
            </Link>
          ) : null
        }
      />

      {isNew ? (
        <section>
          <SectionHeading description="Store the file exactly as this client sends it. Nothing is modified in place — cleaning writes a new version and leaves the original intact.">
            Start with a file
          </SectionHeading>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
            <Card className="p-5">
              <UploadPanel workspaceId={workspace.id} datasets={datasets ?? []} />
            </Card>
            <EmptyState
              title="Nothing uploaded yet"
              body="Upload the file this client sends you every month. DataEngine learns the workflow from the fixes you approve on the first one."
              steps={[
                'Store the file exactly as it arrived',
                'Choose Analyse and DataEngine reads it, profiles it and finds the problems',
                'Review what it proposes and approve what you want',
                'Next month the same file is cleaned the same way, with only the differences brought back to you',
              ]}
            />
          </div>
        </section>
      ) : (
        <>
          <TabBar
            current={tab}
            tabs={[
              {
                key: 'overview',
                href: href('overview'),
                label: 'Overview',
                // The only count on the bar, because it is the only one that
                // changes what somebody does next.
                hint: decisions > 0 ? decisions : undefined,
              },
              {
                key: 'data',
                href: href('data'),
                label: 'Data',
                hint: (uploads ?? []).length || undefined,
              },
              {
                key: 'history',
                href: href('history'),
                label: 'History',
                hint: operations.length || undefined,
              },
            ]}
          />

          {tab === 'overview' && (
            <div className="space-y-10">
              {openRun ? (
                <DeviationsPanel
                  workspaceId={workspace.id}
                  run={openRun}
                  deviations={runDeviations}
                />
              ) : null}

              {reviewVersionId && changes.length > 0 ? (
                <ReviewQueue
                  workspaceId={workspace.id}
                  datasetVersionId={reviewVersionId}
                  changes={changes}
                />
              ) : null}

              {latestVersion ? (
                <CleanedDataCard
                  workspaceId={workspace.id}
                  version={latestVersion}
                  awaitingApply={awaitingApply}
                  currentDownloads={currentDownloads}
                  supersededDownloads={supersededDownloads}
                  profileColumns={profileColumns}
                />
              ) : (
                <EmptyState
                  title="Nothing cleaned yet"
                  body="A file has been uploaded but not analysed. Open the Data tab and choose Analyse — DataEngine reads it, profiles it and brings back what it proposes to fix."
                />
              )}

              <section>
                <SectionHeading hint="Live">What DataEngine is doing</SectionHeading>
                <AgentPanel
                  workspaceId={workspace.id}
                  initialJobs={jobs ?? []}
                  initialWorkers={workers ?? []}
                />
              </section>
            </div>
          )}

          {tab === 'data' && (
            <div className="space-y-10">
              <section>
                <SectionHeading description="Store the file exactly as this client sends it. Nothing is modified in place — cleaning writes a new version and leaves the original intact.">
                  Upload a file
                </SectionHeading>
                <Card className="max-w-2xl p-5">
                  <UploadPanel workspaceId={workspace.id} datasets={datasets ?? []} />
                </Card>
              </section>

              <section className="min-w-0">
                <SectionHeading
                  hint={uploads && uploads.length > 0 ? `${uploads.length} stored` : undefined}
                >
                  Files
                </SectionHeading>
                {uploads && uploads.length > 0 ? (
                  <WorkspaceFiles
                    workspaceId={workspace.id}
                    uploads={uploads}
                    datasetNames={datasetNames}
                  />
                ) : (
                  <EmptyState
                    title="No files yet"
                    body="Upload the spreadsheet this client sends you and it will be stored here, byte for byte, alongside every version cleaned from it."
                  />
                )}
              </section>

              {/* The log belongs on this tab as well as on Overview: pressing
                  Analyse happens here, and the answer to "did that do
                  anything" should not be one tab away. */}
              <section>
                <SectionHeading hint="Live">What DataEngine is doing</SectionHeading>
                <AgentPanel
                  workspaceId={workspace.id}
                  initialJobs={jobs ?? []}
                  initialWorkers={workers ?? []}
                />
              </section>
            </div>
          )}

          {tab === 'history' && (
            <div id="history" className="scroll-mt-24">
              <SectionHeading description="Everything this workspace has run, with the file each one produced. Results stay downloadable after you leave the page.">
                Operation history
              </SectionHeading>
              <OperationHistory
                operations={operations}
                currentVersionNo={latestVersionNo}
                openOperationId={openOperationId}
                datasetId={datasetFilterId}
                datasetLabel={datasetFilterId ? (datasetNames.get(datasetFilterId) ?? null) : null}
              />
            </div>
          )}
        </>
      )}
    </>
  );
}
