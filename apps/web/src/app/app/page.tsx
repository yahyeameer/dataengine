import { CategoriseFlow } from '@/components/categorise-flow';
import { OperationHistory } from '@/components/operation-history';
import { SectionHeading } from '@/components/ui';
import { requireCurrentOrg } from '@/lib/authz';
import { type HistoryJobRow, toOperations } from '@/lib/history';
import { createServerSupabase } from '@/lib/supabase/server';

export const metadata = { title: 'Categorise · DataEngine' };

/**
 * The first screen after signing in, and deliberately the smallest one.
 *
 * It used to be a directory of workspaces — accurate, and an answer to a
 * question the accountant had not asked yet. What they came to do is get a file
 * categorised, so that is what is here, and the directory has moved one click
 * away to /app/workspaces.
 *
 * --- why this screen fetches anything ---------------------------------------
 * It used to fetch nothing, on the reasoning that the flow resolves its own
 * workspace on the first upload. That was right about the upload and wrong
 * about the return visit. The flow holds its run in React state keyed on an
 * upload id, so leaving this page dropped the only reference anybody had to a
 * finished categorisation -- the workbook stayed in the exports bucket, still
 * signed on request, with nothing left that could name it. A customer who
 * closed the tab had lost the file in every sense that matters to them.
 *
 * So the screen they land on is also the screen that remembers. The list below
 * is read from `agent_jobs`, which recorded every one of those runs all along.
 */
export default async function CategorisePage() {
  const { org } = await requireCurrentOrg();
  const supabase = await createServerSupabase();

  // Categorisation only, and only for this organisation. The whole record --
  // cleaning, analyses, reports, exports, per workspace -- is one click away in
  // the workspace itself; what belongs here is the thing this screen does.
  //
  // RLS already scopes `agent_jobs` to the caller's organisations. The explicit
  // filter is the server-side half of the same check, as everywhere else.
  const { data: recent } = await supabase
    .from('agent_jobs')
    .select(
      'id, kind, status, result, error, created_at, finished_at, dataset_id, dataset_version_id',
    )
    .eq('org_id', org.id)
    .in('kind', ['categorise_statement', 'categorize_dataset'])
    .order('created_at', { ascending: false })
    .limit(8);

  const operations = toOperations((recent ?? []) as HistoryJobRow[]);

  return (
    <div className="py-6 sm:py-12">
      <CategoriseFlow />

      {operations.length > 0 && (
        <section className="mt-14">
          <SectionHeading description="Files you have categorised before. Each one can be opened and downloaded again — nothing here depends on the tab you ran it in.">
            Earlier categorisations
          </SectionHeading>
          <OperationHistory operations={operations} />
        </section>
      )}
    </div>
  );
}
