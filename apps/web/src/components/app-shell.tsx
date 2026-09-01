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
    <div className="flex min-h-svh flex-col bg-[#050811] text-slate-100 selection:bg-sky-500/20">
      <SystemHealthBanner role={role} health={health} />

      <div className="flex flex-1 flex-col lg:flex-row">
        {/* --- Apple Vision Translucent Sidebar --- */}
        <aside className="sticky top-0 z-30 shrink-0 border-b border-white/10 bg-[#080d1a]/80 backdrop-blur-2xl lg:h-svh lg:w-64 lg:self-start lg:border-b-0 lg:border-r lg:bg-[#070b16]/70">
          
          {/* Mobile Bar */}
          <div className="lg:hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <Link
                href="/app"
                className="flex items-center gap-2.5 rounded-xl p-1 transition-colors hover:bg-white/5"
              >
                <Mark className="h-6 w-6 text-sky-400" />
                <span className="font-heading font-extrabold text-base tracking-tight text-slate-100">
                  DataEngine
                </span>
              </Link>

              <span className="truncate border-l border-white/10 pl-3 text-xs font-mono text-slate-400 max-w-[140px]">
                {orgName}
              </span>

              <form action="/auth/signout" method="post">
                <button className="px-3 py-1 rounded-lg text-xs font-medium border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white transition-all cursor-pointer" type="submit">
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

          {/* Desktop Full Sidebar */}
          <div className="hidden lg:flex lg:h-full lg:flex-col lg:justify-between">
            <div>
              {/* Header Branding */}
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                <Link href="/app" className="flex items-center gap-3 group">
                  <div className="p-2 rounded-xl bg-white/5 border border-white/10 group-hover:border-sky-400/50 group-hover:bg-sky-500/10 transition-all duration-300 shadow-sm">
                    <Mark className="h-6 w-6 text-sky-400" />
                  </div>
                  <span className="font-heading font-extrabold text-lg tracking-tight text-slate-100">
                    DataEngine
                  </span>
                </Link>
              </div>

              {/* Command Menu */}
              <div className="px-3 pt-4 pb-2">
                <CommandMenu />
              </div>

              {/* Organization Indicator Card */}
              <div className="mx-3 my-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur-md">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Active Client
                  </p>
                  <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-300 border border-sky-500/20">
                    <ShieldCheck className="w-3 h-3 text-sky-400" />
                    {role}
                  </span>
                </div>
                <p className="mt-1.5 truncate font-heading text-sm font-bold text-slate-100" title={orgName}>
                  {orgName}
                </p>
              </div>

              {/* Navigation Links */}
              <nav className="flex flex-col gap-1 px-3 py-3">
                {NAV.map((item) => (
                  <NavLink key={item.href} href={item.href} icon={item.icon}>
                    {item.label}
                  </NavLink>
                ))}
              </nav>
            </div>

            {/* Bottom Status & Account */}
            <div className="mt-auto border-t border-white/10">
              {isAdmin && <EngineStatus state={health.state} />}

              <div className="p-4 bg-white/[0.02]">
                {email && (
                  <p className="truncate text-xs font-mono text-slate-400 mb-3" title={email}>
                    {email}
                  </p>
                )}
                <form action="/auth/signout" method="post">
                  <button className="w-full px-3 py-2 rounded-xl text-xs font-semibold border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white transition-all cursor-pointer" type="submit">
                    Sign out
                  </button>
                </form>
              </div>
            </div>
          </div>
        </aside>

        {/* --- Main Workspace View --- */}
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-8 sm:py-10">
            {children}
          </main>

          <footer className="mt-16 border-t border-white/5 px-6 py-6 bg-[#040710]/90">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-xs leading-relaxed text-slate-400">
                DataEngine · Enterprise Financial Intelligence Copilot
              </p>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}

function EngineStatus({ state }: { state: 'ok' | 'degraded' | 'unknown' }) {
  const label = { ok: 'Engine Connected', degraded: 'Engine Degraded', unknown: 'Connecting...' }[state];
  const color = {
    ok: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]',
    degraded: 'bg-amber-400',
    unknown: 'bg-slate-500',
  }[state];

  return (
    <div className="px-5 py-3.5 bg-white/[0.02] flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Cpu className="w-4 h-4 text-sky-400" />
        <span className="text-xs font-semibold text-slate-300">{label}</span>
      </div>
      <span aria-hidden className={`h-2 w-2 rounded-full ${color}`} />
    </div>
  );
}


