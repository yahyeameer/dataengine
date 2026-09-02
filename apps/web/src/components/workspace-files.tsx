import { AnalyseButton } from '@/components/agent-panel';
import { StatusBadge } from '@/components/ui';
import { formatBytes } from '@/lib/storage';

export type WorkspaceUpload = {
  id: string;
  original_filename: string;
  /** Null until the upload completes; `formatBytes` renders that as an em dash. */
  byte_size: number | null;
  status: string;
  created_at: string;
  dataset_id: string | null;
};

/**
 * Every file this client has sent, exactly as it arrived.
 *
 * The list used to live in the workspace page's right rail, where it competed
 * with the live job log for a column that was already running past a screen. It
 * is the whole of the Data tab now, which is also where the upload form is --
 * "what have I got" and "add another" are one thought.
 */
export function WorkspaceFiles({
  workspaceId,
  uploads,
  datasetNames,
}: {
  workspaceId: string;
  uploads: WorkspaceUpload[];
  datasetNames: Map<string, string>;
}) {
  return (
    <ul className="divide-y divide-border-subtle overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-sm)]">
      {uploads.map((upload) => (
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

          {/* The action and the state in one slot, so the column reads straight
              down even where one row offers Analyse and the next only says
              "no dataset". */}
          <div className="flex shrink-0 items-center gap-2">
            {upload.status === 'stored' ? (
              <AnalyseButton
                workspaceId={workspaceId}
                uploadId={upload.id}
                datasetId={upload.dataset_id}
              />
            ) : null}
            <StatusBadge status={upload.status} />
          </div>
        </li>
      ))}
    </ul>
  );
}
