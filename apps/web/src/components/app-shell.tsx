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
import { CommandMenu } from '@/components/command-menu';
import { StatusDot, secondaryButtonClass } from '@/components/ui';

/**
 * The frame every signed-in screen sits in.
 *
 * It used to hand-pick four near-identical dark values — #050811, #080d1a,
 * #070b16 and #040710 — for the page, the sidebar, the sidebar at large sizes
 * and the footer. No reader could tell them apart, and none of them was the
 * ground the rest of the product was drawn on. There are two surfaces here
 * now: the page, and the rail beside it.
 */

const NAV = [
  { href: '/app', label: 'Categorise', icon: <CategoriseIcon /> },
  { href: '/app/workspaces', label: 'Workspaces', icon: <WorkspacesIcon /> },
  { href: '/app/audit', label: 'Activity Log', icon: <ActivityIcon /> },
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
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <SystemHealthBanner role={role} health={health} />

      <div className="flex flex-1 flex-col lg:flex-row">
        {/* Opaque, not frosted. On desktop this rail is a full-height column
            with nothing scrolling under it, so a backdrop-filter bought no
            depth and cost a compositing layer — and Chromium sampled the
            wrong region into it, painting ghosts of the right rail's figures
            over the empty middle of the sidebar. */}
        <aside className="sticky top-0 z-30 shrink-0 border-b border-border bg-surface lg:h-svh lg:w-64 lg:self-start lg:border-b-0 lg:border-r">
          {/* --- Mobile bar --- */}
          <div className="lg:hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <Link
                href="/app"
                className="flex items-center gap-2.5 rounded-[var(--radius)] p-1 transition-colors hover:bg-surface-2"
              >
                <Mark className="h-6 w-6 text-accent" />
                <span className="font-heading text-base font-semibold tracking-tight">
                  DataEngine
                </span>
              </Link>

              <span
                className="max-w-[140px] truncate border-l border-border pl-3 font-mono text-xs text-muted"
                title={orgName}
              >
                {orgName}
              </span>

              <form action="/auth/signout" method="post">
                <SignOutButton />
              </form>
            </div>

            <nav className="flex items-center gap-1 overflow-x-auto px-3 pb-2.5">
              {NAV.map((item) => (
                <NavLink key={item.href} href={item.href} icon={item.icon}>
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          {/* --- Desktop rail --- */}
          <div className="hidden lg:flex lg:h-full lg:flex-col">
            <div className="flex items-center border-b border-border-subtle px-5 py-4">
              <Link href="/app" className="group flex items-center gap-2.5">
                <Mark className="h-6 w-6 text-accent transition-transform duration-[--duration] group-hover:scale-105" />
                <span className="font-heading text-[15px] font-semibold tracking-tight">
                  DataEngine
                </span>
              </Link>
            </div>

            <div className="px-3 pb-1 pt-3">
              <CommandMenu />
            </div>

            {/* The client whose books are on screen. It is the single most
                consequential piece of state in the product — every figure
                below belongs to this org and to no other — so it is stated
                once, plainly, above the navigation rather than dressed as a
                card competing with it. */}
            <div className="px-5 pb-1 pt-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.11em] text-subtle">
                Active client
              </p>
              <div className="mt-1 flex items-baseline justify-between gap-2">
                <p className="min-w-0 truncate font-heading text-sm font-semibold" title={orgName}>
                  {orgName}
                </p>
                <span className="shrink-0 text-[11px] text-subtle">{role}</span>
              </div>
            </div>

            <nav className="flex flex-col gap-0.5 px-3 py-4">
              {NAV.map((item) => (
                <NavLink key={item.href} href={item.href} icon={item.icon}>
                  {item.label}
                </NavLink>
              ))}
            </nav>

            <div className="mt-auto border-t border-border-subtle">
              {isAdmin && <EngineStatus state={health.state} />}

              <div className="px-5 py-4">
                {email && (
                  <p className="mb-2.5 truncate font-mono text-[11px] text-subtle" title={email}>
                    {email}
                  </p>
                )}
                <form action="/auth/signout" method="post">
                  <SignOutButton full />
                </form>
              </div>
            </div>
          </div>
        </aside>

        {/* --- Main --- */}
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-8 sm:py-10">
            {children}
          </main>

          <footer className="border-t border-border-subtle px-6 py-5">
            <p className="text-center text-[11px] text-subtle">
              DataEngine · categorisation is proposed, never applied without approval
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}

/**
 * One sign-out control, at two widths, rather than two that drifted apart.
 *
 * It used to spell out a secondary button by hand -- the same height, radius,
 * border and hover as `secondaryButtonClass('sm')`, arrived at independently
 * and free to drift from it. `ui.tsx` is the source of truth for a control's
 * shape, so this asks for the shape by name.
 */
function SignOutButton({ full = false }: { full?: boolean }) {
  return (
    <button
      type="submit"
      className={`${secondaryButtonClass('sm')} ${full ? 'w-full' : ''}`}
    >
      Sign out
    </button>
  );
}

/**
 * Whether the worker that does the actual categorising is answering.
 *
 * Admins only, at the foot of the rail: it is the difference between "the
 * queue is slow" and "nothing you upload tonight will be processed", and an
 * accountant who cannot act on it does not need to carry it.
 */
function EngineStatus({ state }: { state: 'ok' | 'degraded' | 'unknown' }) {
  const label = { ok: 'Engine connected', degraded: 'Engine degraded', unknown: 'Connecting…' }[
    state
  ];
  const tone = ({ ok: 'success', degraded: 'warning', unknown: 'neutral' } as const)[state];

  return (
    <div className="flex items-center justify-between gap-2 px-5 py-3">
      <span className="text-[11px] font-medium text-muted">{label}</span>
      <StatusDot tone={tone} live={state === 'ok'} />
    </div>
  );
}
