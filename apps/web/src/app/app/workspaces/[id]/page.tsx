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
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
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

  return (
    <>
      <PageHeader title={workspace.name} subtitle={workspace.client_name ?? 'Client workspace'} />

      <div className="mb-6">
        <AgentPanel
          workspaceId={workspace.id}
          initialJobs={jobs ?? []}
          initialWorkers={workers ?? []}
        />
      </div>

      {latestVersion ? (
        <section className="mb-6 rounded-lg border border-emerald-600/40 bg-emerald-500/5 px-4 py-5 text-center">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-300">
            Cleaned data ready
          </h2>
          <p className="mt-1 text-xs opacity-70">
            Version {latestVersion.version_no}
            {latestVersion.row_count !== null ? ` · ${latestVersion.row_count} rows` : ''} · the
            original file is untouched
          </p>

          <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
            <ExportButton workspaceId={workspace.id} datasetVersionId={latestVersion.id} />
          </div>

          {readyDownloads.length > 0 ? (
            <div className="mt-4 border-t border-emerald-600/20 pt-3">
              <p className="text-xs font-medium opacity-70">
                Ready to download ({readyDownloads.length})
              </p>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                {readyDownloads.map((job) => (
                  <DownloadButton key={job.id} job={job} />
                ))}
              </div>
            </div>
          ) : (
            <p className="mt-3 text-xs opacity-60">
              Choose a format above. The file takes a few seconds to prepare, then a download
              button appears here.
            </p>
          )}
        </section>
      ) : null}

      {openRun ? (
        <div className="mb-8">
          <DeviationsPanel
            workspaceId={workspace.id}
            run={openRun}
            deviations={runDeviations}
          />
        </div>
      ) : null}

      <div className="mb-6">
        <AskPanel workspaceId={workspace.id} />
      </div>

      {latestVersion && profileColumns.length > 0 ? (
        <div className="mb-6">
          <CategorizeButton
            workspaceId={workspace.id}
            datasetVersionId={latestVersion.id}
            columns={profileColumns}
          />
        </div>
      ) : null}

      {reviewVersionId && changes.length > 0 ? (
        <div className="mb-8">
          <ReviewQueue
            workspaceId={workspace.id}
            datasetVersionId={reviewVersionId}
            changes={changes}
          />
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide opacity-60">
            Upload a file
          </h2>
          <Card className="p-5">
            <UploadPanel workspaceId={workspace.id} datasets={datasets ?? []} />
          </Card>
          <p className="mt-3 text-xs opacity-60">
            Files are stored exactly as they arrived. Nothing is modified in place — cleaning writes
            a new version and leaves the original intact.
          </p>

          {latestVersion ? (
            <>
              <p className="mt-3 text-xs opacity-60">
                Latest dataset version: v{latestVersion.version_no}
                {latestVersion.row_count !== null ? ` · ${latestVersion.row_count} rows` : ''}
              </p>
            </>
          ) : null}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide opacity-60">Uploads</h2>

          {!uploads || uploads.length === 0 ? (
            <EmptyState
              title="Nothing uploaded yet"
              body="Upload the file this client sends you every month. Once it is stored, hand it to the agent and it will read it, profile it and tell you what needs fixing."
            />
          ) : (
            <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/15">
              {uploads.map((upload) => (
                <li key={upload.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{upload.original_filename}</p>
                    <p className="text-xs opacity-60">
                      {upload.dataset_id
                        ? (datasetNames.get(upload.dataset_id) ?? 'Unknown dataset')
                        : 'No dataset'}
                      {' · '}
                      {new Date(upload.created_at).toLocaleString('en-GB')}
                      {' · '}
                      {formatBytes(upload.byte_size)}
                    </p>
                  </div>

                  {upload.status === 'stored' ? (
                    <AnalyseButton
                      workspaceId={workspace.id}
                      uploadId={upload.id}
                      datasetId={upload.dataset_id}
                    />
                  ) : null}

                  <StatusBadge status={upload.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
