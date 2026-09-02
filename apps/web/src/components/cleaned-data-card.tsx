import { CategorizeButton, DownloadButton, ExportButton } from '@/components/agent-panel';
import { Card, SectionHeading } from '@/components/ui';
import type { DownloadableJob } from '@/lib/agent';

/**
 * The result, and everything you can do with it.
 *
 * Lifted out of the workspace page, which had grown to six hundred lines of
 * mixed querying and markup and was the thing this redesign was asked to fix.
 * It takes plain data and renders it; every figure below is passed in, and
 * there is no fetch in this file.
 */
export function CleanedDataCard({
  workspaceId,
  version,
  awaitingApply,
  currentDownloads,
  supersededDownloads,
  profileColumns,
}: {
  workspaceId: string;
  version: { id: string; version_no: number; row_count: number | null };
  /**
   * Approved, and not yet written into any version. See the banner below: this
   * is the gap an export falls into.
   */
  awaitingApply: number;
  currentDownloads: DownloadableJob[];
  supersededDownloads: DownloadableJob[];
  profileColumns: string[];
}) {
  return (
    <div>
      <SectionHeading
        hint={`v${version.version_no}${
          version.row_count !== null
            ? ` · ${version.row_count.toLocaleString('en-GB')} rows`
            : ''
        }`}
      >
        Cleaned data
      </SectionHeading>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div className="min-w-0">
            <p className="text-sm font-medium">Version {version.version_no} is ready</p>
            <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted">
              This is the cleaned result. The file you uploaded is untouched and still available.
            </p>
          </div>
          <ExportButton
            workspaceId={workspaceId}
            datasetVersionId={version.id}
            versionNo={version.version_no}
          />
        </div>

        {/* Approving is not applying, and an export taken between the two is the
            file that started every "where did my categories go" question.
            Approval records a decision; the column is written when
            apply_cleaning runs and makes a new version. Saying so at the export
            control, rather than only in the review queue, is the difference
            between a rule somebody knows and a rule somebody meets. */}
        {awaitingApply > 0 ? (
          <div className="border-t border-warning/30 bg-warning-soft/40 px-5 py-4">
            <p className="text-sm leading-relaxed">
              <span className="font-medium">
                {awaitingApply} approved change{awaitingApply === 1 ? '' : 's'}{' '}
                {awaitingApply === 1 ? 'is' : 'are'} not in version {version.version_no} yet.
              </span>{' '}
              <span className="text-muted">
                Approving records the decision; the data changes when you choose{' '}
                <em>Apply and create a new version</em> above. Anything exported now will not
                contain {awaitingApply === 1 ? 'it' : 'them'}.
              </span>
            </p>
          </div>
        ) : null}

        {currentDownloads.length > 0 ? (
          <div className="border-t border-border bg-surface-2/40 px-5 py-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">
              Ready to download · version {version.version_no} ({currentDownloads.length})
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {currentDownloads.map((job) => (
                <DownloadButton key={job.id} job={job} currentVersionNo={version.version_no} />
              ))}
            </div>
          </div>
        ) : (
          <p className="border-t border-border bg-surface-2/40 px-5 py-4 text-xs leading-relaxed text-subtle">
            Choose a format above. The file takes a few seconds to prepare, then a download button
            appears here.
          </p>
        )}

        {/* Split by the version each file was made from. An export is a snapshot
            of an immutable version, so applying a cleaning does not update the
            files already written -- it makes them historical. Shown
            undifferentiated they are a trap: approve a categorisation, export
            before pressing apply, and the resulting file has no category column
            while sitting next to one that does under the same label. */}
        {supersededDownloads.length > 0 ? (
          <details className="border-t border-border px-5 py-4">
            <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">
              Earlier versions ({supersededDownloads.length})
            </summary>
            <p className="mt-2 max-w-prose text-xs leading-relaxed text-subtle">
              Made before the latest changes were applied. Still correct for the version they came
              from, and not what you want if you are after the current figures.
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {supersededDownloads.map((job) => (
                <DownloadButton key={job.id} job={job} currentVersionNo={version.version_no} />
              ))}
            </div>
          </details>
        ) : null}

        {profileColumns.length > 0 ? (
          <div className="border-t border-border p-5">
            <CategorizeButton
              workspaceId={workspaceId}
              datasetVersionId={version.id}
              columns={profileColumns}
            />
          </div>
        ) : null}
      </Card>
    </div>
  );
}
