import Link from 'next/link';

import {
  ActivityIcon,
  CategoriseIcon,
  NavLink,
  WorkspacesIcon,
} from '@/components/nav-link';
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
 * Below `lg` the sidebar becomes a sticky top bar. It used to become a plain
 * horizontal strip that dropped the organisation name entirely, so on a tablet
 * or a phone there was nothing on screen saying whose books you were looking
 * at — in a product whose whole premise is one workspace per client. The bar
 * now carries the organisation, and the sign-out control moved behind the
 * account row instead of being pinned to an edge it overflowed by six pixels.
 *
 * Server component apart from `NavLink`, which needs the pathname to mark the
 * current destination.
 */

// Categorise leads because it is the product: upload a file, get it back
// categorised. Workspaces is everything behind that -- the versions, the
// review queue, the full history of a run -- and it is one click away rather
// than in the way.
const NAV = [
  { href: '/app', label: 'Categorise', icon: <CategoriseIcon /> },
  { href: '/app/workspaces', label: 'Workspaces', icon: <WorkspacesIcon /> },
  { href: '/app/audit', label: 'Activity', icon: <ActivityIcon /> },
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
        <aside className="glass-bar sticky top-0 z-30 shrink-0 border-b border-border lg:h-svh lg:w-64 lg:self-start lg:border-b-0 lg:border-r lg:bg-surface lg:backdrop-blur-none">
          {/* --- narrow: a bar in two rows ---------------------------------
              One row could not hold the wordmark, the organisation, two
              destinations and sign-out on a 390px screen: the organisation
              truncated to "acc…", which is the one thing on the bar a person
              needs to read. Identity and account on top, navigation beneath,
              and the whole thing collapses back to a single row as soon as
              there is width for it. */}
          <div className="lg:hidden">
            <div className="flex items-center gap-3 px-4 pb-2 pt-2.5 sm:pb-2.5">
              {/* `-ml-1.5 p-1.5` rather than a bare 22px mark: below `sm` the
                  wordmark is hidden and the link was a 22×22 tap target. The
                  padding is negative-margined back out so the bar's optical
                  left edge does not move. */}
              <Link
                href="/app"
                className="-ml-1.5 flex shrink-0 items-center gap-2.5 rounded-[var(--radius)] p-1.5 transition-colors hover:bg-surface-2"
                aria-label="DataEngine — all workspaces"
              >
                <Mark className="h-[22px] w-[22px]" />
                <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">
                  DataEngine
                </span>
              </Link>

              {/* Which client's books, on the screens that had no room for the
                  sidebar block. */}
              <span
                className="min-w-0 flex-1 truncate border-l border-border pl-3 text-sm font-medium"
                title={orgName}
              >
                {orgName}
              </span>

              <form action="/auth/signout" method="post" className="shrink-0">
                <button className={secondaryButtonClass('sm')} type="submit">
                  Sign out
                </button>
              </form>
            </div>

            <nav className="flex items-center gap-1 px-3 pb-2">
              {NAV.map((item) => (
                <NavLink key={item.href} href={item.href} icon={item.icon}>
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          {/* --- wide: the sidebar proper -----------------------------------
              Sticky and viewport-tall rather than stretching with the page.
              A workspace with a full review queue runs to six thousand pixels,
              and a sidebar that grows with it put the engine status and the
              account block at the very bottom of that -- present, and never
              seen. */}
          <div className="hidden lg:flex lg:h-full lg:flex-col lg:overflow-y-auto">
            <Link
              href="/app"
              className="flex items-center gap-2.5 border-b border-border px-5 py-4 transition-opacity hover:opacity-80"
            >
              <Mark className="h-[22px] w-[22px]" />
              <span className="text-[15px] font-semibold tracking-tight">DataEngine</span>
            </Link>

            {/* Which client's books am I looking at. The most important thing on
                the frame, and the question a practice with forty clients asks
                every time they switch tab. */}
            <div className="min-w-0 border-b border-border px-5 py-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">
                Organisation
              </p>
              <p className="mt-1.5 truncate text-sm font-medium" title={orgName}>
                {orgName}
              </p>
              <p className="mt-0.5 text-xs capitalize text-subtle">{role}</p>
            </div>

            <nav className="flex flex-col gap-1 px-3 py-3">
              {NAV.map((item) => (
                <NavLink key={item.href} href={item.href} icon={item.icon}>
                  {item.label}
                </NavLink>
              ))}
            </nav>

            {/* Pinned to the bottom. The status and the account are reference,
                not navigation, and the gap above them used to be a hole in the
                middle of the frame on a tall screen. */}
            <div className="mt-auto">
              {isAdmin && <EngineStatus state={health.state} />}

              <div className="border-t border-border px-5 py-4">
                {email && (
                  <p className="truncate text-xs text-subtle" title={email}>
                    {email}
                  </p>
                )}
                <form action="/auth/signout" method="post" className="mt-2.5">
                  <button className={`${secondaryButtonClass('sm')} w-full`} type="submit">
                    Sign out
                  </button>
                </form>
              </div>
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 sm:px-8 sm:py-10">
            {children}
          </main>

          <footer className="mt-6 border-t border-border px-6 py-5">
            <p className="mx-auto max-w-2xl text-center text-xs leading-relaxed text-subtle">
              A copilot, not an autonomous accountant. Every material change is reviewed and
              signed off by a person, and every number can be traced to its source rows.
            </p>
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
  // Same words as the workspace panel's engine strip. The frame said
  // "Operational" while the panel on the page said "Running without a model",
  // about the same worker, from the same row.
  const label = { ok: 'Connected', degraded: 'Degraded', unknown: 'Unknown' }[state];
  const dot = {
    ok: 'bg-success',
    degraded: 'bg-warning',
    unknown: 'bg-subtle',
  }[state];

  return (
    <div className="border-t border-border px-5 py-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">AI engine</p>
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
