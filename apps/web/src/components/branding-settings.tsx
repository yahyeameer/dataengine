'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

import {
  Card,
  ErrorText,
  Field,
  SectionHeading,
  buttonClass,
  dangerButtonClass,
  fileInputClass,
  inputClass,
  secondaryButtonClass,
} from '@/components/ui';
import {
  DEFAULT_ACCENT,
  accentIsAccessible,
  checkLogo,
  contrastRatio,
  inkOn,
  normaliseAccent,
  resolveBusinessName,
  type BrandingRow,
} from '@/lib/branding';

type Candidate = {
  id: string;
  source_name: string;
  width: number | null;
  height: number | null;
  score: number;
  reasons: unknown;
  usable: boolean;
  rejected_reason: string | null;
  previewUrl: string | null;
};

/**
 * The branding screen.
 *
 * Two things about it are load-bearing rather than decorative.
 *
 * **The preview is the document.** The band, the ink colour on it and the
 * fallback header all use the same rules the PDF renderer uses, ported in
 * `lib/branding.ts`. An approximation here would be worse than no preview: the
 * whole point is to answer "what will the client see" without generating a
 * report to find out.
 *
 * **A file is checked before it is sent.** The route checks it again — that is
 * the check that matters — but a 2 MB refusal that arrives after a 2 MB upload
 * is a worse experience for exactly the person most likely to hit it.
 */
