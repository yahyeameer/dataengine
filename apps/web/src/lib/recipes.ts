/**
 * Reading a recipe on screen.
 *
 * The engine is the authority: `services/hermes/hermes/tools/recipe_schema.py`
 * decides which operations exist, what each one is classified as and whether a
 * definition may be stored at all. What lives here is the vocabulary needed to
 * *display* one — the plain-English name of a step, and the same safety tiers
 * so the recipe page can say "two of these steps will stop for approval"
 * without running anything.
 *
 * Kept deliberately small, and deliberately not the enforcement point. A step
 * list posted from this app is validated again by the worker before it is ever
 * replayed; if the two lists here ever drift from the engine's, the cost is a
 * label reading "map_values" rather than a recipe doing something unapproved.
 */

export const REPORT_FORMATS = ['pdf', 'docx', 'xlsx', 'md'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export type Safety = 'safe' | 'review_required' | 'blocked';

/** Mirrors SAFE_OPERATIONS in recipe_schema.py. */
const SAFE_OPERATIONS = new Set([
  'normalize_whitespace',
  'normalize_case',
  'drop_duplicate_rows',
  'review_ambiguous_dates',
  'review_key_conflicts',
  'review_outliers',
  'review_vat_rate',
  'block_totals_mismatch',
]);

/** Mirrors REVIEW_OPERATIONS. Everything else is unknown, and unknown is blocked. */
const REVIEW_OPERATIONS = new Set([
  'map_values',
  'coerce_number',
  'normalize_date',
  'assign_category',
  'assign_hmrc_categories',
]);

export function safetyOf(op: string): Safety {
  if (SAFE_OPERATIONS.has(op)) return 'safe';
  if (REVIEW_OPERATIONS.has(op)) return 'review_required';
  return 'blocked';
}

const LABELS: Record<string, string> = {
  normalize_whitespace: 'Trim whitespace',
  normalize_case: 'Standardise capitalisation',
  map_values: 'Normalise names against the mapping table',
  drop_duplicate_rows: 'Remove exact duplicates',
  coerce_number: 'Read as numbers',
  normalize_date: 'Standardise dates',
  assign_category: 'Assign categories',
  assign_hmrc_categories: 'Assign HMRC categories',
  review_ambiguous_dates: 'Flag ambiguous dates for review',
  review_key_conflicts: 'Flag conflicting keys for review',
  review_outliers: 'Flag outliers for review',
  review_vat_rate: 'Flag unexpected VAT rates for review',
  block_totals_mismatch: 'Stop if totals do not reconcile',
};

export type RecipeStep = {
  id?: string;
  op?: string;
  params?: Record<string, unknown> | null;
  enabled?: boolean;
};

export function stepLabel(step: RecipeStep): string {
  const op = step.op ?? 'unknown';
  const base = LABELS[op] ?? op.replaceAll('_', ' ');
  const column = step.params?.column;
  return typeof column === 'string' && column ? `${base} · ${column}` : base;
}

export function parseSteps(value: unknown): RecipeStep[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is RecipeStep => typeof item === 'object' && item !== null);
}

export function safetySummary(steps: RecipeStep[]): Record<Safety, number> {
  const summary: Record<Safety, number> = { safe: 0, review_required: 0, blocked: 0 };
  for (const step of steps) summary[safetyOf(step.op ?? '')] += 1;
  return summary;
}

export type ReportConfig = { formats: ReportFormat[]; title?: string };

export function parseReportConfig(value: unknown): ReportConfig | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { formats?: unknown; title?: unknown };
  const formats = Array.isArray(raw.formats)
    ? raw.formats.filter((item): item is ReportFormat =>
        (REPORT_FORMATS as readonly string[]).includes(item as string),
      )
    : [];
  if (formats.length === 0) return null;
  return { formats, ...(typeof raw.title === 'string' ? { title: raw.title } : {}) };
}

export function validateReportConfig(
  input: { formats: string[]; title?: string | null },
): { ok: true; config: ReportConfig } | { ok: false; reason: string } {
  const formats: ReportFormat[] = [];
  for (const value of input.formats) {
    if (!(REPORT_FORMATS as readonly string[]).includes(value)) {
      return { ok: false, reason: `${value} is not a report format.` };
    }
    if (!formats.includes(value as ReportFormat)) formats.push(value as ReportFormat);
  }
  if (formats.length === 0) return { ok: false, reason: 'Choose at least one format.' };

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  return { ok: true, config: { formats, ...(title ? { title: title.slice(0, 200) } : {}) } };
}
