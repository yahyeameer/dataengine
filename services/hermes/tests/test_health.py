"""
The monitor for the failure that does not look like one.

Two properties matter here and neither is about SQL. A check that could not run
must not report health -- a monitor defaulting to "fine" lies exactly when it
matters. And the degradation verdict has to survive into the worker's heartbeat
metadata, because that is the row anything else in the system reads.
"""

from __future__ import annotations

from hermes.health import Degradation, HealthReport, check
from hermes.supabase import SupabaseError


class _Stub:
    def __init__(self, rows=None, error=None):
        self._rows, self._error = rows or [], error

    def select(self, table, columns="*", **kwargs):
        assert table == "agent_llm_health", f"read the wrong view: {table}"
        if self._error:
            raise self._error
        return self._rows


def test_a_healthy_system_reports_ok():
    report = check(_Stub([{"kind": "propose_cleaning", "degraded": 0, "model_ran": 12}]))

    assert report.ok
    assert report.summary() == {"llm_health": "ok"}


def test_it_reports_the_kind_that_stopped_using_a_model():
    report = check(_Stub([
        {"kind": "propose_cleaning", "degraded": 3, "model_ran": 9,
         "first_degraded_at": "2026-08-30T02:06:39Z", "last_degraded_at": "2026-08-30T04:00:00Z"},
        {"kind": "generate_report", "degraded": 0, "model_ran": 4},
    ]))

    assert not report.ok
    assert [d.kind for d in report.degraded] == ["propose_cleaning"]
    summary = report.summary()
    assert summary["llm_health"] == "degraded"
    assert summary["llm_degraded_kinds"] == {"propose_cleaning": 3}
    assert summary["llm_degraded_since"] == "2026-08-30T02:06:39Z"


def test_a_check_that_could_not_run_is_not_reported_as_healthy():
    # The whole point. An unreachable database means we do not know, and
    # saying "ok" here would be the monitor lying at the moment it matters.
    report = check(_Stub(error=SupabaseError(503, "upstream unavailable")))

    assert report.checked is False
    assert report.ok is False, "an unrunnable check must never read as healthy"
    assert report.summary()["llm_health"] == "unknown"


def test_share_describes_how_much_of_the_workload_degraded():
    item = Degradation(kind="propose_cleaning", degraded=3, model_ran=9,
                       first_degraded_at=None, last_degraded_at=None)

    assert item.share == 0.25


def test_an_unchecked_report_starts_unknown_not_healthy():
    assert HealthReport(checked=False, error="not yet checked").ok is False


# -----------------------------------------------------------------------------
# The window
#
# The view counts for all time on purpose -- "this started on the 30th" is what
# identifies the change. But an alert on an all-time count never clears, and a
# monitor that is permanently red is one people stop reading. The record and the
# alert therefore have different horizons.
# -----------------------------------------------------------------------------

from datetime import datetime, timedelta, timezone


def _iso(hours_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).isoformat()


def test_a_degradation_that_was_fixed_yesterday_stops_alerting():
    report = check(_Stub([
        {"kind": "propose_cleaning", "degraded": 1, "model_ran": 40,
         "first_degraded_at": _iso(72), "last_degraded_at": _iso(48)},
    ]))

    assert report.ok, "a resolved degradation kept the monitor permanently red"
    assert report.summary() == {"llm_health": "ok"}


def test_a_degradation_still_happening_does_alert():
    report = check(_Stub([
        {"kind": "propose_cleaning", "degraded": 2, "model_ran": 5,
         "first_degraded_at": _iso(3), "last_degraded_at": _iso(1)},
    ]))

    assert not report.ok
    assert report.summary()["llm_degraded_kinds"] == {"propose_cleaning": 2}


def test_an_unparseable_timestamp_is_treated_as_current():
    # Failing open: dropping a real degradation because a date format changed
    # is the wrong way for a monitor to be wrong.
    report = check(_Stub([
        {"kind": "generate_report", "degraded": 1, "model_ran": 0,
         "first_degraded_at": "not-a-date", "last_degraded_at": "not-a-date"},
    ]))

    assert not report.ok