export function BrandingSettings({
  organizationId,
  organizationName,
  branding,
  logoPreviewUrl,
  canEdit,
}: {
  organizationId: string;
  organizationName: string;
  branding:
    | (BrandingRow & { logo_width?: number | null; logo_height?: number | null })
    | null;
  logoPreviewUrl: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [businessName, setBusinessName] = useState(branding?.business_name ?? '');
  const [legalName, setLegalName] = useState(branding?.legal_name ?? '');
  const [accent, setAccent] = useState(branding?.accent_color ?? DEFAULT_ACCENT);
  const [footer, setFooter] = useState(branding?.footer_text ?? '');
  const [logoUrl, setLogoUrl] = useState(branding?.logo_url ?? '');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);

  const validAccent = normaliseAccent(accent) ?? DEFAULT_ACCENT;
  const ink = inkOn(validAccent);
  const ratio = contrastRatio(validAccent, ink);
  const accessible = accentIsAccessible(validAccent);

  const resolved = resolveBusinessName({
    branding: { ...(branding ?? {}), business_name: businessName || null } as BrandingRow,
    organizationName,
  });

  // Images found inside uploaded workbooks, waiting for somebody to say which
  // one is the logo. Fetched rather than server-rendered because each carries a
  // signed preview URL with a five-minute life, and a page cached for longer
  // than that would show broken images.
  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;
    fetch(`/api/branding/candidates?organizationId=${organizationId}`)
      .then((response) => (response.ok ? response.json() : { candidates: [] }))
      .then((payload) => {
        if (!cancelled) setCandidates(payload.candidates ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [organizationId, canEdit]);

  async function send(url: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(url, init);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error ?? 'That did not work.');
        return null;
      }
      startTransition(() => router.refresh());
      return payload;
    } finally {
      setBusy(false);
    }
  }

  async function saveFields() {
    const payload = await send('/api/branding', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organizationId,
        businessName,
        legalName,
        accentColor: accent,
        footerText: footer,
        logoUrl,
      }),
    });
    if (payload?.accentWarning) setNotice(payload.accentWarning);
    else if (payload) setNotice('Saved. New reports will use this.');
  }

  async function uploadLogo(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const checked = checkLogo(bytes);
    if (!checked.ok) {
      setError(checked.reason);
      return;
    }

    const form = new FormData();
    form.set('organizationId', organizationId);
    form.set('file', file);
    const payload = await send('/api/branding/logo', { method: 'POST', body: form });
    if (payload) setNotice('Logo uploaded.');
  }

  async function removeLogo() {
    const payload = await send('/api/branding/logo', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId }),
    });
    if (payload) setNotice('Logo removed. Reports will use a text header.');
  }

  async function decideCandidate(candidateId: string, action: 'approve' | 'dismiss') {
    const payload = await send('/api/branding/candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId, candidateId, action }),
    });
    if (payload) {
      setCandidates((current) => current.filter((item) => item.id !== candidateId));
      setNotice(action === 'approve' ? 'That image is now your logo.' : 'Dismissed.');
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <div className="space-y-6">
        <section>
          <SectionHeading description="Reports resolve this name themselves. Nothing has to send one with the request, and nothing infers one from a spreadsheet cell.">
            Identity
          </SectionHeading>
          <Card>
            <div className="space-y-4 p-5">
              <Field
                label="Business name"
                hint={
                  businessName
                    ? 'This is what appears on every report.'
                    : `Empty — reports currently say “${resolved.name}” (from the ${
                        resolved.source === 'organization' ? 'organisation record' : resolved.source
                      }).`
                }
              >
                <input
                  className={inputClass}
                  value={businessName}
                  maxLength={120}
                  disabled={!canEdit}
                  onChange={(event) => setBusinessName(event.target.value)}
                />
              </Field>

              <Field label="Legal name (optional)" hint="Kept for documents that need it.">
                <input
                  className={inputClass}
                  value={legalName}
                  maxLength={200}
                  disabled={!canEdit}
                  onChange={(event) => setLegalName(event.target.value)}
                />
              </Field>

              <Field
                label="Accent colour"
                hint={
                  accessible
                    ? `Contrast ${ratio}:1 against the text the renderer will choose.`
                    : `Contrast ${ratio}:1 — below the 4.5:1 needed for small text. The band stays readable, the footer will not.`
                }
              >
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={validAccent}
                    disabled={!canEdit}
                    onChange={(event) => setAccent(event.target.value)}
                    className="h-10 w-14 cursor-pointer rounded-[var(--radius)] border border-border bg-surface"
                  />
                  <input
                    className={inputClass}
                    value={accent}
                    maxLength={9}
                    disabled={!canEdit}
                    onChange={(event) => setAccent(event.target.value)}
                  />
                </div>
              </Field>

              <Field label="Report footer" hint="Printed at the foot of every page.">
                <input
                  className={inputClass}
                  value={footer}
                  maxLength={200}
                  disabled={!canEdit}
                  onChange={(event) => setFooter(event.target.value)}
                />
              </Field>

              {canEdit && (
                <button className={buttonClass()} disabled={busy} onClick={() => void saveFields()}>
                  {busy ? 'Saving…' : 'Save branding'}
                </button>
              )}
            </div>
          </Card>
        </section>

        <section>
          <SectionHeading description="PNG, JPEG or WebP, up to 2 MB. Stored privately — reports read it server-side and never publish a link to it.">
            Logo
          </SectionHeading>
          <Card>
            <div className="space-y-4 p-5">
              {logoPreviewUrl ? (
                <div className="flex items-center gap-4">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a
                      signed, short-lived URL on a private bucket cannot be
                      optimised through next/image's loader. */}
                  <img
                    src={logoPreviewUrl}
                    alt="Current logo"
                    className="max-h-16 max-w-[12rem] object-contain"
                  />
                  <span className="text-sm text-muted">
                    {branding?.logo_width}×{branding?.logo_height}
                  </span>
                </div>
              ) : (
                <p className="text-sm text-muted">
                  No logo. Reports print a text header with the business name — never an empty box.
                </p>
              )}

              {canEdit && (
                <>
                  <Field label="Upload a logo">
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className={fileInputClass}
                      disabled={busy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadLogo(file);
                      }}
                    />
                  </Field>

                  {logoPreviewUrl && (
                    <button
                      className={dangerButtonClass()}
                      disabled={busy}
                      onClick={() => void removeLogo()}
                    >
                      Remove logo
                    </button>
                  )}

                  <Field
                    label="Or a logo URL"
                    hint="https only. Fetched server-side, and refused if the host resolves inside a private network."
                  >
                    <input
                      className={inputClass}
                      value={logoUrl}
                      maxLength={2048}
                      placeholder="https://example.com/logo.png"
                      onChange={(event) => setLogoUrl(event.target.value)}
                    />
                  </Field>
                </>
              )}
            </div>
          </Card>
        </section>

        {candidates.length > 0 && (
          <section>
            <SectionHeading description="Images found inside workbooks you uploaded. Nothing here is used until you say which one is the logo.">
              Images found in your files
            </SectionHeading>
            <Card>
              <ul className="divide-y divide-border-subtle">
                {candidates.map((candidate) => (
                  <li key={candidate.id} className="flex flex-wrap items-center gap-4 p-4">
                    {candidate.previewUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element -- signed private URL */
                      <img
                        src={candidate.previewUrl}
                        alt={candidate.source_name}
                        className="max-h-12 max-w-[8rem] object-contain"
                      />
                    ) : (
                      <span className="text-xs text-subtle">no preview</span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{candidate.source_name}</span>
                      <span className="block text-xs text-subtle">
                        {candidate.width}×{candidate.height} ·{' '}
                        {Array.isArray(candidate.reasons)
                          ? (candidate.reasons as string[]).slice(0, 2).join('; ')
                          : ''}
                        {candidate.rejected_reason ? ` · ${candidate.rejected_reason}` : ''}
                      </span>
                    </span>
                    <span className="flex gap-2">
                      {candidate.usable && (
                        <button
                          className={secondaryButtonClass('sm')}
                          disabled={busy}
                          onClick={() => void decideCandidate(candidate.id, 'approve')}
                        >
                          Use as company logo
                        </button>
                      )}
                      <button
                        className={secondaryButtonClass('sm')}
                        disabled={busy}
                        onClick={() => void decideCandidate(candidate.id, 'dismiss')}
                      >
                        Not a logo
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        )}

        <ErrorText>{error}</ErrorText>
        {notice && <p className="text-sm text-success">{notice}</p>}
      </div>

      <aside>
        <SectionHeading description="The same rules the PDF, Word and Excel renderers use.">
          Preview
        </SectionHeading>
        <Card>
          <div className="p-5">
            <div
              className="rounded-t-[var(--radius)] px-4 py-4"
              style={{ backgroundColor: validAccent, color: ink }}
            >
              {logoPreviewUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element -- signed private URL */
                <img
                  src={logoPreviewUrl}
                  alt=""
                  className="mb-2 max-h-10 max-w-[10rem] object-contain"
                />
              ) : null}
              <p className="text-base font-semibold uppercase tracking-wide">{resolved.name}</p>
            </div>
            <div className="rounded-b-[var(--radius)] border border-t-0 border-border px-4 py-4">
              <p className="text-lg font-semibold">Monthly Operations Report</p>
              <p className="text-sm text-muted">September 2026</p>
              {footer && <p className="mt-6 border-t border-border pt-2 text-xs text-subtle">{footer}</p>}
            </div>
          </div>
        </Card>
      </aside>
    </div>
  );
}
