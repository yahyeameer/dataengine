/**
 * The admin banner's verdict logic.
 *
 * The banner exists for a failure that does not look like one: the model stops
 * running, jobs keep succeeding, and the explanations quietly come from the
 * rule engine. What is tested here is not the markup -- it is the three
 * decisions the banner makes, because getting any of them wrong turns a monitor
 * into either wallpaper or a liar.
 *
 * **Silent when healthy.** A banner that is always on screen is furniture, and
 * furniture is not read.
 *
 * **`unknown` is never reported as `degraded`.** A worker that has gone quiet
 * means the model might be fine and we cannot see it. Dressing that up as a
 * fault is how the first false alarm teaches people to ignore the second real
 * one.
 *
 * **The window is the worker's.** The banner reads the verdict the worker
 * already computed over its own twenty-four hour window. It must not recompute
 * it -- two copies of a rule is one rule and one bug waiting to disagree.
 *
 * Usage: npm run test:health
 */

import assert from 'node:assert/strict';

import { readHealth } from '../apps/web/src/lib/system-health';

let failures = 0;

function check(name: string, run: () => void) {
  try {
    run();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error instanceof Error ? error.message : String(error)}`);
  }
}

const now = new Date('2026-08-30T12:00:00Z');
const fresh = '2026-08-30T11:59:45Z'; // 15s ago
const stale = '2026-08-30T11:50:00Z'; // 10 minutes ago

console.log('\nsystem health banner\n');

check('a healthy worker produces ok, so the banner renders nothing', () => {
  const health = readHealth(
    [{ id: 'hermes-vps-01', last_seen_at: fresh, metadata: { llm_health: 'ok' } }],
    now,
  );
  assert.equal(health.state, 'ok');
  assert.deepEqual(health.degradedKinds, {});
});

check('degradation carries the kinds, the counts and the timestamp', () => {
  const health = readHealth(
    [
      {
        id: 'hermes-vps-01',
        last_seen_at: fresh,
        metadata: {
          llm_health: 'degraded',
          llm_degraded_kinds: { propose_cleaning: 3, generate_report: 1 },
          llm_degraded_since: '2026-08-30T02:06:39Z',
        },
      },
    ],
    now,
  );
  assert.equal(health.state, 'degraded');
  assert.deepEqual(health.degradedKinds, { propose_cleaning: 3, generate_report: 1 });
  assert.equal(health.degradedSince, '2026-08-30T02:06:39Z');
  assert.equal(health.workerId, 'hermes-vps-01');
});

check('a worker that went quiet is unknown, never degraded', () => {
  const health = readHealth(
    [{ id: 'hermes-vps-01', last_seen_at: stale, metadata: { llm_health: 'ok' } }],
    now,
  );
  assert.equal(health.state, 'unknown', 'a stale worker cannot vouch for anything');
  assert.notEqual(health.state, 'degraded', 'absence of a signal is not evidence of a fault');
  assert.match(health.reason ?? '', /has not reported/);
});

check("the worker's own unknown is passed through with its reason", () => {
  const health = readHealth(
    [
      {
        id: 'hermes-vps-01',
        last_seen_at: fresh,
        metadata: { llm_health: 'unknown', llm_health_error: '503' },
      },
    ],
    now,
  );
  assert.equal(health.state, 'unknown');
  assert.match(health.reason ?? '', /503/);
});

check('no worker at all is unknown, not ok', () => {
  const health = readHealth([], now);
  assert.equal(health.state, 'unknown');
  assert.match(health.reason ?? '', /has ever registered/);
});

check('with several workers the freshest verdict wins', () => {
  const health = readHealth(
    [
      { id: 'old-worker', last_seen_at: stale, metadata: { llm_health: 'degraded' } },
      { id: 'hermes-vps-01', last_seen_at: fresh, metadata: { llm_health: 'ok' } },
    ],
    now,
  );
  assert.equal(health.state, 'ok');
  assert.equal(health.workerId, 'hermes-vps-01');
});

check('a worker with no verdict yet is unknown rather than healthy', () => {
  const health = readHealth([{ id: 'hermes-vps-01', last_seen_at: fresh, metadata: {} }], now);
  assert.equal(health.state, 'unknown');
});

check('missing metadata does not throw', () => {
  const health = readHealth([{ id: 'hermes-vps-01', last_seen_at: fresh, metadata: null }], now);
  assert.equal(health.state, 'unknown');
});

console.log(
  failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
