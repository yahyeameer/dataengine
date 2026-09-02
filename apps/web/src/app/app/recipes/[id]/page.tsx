import Link from 'next/link';
import { notFound } from 'next/navigation';

import { RecipeActions } from '@/components/recipe-actions';
import { RecipeSchedulePanel, type ScheduleFiring } from '@/components/recipe-schedule';
import {
  Badge,
  Card,
  EmptyState,
  Fact,
  PageHeader,
  SectionHeading,
  Stat,
  StatusBadge,
  TableShell,
  Td,
  Th,
  tableBodyClass,
} from '@/components/ui';
import { requireCurrentOrg } from '@/lib/authz';
import { parseReportConfig, parseSteps, safetyOf, safetySummary, stepLabel } from '@/lib/recipes';
import type { RecipeSchedule } from '@/lib/schedules';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * One recipe: what it does, what it has done, and what it will need a person
 * for.
 *
 * The order on the page is the order the work happens in — input, cleaning,
 * checks, report, brand — because that is the sequence somebody is checking
 * against when they ask "will this do the right thing to next month's file".
 *
 * Two things are stated rather than implied. Every step carries its safety
 * classification, so "this recipe changes financial values" is visible without
 * running it. And the brand section says the recipe *references* the
 * organisation's branding rather than storing a copy — which is why renaming
 * the business changes next month's report and leaves last month's alone.
 */
