"""
The worker's scheduling and housekeeping passes.

The scheduling *decisions* -- when a monthly schedule next fires, whether two
schedulers can fire the same instant, what happens when no new file has arrived
-- live in SQL and are asserted against a real database in
`supabase/tests/scheduling_and_queue.sql`. There is deliberately no second
implementation of any of that here to test.

What is left in Python is the wiring, and the wiring has one job: never take the
worker down. A scheduler that raises stops the loop that claims jobs, so an
automation feature nobody switched on could stop the queue everybody depends on.
These tests are mostly about that.
"""

from __future__ import annotations

import logging

import pytest

from hermes.config import Config, LLMConfig
from hermes.supabase import SupabaseError
from hermes.worker import Worker


class _Supabase:
    """Records calls; raises what the test asks it to."""

    def __init__(self, responses: dict | None = None, raises: Exception | None = None) -> None:
        self.responses = responses or {}
        self.raises = raises
        self.calls: list[tuple[str, dict]] = []

    def rpc(self, name: str, params: dict | None = None):
        self.calls.append((name, params or {}))
        if self.raises is not None:
            raise self.raises
        return self.responses.get(name)

    def close(self) -> None:  # pragma: no cover - tidiness only
        pass

    def names(self) -> list[str]:
        return [name for name, _params in self.calls]


def _worker(monkeypatch, supabase: _Supabase, **overrides) -> Worker:
    config = Config(
        supabase_url="https://example.supabase.co",
        service_key="service-key",
        worker_id="worker-1",
        hostname="box",
        llm=LLMConfig(),
        **overrides,
    )
    # The real constructor opens an HTTP client to Supabase and to the model.
    monkeypatch.setattr("hermes.worker.SupabaseClient", lambda *_a, **_k: supabase)
    monkeypatch.setattr("hermes.worker.LLMRouter", lambda *_a, **_k: _NoLLM())
    return Worker(config)


class _NoLLM:
    enabled = False

    def close(self) -> None:  # pragma: no cover
        pass


# ---------------------------------------------------------------------------
# The scheduler pass
# ---------------------------------------------------------------------------


def test_the_scheduler_is_one_rpc_and_not_a_process(monkeypatch):
    # The whole scheduler. If this ever becomes two calls or a loop over
    # schedules in Python, the concurrency guarantees move out of the database
    # and into code that two workers run at once.
    supabase = _Supabase({"claim_due_recipe_schedules": []})
    worker = _worker(monkeypatch, supabase)

    assert worker.run_scheduler() == 0
    assert supabase.names() == ["claim_due_recipe_schedules"]


def test_a_firing_is_logged_with_the_ids_needed_to_follow_it(monkeypatch, caplog):
    supabase = _Supabase(
        {
            "claim_due_recipe_schedules": [
                {
                    "fired_schedule_id": "sched-1",
                    "fired_scheduled_for": "2026-10-01T06:00:00Z",
                    "fired_status": "enqueued",
                    "fired_job_id": "job-9",
                }
            ]
        }
    )
    worker = _worker(monkeypatch, supabase)

    with caplog.at_level(logging.INFO, logger="hermes.worker"):
        assert worker.run_scheduler() == 1

    line = "\n".join(record.getMessage() for record in caplog.records)
    assert "sched-1" in line and "job-9" in line and "enqueued" in line


def test_a_skipped_firing_is_reported_rather_than_hidden(monkeypatch, caplog):
    # "Waiting for this month's file" is the ordinary outcome of a schedule on a
    # product where a person still uploads the file. It has to be visible, or
    # the feature looks broken every month until the upload happens.
    supabase = _Supabase(
        {
            "claim_due_recipe_schedules": [
                {
                    "fired_schedule_id": "sched-1",
                    "fired_scheduled_for": "2026-10-01T06:00:00Z",
                    "fired_status": "skipped_no_source",
                    "fired_job_id": None,
                }
            ]
        }
    )
    worker = _worker(monkeypatch, supabase)

    with caplog.at_level(logging.INFO, logger="hermes.worker"):
        worker.run_scheduler()

    line = "\n".join(record.getMessage() for record in caplog.records)
    assert "skipped_no_source" in line
    assert "job None" not in line, "a skip has no job and must not pretend to"


def test_a_database_error_in_the_scheduler_never_reaches_the_loop(monkeypatch):
    # The one that matters. The loop that calls this is the loop that claims
    # jobs; an exception here would stop the queue for everybody to protect a
    # monthly report for one customer.
    supabase = _Supabase(raises=SupabaseError("down", status=503, body="{}"))
    worker = _worker(monkeypatch, supabase)

    assert worker.run_scheduler() == 0


def test_a_worker_can_be_configured_not_to_schedule(monkeypatch):
    # How a deployment splits roles later: some workers process, some also
    # schedule. Off on all of them means schedules never fire, which is why the
    # default is on.
    supabase = _Supabase({"claim_due_recipe_schedules": []})
    worker = _worker(monkeypatch, supabase, scheduler_enabled=False)

    assert worker.run_scheduler() == 0
    assert supabase.calls == [], "a disabled scheduler must not even ask"


# ---------------------------------------------------------------------------
# The stuck-job sweep
# ---------------------------------------------------------------------------


def test_the_sweep_reports_how_many_jobs_it_ended(monkeypatch, caplog):
    supabase = _Supabase({"sweep_stuck_agent_jobs": 2})
    worker = _worker(monkeypatch, supabase)

    with caplog.at_level(logging.WARNING, logger="hermes.worker"):
        assert worker.sweep_stuck_jobs() == 2

    assert "2" in "\n".join(record.getMessage() for record in caplog.records)


def test_a_quiet_sweep_says_nothing(monkeypatch, caplog):
    # The normal case, every five minutes, forever. A log line here would bury
    # the ones that matter.
    supabase = _Supabase({"sweep_stuck_agent_jobs": 0})
    worker = _worker(monkeypatch, supabase)

    with caplog.at_level(logging.WARNING, logger="hermes.worker"):
        assert worker.sweep_stuck_jobs() == 0

    assert caplog.records == []


def test_a_failing_sweep_never_reaches_the_loop(monkeypatch):
    supabase = _Supabase(raises=SupabaseError("down", status=500, body="{}"))
    worker = _worker(monkeypatch, supabase)

    assert worker.sweep_stuck_jobs() == 0


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "field,default",
    [("scheduler_seconds", 60), ("stuck_sweep_seconds", 300), ("scheduler_enabled", True)],
)
def test_the_housekeeping_intervals_are_configurable_with_sane_defaults(field, default):
    # Not hardcoded inside the loop: section 16's rule about limits applies to
    # intervals too, and an operator who needs a tighter schedule resolution
    # should not need a code change.
    config = Config(
        supabase_url="https://example.supabase.co",
        service_key="k",
        worker_id="w",
        hostname="h",
    )
    assert getattr(config, field) == default
