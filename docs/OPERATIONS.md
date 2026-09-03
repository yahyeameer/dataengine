# Running DataEngine

What the moving parts are, what happens when one of them stops, how to add
capacity, and what the limits actually are. Every number here was measured on
this build; where something is an estimate it says so.

## Architecture

```
  Browser
     │  HTTPS (Traefik, Let's Encrypt)
     ▼
  Next.js  ──── signed upload URL ───▶  Supabase Storage (raw)
     │                                        │
     │  writes a row                          │
     ▼                                        ▼
  Supabase Postgres ── agent_jobs ──▶  Hermes worker (1..N)
     ▲   RLS on every table                   │
     │                                  parse / profile / clean
     │                                  DuckDB + Polars
     │                                        │
     └──────── results, versions ─────────────┘
                                              │
                                       Supabase Storage
                                       (parquet, exports, branding)
```

The dashboard never calls the worker and the worker never accepts a connection.
They share a database and nothing else, which is why the worker host needs no
inbound port, no domain and no certificate — and why adding a second worker is a
deployment change and not an architectural one.

## Scheduling

```
  a person configures a schedule
            │
            ▼
  recipe_schedules.next_run_at            (computed in SQL, in the client's timezone)
            │
            │  every worker, on its idle pass, every 60s
            ▼
  claim_due_recipe_schedules()            one transaction:
            │                               · lock the due row (skip locked)
            │                               · find a dataset version newer than
            │                                 the watermark
            │                               · record the firing (unique on
            │                                 schedule_id + scheduled_for)
            │                               · enqueue replay_recipe
            │                               · advance next_run_at
            ▼
  agent_jobs (replay_recipe)              the same job a person's click creates
            │
            ▼
  worker claims it → recipe replays → new immutable dataset version
            │
            ▼
  recipe_runs  ──▶  report_artifacts  ──▶  exports bucket
```

**The scheduler is not a process.** It is one function call on the worker's idle
pass. Every worker runs it; the row lock and the unique key make that safe.
There is no scheduler container to deploy, monitor, or lose.

**A schedule does not fetch data.** DataEngine has no connector to a client's
accounting system, so a schedule fires and looks for a dataset version newer
than the one it last processed. If none has arrived it records
`skipped_no_source` and the recipe page says "waiting for this period's file".
That is the ordinary outcome for any month whose file has not been uploaded yet,
and it is shown as a normal state rather than an error.

**Duplicate prevention.** The execution identity is
`(schedule_id, scheduled_for)` with a unique constraint. `scheduled_for` is the
instant the schedule was *due*, so two workers waking seconds apart compute the
same key and one insert loses. Because the firing, the job and the `next_run_at`
advance are one transaction, there is no window in which a crash leaves work
enqueued and the schedule still looking due.

**Day-of-month policy.** A day that does not exist in a month runs on that
month's last day: "the 31st" is the 28th in February, the 29th in a leap
February, the 30th in April. Skipping the month instead would mean a monthly
report that silently does not exist once a year.

**Daylight saving.** Times are stored as wall clock plus an IANA zone and
converted at computation time, so 09:00 in Europe/London is 08:00 UTC in July
and 09:00 UTC in December. A local time that does not exist because the clocks
went forward is resolved through the gap rather than skipped.

## Adding capacity

Workers compete for jobs through `claim_agent_job`, which uses `FOR UPDATE SKIP
LOCKED`. Two workers never get the same job, and no worker knows about any
other. To add one:

```bash
# on any host that can reach Supabase over HTTPS
cd services/hermes
cp .env.example .env          # SUPABASE_URL + SUPABASE_SECRET_KEY
HERMES_WORKER_ID=hermes-box2 docker compose up -d
```

The only rule is that `HERMES_WORKER_ID` is unique per process — it is the key
of the `agent_workers` row and the value `claim`/`heartbeat`/`finish` check
ownership against.

Measured on this build, with a two-second job and the per-organization ceiling
raised out of the way:

| Workers | Throughput      | Wall clock for 24 jobs |
|--------:|-----------------|------------------------|
|       1 | 1,795 jobs/hour | 48.1 s                 |
|       2 | 3,589 jobs/hour | 24.1 s                 |
|       4 | 7,168 jobs/hour | 12.1 s                 |

Linear, because the queue contributes no measurable coordination cost at this
scale. The queue itself sustains roughly 1,000 claim→finish cycles per second
with four workers (p95 5.8 ms); at eight workers on one core throughput *drops*
to ~790/s with p95 16.9 ms, which is contention on the claim statement and the
first sign that workers should be on separate hosts rather than the same one.

### Splitting roles later

Every worker schedules by default. To run a worker that only processes jobs:

```
HERMES_SCHEDULER_ENABLED=false
```

Do not set that on every worker, or nothing fires.

## Concurrency and quotas

