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
import { CommandMenu } from '@/components/command-menu';
import { ShieldCheck, Cpu } from 'lucide-react';

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
    <div className="flex min-h-svh flex-col bg-slate-950 text-slate-100 selection:bg-cyan-500/30">
      <SystemHealthBanner role={role} health={health} />

      <div className="flex flex-1 flex-col lg:flex-row">
        {/* --- Sidebar Navigation --- */}
        <aside className="sticky top-0 z-30 shrink-0 border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-xl lg:h-svh lg:w-64 lg:self-start lg:border-b-0 lg:border-r lg:bg-slate-900/40">
          
          {/* Mobile top bar */}
          <div className="lg:hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <Link
                href="/app"
                className="flex items-center gap-2.5 rounded-lg p-1 transition-colors hover:bg-slate-800/50"
              >
                <Mark className="h-6 w-6 text-cyan-400" />
                <span className="font-heading font-extrabold text-base tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-teal-300 to-indigo-300">
                  DataEngine
                </span>
              </Link>

              <span className="truncate border-l border-slate-800 pl-3 text-xs font-medium text-slate-300 max-w-[140px]">
                {orgName}
              </span>

              <form action="/auth/signout" method="post">
                <button className={secondaryButtonClass('sm')} type="submit">
                  Sign out
                </button>
              </form>
            </div>

            <nav className="flex items-center gap-1 px-3 pb-2.5 overflow-x-auto">
              {NAV.map((item) => (
                <NavLink key={item.href} href={item.href} icon={item.icon}>
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          {/* Desktop full sidebar */}
          <div className="hidden lg:flex lg:h-full lg:flex-col lg:justify-between">
            <div>
              {/* Header Branding */}
              <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-4">
                <Link href="/app" className="flex items-center gap-3 group">
                  <div className="p-1.5 rounded-xl bg-gradient-to-br from-cyan-500/20 to-teal-500/10 border border-cyan-500/30 group-hover:border-cyan-400/60 transition-all shadow-[0_0_15px_-3px_rgba(6,182,212,0.3)]">
                    <Mark className="h-6 w-6 text-cyan-400" />
                  </div>
                  <span className="font-heading font-extrabold text-lg tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-slate-100 via-cyan-100 to-teal-200">
                    DataEngine
                  </span>
                </Link>
              </div>

              {/* Quick Command Trigger */}
              <div className="px-3 pt-4 pb-2">
                <CommandMenu />
              </div>

              {/* Workspace / Org Badge */}
              <div className="mx-3 my-2 rounded-xl border border-slate-800/80 bg-slate-900/50 p-3.5 shadow-inner">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400/80">
                    Active Client
                  </p>
                  <span className="inline-flex items-center gap-1 rounded-full bg-cyan-950/60 px-2 py-0.5 text-[10px] font-medium text-cyan-300 border border-cyan-800/50">
                    <ShieldCheck className="w-3 h-3 text-cyan-400" />
                    {role}
                  </span>
                </div>
                <p className="mt-1.5 truncate text-sm font-semibold text-slate-100" title={orgName}>
                  {orgName}
                </p>
              </div>

              {/* Navigation Links */}
              <nav className="flex flex-col gap-1.5 px-3 py-3">
                {NAV.map((item) => (
                  <NavLink key={item.href} href={item.href} icon={item.icon}>
                    {item.label}
                  </NavLink>
                ))}
              </nav>
            </div>

            {/* Bottom Status & Account */}
            <div className="mt-auto border-t border-slate-800/80">
              {isAdmin && <EngineStatus state={health.state} />}

              <div className="p-4 bg-slate-900/30">
                {email && (
                  <p className="truncate text-xs font-mono text-slate-400 mb-3" title={email}>
                    {email}
                  </p>
                )}
                <form action="/auth/signout" method="post">
                  <button className={`${secondaryButtonClass('sm')} w-full text-slate-300 hover:text-slate-100 hover:border-slate-700`} type="submit">
                    Sign out
                  </button>
                </form>
              </div>
            </div>
          </div>
        </aside>

        {/* --- Main Content Area --- */}
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-8 sm:py-10">
            {children}
          </main>

          <footer className="mt-12 border-t border-slate-800/60 px-6 py-6 bg-slate-950/80">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-xs leading-relaxed text-slate-400">
                DataEngine AI Copilot · Professional Financial Automation Engine
              </p>
              <p className="mt-1 text-[11px] text-slate-400/80">
                Every material proposal is verifiable and audited against source bank files.
              </p>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}

function EngineStatus({ state }: { state: 'ok' | 'degraded' | 'unknown' }) {
  const label = { ok: 'AI Engine Ready', degraded: 'Engine Degraded', unknown: 'Connecting...' }[state];
  const color = {
    ok: 'bg-emerald-400 text-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]',
    degraded: 'bg-amber-400 text-amber-400',
    unknown: 'bg-slate-500 text-slate-500',
  }[state];

  return (
    <div className="px-5 py-3.5 bg-slate-900/20 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Cpu className="w-4 h-4 text-cyan-400" />
        <span className="text-xs font-semibold text-slate-300">{label}</span>
      </div>
      <span aria-hidden className={`h-2 w-2 rounded-full ${color}`} />
    </div>
  );
}

