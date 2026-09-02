'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  Badge,
  Card,
  ErrorText,
  Fact,
  SectionHeading,
  buttonClass,
  inputClass,
  secondaryButtonClass,
  selectClass,
} from '@/components/ui';
import {
  FREQUENCY_LABELS,
  RUN_STATUS_LABELS,
  RUN_STATUS_TONE,
  SCHEDULE_FREQUENCIES,
  TIMEZONES,
  WEEKDAYS,
  describeCadence,
  formatInZone,
  ordinal,
  type RecipeSchedule,
  type ScheduleFrequency,
  type ScheduleRunStatus,
} from '@/lib/schedules';

export type ScheduleFiring = {
  id: string;
  scheduled_for: string;
  fired_at: string;
  status: ScheduleRunStatus;
  detail: string | null;
  job_id: string | null;
};

/**
 * Automation, explained to somebody who runs a business rather than a server.
 *
 * The sentence at the top is the whole feature and it is deliberately blunt
 * about its own limits: DataEngine has no connector to a client's accounting
 * system, so "automatic" means *the recipe runs itself once the file is here*,
 * not *the file arrives by itself*. A schedule that implied otherwise would be
 * discovered to be a lie in month two, which is the worst possible month to
 * discover it.
 *
 * Everything else follows from that. "Waiting for this period's file" is shown
 * as a normal amber state rather than an error, because on most months for most
 * clients that is what a correctly working schedule says until somebody
 * uploads. And the next run is printed in the schedule's own timezone: telling
 * a London bookkeeper that their Nairobi client's 09:00 report runs at 06:00 is
 * true and useless.
 */
