import { getSystemHealth, type SystemHealth } from '@/lib/system-health';

/**
 * Says when the model has stopped running, and nothing at all when it has not.
 *
 * The failure this exists for does not look like a failure: the job succeeds,
 * proposals appear, and the explanations quietly come from the rule engine
 * instead of the model. Without something on the screen, the first person to
 * notice would be a customer wondering why the writing got worse.
 *
 * Two rules keep it from becoming wallpaper.
 *
 * **Silent when healthy.** A banner that is always there is furniture, and
 * furniture is not read. This renders `null` on `ok`, so its presence is the
 * signal.
 *
 * **`unknown` is not `degraded`.** A worker that has gone quiet tells us the
 * model might be fine and we cannot see it. Reporting that as a fault would be
 * a guess dressed as a finding, and the first false alarm is what teaches
 * people to ignore the second real one.
 *
 * Admins only. A member cannot act on this and does not need to read that the
 * system they are relying on is having a bad afternoon.
 */
export async function SystemHealthBanner({
  role,
  health: provided,
}: {
  role: string;
  /** Passed in by the shell, which already read it for the sidebar status.
      Two reads of the same row per page load is one too many. */
  health?: SystemHealth;
}) {
  if (role !== 'owner' && role !== 'admin') return null;

  const health = provided ?? (await getSystemHealth());
  if (health.state === 'ok') return null;

  const degraded = health.state === 'degraded';

  const tone = degraded
    ? 'border-warning/30 bg-warning-soft text-warning'
    : 'border-border bg-surface-2 text-muted';

  const kinds = Object.entries(health.degradedKinds);
  const total = kinds.reduce((sum, [, n]) => sum + n, 0);

  return (
    <div role="status" className={`border-b px-5 py-3 text-sm sm:px-8 ${tone}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-semibold">
          {degraded ? 'AI explanations are running without a model' : 'Model status unknown'}
        </span>

        {degraded ? (
          <>
            <span className="text-muted">
              {total} job{total === 1 ? '' : 's'} in the last 24 hours answered from the rule
              engine
              {kinds.length > 0 && (
                <>
                  {' '}
                  (
                  {kinds
                    .map(([kind, n]) => `${kind.replace(/_/g, ' ')} ×${n}`)
                    .join(', ')}
                  )
                </>
              )}
              . Results are still correct; the wording is plainer.
            </span>
            {health.degradedSince && (
              <span className="text-subtle">
                since{' '}
                <span className="tabular">
                  {new Date(health.degradedSince).toLocaleString('en-GB')}
                </span>
              </span>
            )}
          </>
        ) : (
          <span className="text-muted">{health.reason}</span>
        )}

        {health.workerId && (
          <span className="ml-auto shrink-0 font-mono text-xs text-subtle">
            {health.workerId}
            {health.secondsSinceHeartbeat !== null && ` · ${health.secondsSinceHeartbeat}s ago`}
          </span>
        )}
      </div>
    </div>
  );
}
