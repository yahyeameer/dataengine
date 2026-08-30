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


# -----------------------------------------------------------------------------
# The alert webhook
#
# The interesting behaviour is what it does NOT send. A level-triggered alert on
# a condition that lasts a day fires 144 times, and the third one is where
# somebody mutes the channel -- at which point the monitor is worse than none,
# because everyone believes they are covered.
# -----------------------------------------------------------------------------

from hermes.health import build_alert


def _degraded_report():
    return check(_Stub([
        {"kind": "propose_cleaning", "degraded": 2, "model_ran": 5,
         "first_degraded_at": _iso(3), "last_degraded_at": _iso(1)},
    ]))


class _Worker:
    """The transition logic, lifted out of the worker so it can be driven."""

    def __init__(self, url="https://hooks.example/x"):
        self.url, self.sent, self._notified_state = url, [], None

    def observe(self, report):
        if not self.url or not report.checked:
            return
        state = "degraded" if report.degraded else "ok"
        if state == self._notified_state:
            return
        if self._notified_state is None and state == "ok":
            self._notified_state = state
            return
        payload = build_alert(report, recovered=(state == "ok"))
        if payload:
            self.sent.append(payload)
        self._notified_state = state


def test_a_sustained_fault_alerts_once_not_every_check():
    w = _Worker()
    for _ in range(20):          # ~3.5 hours of ten-minute checks
        w.observe(_degraded_report())

    assert len(w.sent) == 1, f"a lasting fault sent {len(w.sent)} alerts; the channel gets muted"


def test_coming_up_healthy_says_nothing():
    w = _Worker()
    w.observe(check(_Stub([{"kind": "propose_cleaning", "degraded": 0, "model_ran": 9}])))

    assert w.sent == [], "a healthy start is not news"


def test_coming_up_into_a_fault_does_alert():
    # A worker restarted into an already-degraded system must still say so --
    # otherwise a restart silently clears the only warning.
    w = _Worker()
    w.observe(_degraded_report())

    assert len(w.sent) == 1
    assert w.sent[0]["status"] == "degraded"


def test_recovery_is_announced():
    w = _Worker()
    w.observe(_degraded_report())
    w.observe(check(_Stub([{"kind": "propose_cleaning", "degraded": 0, "model_ran": 9}])))

    assert [p["status"] for p in w.sent] == ["degraded", "ok"]


def test_a_flapping_fault_alerts_on_each_real_transition():
    w = _Worker()
    healthy = check(_Stub([{"kind": "propose_cleaning", "degraded": 0, "model_ran": 9}]))
    for report in (_degraded_report(), healthy, _degraded_report(), healthy):
        w.observe(report)

    assert [p["status"] for p in w.sent] == ["degraded", "ok", "degraded", "ok"]


def test_an_unrunnable_check_never_alerts():
    w = _Worker()
    w.observe(check(_Stub(error=SupabaseError(503, "down"))))

    assert w.sent == [], "unknown is not a fault; paging for it spends the channel's credibility"


def test_no_webhook_configured_is_a_no_op():
    w = _Worker(url="")
    w.observe(_degraded_report())

    assert w.sent == []


def test_the_payload_names_kinds_and_counts_but_no_customer_data():
    payload = build_alert(_degraded_report(), recovered=False)

    assert payload["kinds"] == {"propose_cleaning": 2}
    # Slack reads `text`, Discord reads `content`: one payload, both work.
    assert payload["text"] == payload["content"]
    blob = str(payload).lower()
    for leaked in ("workspace", "dataset", "supplier", ".xlsx", "org_id"):
        assert leaked not in blob, f"alert payload leaked {leaked!r}"
