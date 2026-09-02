import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError } from '@/lib/api';
import { requireOrgAdmin } from '@/lib/authz';
import { accentIsAccessible, normaliseAccent } from '@/lib/branding';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * The organisation's identity, as the branding screen edits it.
 *
 * The write runs through the *user's* client, not the service role.
 * `upsert_organization_branding` is SECURITY DEFINER and re-checks the caller's
 * role from `auth.uid()` itself, so the database authorises the change
 * independently of this route having got `requireOrgAdmin` right. That is the
 * same two-lock arrangement every other write path here uses, and it is why the
 * admin client is not constructed at all on this route.
 *
 * A field left out is left alone; a field sent empty is cleared. Without that
 * distinction a screen saving one field has to resend all of them, and the
 * first time it forgets one it silently erases somebody's footer.
 */

const patchSchema = z.object({
  organizationId: z.string().uuid(),
  businessName: z.string().max(120).nullish(),
  legalName: z.string().max(200).nullish(),
  accentColor: z.string().max(9).nullish(),
  footerText: z.string().max(200).nullish(),
  logoUrl: z.string().max(2048).nullish(),
});

export async function PATCH(request: Request) {
  try {
    const body = patchSchema.parse(await request.json());
    await requireOrgAdmin(body.organizationId);

    // Normalised here rather than left to the column's regex, so "8A1538" and
    // "#8a1538" are the same colour and a malformed one is a sentence rather
    // than a constraint violation.
    let accent: string | undefined;
    if (body.accentColor !== undefined && body.accentColor !== null) {
      if (body.accentColor.trim() === '') {
        accent = '';
      } else {
        const normalised = normaliseAccent(body.accentColor);
        if (!normalised) {
          return NextResponse.json(
            { error: `${body.accentColor} is not a colour. Use a hex value like #8a1538.` },
            { status: 400 },
          );
        }
        accent = normalised;
      }
    }

    // An https URL only, and never one pointing at a private address. The
    // worker checks this again — including what the hostname resolves to —
    // before it fetches anything, because DNS is not something a form can
    // check. This is the early, readable refusal.
    if (body.logoUrl) {
      const trimmed = body.logoUrl.trim();
      if (trimmed && !/^https:\/\/[a-z0-9.-]+(:\d+)?(\/|$)/i.test(trimmed)) {
        return NextResponse.json(
          { error: 'A logo URL must be an https:// address.' },
          { status: 400 },
        );
      }
    }

    const supabase = await createServerSupabase();
    const { data, error } = await supabase.rpc('upsert_organization_branding', {
      p_organization_id: body.organizationId,
      p_business_name: body.businessName ?? undefined,
      p_legal_name: body.legalName ?? undefined,
      p_accent_color: accent,
      p_footer_text: body.footerText ?? undefined,
      p_logo_url: body.logoUrl ?? undefined,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({
      branding: data,
      // Reported, not enforced. The renderer flips its ink to whichever of
      // white or near-black survives, so a low-contrast accent is a warning
      // about legibility rather than a rejected colour.
      accentWarning:
        accent && !accentIsAccessible(accent)
          ? `${accent} does not reach 4.5:1 against either white or near-black text.`
          : null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
