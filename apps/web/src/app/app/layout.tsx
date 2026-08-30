import Link from 'next/link';

import { requireCurrentOrg } from '@/lib/authz';
import { SystemHealthBanner } from '@/components/system-health-banner';
import { secondaryButtonClass } from '@/components/ui';

export default async function AppLayout({ children }: LayoutProps<'/app'>) {
  const { org, role } = await requireCurrentOrg();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      {/* Renders nothing while the model is running, so its presence is the
          signal. Above the header because a warning below the fold is a
          warning nobody reads. */}
      <SystemHealthBanner role={role} />

      <header className="border-b border-black/10 dark:border-white/15">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <Link href="/app" className="font-semibold tracking-tight">
            {org.name}
          </Link>
          <span className="rounded bg-black/5 px-2 py-0.5 text-xs opacity-70 dark:bg-white/10">
            {role}
          </span>

          <nav className="flex items-center gap-4 text-sm">
            <Link className="opacity-70 hover:opacity-100" href="/app">
              Workspaces
            </Link>
            <Link className="opacity-70 hover:opacity-100" href="/app/audit">
              Audit log
            </Link>
          </nav>

          <form action="/auth/signout" method="post" className="ml-auto">
            <button className={`${secondaryButtonClass} px-3 py-1.5`} type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">{children}</main>

      {/* Section 13: the copilot positioning is legally load-bearing, so it is
          stated in the product and not only in the contract. */}
      <footer className="border-t border-black/10 px-6 py-4 text-center text-xs opacity-60 dark:border-white/15">
        A copilot, not an autonomous accountant. Every material change is reviewed and signed off by
        a person, and every number can be traced to its source rows.
      </footer>
    </div>
  );
}
