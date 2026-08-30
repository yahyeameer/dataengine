import Link from 'next/link';

import { Mark } from '@/components/product-story';
import { SystemHealthBanner } from '@/components/system-health-banner';
import { getSystemHealth } from '@/lib/system-health';
import { secondaryButtonClass } from '@/components/ui';

/**
 * The application shell.
 *
 * A sidebar rather than a top bar, because this is a tool somebody keeps open
 * for an afternoon and vertical navigation leaves the full width to the tables
 * that are the actual work.
 *
 * Navigation lists the routes that exist. There is no Cleaning or Reports entry
 * because there is no such route — those are panels inside a workspace, and a
 * nav item leading nowhere is worse than one absent.
 *
 * Server component throughout. No client JavaScript is shipped for the frame.
 */

const NAV = [
  { href: '/app', label: 'Workspaces' },
  { href: '/app/audit', label: 'Activity' },
];

export async function AppShell({
  orgName,
  role,
  email,
  children,
}: {
  orgName: string;
  role: string;
  email?: string | null;
  children: React.ReactNode;
}) {
  const health = await getSystemHealth();
  const isAdmin = role === 'owner' || role === 'admin';

  return (
    <div className="flex min-h-svh flex-col">
      <SystemHealthBanner role={role} health={health} />

      <div className="flex flex-1 flex-col lg:flex-row">
        {/* Sidebar. On narrow screens it collapses to a horizontal strip rather
            than a hamburger: two destinations do not justify a drawer, and a
            menu that hides half the product on a tablet is a menu that gets
            used once. */}
        <aside className="shrink-0 border-b border-border bg-surface lg:w-60 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-4 px-4 py-3 lg:flex-col lg:items-stretch lg:gap-0 lg:px-0 lg:py-0">
            <Link
              href="/app"
              className="flex items-center gap-2.5 lg:border-b lg:border-border lg:px-5 lg:py-4"
            >
              <Mark className="h-[22px] w-[22px]" />
              <span className="text-[15px] font-semibold tracking-tight">DataEngine</span>
            </Link>

            {/* Which client's books am I looking at. The most important thing on
                the frame, and the question a practice with forty clients asks
                every time they switch tab. */}
            <div className="hidden min-w-0 border-b border-border px-5 py-3.5 lg:block">
              <p className="text-[11px] font-medium uppercase tracking-wider text-subtle">
                Organisation
              </p>
              <p className="mt-1 truncate text-sm font-medium">{orgName}</p>
              <p className="mt-0.5 text-xs capitalize text-subtle">{role}</p>
            </div>

            <nav className="flex gap-1 lg:flex-1 lg:flex-col lg:px-3 lg:py-3">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-[var(--radius)] px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground lg:py-2"
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="ml-auto flex items-center gap-3 lg:ml-0 lg:flex-col lg:items-stretch lg:gap-0">
              {isAdmin && <EngineStatus state={health.state} />}

              <div className="hidden border-t border-border px-5 py-3.5 lg:block">
                {email && <p className="truncate text-xs text-subtle" title={email}>{email}</p>}
                <form action="/auth/signout" method="post" className="mt-2">
                  <button className={`${secondaryButtonClass} w-full px-3 py-1.5 text-xs`} type="submit">
                    Sign out
                  </button>
                </form>
              </div>

              <form action="/auth/signout" method="post" className="lg:hidden">
                <button className={`${secondaryButtonClass} px-3 py-1.5 text-xs`} type="submit">
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 sm:px-8">{children}</main>

          <footer className="border-t border-border px-6 py-4 text-center text-xs text-subtle">
            A copilot, not an autonomous accountant. Every material change is reviewed and signed
            off by a person, and every number can be traced to its source rows.
          </footer>
        </div>
      </div>
    </div>
  );
}

/**
 * Whether the reasoning engine is actually running.
 *
 * Three states and never two: `unknown` means the worker has not reported, and
 * showing that as healthy would be the interface lying at the one moment it
 * matters. Admins only — a member cannot act on it.
 *
 * Quiet by design. The banner above is what shouts; this is for the glance
 * that confirms nothing is wrong.
 */
function EngineStatus({ state }: { state: 'ok' | 'degraded' | 'unknown' }) {
  const label = { ok: 'Operational', degraded: 'Degraded', unknown: 'Unknown' }[state];
  const dot = {
    ok: 'bg-success',
    degraded: 'bg-warning',
    unknown: 'bg-subtle',
  }[state];

  return (
    <div className="hidden border-t border-border px-5 py-3.5 lg:block">
      <p className="text-[11px] font-medium uppercase tracking-wider text-subtle">AI engine</p>
      <p className="mt-1.5 flex items-center gap-2 text-sm">
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${dot} ${state === 'ok' ? 'pulse-dot' : ''}`}
        />
        {label}
      </p>
    </div>
  );
}
