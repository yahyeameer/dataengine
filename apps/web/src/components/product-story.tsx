/**
 * What DataEngine is, for someone who has never seen it.
 *
 * This sits beside the sign-in form, so it has a few seconds to answer "what is
 * this and why would I trust it with a client's books". Every claim here is one
 * the system actually implements — the pipeline stages are the real job kinds,
 * the recipe loop is `_capture_recipe_from` and the signature match in
 * `handle_parse_workbook`, and the redaction claim is `llm/redact.py`.
 *
 * Nothing here says the AI trains itself or gets smarter. It does not, and an
 * accountant who later discovered that had been oversold would be right to
 * distrust everything else on the page.
 *
 * Server component: no state, no effects, no JavaScript shipped.
 */

const PIPELINE = [
  { step: 'Upload', detail: 'Your spreadsheet, as it is' },
  { step: 'Understand', detail: 'Finds the real table in the mess' },
  { step: 'Clean', detail: 'Proposes fixes, you approve them' },
  { step: 'Categorise', detail: 'Groups values you review' },
  { step: 'Analyse', detail: 'Answers questions about the result' },
  { step: 'Report', detail: 'A month-end you can send on' },
];

export function ProductStory() {
  return (
    <div className="flex flex-col justify-center">
      <div className="mb-8 flex items-center gap-2.5">
        <Mark />
        <span className="text-[15px] font-semibold tracking-tight">DataEngine</span>
      </div>

      <h1 className="max-w-lg text-4xl font-semibold leading-[1.1] tracking-tight text-balance sm:text-5xl">
        Turn messy business data into decisions.
      </h1>

      <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted">
        Upload a spreadsheet. DataEngine finds the real table inside it, tells you what is wrong
        with the data, and proposes fixes for you to approve — then does the same work again next
        month without being asked twice.
      </p>

      {/* The pipeline. A list rather than a diagram: it reads on a phone, it
          reads to a screen reader, and it ships no JavaScript. */}
      <ol className="mt-10 max-w-md space-y-0">
        {PIPELINE.map(({ step, detail }, i) => (
          <li key={step} className="group relative flex gap-4 pb-5 last:pb-0">
            {/* Connector, drawn behind the marker and stopped on the last item. */}
            {i < PIPELINE.length - 1 && (
              <span
                aria-hidden
                className="absolute left-[11px] top-6 h-[calc(100%-1rem)] w-px bg-border"
              />
            )}
            <span
              aria-hidden
              className="relative z-10 mt-0.5 flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent-soft font-mono text-[10px] font-semibold text-accent"
            >
              {i + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{step}</span>
              <span className="block text-sm text-subtle">{detail}</span>
            </span>
          </li>
        ))}
      </ol>

      {/* The two things that actually differentiate this product, and the two
          an accountant cares about most. Both are verifiable in the codebase. */}
      <div className="mt-10 grid max-w-md gap-3 sm:grid-cols-2">
        <Assurance title="You approve every change">
          Nothing is altered on its own. DataEngine proposes; a person decides; the original file is
          never overwritten.
        </Assurance>
        <Assurance title="The model never sees your rows">
          It receives column names, statistics and a handful of frequent values — never a row, and
          never a figure tied to a client.
        </Assurance>
      </div>

      <p className="mt-8 max-w-md text-sm leading-relaxed text-subtle">
        <span className="font-medium text-muted">It learns your month-end.</span> When you approve a
        set of fixes, DataEngine keeps them as a recipe. Next month&rsquo;s file with the same shape
        is cleaned the same way automatically, and only the things that differ are brought back to
        you.
      </p>
    </div>
  );
}

function Assurance({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius)] border border-border bg-surface/60 p-3.5">
      <p className="text-[13px] font-semibold tracking-tight">{title}</p>
      <p className="mt-1 text-[13px] leading-relaxed text-subtle">{children}</p>
    </div>
  );
}

/**
 * The mark: a table condensing to a single row.
 *
 * Six bars becoming one is the product in one glyph — many messy rows, one
 * clean answer — and it costs a few hundred bytes of inline SVG rather than a
 * logo file and a network request.
 */
export function Mark({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden fill="none">
      {/* Three ragged rows — the spreadsheet as it arrives. Drawn in the
          inherited colour at falling opacity so the eye reads them as one
          group rather than three facts. */}
      <rect x="4" y="5" width="15" height="3" rx="1.5" fill="currentColor" opacity="0.35" />
      <rect x="4" y="11" width="21" height="3" rx="1.5" fill="currentColor" opacity="0.45" />
      <rect x="4" y="17" width="11" height="3" rx="1.5" fill="currentColor" opacity="0.35" />
      {/* One clean row: the answer. Full strength, full width. */}
      <rect x="4" y="24" width="24" height="3" rx="1.5" fill="currentColor" />
    </svg>
  );
}
