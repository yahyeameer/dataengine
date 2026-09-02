import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError } from '@/lib/api';
import { adminFor, requireOrgAdmin } from '@/lib/authz';
import { BRANDING_BUCKET, MAX_LOGO_BYTES, checkLogo, logoObjectPath } from '@/lib/branding';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * Uploading and removing the organisation's logo.
 *
 * Unlike a dataset upload, the bytes come *through* this route rather than
 * going browser-to-storage on a signed URL. Two reasons, and both are about the
 * file being small: a logo is a couple of hundred kilobytes rather than a
 * fifty-megabyte ledger, so there is no memory argument for streaming it past
 * us — and it has to be *inspected* before it is stored. A signed upload URL
 * would put an unexamined file in the bucket and leave the checking to whoever
 * next tried to draw it, which is a worker, mid-report, on a client's document.
 *
 * The path is derived from the proven organization id and never from anything
 * the caller sent. `set_organization_logo` refuses a path outside the
 * organisation's own prefix as well, so getting this wrong is caught twice.
 */

export const runtime = 'nodejs';

const deleteSchema = z.object({ organizationId: z.string().uuid() });

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const organizationId = form.get('organizationId');
    const file = form.get('file');

    if (typeof organizationId !== 'string' || !z.string().uuid().safeParse(organizationId).success) {
      return NextResponse.json({ error: 'organizationId is required' }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Choose an image to upload.' }, { status: 400 });
    }
    if (file.size > MAX_LOGO_BYTES) {
      return NextResponse.json(
        { error: `A logo must be under ${MAX_LOGO_BYTES / (1024 * 1024)} MB.` },
        { status: 413 },
      );
    }

    const context = await requireOrgAdmin(organizationId);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const checked = checkLogo(bytes);
    if (!checked.ok) {
      return NextResponse.json({ error: checked.reason }, { status: 400 });
    }

    // Only now, with the caller proven and the file examined.
    const admin = adminFor(context);
    const path = logoObjectPath(organizationId);

    const { error: uploadError } = await admin.storage
      .from(BRANDING_BUCKET)
      .upload(path, bytes, { contentType: checked.mime, upsert: true });

    if (uploadError) {
      return NextResponse.json({ error: `Could not store the logo: ${uploadError.message}` }, {
        status: 500,
      });
    }

    const { data, error } = await admin.rpc('set_organization_logo', {
      p_organization_id: organizationId,
      p_storage_path: path,
      p_mime_type: checked.mime,
      p_width: checked.width,
      p_height: checked.height,
      p_byte_size: bytes.byteLength,
      p_actor: context.user.id,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({
      branding: data,
      logo: { width: checked.width, height: checked.height, mime: checked.mime },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Removing the logo.
 *
 * The row is cleared and the object is deleted, in that order: a branding row
 * pointing at an object that no longer exists produces a report with no logo
 * and a warning, whereas an object with no row is unreferenced. Getting the
 * order wrong makes the failure worse than the outcome it was avoiding.
 */
export async function DELETE(request: Request) {
  try {
    const body = deleteSchema.parse(await request.json());
    const context = await requireOrgAdmin(body.organizationId);

    const supabase = await createServerSupabase();
    const { data, error } = await supabase.rpc('clear_organization_logo', {
      p_organization_id: body.organizationId,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    const admin = adminFor(context);
    await admin.storage.from(BRANDING_BUCKET).remove([logoObjectPath(body.organizationId)]);

    return NextResponse.json({ branding: data });
  } catch (error) {
    return handleRouteError(error);
  }
}
