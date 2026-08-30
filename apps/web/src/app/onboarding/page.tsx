import { redirect } from 'next/navigation';

import { CreateOrgForm } from '@/components/create-org-form';
import { Card } from '@/components/ui';
import { listMyOrganizations, requireUser } from '@/lib/authz';

export const metadata = { title: 'Set up your firm · DataEngine' };

export default async function OnboardingPage() {
  await requireUser();

  // Already onboarded: nothing to do here.
  const orgs = await listMyOrganizations();
  if (orgs.length > 0) redirect('/app');

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-16">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Set up your firm</h1>
      <p className="mb-6 text-sm text-muted">
        Each client you work for gets its own workspace inside the firm, so their data, recipes and
        audit trail stay separate.
      </p>
      <Card className="p-5">
        <CreateOrgForm />
      </Card>
    </main>
  );
}
