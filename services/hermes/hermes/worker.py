"""
The worker loop.

This is the process that runs on the VPS forever. Everything about it is shaped
by that: it must survive a network blip, a bad file, a killed process and a
reboot, and it must be diagnosable by someone reading `journalctl` at midnight
with no debugger.

The loop is deliberately boring.

    heartbeat -> claim -> run -> report -> repeat

There is no in-process scheduling, no thread pool and no async. One job at a
time, in one process, with the database as the only shared state. To run more
work, run more copies -- `claim_agent_job` uses `skip locked`, so two workers on
two hosts cooperate with no coordination between them. Concurrency that lives
in the database is concurrency you can reason about from a SQL prompt.

Failure handling has one rule: the job must always reach a terminal state or
lose its lease. A worker that dies holding a claim is fine, because the lease
expires. A worker that swallows an exception and returns to the top of the loop
without reporting is not, so the try/except around the handler is total.
"""

from __future__ import annotations

import logging
import signal
import sys
import threading
import time
from typing import Any

from . import health
from .config import Config, ConfigError, load_config
from .jobs import HANDLERS, JobContext, JobError
from .llm.router import LLMRouter
from .supabase import SupabaseClient, SupabaseError

log = logging.getLogger("hermes.worker")


class Worker:
    def __init__(self, config: Config):
        self.config = config
        self.supabase = SupabaseClient(config.supabase_url, config.service_key)
        self.llm = LLMRouter(config.llm)
        self._stopping = threading.Event()
        self._jobs_done = 0
        self._jobs_failed = 0
        # Unknown until the first check runs, and reported as unknown rather
        # than as healthy -- a monitor that defaults to "fine" is a monitor
        # that lies for its first interval.
        self._health = health.HealthReport(checked=False, error="not yet checked")
        # Last state actually announced to the webhook. None until the first
        # successful check, which is what keeps a restart from re-announcing a
        # fault somebody is already dealing with.
        self._notified_state: str | None = None

        # HANDLERS is the single source of truth for what this build can run.
        # An empty config means "all of it"; a configured subset is checked
        # against the handler table, because a worker that announces a kind it
        # cannot execute claims those jobs and then fails every one of them --
        # which is worse than never claiming them at all.
        requested = tuple(config.capabilities)
        unknown = sorted(set(requested) - set(HANDLERS))
        if unknown:
            raise ConfigError(
                f"HERMES_CAPABILITIES names {', '.join(unknown)}, which this build "
                f"has no handler for. Known kinds: {', '.join(sorted(HANDLERS))}."
            )
        self.capabilities = requested or tuple(HANDLERS)

    # -- lifecycle -----------------------------------------------------------

    def request_stop(self, signum: int | None = None, _frame: Any = None) -> None:
        """
        Finish the current job, then exit.

        Deliberately not an immediate abort. A parse that is 90% done has
        already spent the expensive part; killing it means redoing that work
        after the restart, and a deploy should not cost the customer their
        month-end run. systemd's default 90-second stop timeout is enough for
        anything this service does, and the lease covers the case where it is
        not.
        """
        if signum is not None:
            log.info("signal %s received; finishing the current job then stopping", signum)
        self._stopping.set()

    def close(self) -> None:
        self.llm.close()
        self.supabase.close()

    # -- database chores -----------------------------------------------------

    def announce(self) -> None:
        # The health verdict rides the heartbeat rather than getting its own
        # schedule. One fewer thing to run, and it lands in `agent_workers`,
        # which the dashboard already reads -- so "is the model actually
        # running" is answerable without knowing a view name in advance.
        metadata: dict[str, Any] = {
            "llm_enabled": self.llm.enabled,
            "reasoning_provider": self.config.llm.provider_for("reasoning"),
            "jobs_done": self._jobs_done,
            "jobs_failed": self._jobs_failed,
        }
        metadata.update(self._health.summary())

        self.supabase.rpc(
            "agent_worker_heartbeat",
            {
                "p_worker_id": self.config.worker_id,
                "p_hostname": self.config.hostname,
                "p_version": self.config.version,
                "p_capabilities": list(self.capabilities),
                "p_metadata": metadata,
            },
        )

    def check_health(self) -> None:
        """
        Re-read the degradation view, shout if anything is answering without a
        model, and notify out of band when that changes.

        Far less often than the heartbeat: this is a slow-moving condition --
        once the model stops running it stays stopped until somebody fixes it
        -- and a warning repeated every thirty seconds is one people learn to
        scroll past, which defeats the point.
        """
        self._health = health.check(self.supabase)
        health.log_report(self._health)
        self._notify_health_change()

    def _notify_health_change(self) -> None:
        """
        Post to the alert webhook, but only when the answer has changed.

        **Edge-triggered, deliberately.** A level-triggered alert on a condition
        that lasts twenty-four hours would fire a hundred and forty-four times,
        and the third one is where somebody mutes the channel. Firing on the
        transition means the message arrives once, when it is news.

        **`unknown` is not notified.** A check that could not run is logged and
        shown in the dashboard banner, and it is usually transient -- a blip
        reaching the database. Paging somebody for it would spend the channel's
        credibility on a condition that fixes itself, and the same blip stops
        the worker claiming jobs anyway, which is noticed by louder means.

        **Recovery is notified.** Being told a fault has cleared is what stops
        somebody driving to a laptop on a Sunday.
        """
        url = self.config.alert_webhook_url
        if not url or not self._health.checked:
            return

        state = "degraded" if self._health.degraded else "ok"
        previous = self._notified_state

        if state == previous:
            return

        # Nothing to announce about a system that came up healthy; the first
        # interesting transition is into trouble. Coming up *into* trouble is
        # worth saying, so that case is not suppressed.
        if previous is None and state == "ok":
            self._notified_state = state
            return

        payload = health.build_alert(self._health, recovered=(state == "ok"))
        if payload and health.send_alert(url, payload):
            log.info("health alert sent: %s -> %s", previous or "startup", state)

        # Recorded whether or not delivery succeeded. Retrying a failed webhook
        # on the next pass would turn one unreachable endpoint into an alert
        # every ten minutes for as long as the fault lasts.
        self._notified_state = state

    def claim(self) -> dict[str, Any] | None:
        claimed = self.supabase.rpc(
            "claim_agent_job",
            {
                "p_worker_id": self.config.worker_id,
                "p_kinds": list(self.capabilities),
                "p_lease_seconds": self.config.lease_seconds,
            },
        )
        # PostgREST returns a single-row set for a function returning a record;
        # null or an empty list both mean "nothing to do".
        if isinstance(claimed, list):
            claimed = claimed[0] if claimed else None
        if not claimed or not claimed.get("id"):
            return None
        return claimed

    def _heartbeat_for(self, job_id: str):
        def heartbeat(progress: dict[str, Any]) -> None:
            try:
                self.supabase.rpc(
                    "heartbeat_agent_job",
                    {
                        "p_job_id": job_id,
                        "p_worker_id": self.config.worker_id,
                        "p_progress": progress,
                        "p_lease_seconds": self.config.lease_seconds,
                    },
                )
            except SupabaseError as error:
                # A failed heartbeat is not fatal. The lease may still be valid,
                # and if it is not, the completion call will be rejected and
                # another worker will have taken the job -- which is correct.
                log.warning("heartbeat for %s failed: %s", job_id, error)

        return heartbeat

    def finish(
        self,
        job_id: str,
        success: bool,
        result: Any = None,
        error: str | None = None,
        retryable: bool = True,
    ) -> None:
        self.supabase.rpc(
            "finish_agent_job",
            {
                "p_job_id": job_id,
                "p_worker_id": self.config.worker_id,
                "p_success": success,
                "p_result": result,
                "p_error": error,
                "p_retryable": retryable,
            },
        )

    # -- the loop ------------------------------------------------------------

    def run_job(self, job: dict[str, Any]) -> None:
        kind = job["kind"]
        job_id = job["id"]
        handler = HANDLERS.get(kind)

        log.info(
            "job %s: %s for workspace %s (attempt %s)",
            job_id, kind, job["workspace_id"], job.get("attempts"),
        )

        if handler is None:
            # Reachable if the database knows a job kind this build does not --
            # i.e. the web app was deployed and the agent was not.
            self.finish(job_id, False, None, f"this agent build cannot run {kind!r}")
            self._jobs_failed += 1
            return

        context = JobContext(
            config=self.config,
            supabase=self.supabase,
            llm=self.llm,
            job=job,
            heartbeat=self._heartbeat_for(job_id),
        )

        started = time.perf_counter()
        try:
            result = handler(context)
            elapsed = int((time.perf_counter() - started) * 1000)
            if isinstance(result, dict):
                result.setdefault("duration_ms", elapsed)
            self.finish(job_id, True, result)
            self._jobs_done += 1
            log.info("job %s: done in %sms", job_id, elapsed)

        except JobError as error:
            # A message written for the accountant. Shown verbatim, and normally
            # not retried -- see JobError.
            log.warning("job %s: %s", job_id, error)
            self.finish(job_id, False, None, str(error), retryable=error.retryable)
            self._jobs_failed += 1

        except SupabaseError as error:
            log.error("job %s: supabase error %s %s", job_id, error.status, error.body)
            self.finish(
                job_id, False, None,
                f"Lost contact with Supabase while running this job ({error.status}). "
                f"It will be retried.",
            )
            self._jobs_failed += 1

        except Exception as error:  # noqa: BLE001 - the loop must never die on a job
            log.exception("job %s: unexpected failure", job_id)
            self.finish(
                job_id, False, None,
                f"The agent hit an unexpected error ({type(error).__name__}). "
                f"The details are in the agent log.",
            )
            self._jobs_failed += 1

    def run_forever(self) -> int:
        log.info(
            "hermes %s starting as %s on %s (models: %s)",
            self.config.version,
            self.config.worker_id,
            self.config.hostname,
            self.config.llm.provider_for("reasoning") or "none (rule engine only)",
        )

        try:
            self.announce()
        except SupabaseError as error:
            log.error("could not register with Supabase: %s %s", error.status, error.body)
            return 1

        # Checked once at startup so a worker that comes up into an already
        # degraded system says so immediately, rather than after the first
        # full interval.
        self.check_health()

        last_announce = time.monotonic()
        last_health = time.monotonic()
        backoff = self.config.poll_seconds

        while not self._stopping.is_set():
            try:
                now = time.monotonic()
                if now - last_health >= self.config.health_check_seconds:
                    self.check_health()
                    last_health = now

                if now - last_announce >= self.config.heartbeat_seconds:
                    self.announce()
                    last_announce = now

                job = self.claim()

                if job is None:
                    self._stopping.wait(self.config.poll_seconds)
                    backoff = self.config.poll_seconds
                    continue

                self.run_job(job)
                backoff = self.config.poll_seconds

            except SupabaseError as error:
                # The database is unreachable. Back off rather than hammering
                # it, but keep trying forever -- a VPS that gives up after five
                # attempts is a VPS somebody has to notice and restart.
                log.error("supabase unreachable (%s); retrying in %ss", error.status, backoff)
                self._stopping.wait(backoff)
                backoff = min(backoff * 2, 120)

            except Exception:  # noqa: BLE001
                log.exception("unexpected error in the worker loop; continuing")
                self._stopping.wait(backoff)
                backoff = min(backoff * 2, 120)

        log.info(
            "stopped after %s job(s) done, %s failed", self._jobs_done, self._jobs_failed
        )
        return 0


