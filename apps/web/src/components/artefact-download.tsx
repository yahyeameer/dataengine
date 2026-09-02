'use client';

import { useState } from 'react';

/**
 * Asking for the file a job produced.
 *
 * One implementation, because there are now three places that offer a
 * download -- the job panel, the categorise result screen, and a reference
 * inside an answer -- and they were on their way to three copies of the same
 * eight lines. The parts that legitimately differ between them are the label,
 * the icon and the wording of the failure; the fetch is not one of them.
 *
 * The job id is the whole request. `/api/exports` re-reads that job through
 * the caller's own RLS-bound client and re-derives the storage path
 * server-side, so nothing here is an authorisation and a caller cannot ask for
 * an object by naming it. The signed URL it returns carries its own
 * Content-Disposition, which is why navigating to it saves the file instead of
 * replacing the page, and why it is minted on the click rather than on render:
 * it is good for sixty seconds.
 */
export function useArtefactDownload(jobId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/exports?jobId=${jobId}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not prepare the download');
      window.location.href = body.url as string;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not prepare the download');
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, download };
}