export default async function RecipeDetailPage({ params }: PageProps<'/app/recipes/[id]'>) {
  const { id } = await params;
  const { org, role } = await requireCurrentOrg();
  const supabase = await createServerSupabase();

  const { data: recipe } = await supabase
    .from('cleaning_recipes')
    .select(
      'id, name, description, enabled, workspace_id, dataset_id, source_signature, current_version_id, created_at, updated_at',
    )
    .eq('id', id)
    .maybeSingle();

  if (!recipe) notFound();

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, name, client_name, org_id')
    .eq('id', recipe.workspace_id)
    .maybeSingle();

  // RLS would already have hidden a recipe belonging to another tenant. The
  // org comparison is the second lock, and a mismatch is a 404 rather than a
  // 403 so the page never confirms that somebody else's id is real.
  if (!workspace || workspace.org_id !== org.id) notFound();

  const [{ data: versions }, { data: dataset }, { data: branding }] = await Promise.all([
    supabase
      .from('recipe_versions')
      .select('id, version_no, steps, invariants, report_config, change_note, created_at')
      .eq('recipe_id', recipe.id)
      .order('version_no', { ascending: false }),
    recipe.dataset_id
      ? supabase.from('datasets').select('id, name').eq('id', recipe.dataset_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from('organization_branding')
      .select('business_name, accent_color, logo_storage_path, footer_text')
      .eq('organization_id', org.id)
      .maybeSingle(),
  ]);

  const versionIds = (versions ?? []).map((version) => version.id);
  const { data: runs } = versionIds.length
    ? await supabase
        .from('recipe_runs')
        .select(
          'id, recipe_version_id, status, rows_processed, auto_corrections, deviations_count, automation_rate, invariant_status, started_at, finished_at, dataset_version_out, report_artifact_id',
        )
        .in('recipe_version_id', versionIds)
        .order('started_at', { ascending: false })
        .limit(30)
    : { data: [] };

  // The schedule and its firings. Read after the runs because the panel shows
  // both: what is configured, and what it has actually done.
  const { data: schedule } = await supabase
    .from('recipe_schedules')
    .select(
      'id, enabled, frequency, day_of_month, day_of_week, hour, minute, timezone, next_run_at, last_run_at, last_status, last_error, consecutive_failures',
    )
    .eq('recipe_id', recipe.id)
    .maybeSingle();

  const { data: firings } = schedule
    ? await supabase
        .from('recipe_schedule_runs')
        .select('id, scheduled_for, fired_at, status, detail, job_id')
        .eq('schedule_id', schedule.id)
        .order('scheduled_for', { ascending: false })
        .limit(12)
    : { data: [] };

  const reportIds = (runs ?? [])
    .map((run) => run.report_artifact_id)
    .filter((value): value is string => Boolean(value));

  const { data: reports } = reportIds.length
    ? await supabase
        .from('report_artifacts')
        .select('id, status, formats, branding_snapshot, period, generated_at')
        .in('id', reportIds)
    : { data: [] };

  const reportById = new Map((reports ?? []).map((report) => [report.id, report]));

  const current = (versions ?? []).find((version) => version.id === recipe.current_version_id)
    ?? (versions ?? [])[0]
    ?? null;

  const steps = parseSteps(current?.steps);
  const summary = safetySummary(steps);
  const reportConfig = parseReportConfig(current?.report_config);
  const invariants = Array.isArray(current?.invariants) ? current.invariants : [];

  const succeeded = (runs ?? []).filter((run) => run.status === 'succeeded').length;
  const failed = (runs ?? []).filter(
    (run) => run.status === 'failed' || run.status === 'blocked',
  ).length;
  const lastRun = (runs ?? [])[0] ?? null;
  const isAdmin = role === 'owner' || role === 'admin';

  return (
    <div>
      <PageHeader
        eyebrow={workspace.client_name || workspace.name}
        title={recipe.name}
        subtitle={recipe.description ?? undefined}
        action={
          <RecipeActions
            recipeId={recipe.id}
            workspaceId={recipe.workspace_id}
            enabled={recipe.enabled}
            reportFormats={reportConfig?.formats ?? []}
            canEdit={isAdmin}
          />
        }
      />

      <div className="mb-8 grid gap-4 sm:grid-cols-4">
        <Stat
          label="Status"
          value={recipe.enabled ? 'Active' : 'Disabled'}
          tone={recipe.enabled ? 'accent' : 'neutral'}
        />
        <Stat label="Version" value={current ? `v${current.version_no}` : '—'} />
        <Stat label="Successful runs" value={String(succeeded)} />
        <Stat
          label="Failed or blocked"
          value={String(failed)}
          tone={failed > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <section>
            <SectionHeading
              description="Every step names an operation the cleaning engine implements. A recipe never carries SQL, Python or a shell command."
              hint={
                summary.review_required > 0
                  ? `${summary.review_required} step(s) stop for approval`
                  : 'all steps are in the safe tier'
              }
            >
              Cleaning
            </SectionHeading>

            {steps.length === 0 ? (
              <EmptyState title="No steps" body="This recipe has no current version to show." />
            ) : (
              <Card>
                <ul className="divide-y divide-border-subtle">
                  {steps.map((step, index) => {
                    const safety = safetyOf(step.op ?? '');
                    return (
                      <li
                        key={step.id ?? index}
                        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                      >
                        <span className="min-w-0">
                          <span className="font-mono text-[11px] text-subtle">
                            {step.id ?? `step_${index + 1}`}
                          </span>
                          <span className="ml-3 text-sm">{stepLabel(step)}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          {step.enabled === false && <Badge tone="neutral">Disabled</Badge>}
                          <Badge
                            tone={
                              safety === 'safe'
                                ? 'success'
                                : safety === 'review_required'
                                  ? 'warning'
                                  : 'danger'
                            }
                          >
                            {safety === 'safe'
                              ? 'Safe'
                              : safety === 'review_required'
                                ? 'Review required'
                                : 'Not permitted'}
                          </Badge>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
          </section>

          <section>
            <SectionHeading description="Checks that run after the steps. A run with no deviations can still fail here — that is the guard against a file that kept its shape and changed its meaning.">
              Validation
            </SectionHeading>
            {invariants.length === 0 ? (
              <EmptyState title="No invariants" body="This recipe carries no post-run checks." />
            ) : (
              <Card>
                <ul className="divide-y divide-border-subtle">
                  {invariants.map((invariant, index) => {
                    const item = invariant as { id?: string; type?: string; severity?: string };
                    return (
                      <li
                        key={item.id ?? index}
                        className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                      >
                        <span>{item.id ?? item.type}</span>
                        <Badge tone={item.severity === 'block' ? 'danger' : 'warning'}>
                          {item.severity ?? 'review'}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
          </section>

          <section>
            <SectionHeading description="What a completed run produces. A run that stops for review produces nothing — a report about rows nobody has approved would carry the client's name on figures they have not seen.">
              Report
            </SectionHeading>
            <Card>
              <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
                <Fact label="Formats">
                  {reportConfig ? reportConfig.formats.join(', ').toUpperCase() : 'None configured'}
                </Fact>
                <Fact label="Title">{reportConfig?.title ?? 'The dataset name'}</Fact>
              </div>
            </Card>
          </section>

          <RecipeSchedulePanel
            workspaceId={recipe.workspace_id}
            recipeId={recipe.id}
            schedule={(schedule ?? null) as RecipeSchedule | null}
            firings={(firings ?? []) as ScheduleFiring[]}
            canEdit={isAdmin}
          />

          <section>
            <SectionHeading description="What actually happened, newest first.">
              Run history
            </SectionHeading>
            {(runs ?? []).length === 0 ? (
              <EmptyState
                title="Never run"
                body="Upload a file matching this recipe's layout and it will be replayed automatically."
              />
            ) : (
              <TableShell minWidth="48rem">
                <thead>
                  <tr>
                    <Th>Started</Th>
                    <Th>Status</Th>
                    <Th align="right">Rows</Th>
                    <Th align="right">Auto-fixes</Th>
                    <Th align="right">Deviations</Th>
                    <Th>Invariants</Th>
                    <Th>Report</Th>
                  </tr>
                </thead>
                <tbody className={tableBodyClass}>
                  {(runs ?? []).map((run) => {
                    const report = run.report_artifact_id
                      ? reportById.get(run.report_artifact_id)
                      : null;
                    return (
                      <tr key={run.id}>
                        <Td>{new Date(run.started_at).toLocaleString('en-GB')}</Td>
                        <Td>
                          <StatusBadge status={run.status} />
                        </Td>
                        <Td align="right">{run.rows_processed?.toLocaleString('en-GB') ?? '—'}</Td>
                        <Td align="right">{run.auto_corrections}</Td>
                        <Td align="right">{run.deviations_count}</Td>
                        <Td>{run.invariant_status ?? '—'}</Td>
                        <Td>
                          {report ? (
                            <span title={JSON.stringify(report.branding_snapshot)}>
                              {report.status}
                            </span>
                          ) : (
                            '—'
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableShell>
            )}
          </section>
        </div>

        <aside className="space-y-6">
          <section>
            <SectionHeading>Input</SectionHeading>
            <Card>
              <div className="space-y-3 px-4 py-4">
                <Fact label="Dataset">{dataset?.name ?? 'Any matching upload'}</Fact>
                <Fact label="Workspace">
                  <Link
                    href={`/app/workspaces/${workspace.id}`}
                    className="text-accent hover:underline"
                  >
                    {workspace.client_name || workspace.name}
                  </Link>
                </Fact>
                <Fact label="Matches files shaped like">
                  <span className="break-all font-mono text-xs">
                    {recipe.source_signature ?? 'not yet fingerprinted'}
                  </span>
                </Fact>
              </div>
            </Card>
          </section>

          <section>
            <SectionHeading description="A recipe points at the organisation's branding rather than copying it, so a rename reaches next month's report and leaves last month's alone.">
              Brand
            </SectionHeading>
            <Card>
              <div className="space-y-3 px-4 py-4">
                <Fact label="Business name">
                  {branding?.business_name ?? org.name}
                </Fact>
                <Fact label="Logo">
                  {branding?.logo_storage_path ? 'Uploaded' : 'None — reports use a text header'}
                </Fact>
                <Fact label="Accent">
                  {branding?.accent_color ?? 'DataEngine default'}
                </Fact>
                <Link
                  href="/app/settings/branding"
                  className="inline-block text-sm text-accent hover:underline"
                >
                  Change branding
                </Link>
              </div>
            </Card>
          </section>

          <section>
            <SectionHeading description="Immutable. Changing a recipe writes a new version; historical runs keep pointing at the one they used.">
              Versions
            </SectionHeading>
            <Card>
              <ul className="divide-y divide-border-subtle">
                {(versions ?? []).map((version) => (
                  <li key={version.id} className="px-4 py-3 text-sm">
                    <span className="flex items-center justify-between gap-3">
                      <span className="font-medium">v{version.version_no}</span>
                      {version.id === recipe.current_version_id && (
                        <Badge tone="accent">Current</Badge>
                      )}
                    </span>
                    <span className="mt-1 block text-xs text-subtle">
                      {new Date(version.created_at).toLocaleDateString('en-GB')}
                      {version.change_note ? ` · ${version.change_note}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </section>

          {lastRun && (
            <section>
              <SectionHeading>Last run</SectionHeading>
              <Card>
                <div className="space-y-3 px-4 py-4">
                  <Fact label="When">
                    {new Date(lastRun.started_at).toLocaleString('en-GB')}
                  </Fact>
                  <Fact label="Automation rate">
                    {lastRun.automation_rate === null
                      ? '—'
                      : `${Math.round(Number(lastRun.automation_rate) * 100)}%`}
                  </Fact>
                </div>
              </Card>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
