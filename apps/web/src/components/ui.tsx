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
      className={`rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-md)] ${className}`}
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
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div className="min-w-0">
          <h2 className="font-heading text-base font-semibold tracking-tight text-foreground">{title}</h2>
          {description && <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>}
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
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-accent">
            {eyebrow}
          </p>
        )}
        {/* Large enough to be the first thing read on the page, and the only
            thing at this size. Every other heading in the product steps down
            from here rather than competing with it. */}
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-balance sm:text-[32px]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">{subtitle}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}

/**
 * The one section heading in the product.
 *
 * There used to be three sizes of section title on the workspace page -- 14px
 * here, an 18px heading the review queue rolled itself, and a 14px uppercase
 * one in the deviations panel -- so the page read as three screens stapled
 * together. Everything now steps down from `PageHeader` through this.
 */
export function SectionHeading({
  children,
  hint,
  description,
}: {
  children: ReactNode;
  hint?: ReactNode;
  description?: string;
}) {
  return (
    <div className="mb-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[17px] font-semibold tracking-tight">{children}</h2>
        {hint && <span className="text-xs text-subtle">{hint}</span>}
      </div>
      {description && <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>}
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
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius)] font-medium ' +
  'transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 ' +
  'disabled:shadow-none';

/**
 * Two control sizes and no others.
 *
 * The product had five, arrived at one call site at a time -- `px-2.5 py-1`,
 * `px-3 py-1.5`, `px-4 py-2` -- so two buttons doing the same job in two panels
 * were different heights. `md` is the default; `sm` is for controls that sit
 * inside a row of content rather than under it.
 *
 * Both clear 32px, which is the smallest a real person hits reliably.
 */
export const controlSize = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm',
} as const;

export type ControlSize = keyof typeof controlSize;

/**
 * The filled control.
 *
 * `text-accent-ink` rather than `text-white`: the dark theme's accent is a pale
 * mint, and white on it was the one unreadable pairing in the palette. Every
 * primary button in the product was affected.
 */
export function buttonClass(size: ControlSize = 'md') {
  return (
    `${controlBase} ${controlSize[size]} glow-hover bg-accent text-accent-ink ` +
    'hover:bg-accent-hover shadow-[var(--shadow-sm)]'
  );
}

export function secondaryButtonClass(size: ControlSize = 'md') {
  return (
    `${controlBase} ${controlSize[size]} border border-border bg-surface text-foreground ` +
    'transition-[color,background-color,border-color,box-shadow] ' +
    'hover:border-border-strong hover:bg-surface-2'
  );
}

export function ghostButtonClass(size: ControlSize = 'sm') {
  return `${controlBase} ${controlSize[size]} text-muted hover:bg-surface-2 hover:text-foreground`;
}

export function dangerButtonClass(size: ControlSize = 'md') {
  return (
    `${controlBase} ${controlSize[size]} border border-danger/30 bg-danger-soft text-danger ` +
    'hover:border-danger/50'
  );
}

/**
 * A quiet text control for a disclosure -- "Show evidence", "Show all". Not a
 * button shape, because it reveals rather than does.
 */
/**
 * Sized to be hittable. At its natural line height this was a 20px-tall target
 * on a phone, which is under every touch guideline going -- and it is the
 * control that opens the evidence behind a decision worth millions.
 */
export const disclosureClass =
  'inline-flex min-h-8 items-center gap-1.5 rounded-[var(--radius)] py-1.5 text-[13px] ' +
  'font-medium text-accent transition-colors hover:text-accent-hover';

export const inputClass =
  'w-full min-w-0 rounded-[var(--radius)] border border-border bg-surface px-3 text-sm text-foreground ' +
  'h-10 outline-none transition-[border-color,box-shadow] placeholder:text-subtle ' +
  'focus:border-accent focus:ring-2 focus:ring-[var(--accent-ring)]';

/** The same field at the small size, for controls that sit inside a row. */
export const inputClassSm =
  'w-full min-w-0 rounded-[var(--radius)] border border-border bg-surface px-2.5 text-[13px] text-foreground ' +
  'h-8 outline-none transition-[border-color,box-shadow] placeholder:text-subtle ' +
  'focus:border-accent focus:ring-2 focus:ring-[var(--accent-ring)]';

/**
 * A `select` needs `max-w-full` explicitly.
 *
 * A native select sizes itself to its widest option, ignores its flex
 * container, and will not shrink. The categorise control was fed real column
 * names and stretched the whole workspace page to 1,649px on a 1,440px screen
 * -- every viewport scrolled sideways because of one dropdown.
 */
export const selectClass = `${inputClass} max-w-full`;

/**
 * A file input keeps its native button, so it cannot take a fixed height the
 * way the other controls do -- the browser lays the button out on its own
 * baseline and a hard `h-10` clips it.
 */
