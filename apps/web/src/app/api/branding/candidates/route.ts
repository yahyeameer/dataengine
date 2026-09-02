import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError } from '@/lib/api';
import { adminFor, requireOrgAdmin } from '@/lib/authz';
import { BRANDING_BUCKET } from '@/lib/branding';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * "Images found in this file" — approving one, dismissing the rest.
 *
 * This is the step that turns a picture the ingest happened to find into the
 * company logo, and it is the *only* step that does. The worker scores
 * candidates and stores them; nothing in the pipeline promotes one on its own,
 * because a workbook commonly holds a logo, a product photograph, a chart and a
 * signature, and a confident wrong guess ends up on every document a firm sends
 * for a year.
 *
 * GET returns the open candidates with a short-lived preview URL for each, so
 * the screen can show what it is asking about. The URLs are minted here rather
 * than stored: the bucket is private, and a preview link that outlives the page
 * is a credential.
 */

const PREVIEW_TTL_SECONDS = 300;

const actionSchema = z.object({
  organizationId: z.string().uuid(),
  candidateId: z.string().uuid(),
  action: z.enum(['approve', 'dismiss']),
});

export async function GET(request: Request) {
  try {
    const organizationId = new URL(request.url).searchParams.get('organizationId');
    if (!organizationId) {
      return NextResponse.json({ error: 'organizationId is required' }, { status: 400 });
    }

    const context = await requireOrgAdmin(organizationId);
    const supabase = await createServerSupabase();

    const { data, error } = await supabase
      .from('brand_asset_candidates')
      .select(
        'id, source_name, mime_type, width, height, byte_size, score, reasons, usable, rejected_reason, storage_path, created_at, workspace_id',
      )
      .eq('organization_id', organizationId)
      .is('approved_at', null)
      .is('dismissed_at', null)
      .order('score', { ascending: false })
      .limit(24);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const admin = adminFor(context);
    const candidates = await Promise.all(
      (data ?? []).map(async (candidate) => {
        if (!candidate.usable) return { ...candidate, previewUrl: null };
        const { data: signed } = await admin.storage
          .from(BRANDING_BUCKET)
          .createSignedUrl(candidate.storage_path, PREVIEW_TTL_SECONDS);
        return { ...candidate, previewUrl: signed?.signedUrl ?? null };
      }),
    );

    return NextResponse.json({ candidates });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = actionSchema.parse(await request.json());
    await requireOrgAdmin(body.organizationId);

    // Both RPCs re-derive the organisation from the candidate row and check the
    // caller's role themselves, and both answer "no such image" when the
    // candidate belongs to another tenant — the id is not confirmed as real.
    const supabase = await createServerSupabase();
    const { data, error } =
      body.action === 'approve'
        ? await supabase.rpc('approve_brand_asset', { p_candidate_id: body.candidateId })
        : await supabase.rpc('dismiss_brand_asset', { p_candidate_id: body.candidateId });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ result: data });
  } catch (error) {
    return handleRouteError(error);
  }
}
