import { BrandingSettings } from '@/components/branding-settings';
import { PageHeader } from '@/components/ui';
import { adminFor, requireCurrentOrg, requireOrgAdmin, type OrgContext } from '@/lib/authz';
import { BRANDING_BUCKET } from '@/lib/branding';
import { createServerSupabase } from '@/lib/supabase/server';

export const metadata = { title: 'Branding · DataEngine' };

/**
 * Settings → Organisation → Branding.
 *
 * This screen exists because of what the report generator used to do without
 * it: fall back to the accounting firm's own row for a name, and take a colour
 * off whatever job payload happened to carry one. Neither is a business
 * identity, and neither survives being asked "who decided that".
 *
 * The logo preview is a signed URL minted on this request. The bucket is
 * private and it stays private — a public URL for a client's logo is a small
 * permanent leak of who a firm's clients are.
 */
export default async function BrandingSettingsPage() {
  const { org } = await requireCurrentOrg();

  // Reading the page is a member action; changing anything is not. The form
  // takes `canEdit` and every write re-checks the role in the database, so a
  // member sees the current branding and no controls.
  let admin: OrgContext | null = null;
  try {
    admin = await requireOrgAdmin(org.id);
  } catch {
    admin = null;
  }
  const canEdit = admin !== null;

  const supabase = await createServerSupabase();
  const { data: branding } = await supabase
    .from('organization_branding')
    .select(
      'business_name, legal_name, logo_storage_path, logo_url, logo_width, logo_height, accent_color, footer_text, updated_at',
    )
    .eq('organization_id', org.id)
    .maybeSingle();

  let logoPreviewUrl: string | null = null;
  if (admin && branding?.logo_storage_path) {
    const { data: signed } = await adminFor(admin)
      .storage.from(BRANDING_BUCKET)
      .createSignedUrl(branding.logo_storage_path, 300);
    logoPreviewUrl = signed?.signedUrl ?? null;
  }

  return (
    <div>
      <PageHeader
        eyebrow="Organisation"
        title="Branding"
        subtitle="What every report says about who produced it. Reports resolve this automatically — nothing has to send a name with the request."
      />
      <BrandingSettings
        organizationId={org.id}
        organizationName={org.name}
        branding={branding ?? null}
        logoPreviewUrl={logoPreviewUrl}
        canEdit={canEdit}
      />
    </div>
  );
}
