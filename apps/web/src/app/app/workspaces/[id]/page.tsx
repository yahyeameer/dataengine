import { notFound } from 'next/navigation';

import {
  AgentPanel,
  AnalyseButton,
  CategorizeButton,
  DownloadButton,
  ExportButton,
} from '@/components/agent-panel';
import { AskPanel, type Turn } from '@/components/ask-panel';
import {
  DeviationsPanel,
  type Deviation,
  type RecipeRun,
} from '@/components/deviations-panel';
import { ReviewQueue, type ProposedChange } from '@/components/review-queue';
import { UploadPanel } from '@/components/upload-panel';
import {
  Card,
  EmptyState,
  PageHeader,
  RightRail,
  SectionHeading,
  StatusBadge,
} from '@/components/ui';
import { OperationHistory } from '@/components/operation-history';
import { type DownloadableJob, exportVersionNo, isAdvisory } from '@/lib/agent';
import { HISTORY_KINDS, type HistoryJobRow, isDownloadable, toOperations } from '@/lib/history';
import { buildReferences } from '@/lib/references';
import { requireCurrentOrg } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';
import { formatBytes } from '@/lib/storage';

export default async function WorkspacePage({
  params,
  searchParams,
}: PageProps<'/app/workspaces/[id]'>) {
  const { id } = await params;
  // `?op=` and `?dataset=` are how a result becomes addressable: a reference
  // in an answer, a bookmark and a link sent to a colleague all reopen the
  // same row. Both are read as plain strings and only ever compared against
  // rows this workspace already returned, so an id from a stranger's URL
  // matches nothing rather than fetching anything.
  const query = await searchParams;
  const openOperationId = typeof query.op === 'string' ? query.op : null;
  const datasetFilterId = typeof query.dataset === 'string' ? query.dataset : null;
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
    // History, read separately from the live job feed above it. That one is
    // the last twenty of everything including the plumbing, refreshed every
    // few seconds for the panel that shows what is running; this is the
    // operations an accountant would recognise, reaching far enough back to
    // find last month's categorisation. Different questions, different
    // depths, and merging them would compromise both.
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
  // success, because it had succeeded -- it ran, and stopped to ask. Read the
  // most recent unfinished run so the panel can say what it is waiting for.
  const { data: runs } = await supabase
    .from('recipe_runs')
    .select(
      'id, status, dataset_version_in, rows_processed, rows_matched, auto_corrections, automation_rate, invariant_status',
    )
    .eq('workspace_id', workspace.id)
    .in('status', ['needs_review', 'blocked'])
    .order('started_at', { ascending: false })
    .limit(1);

  // The conversation, from the table that has always held it. The panel used
  // to render whichever single turn its React state happened to be holding, so
  // navigating away lost a thread that was still in the database.
  const { data: answers } = await supabase
    .from('hermes_answers')
    .select('request_id, question, answer, status, error, created_at')
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: true })
    .limit(30);

  const turns: Turn[] = (answers ?? []).map((row) => ({
    requestId: row.request_id,
    question: row.question,
    answer: row.answer,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
  }));

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

  // The recoverable record. Built here rather than in the component so the
  // component receives plain data and the page keeps the one query.
  const operations = toOperations((historyJobs ?? []) as HistoryJobRow[], datasetNames);

  // The names an answer might mention that this workspace can actually resolve.
  // Built from the same rows the history renders, so a reference in an answer
  // and the row it points at can never disagree.
  const references = buildReferences(operations, datasets ?? []);
  const datasetIds = (datasets ?? []).map((d) => d.id);

  // The review queue belongs to a version, not to the workspace, so find the
  // most recent version that still has something to decide. Anything older has
  // either been dealt with or superseded by a re-analysis.
  let reviewVersionId: string | null = null;
  let changes: ProposedChange[] = [];
  let latestVersion: { id: string; version_no: number; row_count: number | null } | null = null;
  // Approved, and not yet written into any version. See the note beside the
  // banner below: this is the gap an export falls into.
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
      // whichever one happened to sort first.
      //
      // The order above is confidence then materiality, because that is the
      // order a reviewer should read the list in. Taking `[0].dataset_version_id`
      // from it meant the *version* was chosen by confidence too: one stale
      // blocking finding left on an older version outranked everything, and a
      // categorisation just proposed against the current version was filtered
      // out of its own queue. The job succeeded, the proposal existed, and the
      // screen showed no sign of it.
      reviewVersionId = openChanges.reduce((newest, change) =>
        change.created_at > newest.created_at ? change : newest,
      ).dataset_version_id;

      changes = openChanges.filter(
        (change) => change.dataset_version_id === reviewVersionId,
      );

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

  // Files the agent has already written and nobody has been able to find.
  //
  // Derived from the job list that was fetched anyway rather than a second
  // query. Every export lands here the moment its job succeeds, which is the
  // whole point: the download used to live inline in a job row at the top of
  // the page and at the bottom of a column, and in testing it was missed
  // entirely -- the work completed and the person could not see the result.
  // One definition of "this job left a file", shared with the download control
  // and matching the kinds `/api/exports` will actually sign. The list here
  // used to name `export_dataset` and `generate_report` only, so a
  // categorisation -- the product's main operation -- wrote a workbook that
  // this screen never offered. The file was signed and reachable the whole
  // time; nothing on the page knew to ask for it.
  const readyDownloads = (jobs ?? []).filter((job) =>
    isDownloadable(job),
  ) as DownloadableJob[];

  // Split by the version each file was made from.
  //
  // An export is a snapshot of an immutable version, so applying a cleaning
  // does not update the files already written — it makes them historical. Shown
  // undifferentiated they are a trap: approve a categorisation, export before
  // pressing apply, and the resulting file has no category column while sitting
  // next to one that does under the same "Download Excel" label. Every report of
  // "the categories are missing from my download" is this list.
  // Hoisted out of `latestVersion` because narrowing a `let` does not survive
  // into the callbacks below.
  const latestVersionNo = latestVersion?.version_no ?? null;

  const currentDownloads = readyDownloads.filter((job) => {
    const versionNo = exportVersionNo(job);
    return versionNo === null || latestVersionNo === null || versionNo >= latestVersionNo;
  });
  const supersededDownloads = readyDownloads.filter(
    (job) => !currentDownloads.includes(job),
  );

  const needsDecision = (reviewVersionId && changes.length > 0) || Boolean(openRun);

  // A workspace nobody has uploaded to yet is a different screen. The order
  // below leads with the machinery, which is right once there is work in
  // flight and wrong on day one -- a new customer met "What DataEngine is
  // doing / Nothing has run yet" sitting above the upload form that was the
  // only thing they could actually do.
  const isNew = (uploads ?? []).length === 0 && (jobs ?? []).length === 0;

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title={workspace.name}
        subtitle={workspace.client_name ?? 'Client workspace'}
      />

      {/* Ordered by what the reader came to find out, not by what the system
          does. An accountant opening a client asks "is anything waiting on me"
          before anything else, so decisions come first and the machinery that
          produced them comes after.

          That ordering was right and the layout still buried it: eight full-
          width sections stacked into nine thousand pixels, so the queue that
          needs a decision and the engine log that explains it were never on
          screen together. The decisions, the cleaned result and the question
          box are the column; the machinery — what the engine is doing, what
          has been uploaded — is the rail beside them. */}

      <RightRail
        railLabel="Workspace activity"
        // The rail carries a live job log and every file in the workspace, so
        // it routinely runs past a screen. Pinning it would strand its foot.
        sticky={false}
        rail={
          <>
            <section>
              <SectionHeading hint="Live">What DataEngine is doing</SectionHeading>
              <AgentPanel
                workspaceId={workspace.id}
                initialJobs={jobs ?? []}
                initialWorkers={workers ?? []}
              />
            </section>

            {!isNew ? (
              <section className="min-w-0">
                <SectionHeading
                  hint={uploads && uploads.length > 0 ? `${uploads.length} stored` : undefined}
                >
                  Files
                </SectionHeading>

                <ul className="divide-y divide-border-subtle overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-sm)]">
                  {(uploads ?? []).map((upload) => (
                    <li
                      key={upload.id}
                      className="row-hover flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{upload.original_filename}</p>
                        <p className="mt-0.5 truncate text-xs text-subtle">
                          {upload.dataset_id
                            ? (datasetNames.get(upload.dataset_id) ?? 'Unknown dataset')
                            : 'No dataset'}
                          {' · '}
                          <span className="tabular">
                            {new Date(upload.created_at).toLocaleDateString('en-GB')}
                          </span>
                          {' · '}
                          <span className="tabular">{formatBytes(upload.byte_size)}</span>
                        </p>
                      </div>

                      {/* The action and the state in one slot, so the column
                          reads straight down even where one row offers Analyse
                          and the next only says "no dataset". */}
                      <div className="flex shrink-0 items-center gap-2">
                        {upload.status === 'stored' ? (
                          <AnalyseButton
                            workspaceId={workspace.id}
                            uploadId={upload.id}
                            datasetId={upload.dataset_id}
                          />
                        ) : null}
                        <StatusBadge status={upload.status} />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {!isNew ? (
              <section>
                <SectionHeading description="Files are stored exactly as they arrived. Nothing is modified in place — cleaning writes a new version and leaves the original intact.">
                  Upload a file
                </SectionHeading>
                <Card className="p-5">
                  <UploadPanel workspaceId={workspace.id} datasets={datasets ?? []} />
                </Card>
              </section>
            ) : null}
          </>
        }
      >

      {needsDecision ? (
        <div className="mb-10 space-y-6">
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
        </div>
      ) : null}

      {isNew ? (
        <section className="mb-10">
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
      ) : null}

      {latestVersion ? (
        <div className="mb-10">
          <SectionHeading
            hint={`v${latestVersion.version_no}${
              latestVersion.row_count !== null
                ? ` · ${latestVersion.row_count.toLocaleString('en-GB')} rows`
                : ''
            }`}
          >
            Cleaned data
          </SectionHeading>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-4 p-5">
              <div className="min-w-0">
                <p className="text-sm font-medium">Version {latestVersion.version_no} is ready</p>
                <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted">
                  This is the cleaned result. The file you uploaded is untouched and still
                  available.
                </p>
              </div>
              <ExportButton
                workspaceId={workspace.id}
                datasetVersionId={latestVersion.id}
                versionNo={latestVersion.version_no}
              />
            </div>

            {/* Approving is not applying, and an export taken between the two
                is the file that started every "where did my categories go"
                question. Approval records a decision; the column is written
                when apply_cleaning runs and makes a new version. Saying so at
                the export control, rather than only in the review queue
                further up the page, is the difference between a rule somebody
                knows and a rule somebody meets. */}
            {awaitingApply > 0 ? (
              <div className="border-t border-warning/30 bg-warning-soft/40 px-5 py-4">
                <p className="text-sm leading-relaxed">
                  <span className="font-medium">
                    {awaitingApply} approved change{awaitingApply === 1 ? '' : 's'}{' '}
                    {awaitingApply === 1 ? 'is' : 'are'} not in version{' '}
                    {latestVersion.version_no} yet.
                  </span>{' '}
                  <span className="text-muted">
                    Approving records the decision; the data changes when you choose{' '}
                    <em>Apply and create a new version</em> above. Anything exported now will
                    not contain {awaitingApply === 1 ? 'it' : 'them'}.
                  </span>
                </p>
              </div>
            ) : null}

            {currentDownloads.length > 0 ? (
              <div className="border-t border-border bg-surface-2/40 px-5 py-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">
                  Ready to download · version {latestVersion.version_no} (
                  {currentDownloads.length})
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {currentDownloads.map((job) => (
                    <DownloadButton
                      key={job.id}
                      job={job}
                      currentVersionNo={latestVersionNo}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <p className="border-t border-border bg-surface-2/40 px-5 py-4 text-xs leading-relaxed text-subtle">
                Choose a format above. The file takes a few seconds to prepare, then a download
                button appears here.
              </p>
            )}

            {supersededDownloads.length > 0 ? (
              <details className="border-t border-border px-5 py-4">
                <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">
                  Earlier versions ({supersededDownloads.length})
                </summary>
                <p className="mt-2 max-w-prose text-xs leading-relaxed text-subtle">
                  Made before the latest changes were applied. Still correct for the version
                  they came from, and not what you want if you are after the current figures.
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {supersededDownloads.map((job) => (
                    <DownloadButton
                      key={job.id}
                      job={job}
                      currentVersionNo={latestVersionNo}
                    />
                  ))}
                </div>
              </details>
            ) : null}

            {profileColumns.length > 0 ? (
              <div className="border-t border-border p-5">
                <CategorizeButton
                  workspaceId={workspace.id}
                  datasetVersionId={latestVersion.id}
                  columns={profileColumns}
                />
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      {/* Offered only once there is something to ask about. On a workspace with
          no data the panel invited a question nothing could answer. */}
      {!isNew ? (
        <div className="mb-10">
          <SectionHeading hint="Reads this workspace only">Ask about this data</SectionHeading>
          <AskPanel
            workspaceId={workspace.id}
            initialTurns={turns}
            references={references}
          />
        </div>
      ) : null}

      {/* The way back to work that is already finished.

          It sits after the current result and before nothing, which is where
          somebody looks once they have established that today's file is not
          the one they came for. Every row is a job that has always been in the
          database; what was missing was an address for it. */}
      {!isNew ? (
        <div className="mb-10 scroll-mt-24" id="history">
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
      ) : null}

      </RightRail>
    </>
  );
}
