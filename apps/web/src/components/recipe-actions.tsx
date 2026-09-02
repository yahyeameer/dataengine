'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  ErrorText,
  dangerButtonClass,
  secondaryButtonClass,
} from '@/components/ui';
import { REPORT_FORMATS, type ReportFormat } from '@/lib/recipes';

/**
 * The three things a person does to a recipe from its own page: turn it off,
 * copy it, and change what it delivers.
 *
 * Every one of them is a POST to `/api/recipes`, which is a thin wrapper over
 * an RPC that re-checks access from `auth.uid()`. Nothing here is trusted with
 * anything: `canEdit` hides controls a member cannot use, and the database
 * refuses them independently if the button is reached another way.
 *
 * Changing the deliverable writes a *new version* rather than editing the
 * current one, which is why the button says so. A recipe version is what a
 * historical run points at, and a run that silently changed its own definition
 * afterwards would be a lie in the audit trail rather than an edit.
 */
export function RecipeActions({
  recipeId,
  workspaceId,
  enabled,
  reportFormats,
  canEdit,
}: {
  recipeId: string;
  workspaceId: string;
  enabled: boolean;
  reportFormats: ReportFormat[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [formats, setFormats] = useState<ReportFormat[]>(reportFormats);

  async function post(body: Record<string, unknown>) {
    setError(null);
    const response = await fetch('/api/recipes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, recipeId, ...body }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(payload.error ?? 'That did not work.');
      return false;
    }
    startTransition(() => router.refresh());
    return true;
  }

  if (!canEdit) return null;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={secondaryButtonClass()}
          disabled={pending}
          onClick={() => setEditing((open) => !open)}
        >
          {editing ? 'Cancel' : 'Change deliverable'}
        </button>
        <button
          type="button"
          className={secondaryButtonClass()}
          disabled={pending}
          onClick={() => void post({ action: 'duplicate' })}
        >
          Duplicate
        </button>
        <button
          type="button"
          className={enabled ? dangerButtonClass() : secondaryButtonClass()}
          disabled={pending}
          onClick={() => void post({ action: 'setEnabled', enabled: !enabled })}
        >
          {enabled ? 'Disable' : 'Enable'}
        </button>
      </div>

      {editing && (
        <div className="w-72 rounded-[var(--radius)] border border-border bg-surface p-4 text-left">
          <p className="mb-3 text-sm font-medium">Formats this recipe produces</p>
          <div className="space-y-2">
            {REPORT_FORMATS.map((format) => (
              <label key={format} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={formats.includes(format)}
                  onChange={(event) =>
                    setFormats((current) =>
                      event.target.checked
                        ? [...current, format]
                        : current.filter((item) => item !== format),
                    )
                  }
                />
                {format.toUpperCase()}
              </label>
            ))}
          </div>
          <button
            type="button"
            className={`${secondaryButtonClass()} mt-3`}
            disabled={pending || formats.length === 0}
            onClick={async () => {
              const done = await post({
                action: 'newVersion',
                reportConfig: { formats },
                changeNote: `Deliverable set to ${formats.join(', ').toUpperCase()}`,
              });
              if (done) setEditing(false);
            }}
          >
            Save as a new version
          </button>
        </div>
      )}

      <ErrorText>{error}</ErrorText>
    </div>
  );
}
