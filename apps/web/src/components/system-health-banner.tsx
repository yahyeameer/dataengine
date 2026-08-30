import { getSystemHealth } from '@/lib/system-health';

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
export async function SystemHealthBanner({ role }: { role: string }) {
  if (role !== 'owner' && role !== 'admin') return null;

  const health = await getSystemHealth();
  if (health.state === 'ok') return null;

  const degraded = health.state === 'degraded';

  const tone = degraded
    ? 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200'
    : 'border-black/15 bg-black/5 text-black/80 dark:border-white/20 dark:bg-white/5 dark:text-white/80';

  const kinds = Object.entries(health.degradedKinds);
  const total = kinds.reduce((sum, [, n]) => sum + n, 0);

  return (
    <div role="status" className={`border-b px-6 py-2.5 text-sm ${tone}`}>
      <div className="mx-auto flex max-w-5xl flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-semibold">
          {degraded ? 'AI explanations are running without a model' : 'Model status unknown'}
        </span>

        {degraded ? (
          <>
            <span className="opacity-90">
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
              <span className="opacity-70">
                since {new Date(health.degradedSince).toLocaleString('en-GB')}
              </span>
            )}
          </>
        ) : (
          <span className="opacity-90">{health.reason}</span>
        )}

        {health.workerId && (
          <span className="ml-auto font-mono text-xs opacity-60">
            {health.workerId}
            {health.secondsSinceHeartbeat !== null && ` · ${health.secondsSinceHeartbeat}s ago`}
          </span>
        )}
      </div>
    </div>
  );
}
