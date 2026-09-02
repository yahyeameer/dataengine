#!/usr/bin/env python3
"""
Queue load test: find the first real bottleneck, not a theoretical one.

What this measures and what it does not.

It drives the **queue** -- `enqueue_agent_job_internal`, `claim_agent_job`,
`heartbeat_agent_job`, `finish_agent_job`, `claim_due_recipe_schedules` -- with
N organizations submitting jobs and W workers competing for them. That is the
part of the system every customer shares, the part that decides whether one
firm can starve another, and the part whose behaviour under contention cannot be
reasoned about from the code.

It does **not** measure parsing, DuckDB or report rendering. Those are
per-job CPU costs on a known file size; they do not change shape with the number
of organizations, and measuring them here would produce a number about this
laptop rather than about the architecture.

So the output is: how many claim/finish cycles a second the queue sustains, how
that changes with worker count, whether the per-organization ceiling holds under
contention, and where the time actually goes.

    python scripts/queue_load_test.py --dsn "$DSN" --orgs 50 --jobs 4 --workers 4

Run it against a scratch database with the migrations applied. It writes several
thousand rows and does not clean up.
"""

from __future__ import annotations

import argparse
import statistics
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

try:
    import psycopg
except ImportError:  # pragma: no cover - the script says what to do
    raise SystemExit("pip install 'psycopg[binary]' to run the load test")


def seed(dsn: str, orgs: int, jobs_per_org: int) -> list[str]:
    """One organization, one workspace, one dataset and N queued jobs each."""
    workspace_ids: list[str] = []
    with psycopg.connect(dsn, autocommit=True) as connection:
        user_id = str(uuid.uuid4())
        connection.execute(
            "insert into auth.users (id, email) values (%s, %s) on conflict do nothing",
            (user_id, f"load-{user_id[:8]}@example.test"),
        )
        for index in range(orgs):
            org_id, workspace_id = str(uuid.uuid4()), str(uuid.uuid4())
            slug = f"load-{index}-{org_id[:8]}"
            connection.execute(
                "insert into organizations (id, name, slug, created_by) values (%s,%s,%s,%s)",
                (org_id, f"Load org {index}", slug, user_id),
            )
            connection.execute(
                "insert into organization_members (org_id, user_id, role) values (%s,%s,'owner')",
                (org_id, user_id),
            )
            connection.execute(
                "insert into workspaces (id, org_id, name, created_by) values (%s,%s,%s,%s)",
                (workspace_id, org_id, f"Client {index}", user_id),
            )
            with connection.cursor() as cursor:
                cursor.executemany(
                    "insert into agent_jobs (org_id, workspace_id, kind) "
                    "values (%s,%s,'parse_workbook')",
                    [(org_id, workspace_id)] * jobs_per_org,
                )
            workspace_ids.append(workspace_id)
    return workspace_ids


def worker_loop(dsn: str, worker_id: str, hold_ms: int, deadline: float) -> list[float]:
    """
    One worker, doing what the real one does: claim, heartbeat, finish.

    `hold_ms` stands in for the work. Set it to zero to measure the queue's own
    throughput ceiling; set it to something realistic to see how many workers a
    given job duration needs.
    """
    latencies: list[float] = []
    with psycopg.connect(dsn, autocommit=True) as connection:
        connection.execute(
            "insert into agent_workers (id, hostname) values (%s,'load') on conflict do nothing",
            (worker_id,),
        )
        while time.monotonic() < deadline:
            started = time.perf_counter()
            row = connection.execute(
                "select id, created_at from claim_agent_job(%s, null, 300)", (worker_id,)
            ).fetchone()
            if row is None:
                # An empty queue is the end of the run, not a pause: every job
                # was seeded up front.
                break
            job_id = row[0]
            connection.execute(
                "select heartbeat_agent_job(%s,%s,%s,300)", (job_id, worker_id, '{"stage":"load"}')
            )
            if hold_ms:
                time.sleep(hold_ms / 1000)
            connection.execute(
                "select finish_agent_job(%s,%s,true,%s)", (job_id, worker_id, '{"ok":true}')
            )
            latencies.append(time.perf_counter() - started)
    return latencies


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(round(fraction * (len(ordered) - 1))))
    return ordered[index]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsn", required=True, help="postgres connection string")
    parser.add_argument("--orgs", type=int, default=10)
    parser.add_argument("--jobs", type=int, default=4, help="jobs per organization")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--hold-ms", type=int, default=0, help="simulated work per job")
    parser.add_argument("--seconds", type=int, default=120, help="hard stop")
    args = parser.parse_args()

    total_jobs = args.orgs * args.jobs
    print(f"seeding {args.orgs} organizations x {args.jobs} jobs = {total_jobs} jobs")
    seed_started = time.perf_counter()
    seed(args.dsn, args.orgs, args.jobs)
    seed_seconds = time.perf_counter() - seed_started
    print(f"  seeded in {seed_seconds:.1f}s ({total_jobs / seed_seconds:.0f} enqueues/s)")

    deadline = time.monotonic() + args.seconds
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(
            pool.map(
                lambda index: worker_loop(args.dsn, f"load-worker-{index}", args.hold_ms, deadline),
                range(args.workers),
            )
        )
    elapsed = time.perf_counter() - started

    latencies = [value for batch in results for value in batch]
    processed = len(latencies)

    print()
    print(f"workers                 {args.workers}")
    print(f"jobs processed          {processed} of {total_jobs}")
    print(f"wall clock              {elapsed:.1f}s")
    print(f"throughput              {processed / elapsed:.0f} jobs/s"
          f"  ({processed / elapsed * 3600:.0f}/hour)")
    if latencies:
        print(f"claim->finish mean      {statistics.mean(latencies) * 1000:.1f}ms")
        print(f"claim->finish p50       {percentile(latencies, 0.50) * 1000:.1f}ms")
        print(f"claim->finish p95       {percentile(latencies, 0.95) * 1000:.1f}ms")
        print(f"claim->finish max       {max(latencies) * 1000:.1f}ms")
    print(f"per worker              {processed / args.workers:.0f} jobs")

    with psycopg.connect(args.dsn, autocommit=True) as connection:
        left = connection.execute(
            "select count(*) from agent_jobs where status = 'queued'"
        ).fetchone()[0]
        over = connection.execute(
            """
            select count(*) from (
              select org_id, count(*) as running
                from agent_jobs
               where status = 'running' and lease_expires_at > now()
               group by org_id
            ) c where c.running > org_concurrency_limit(c.org_id)
            """
        ).fetchone()[0]
    print(f"still queued            {left}")
    print(f"organizations over cap  {over}   (must be 0)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
