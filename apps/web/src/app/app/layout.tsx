import { AppShell } from '@/components/app-shell';
import { getUser, requireCurrentOrg } from '@/lib/authz';

export default async function AppLayout({ children }: LayoutProps<'/app'>) {
  const [{ org, role }, user] = await Promise.all([requireCurrentOrg(), getUser()]);

  return (
    <AppShell orgName={org.name} role={role} email={user?.email}>
      {children}
    </AppShell>
  );
}