export const fileInputClass =
  'w-full min-w-0 rounded-[var(--radius)] border border-border bg-surface px-3 py-2 text-sm ' +
  'text-foreground outline-none transition-[border-color,box-shadow] ' +
  'file:mr-3 file:rounded-[6px] file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 ' +
  'file:text-[13px] file:font-medium file:text-foreground hover:border-border-strong ' +
  'focus:border-accent focus:ring-2 focus:ring-[var(--accent-ring)]';
export const selectClassSm = `${inputClassSm} max-w-full`;

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

/**
 * Every status string this product can show, mapped once.
 *
 * The four job states are the spine of it: queued amber, running blue,
 * succeeded green, failed red. `queued` was `neutral`, which made a job that
 * had not started yet look identical to one that had been rejected and to one
 * that had been superseded — three different facts in the same grey. Waiting
 * is a state the reader is waiting *on*, so it gets a colour.
 */
const STATUS_TONE: Record<string, Tone> = {
  // uploads
  pending: 'warning',
  stored: 'success',
  // jobs
  queued: 'warning',
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
  const laddered = Boolean(steps && steps.length > 0);

  return (
    // A solid surface rather than a dashed outline. The dashed box read as a
    // drop target on the workspace page -- it sat beside an upload form, and
    // nothing could be dropped on it.
    <div className="rounded-[var(--radius-lg)] border border-border bg-surface px-6 py-10 sm:px-8">
      <div className={laddered ? '' : 'text-center'}>
        <h3 className="text-base font-semibold tracking-tight">{title}</h3>
        <p
          className={`mt-1.5 text-sm leading-relaxed text-muted ${
            laddered ? 'max-w-lg' : 'mx-auto max-w-md'
          }`}
        >
          {body}
        </p>
      </div>

      {laddered && (
        // The same numbered ladder the sign-in page uses to explain the
        // product, so a first-time customer meets one explanation twice rather
        // than two different ones.
        <ol className="mt-6 max-w-lg">
          {steps!.map((step, i) => (
            <li key={step} className="relative flex gap-3.5 pb-4 last:pb-0">
              {i < steps!.length - 1 && (
                <span
                  aria-hidden
                  className="absolute left-[11px] top-6 h-[calc(100%-1rem)] w-px bg-border"
                />
              )}
              <span
                aria-hidden
                className="relative z-10 flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent-soft font-mono text-[10px] font-semibold text-accent"
              >
                {i + 1}
              </span>
              <span className="min-w-0 pt-0.5 text-sm leading-relaxed text-muted">{step}</span>
            </li>
          ))}
        </ol>
      )}

      {action && (
        <div className={`mt-7 flex ${laddered ? '' : 'justify-center'}`}>{action}</div>
      )}
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
 *
 * `stickyHead` because the audit log is two hundred rows and twenty thousand
 * pixels tall. A header that scrolls away on a table that long is a header
 * that is only read once.
 */
export function TableShell({
  children,
  stickyHead = false,
  minWidth = '42rem',
  maxHeight = '70vh',
}: {
  children: ReactNode;
  stickyHead?: boolean;
  minWidth?: string;
  /** Only used with `stickyHead`; see below for why it is not optional there. */
  maxHeight?: string;
}) {
  return (
    <div
      // `sticky` resolves against the nearest scrollport, and `overflow-x-auto`
      // already made this box one -- CSS computes the other axis to `auto` as
      // soon as one axis is not `visible`. With no height limit that box never
      // scrolled, so the header stuck to a scrollport that never moved while
      // the *page* scrolled past it: two hundred audit rows, twenty thousand
      // pixels, and a header visible for the first screenful only. Capping the
      // height is what makes the header actually stick.
      className={`overflow-x-auto rounded-[var(--radius-lg)] border border-border bg-surface ${
        stickyHead
          ? 'overflow-y-auto [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10'
          : ''
      }`}
      style={stickyHead ? { maxHeight } : undefined}
    >
      <table className="w-full text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  align = 'left',
  className = '',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap border-b border-border bg-surface-2 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${className}`}
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
      className={`px-4 py-2.5 align-middle ${
        align === 'right' ? 'text-right tabular' : ''
      } ${className}`}
    >
      {children}
    </td>
  );
}

/** A body whose rows separate and warm under the cursor. */
export const tableBodyClass =
  'divide-y divide-border-subtle [&>tr]:transition-colors [&>tr:hover]:bg-surface-2/70';

/** A single figure with its label. No sparkline, no delta, no invented trend. */
export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'neutral' | 'accent' | 'warning';
}) {
  const accentRing = {
    neutral: 'border-border',
    accent: 'border-accent/30 bg-accent-soft/30',
    warning: 'border-warning/30 bg-warning-soft/40',
  }[tone];

  return (
    <div className={`rounded-[var(--radius-lg)] border bg-surface px-4 py-3.5 ${accentRing}`}>
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular leading-none tracking-tight">{value}</p>
      {hint && <p className="mt-1.5 text-xs text-subtle">{hint}</p>}
    </div>
  );
}

/**
 * A money figure, at the weight the amount deserves.
 *
 * The review queue asks an accountant to sign off on a change worth thirteen
 * million pounds, and that number was rendered at 12px in the same grey as the
 * column name beside it. Materiality is the axis the whole queue is ranked on;
 * it should not be the quietest thing in the row.
 */
export function Money({
  children,
  size = 'sm',
}: {
  children: ReactNode;
  size?: 'sm' | 'lg';
}) {
  return (
    <span
      className={`tabular font-semibold tracking-tight text-foreground ${
        size === 'lg' ? 'text-[17px]' : 'text-[13px]'
      }`}
    >
      {children}
    </span>
  );
}

/**
 * A label/value pair for the impact strip under a proposal. Each fact gets its
 * own cell so the numbers line up down a column of proposals instead of being
 * buried in a run-on sentence.
 */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-subtle">
        {label}
      </span>
      <span className="text-[13px] leading-none">{children}</span>
    </span>
  );
}

/* --------------------------------------------------------------------------
   Layout

   The screens in this product are one of two shapes: a task with context
   beside it, or a table with a toolbar over it. Both shapes live here so a
   page describes what it contains rather than how wide its columns are.
   -------------------------------------------------------------------------- */

/**
 * A task column with a rail of context beside it.
 *
 * The strongest idea taken from the reference: the thing the reader came to do
 * stays in one uninterrupted column, and everything that is *about* the task —
 * what state it is in, what the engine will do to it, what happened recently —
 * sits to the right where it can be read without being stepped through.
 *
 * The rail collapses under the main column below `lg` rather than disappearing.
 * On a phone the context is still the answer to "what is happening?", and it
 * belongs after the task rather than instead of it.
 *
 * `sticky` on the rail's inner box, not on the rail: a sticky flex child with
 * `align-self: stretch` never moves, which is the usual way this is written
 * and the usual reason it does not work.
 */
export function RightRail({
  children,
  rail,
  railLabel = 'Details',
  sticky = true,
}: {
  children: ReactNode;
  rail: ReactNode;
  railLabel?: string;
  /**
   * Off when the rail is taller than the viewport. A sticky box that does not
   * fit pins its top and puts its own last item permanently out of reach,
   * which is worse than letting it scroll with the page.
   */
  sticky?: boolean;
}) {
  return (
    <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-10">
      <div className="min-w-0 flex-1">{children}</div>
      <aside
        aria-label={railLabel}
        className="w-full shrink-0 lg:w-[19rem] lg:self-start xl:w-[21rem]"
      >
        <div className={`flex flex-col gap-4 ${sticky ? 'lg:sticky lg:top-6' : ''}`}>
          {rail}
        </div>
      </aside>
    </div>
  );
}

/**
 * A titled block inside the rail.
 *
 * Quieter than `Panel` on purpose. The rail is read at a glance and out of the
 * corner of the eye; if every block in it carried a full card header the rail
 * would compete with the task it is meant to support.
 */
export function RailSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-subtle">
          {title}
        </h2>
        {hint && <span className="text-[11px] text-subtle">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * One number, at the size a number deserves.
 *
 * Distinct from `Stat`: `Stat` is a card in a grid on a page, this is a row in
 * a rail, where the label and the figure share a line because vertical space
 * in a rail is the scarce thing.
 */
export function KpiTile({
  label,
  value,
  tone = 'neutral',
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: string;
}) {
  const valueTone: Record<Tone, string> = {
    neutral: 'text-foreground',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
    info: 'text-info',
    accent: 'text-accent',
  };

  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="min-w-0 text-[13px] text-muted">
        {label}
        {hint && <span className="mt-0.5 block text-[11px] text-subtle">{hint}</span>}
      </span>
      <span className={`tabular text-[15px] font-semibold tracking-tight ${valueTone[tone]}`}>
        {value}
      </span>
    </div>
  );
}

/**
 * A row of mutually exclusive choices, rendered as one control.
 *
 * Replaces the pattern of two or three buttons sitting next to each other with
 * the selected one coloured in, which reads as "three actions, one of them
 * highlighted" rather than "one setting, currently on its second value".
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-[var(--radius)] border border-border bg-surface-2 p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={`h-7 cursor-pointer rounded-[calc(var(--radius)-3px)] px-3 text-[13px] font-medium transition-colors ${
              selected
                ? 'bg-surface text-foreground shadow-[var(--shadow-sm)]'
                : 'text-muted hover:text-foreground'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The bar over a table: what you are looking at on the left, what you can do
 * about it on the right.
 *
 * Exists so the gap between a heading and the table under it is one number in
 * one place, rather than whatever each page happened to pick.
 */
export function Toolbar({
  title,
  count,
  children,
}: {
  title: ReactNode;
  count?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {count !== undefined && count !== null && (
          <span className="tabular text-[13px] text-subtle">{count}</span>
        )}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