def configure_logging() -> None:
    import os

    level = os.environ.get("HERMES_LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        # No timestamp: journald and Docker both add their own, and two of them
        # on every line makes the log harder to read, not easier.
        format="%(levelname)-7s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def load_local_env() -> None:
    """
    Environment loading, with a development convenience.

    In production the agent's own `.env` (or the systemd unit's EnvironmentFile)
    is the only source. On a developer's machine the same Supabase credentials
    already exist in `apps/web/.env.local`, and requiring them to be copied into
    a second file is how the two drift apart after a `supabase start` reissues
    the keys.

    So: the agent's own environment always wins, and the web app's file is read
    only to fill gaps. NEXT_PUBLIC_SUPABASE_URL becomes SUPABASE_URL because the
    agent is not a browser and the prefix would be misleading here.
    """
    try:
        from dotenv import dotenv_values, load_dotenv
    except ImportError:
        return

    import os
    from pathlib import Path

    load_dotenv()

    if os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SECRET_KEY"):
        return

    web_env = Path(__file__).resolve().parents[3] / "apps" / "web" / ".env.local"
    if not web_env.is_file():
        return

    values = dotenv_values(web_env)
    mapping = {
        "SUPABASE_URL": values.get("NEXT_PUBLIC_SUPABASE_URL"),
        "SUPABASE_SECRET_KEY": values.get("SUPABASE_SECRET_KEY"),
    }
    for name, value in mapping.items():
        if value and not os.environ.get(name):
            os.environ[name] = value

    log.info("filled missing Supabase settings from %s (development only)", web_env)


def main() -> int:
    configure_logging()
    load_local_env()

    try:
        config = load_config()
    except ConfigError as error:
        log.error("%s", error)
        return 2

    config.work_dir.mkdir(parents=True, exist_ok=True)

    worker = Worker(config)
    signal.signal(signal.SIGINT, worker.request_stop)
    signal.signal(signal.SIGTERM, worker.request_stop)

    try:
        return worker.run_forever()
    finally:
        worker.close()


if __name__ == "__main__":
    raise SystemExit(main())