export function RecipeSchedulePanel({
  workspaceId,
  recipeId,
  schedule,
  firings,
  canEdit,
}: {
  workspaceId: string;
  recipeId: string;
  schedule: RecipeSchedule | null;
  firings: ScheduleFiring[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [enabled, setEnabled] = useState(schedule?.enabled ?? false);
  const [frequency, setFrequency] = useState<ScheduleFrequency>(schedule?.frequency ?? 'monthly');
  const [dayOfMonth, setDayOfMonth] = useState(schedule?.day_of_month ?? 1);
  const [dayOfWeek, setDayOfWeek] = useState(schedule?.day_of_week ?? 1);
  const [time, setTime] = useState(
    `${String(schedule?.hour ?? 9).padStart(2, '0')}:${String(schedule?.minute ?? 0).padStart(2, '0')}`,
  );
  const [timezone, setTimezone] = useState(schedule?.timezone ?? 'Europe/London');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(nextEnabled: boolean) {
    setBusy(true);
    setError(null);
    const [hour, minute] = time.split(':').map((part) => Number.parseInt(part, 10));

    try {
      const response = await fetch('/api/recipes/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          recipeId,
          enabled: nextEnabled,
          frequency,
          dayOfMonth: frequency === 'weekly' || frequency === 'daily' ? null : dayOfMonth,
          dayOfWeek: frequency === 'weekly' ? dayOfWeek : null,
          hour: Number.isFinite(hour) ? hour : 9,
          minute: Number.isFinite(minute) ? minute : 0,
          timezone,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error ?? 'That schedule could not be saved.');
        return;
      }
      setEnabled(nextEnabled);
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/recipes/schedule', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, recipeId }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.error ?? 'That schedule could not be removed.');
        return;
      }
      setEnabled(false);
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  const running = schedule?.enabled ?? false;

  return (
    <section>
      <SectionHeading
        description="DataEngine runs the recipe on its own once this period's file has been uploaded. It cannot fetch the file for you — there is no connection to the client's system yet."
        hint={running ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Off</Badge>}
      >
        Automation
      </SectionHeading>

      <Card>
        <div className="space-y-5 p-5">
          {schedule && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Fact label="Next run">
                {schedule.enabled
                  ? formatInZone(schedule.next_run_at, schedule.timezone)
                  : 'Not scheduled'}
              </Fact>
              <Fact label="Last run">
                {schedule.last_run_at
                  ? formatInZone(schedule.last_run_at, schedule.timezone)
                  : 'Never'}
              </Fact>
              <Fact label="Cadence">{describeCadence(schedule)}</Fact>
              <Fact label="Last outcome">
                {schedule.last_status ? (
                  <Badge tone={RUN_STATUS_TONE[schedule.last_status]}>
                    {RUN_STATUS_LABELS[schedule.last_status]}
                  </Badge>
                ) : (
                  '—'
                )}
              </Fact>
            </div>
          )}

          {/* A repeatedly failing schedule is worth saying out loud. It is
              deliberately not switched off automatically: the brief is explicit
              that one failure must not disable automation, and silently
              stopping is how a client's month-end goes missing. */}
          {schedule && schedule.consecutive_failures > 1 && (
            <p className="rounded-[var(--radius)] border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
              This schedule has failed {schedule.consecutive_failures} times in a row. It is still
              switched on and will try again.
              {schedule.last_error ? ` Last reason: ${schedule.last_error}` : ''}
            </p>
          )}

          {canEdit && (
            <div className="space-y-4 border-t border-border-subtle pt-5">
              <label className="flex items-center gap-2.5 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={busy}
                  onChange={(event) => void save(event.target.checked)}
                />
                Run this recipe automatically
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">How often</span>
                  <select
                    className={selectClass}
                    value={frequency}
                    disabled={busy}
                    onChange={(event) => setFrequency(event.target.value as ScheduleFrequency)}
                  >
                    {SCHEDULE_FREQUENCIES.map((value) => (
                      <option key={value} value={value}>
                        {FREQUENCY_LABELS[value]}
                      </option>
                    ))}
                  </select>
                </label>

                {frequency === 'weekly' ? (
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium">Day</span>
                    <select
                      className={selectClass}
                      value={dayOfWeek}
                      disabled={busy}
                      onChange={(event) => setDayOfWeek(Number(event.target.value))}
                    >
                      {WEEKDAYS.map((name, index) => (
                        <option key={name} value={index}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : frequency === 'daily' ? (
                  <span />
                ) : (
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium">Day of the month</span>
                    <select
                      className={selectClass}
                      value={dayOfMonth}
                      disabled={busy}
                      onChange={(event) => setDayOfMonth(Number(event.target.value))}
                    >
                      {Array.from({ length: 31 }, (_value, index) => index + 1).map((day) => (
                        <option key={day} value={day}>
                          {ordinal(day)}
                        </option>
                      ))}
                    </select>
                    {dayOfMonth > 28 && (
                      // The policy, said where the choice is made rather than in
                      // a footnote nobody reads.
                      <span className="mt-1.5 block text-xs text-subtle">
                        Months without a {ordinal(dayOfMonth)} run on their last day instead.
                      </span>
                    )}
                  </label>
                )}

                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">Time</span>
                  <input
                    type="time"
                    className={inputClass}
                    value={time}
                    disabled={busy}
                    onChange={(event) => setTime(event.target.value)}
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">Timezone</span>
                  <select
                    className={selectClass}
                    value={timezone}
                    disabled={busy}
                    onChange={(event) => setTimezone(event.target.value)}
                  >
                    {TIMEZONES.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={buttonClass()}
                  disabled={busy}
                  onClick={() => void save(enabled)}
                >
                  {busy ? 'Saving…' : schedule ? 'Update schedule' : 'Create schedule'}
                </button>
                {schedule && (
                  <button
                    type="button"
                    className={secondaryButtonClass()}
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    Remove schedule
                  </button>
                )}
              </div>

              <ErrorText>{error}</ErrorText>
            </div>
          )}

          {firings.length > 0 && (
            <div className="border-t border-border-subtle pt-5">
              <p className="mb-2 text-sm font-medium">Scheduled runs</p>
              <ul className="divide-y divide-border-subtle">
                {firings.map((firing) => (
                  <li key={firing.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <span className="w-44 shrink-0 text-muted">
                      {formatInZone(firing.scheduled_for, schedule?.timezone ?? 'UTC')}
                    </span>
                    <Badge tone={RUN_STATUS_TONE[firing.status]}>
                      {RUN_STATUS_LABELS[firing.status]}
                    </Badge>
                    {firing.detail && (
                      <span className="min-w-0 flex-1 truncate text-xs text-subtle">
                        {firing.detail}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}
