import Link from 'next/link';

import { Badge, EmptyState, PageHeader, Stat, TableShell, Td, Th, tableBodyClass } from '@/components/ui';
import { requireCurrentOrg } from '@/lib/authz';
import { parseReportConfig, parseSteps, safetySummary } from '@/lib/recipes';
import { createServerSupabase } from '@/lib/supabase/server';

export const metadata = { title: 'Recipes · DataEngine' };

/**
 * Every workflow this practice has learned, and whether it is still working.
 *
 * A recipe was previously something the product wrote and nobody could see: it
 * was captured when an accountant approved a month's cleaning, matched on the
 * next upload, and replayed — all of it inferred from a job feed. That is fine
 * until the first time a replay does something surprising, at which point "what
 * does this recipe actually do, and since when" is a question with no screen.
 *
 * The list is ordered by what needs attention rather than by name: a recipe
 * whose last run failed is the reason somebody opened this page.
 *
 * Search and the workspace filter are `?q=` and `?workspace=` rather than
 * client state, for the same reason the workspace tabs are — a filtered view
 * somebody wants to send to a colleague has to have a URL.
 */
export default async function RecipesPage({ searchParams }: PageProps<'/app/recipes'>) {
  const query = await searchParams;
  const search = typeof query.q === 'string' ? query.q.trim() : '';
  const workspaceFilter = typeof query.workspace === 'string' ? query.workspace : '';

  const { org } = await requireCurrentOrg();
  const supabase = await createServerSupabase();

  const { data: workspaces } = await supabase
    .from('workspaces')
    .select('id, name, client_name')
    .eq('org_id', org.id)
    .eq('status', 'active')
    .order('name');

  const workspaceIds = (workspaces ?? []).map((workspace) => workspace.id);
  const scopedIds = workspaceFilter
    ? workspaceIds.filter((id) => id === workspaceFilter)
    : workspaceIds;

  // RLS already scopes recipes to workspaces the caller belongs to. The
  // explicit id list is the server-side half of the same check, and it is what
  // makes the workspace filter a filter rather than a suggestion.
  const { data: recipes } = scopedIds.length
    ? await supabase
        .from('cleaning_recipes')
        .select(
          'id, name, description, enabled, workspace_id, dataset_id, source_signature, current_version_id, created_at, updated_at',
        )
        .in('workspace_id', scopedIds)
        .order('updated_at', { ascending: false })
    : { data: [] };

  const filtered = (recipes ?? []).filter((recipe) =>
    search
      ? `${recipe.name} ${recipe.description ?? ''}`.toLowerCase().includes(search.toLowerCase())
      : true,
  );

  const versionIds = filtered
    .map((recipe) => recipe.current_version_id)
    .filter((id): id is string => Boolean(id));

  const [{ data: versions }, { data: runs }] = await Promise.all([
    versionIds.length
      ? supabase
          .from('recipe_versions')
          .select('id, recipe_id, version_no, steps, report_config')
          .in('id', versionIds)
      : Promise.resolve({ data: [] }),
    scopedIds.length
      ? supabase
          .from('recipe_runs')
          .select('id, recipe_version_id, status, started_at')
          .in('workspace_id', scopedIds)
          .order('started_at', { ascending: false })
          .limit(500)
      : Promise.resolve({ data: [] }),
  ]);

  const versionById = new Map((versions ?? []).map((version) => [version.id, version]));
  const versionToRecipe = new Map(
    (versions ?? []).map((version) => [version.id, version.recipe_id]),
  );

  // Run history keyed by recipe rather than by version: "12 successful, 1
  // failed" is a fact about the workflow, and splitting it per version would
  // reset the count every time somebody fixed a step.
  const runStats = new Map<string, { total: number; failed: number; last: string | null }>();
  for (const run of runs ?? []) {
    const recipeId = versionToRecipe.get(run.recipe_version_id);
    if (!recipeId) continue;
    const entry = runStats.get(recipeId) ?? { total: 0, failed: 0, last: null };
    entry.total += 1;
    if (run.status === 'failed' || run.status === 'blocked') entry.failed += 1;
    if (!entry.last) entry.last = run.started_at;
    runStats.set(recipeId, entry);
  }

  const workspaceNames = new Map(
    (workspaces ?? []).map((workspace) => [workspace.id, workspace.client_name || workspace.name]),
  );

  const sorted = [...filtered].sort((a, b) => {
    const failedA = runStats.get(a.id)?.failed ?? 0;
    const failedB = runStats.get(b.id)?.failed ?? 0;
    if (failedA !== failedB) return failedB - failedA;
    return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
  });

  const active = filtered.filter((recipe) => recipe.enabled).length;
  const totalRuns = [...runStats.values()].reduce((sum, entry) => sum + entry.total, 0);

  return (
    <div>
      <PageHeader
        eyebrow="Repeatable work"
        title="Recipes"
        subtitle="A recipe is a month's approved cleaning, written down so next month's file can be run rather than reviewed."
      />

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Stat label="Recipes" value={String(filtered.length)} />
        <Stat label="Active" value={String(active)} />
        <Stat label="Runs recorded" value={String(totalRuns)} />
      </div>

      <form className="mb-6 flex flex-wrap items-end gap-3" method="get">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Search</span>
          <input
            name="q"
            defaultValue={search}
            placeholder="Name or description"
            className="h-10 w-64 max-w-full rounded-[var(--radius)] border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Workspace</span>
          <select
            name="workspace"
            defaultValue={workspaceFilter}
            className="h-10 rounded-[var(--radius)] border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
          >
            <option value="">All workspaces</option>
            {(workspaces ?? []).map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.client_name || workspace.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="h-10 rounded-[var(--radius)] border border-border bg-surface-2 px-4 text-sm font-medium"
        >
          Filter
        </button>
      </form>

      {sorted.length === 0 ? (
        <EmptyState
          title={search || workspaceFilter ? 'No recipes match' : 'No recipes yet'}
          body={
            search || workspaceFilter
              ? 'Nothing here matches that filter.'
              : 'Upload a month, approve the cleaning, and the workflow is saved as a recipe you can replay against next month.'
          }
        />
      ) : (
        <TableShell>
          <thead>
            <tr>
              <Th>Recipe</Th>
              <Th>Workspace</Th>
              <Th>Version</Th>
              <Th>Steps</Th>
              <Th>Report</Th>
              <Th>Runs</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className={tableBodyClass}>
            {sorted.map((recipe) => {
              const version = recipe.current_version_id
                ? versionById.get(recipe.current_version_id)
                : null;
              const steps = parseSteps(version?.steps);
              const safety = safetySummary(steps);
              const reportConfig = parseReportConfig(version?.report_config);
              const stats = runStats.get(recipe.id);

              return (
                <tr key={recipe.id}>
                  <Td>
                    <Link href={`/app/recipes/${recipe.id}`} className="font-medium hover:underline">
                      {recipe.name}
                    </Link>
                    {recipe.description && (
                      <span className="mt-0.5 block max-w-md truncate text-xs text-subtle">
                        {recipe.description}
                      </span>
                    )}
                  </Td>
                  <Td>{workspaceNames.get(recipe.workspace_id) ?? '—'}</Td>
                  <Td>{version ? `v${version.version_no}` : '—'}</Td>
                  <Td>
                    {steps.length}
                    {safety.review_required > 0 && (
                      <span className="ml-2 text-xs text-warning">
                        {safety.review_required} need approval
                      </span>
                    )}
                  </Td>
                  <Td>{reportConfig ? reportConfig.formats.join(', ').toUpperCase() : '—'}</Td>
                  <Td>
                    {stats ? `${stats.total - stats.failed} ok` : '—'}
                    {stats && stats.failed > 0 && (
                      <span className="ml-2 text-xs text-danger">{stats.failed} failed</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={recipe.enabled ? 'success' : 'neutral'}>
                      {recipe.enabled ? 'Active' : 'Disabled'}
                    </Badge>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </TableShell>
      )}
    </div>
  );
}