| Limit | Default | Where |
|---|---|---|
| Global concurrent jobs | 20 | `queue_global_concurrency()` |
| Per-organization concurrent jobs | 3 | `queue_org_concurrency()`, overridable per org |
| Jobs queued per user | 30 / 5 min | `rate_limit_jobs_per_window()` |
| Uploads reserved per user | 20 / 5 min | `rate_limit_uploads_per_window()` |
| Retry backoff | 30 s, 120 s, 480 s | `queue_retry_backoff_seconds()` |

Each is a SQL function, so changing one is `create or replace` and no deploy.
Per-organization overrides live in `organization_limits`, which also carries
columns for storage, monthly jobs, schedules and upload size — recorded but not
yet enforced, so a quota can be switched on without touching the execution path.

Verified: six queued jobs from one firm and two from another, claimed by
competing workers, leaves the first firm at exactly 3 running and the second
firm served rather than starved.

## Limits

| | Verified limit | Why |
|---|---|---|
| Upload / processing | **25 MB** | Measured |
| Storage (raw bucket) | 50 MB | Storage is cheap; processing is not |
| Logo | 2 MB, 32–4000 px, PNG/JPEG/WebP | |

Parsing holds the whole table in memory and reads it row by row in Python, so
cost scales with rows. Measured on this build, in a fresh process:

| File | Rows | parse + profile | Peak RSS |
|---|---|---|---|
| 8.7 MB CSV | 150,000 | 24 s | 194 MB |
| 14.6 MB CSV | 250,000 | 41 s | 307 MB |
| 20.4 MB CSV | 350,000 | 57 s | 438 MB |

Roughly 21 MB of RSS and 2.8 s of CPU per MB of CSV. The worker container is
capped at 768 MB and 0.35 of a core, which made the old 50 MB limit two
incidents at once: it exceeds the memory cap, and at 0.35 CPU its ~140 s of work
becomes ~400 s of wall clock — past the 300 s lease, so a second worker would
claim and parse the same file while the first was still on it. 25 MB leaves
headroom on both. Raise it only alongside a bigger container, a higher CPU share
and a longer lease, and re-measure.

## What happens when something fails

**A worker crashes mid-job.** Its lease expires. The next worker to poll
reclaims the job and starts it again, with the attempt count already
incremented. Nothing is lost; the cost is one lease period of latency.

**A worker crashes repeatedly on the same job.** After `max_attempts` the job is
no longer claimable. `sweep_stuck_agent_jobs`, run every five minutes from every
worker's idle pass, marks it `failed` with a readable reason and a
`finished_at`. Before this existed such a job stayed `running` forever and read
on screen as work in progress.

**A job fails for a transient reason.** It returns to the queue with a backoff —
30 s, then 120 s, then 480 s — rather than being retried on the next poll.
Failures the worker knows are permanent (`JobError` with `retryable=False`: an
unreadable or password-protected workbook, an unresolved blocking issue, a file
over the processing limit) are not retried at all.

**The scheduler cannot reach the database.** `run_scheduler` logs and returns
zero. It never raises, because the loop that calls it is the loop that claims
jobs, and stopping the queue to protect one monthly report is the wrong trade.
Nothing is lost: `next_run_at` was not advanced, so the schedule is still due.

**Two schedulers wake at once.** One takes the row lock; the other's query skips
it and finds nothing. If both somehow reached the same firing, the unique key on
`(schedule_id, scheduled_for)` refuses the second.

**The model is unreachable.** Every call degrades to the rule engine — the job
still succeeds, the explanations get plainer, and `agent_llm_health` records the
fallback. The dashboard banner and `/api/health` read the same verdict.

**Report generation fails.** Each format is rendered independently. One failing
marks that format failed and stores the others; the report row records `partial`
with the error. A recipe run whose report fails is still a successful run with a
cleaned version — the failure is recorded on the run's summary rather than
undoing the work.

**The database is unreachable.** The worker backs off to a two-minute poll and
keeps trying forever rather than exiting. The web app's proxy bounds its auth
call at 5 s and fails safe to signed-out.

## Health

`GET /api/health` — unauthenticated, no cache, three states:

- `healthy` — database reachable, at least one worker heartbeating, queue moving
- `degraded` (HTTP 200) — no live worker, or the oldest job has waited > 15 min,
  or the database is slow. The app is serving; work is not moving.
- `unhealthy` (HTTP 503) — the database is unreachable or unconfigured.

It reports the shape of the system's health and nothing about its contents: no
hostnames, no per-tenant counts, no identifiers.

## Tests

```bash
cd services/hermes && python -m pytest        # 467 tests, no database
psql "$DSN" -f supabase/tests/isolation_branding_recipes.sql
psql "$DSN" -f supabase/tests/scheduling_and_queue.sql
python scripts/queue_load_test.py --dsn "$DSN" --orgs 50 --jobs 4 --workers 4
```

The two SQL files assert what only a database can enforce: row locks, unique
keys, append-only triggers and RLS. Run them against a scratch database — they
insert two firms and do not clean up, because a rollback at the end would also
roll back the evidence.
