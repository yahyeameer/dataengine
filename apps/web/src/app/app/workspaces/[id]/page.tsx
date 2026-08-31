import { notFound } from 'next/navigation';

import {
  AgentPanel,
  AnalyseButton,
  CategorizeButton,
  DownloadButton,
  type DownloadableJob,
  ExportButton,
} from '@/components/agent-panel';
import { AskPanel } from '@/components/ask-panel';
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
  SectionHeading,
  StatusBadge,
} from '@/components/ui';
import { requireCurrentOrg } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';
import { formatBytes } from '@/lib/storage';

export default async function WorkspacePage({ params }: PageProps<'/app/workspaces/[id]'>) {
  const { id } = await params;
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

  const [{ data: datasets }, { data: uploads }, { data: jobs }, { data: workers }] =
    await Promise.all([
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
  const datasetIds = (datasets ?? []).map((d) => d.id);

  // The review queue belongs to a version, not to the workspace, so find the
  // most recent version that still has something to decide. Anything older has
  // either been dealt with or superseded by a re-analysis.
  let reviewVersionId: string | null = null;
  let changes: ProposedChange[] = [];
  let latestVersion: { id: string; version_no: number; row_count: number | null } | null = null;

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
        'id, group_key, step_type, column_name, title, rationale, confidence, affected_rows, materiality_gbp, status, evidence, dataset_version_id',
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
      reviewVersionId = openChanges[0].dataset_version_id;
      changes = openChanges.filter(
        (change) => change.dataset_version_id === reviewVersionId,
      );
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
  const readyDownloads = (jobs ?? []).filter(
    (job) =>
      job.status === 'succeeded' &&
      (job.kind === 'export_dataset' || job.kind === 'generate_report'),
  ) as DownloadableJob[];

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
          produced them comes after. */}

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

      <div className="mb-10">
        <SectionHeading hint="Live">What DataEngine is doing</SectionHeading>
        <AgentPanel
          workspaceId={workspace.id}
          initialJobs={jobs ?? []}
          initialWorkers={workers ?? []}
        />
      </div>

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
              <ExportButton workspaceId={workspace.id} datasetVersionId={latestVersion.id} />
            </div>

            {readyDownloads.length > 0 ? (
              <div className="border-t border-border bg-surface-2/40 px-5 py-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">
                  Ready to download ({readyDownloads.length})
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {readyDownloads.map((job) => (
                    <DownloadButton key={job.id} job={job} />
                  ))}
                </div>
              </div>
            ) : (
              <p className="border-t border-border bg-surface-2/40 px-5 py-4 text-xs leading-relaxed text-subtle">
                Choose a format above. The file takes a few seconds to prepare, then a download
                button appears here.
              </p>
            )}

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
          <AskPanel workspaceId={workspace.id} />
        </div>
      ) : null}

      {!isNew ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
          <section>
            <SectionHeading description="Files are stored exactly as they arrived. Nothing is modified in place — cleaning writes a new version and leaves the original intact.">
              Upload a file
            </SectionHeading>
            <Card className="p-5">
              <UploadPanel workspaceId={workspace.id} datasets={datasets ?? []} />
            </Card>
          </section>

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
                  className="row-hover flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{upload.original_filename}</p>
                    <p className="mt-0.5 truncate text-xs text-subtle">
                      {upload.dataset_id
                        ? (datasetNames.get(upload.dataset_id) ?? 'Unknown dataset')
                        : 'No dataset'}
                      {' · '}
                      <span className="tabular">
                        {new Date(upload.created_at).toLocaleString('en-GB')}
                      </span>
                      {' · '}
                      <span className="tabular">{formatBytes(upload.byte_size)}</span>
                    </p>
                  </div>

                  {/* The action and the state in one slot, so the column reads
                      straight down even where one row offers Analyse and the
                      next only says "no dataset". */}
                  <div className="flex shrink-0 items-center gap-2.5">
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
        </div>
      ) : null}
    </>
  );
}
