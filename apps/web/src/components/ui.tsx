import type { ReactNode } from 'react';

/**
 * The primitives everything else is built from.
 *
 * Kept as one file on purpose: the set is small enough to read in a sitting,
 * and a component library split across twenty files nobody opens is how design
 * systems drift. When this stops fitting on one screen, split it.
 *
 * Two rules hold throughout. Colour comes from a token, never a literal, so
 * light and dark stay in step. And nothing here animates unless the animation
 * carries information -- a status changing, something loading.
 */

/* --------------------------------------------------------------------------
   Surfaces
   -------------------------------------------------------------------------- */

export function Card({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article';
}) {
  return (
    <Tag
      className={`rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-sm)] ${className}`}
    >
      {children}
    </Tag>
  );
}

/** A card that needs a title without the caller hand-rolling the same header. */
export function Panel({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card as="section" className={className}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="p-5">{children}</div>
    </Card>
  );
}

/* --------------------------------------------------------------------------
   Type and page structure
   -------------------------------------------------------------------------- */

export function PageHeader({
  title,
  subtitle,
  action,
  eyebrow,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-accent">
            {eyebrow}
          </p>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-sm text-muted">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}

export function SectionHeading({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-semibold tracking-tight">{children}</h2>
      {hint && <span className="text-xs text-subtle">{hint}</span>}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Controls

   Exported as class strings rather than components because they are applied to
   `button`, `a` and `input` interchangeably, and wrapping each would cost more
   than it saves.
   -------------------------------------------------------------------------- */

const controlBase =
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius)] text-sm font-medium ' +
  'transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50';

export const buttonClass =
  `${controlBase} bg-accent px-4 py-2 text-white hover:bg-accent-hover ` +
  'shadow-[var(--shadow-sm)]';

export const secondaryButtonClass =
  `${controlBase} border border-border bg-surface px-4 py-2 text-foreground hover:bg-surface-2 hover:border-border-strong`;

export const ghostButtonClass =
  `${controlBase} px-3 py-1.5 text-muted hover:bg-surface-2 hover:text-foreground`;

export const dangerButtonClass =
  `${controlBase} border border-danger/30 bg-danger-soft px-4 py-2 text-danger hover:border-danger/50`;

export const inputClass =
  'w-full rounded-[var(--radius)] border border-border bg-surface px-3 py-2 text-sm text-foreground ' +
  'outline-none transition-colors placeholder:text-subtle ' +
  'focus:border-accent focus:ring-2 focus:ring-[var(--accent-ring)]';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-subtle">{hint}</span>}
    </label>
  );
}

/* --------------------------------------------------------------------------
   Status

   One vocabulary for every state in the product. `StatusBadge` previously knew
   three upload statuses and rendered every job status as anonymous grey, so a
   failed job looked exactly like a queued one.
   -------------------------------------------------------------------------- */

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted border-border',
  success: 'bg-success-soft text-success border-success/25',
  warning: 'bg-warning-soft text-warning border-warning/25',
  danger: 'bg-danger-soft text-danger border-danger/25',
  info: 'bg-info-soft text-info border-info/25',
  accent: 'bg-accent-soft text-accent border-accent/25',
};

/** Every status string this product can show, mapped once. */
const STATUS_TONE: Record<string, Tone> = {
  // uploads
  pending: 'warning',
  stored: 'success',
  // jobs
  queued: 'neutral',
  running: 'info',
  succeeded: 'success',
  // proposals
  proposed: 'accent',
  approved: 'success',
  applied: 'success',
  rejected: 'neutral',
  superseded: 'neutral',
  // shared
  failed: 'danger',
};

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? 'neutral';
  const live = status === 'running';
  return (
    <Badge tone={tone}>
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full bg-current ${live ? 'pulse-dot' : ''}`}
      />
      {status}
    </Badge>
  );
}

/** A dot on its own, for places where a pill is too heavy. */
export function StatusDot({ tone = 'neutral', live = false }: { tone?: Tone; live?: boolean }) {
  const colour: Record<Tone, string> = {
    neutral: 'bg-subtle',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    info: 'bg-info',
    accent: 'bg-accent',
  };
  return (
    <span
      aria-hidden
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${colour[tone]} ${live ? 'pulse-dot' : ''}`}
    />
  );
}

/* --------------------------------------------------------------------------
   Feedback
   -------------------------------------------------------------------------- */

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="rounded-[var(--radius)] border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger"
    >
      {children}
    </p>
  );
}

/**
 * An error a person can act on.
 *
 * "Something went wrong" tells the reader only that we know as little as they
 * do. What happened, and what to try, is the least an accountant is owed when
 * a client's file will not process.
 */
export function ErrorState({
  title,
  what,
  next,
  action,
}: {
  title: string;
  what: string;
  next: string;
  action?: ReactNode;
}) {
  return (
    <Card className="p-6">
      <div className="flex gap-3">
        <StatusDot tone="danger" />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{title}</h3>
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="font-medium">What happened</dt>
              <dd className="text-muted">{what}</dd>
            </div>
            <div>
              <dt className="font-medium">What you can do</dt>
              <dd className="text-muted">{next}</dd>
            </div>
          </dl>
          {action && <div className="mt-4">{action}</div>}
        </div>
      </div>
    </Card>
  );
}

/**
 * An empty state that points somewhere.
 *
 * `steps` exists because the first screen a new customer sees is empty, and
 * that is the best moment to explain what the product will do with their file.
 */
export function EmptyState({
  title,
  body,
  steps,
  action,
}: {
  title: string;
  body: string;
  steps?: string[];
  action?: ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-border bg-surface/50 px-6 py-12 text-center">
      <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">{body}</p>

      {steps && steps.length > 0 && (
        <ol className="mx-auto mt-6 max-w-md space-y-2 text-left">
          {steps.map((step, i) => (
            <li key={step} className="flex items-start gap-3 text-sm text-muted">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft font-mono text-[11px] font-semibold text-accent">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      )}

      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Loading

   Shapes that match what is arriving, so the layout does not jump when it
   does. A spinner tells the reader to wait; a skeleton tells them what for.
   -------------------------------------------------------------------------- */

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={`h-3.5 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div
      className="overflow-hidden rounded-[var(--radius-lg)] border border-border"
      role="status"
      aria-label="Loading"
    >
      <div className="flex gap-4 border-b border-border bg-surface-2 px-4 py-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b border-border px-4 py-3.5 last:border-0">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={`h-3.5 flex-1 ${c === 0 ? '' : 'opacity-70'}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Data display
   -------------------------------------------------------------------------- */

/**
 * A table that scrolls inside its own box.
 *
 * Financial tables are wide and phones are not. Letting the page scroll
 * sideways instead breaks every other column on the screen, so the overflow is
 * contained here once rather than remembered at each call site.
 */
export function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-border bg-surface">
      <table className="w-full min-w-[42rem] text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-subtle ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  className = '',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td
      className={`px-4 py-3 align-top ${align === 'right' ? 'text-right tabular' : ''} ${className}`}
    >
      {children}
    </td>
  );
}

/** A single figure with its label. No sparkline, no delta, no invented trend. */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3.5">
      <p className="text-xs font-medium uppercase tracking-wider text-subtle">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-subtle">{hint}</p>}
    </div>
  );
}
