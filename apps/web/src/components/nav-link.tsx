'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * A navigation item that knows whether it is the current one.
 *
 * The frame was entirely server-rendered and therefore had no way to mark the
 * active destination, so both entries looked identical on every screen and the
 * only clue to where you were was the page title. This is the one piece of the
 * shell that needs the client, and it is a few hundred bytes.
 *
 * `/app` is matched exactly. Prefix-matching it would light up Workspaces while
 * the reader is on Activity, since every route in the product starts with
 * `/app`.
 */
export function NavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const active = href === '/app' ? pathname === '/app' : pathname.startsWith(href);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`group relative flex items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-sm transition-colors ${
        active
          ? 'bg-accent-soft font-medium text-accent'
          : 'text-muted hover:bg-surface-2 hover:text-foreground'
      }`}
    >
      <span
        aria-hidden
        className={`shrink-0 transition-colors ${active ? 'text-accent' : 'text-subtle group-hover:text-muted'}`}
      >
        {icon}
      </span>
      {children}
    </Link>
  );
}

/* --------------------------------------------------------------------------
   Icons.

   Inline and stroked to match the weight of the wordmark. Three of them, drawn
   here rather than pulled from a dependency, because three icons is not worth a
   package and a bundle.
   -------------------------------------------------------------------------- */

/** An arrow into a tray: the upload the whole product starts with. */
export function CategoriseIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
      <path
        d="M8 1.75v7.5M5.25 4.5 8 1.75l2.75 2.75"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.25 10.25v2.25a1.5 1.5 0 0 0 1.5 1.5h8.5a1.5 1.5 0 0 0 1.5-1.5v-2.25"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function WorkspacesIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
      <rect x="1.75" y="2.75" width="5" height="4.5" rx="1.25" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9.25" y="2.75" width="5" height="4.5" rx="1.25" stroke="currentColor" strokeWidth="1.4" />
      <rect x="1.75" y="8.75" width="5" height="4.5" rx="1.25" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9.25" y="8.75" width="5" height="4.5" rx="1.25" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function ActivityIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
      <path
        d="M1.75 8.5h2.6l1.7-4.6 2.6 8.2 1.75-3.6h3.85"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
