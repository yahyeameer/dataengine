/**
 * Reading a schedule on screen.
 *
 * The arithmetic is not here. `recipe_schedule_next_run` in the database
 * computes every occurrence, and the row carries the answer — so this module
 * formats what the scheduler decided rather than predicting it. A second
 * calendar in TypeScript would disagree with the first one across a daylight
 * saving boundary and be believed, because it is the one the screen shows.
 *
 * What is here: the vocabulary the form needs, and the sentences that turn a
 * status enum into something an accountant can act on.
 */

export const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export const FREQUENCY_LABELS: Record<ScheduleFrequency, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
  quarterly: 'Every three months',
  yearly: 'Every year',
};

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * The timezones offered in the form.
 *
 * A short list rather than all 500-odd IANA names: the product's customers are
 * UK accounting practices and East African businesses, and a select with every
 * zone in it is a select nobody can use. Anything outside this list is still
 * valid — the database accepts any name `pg_timezone_names` knows — so widening
 * it later is a change to this array and nothing else.
 */
export const TIMEZONES = [
  'Europe/London',
  'UTC',
  'Africa/Nairobi',
  'Africa/Addis_Ababa',
  'Africa/Djibouti',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Europe/Dublin',
  'America/New_York',
] as const;

export type ScheduleRunStatus =
  | 'enqueued'
  | 'skipped_no_source'
  | 'skipped_disabled'
  | 'failed';

/**
 * What a firing meant, in a sentence.
 *
 * `skipped_no_source` is the one that has to read well, because on a product
 * where a person still uploads the file it is the *ordinary* outcome for any
 * month whose file has not arrived yet. Rendered as an error it would make a
 * working schedule look broken twelve times a year.
 */
export const RUN_STATUS_LABELS: Record<ScheduleRunStatus, string> = {
  enqueued: 'Ran',
  skipped_no_source: 'Waiting for this period’s file',
  skipped_disabled: 'Skipped — the recipe is switched off',
  failed: 'Failed',
};

export const RUN_STATUS_TONE: Record<ScheduleRunStatus, 'success' | 'warning' | 'neutral' | 'danger'> =
  {
    enqueued: 'success',
    skipped_no_source: 'warning',
    skipped_disabled: 'neutral',
    failed: 'danger',
  };

export type RecipeSchedule = {
  id: string;
  enabled: boolean;
  frequency: ScheduleFrequency;
  day_of_month: number | null;
  day_of_week: number | null;
  hour: number;
  minute: number;
  timezone: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: ScheduleRunStatus | null;
  last_error: string | null;
  consecutive_failures: number;
};

/** "Every month on the 1st at 09:00, Africa/Nairobi". */
export function describeCadence(schedule: {
  frequency: ScheduleFrequency;
  day_of_month: number | null;
  day_of_week: number | null;
  hour: number;
  minute: number;
  timezone: string;
}): string {
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
  const when =
    schedule.frequency === 'weekly'
      ? `on ${WEEKDAYS[schedule.day_of_week ?? 1]}`
      : schedule.frequency === 'daily'
        ? ''
        : `on the ${ordinal(schedule.day_of_month ?? 1)}`;

  return [FREQUENCY_LABELS[schedule.frequency], when, `at ${time}`, `(${schedule.timezone})`]
    .filter(Boolean)
    .join(' ');
}

export function ordinal(day: number): string {
  const remainder = day % 100;
  if (remainder >= 11 && remainder <= 13) return `${day}th`;
  return `${day}${['th', 'st', 'nd', 'rd'][day % 10] ?? 'th'}`;
}

/**
 * The date as the schedule's own timezone reads it.
 *
 * `next_run_at` is an instant, and showing it in the reader's browser timezone
 * would tell somebody in London that their Nairobi client's 09:00 report runs
 * at 06:00 — true, and not what they configured.
 */
export function formatInZone(instant: string | null, timezone: string): string {
  if (!instant) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(new Date(instant));
  } catch {
    return new Date(instant).toLocaleString('en-GB');
  }
}
