"""
Watching for the failure that does not look like one.

Every model call in this system degrades to the rule engine on a timeout, an
unreachable endpoint, malformed JSON or a missing key. That is deliberate and
it should stay -- an accounting firm's month-end must not fail because an API
is down. The cost of it is that the failure has no failure: the job succeeds,
proposals appear, and the only symptom is that the explanations get plainer.

`agent_llm_health` makes that queryable. This module makes it *noticed*, which
is a different problem. A signal nobody reads is not observability, and the
honest test of monitoring is whether it reaches somebody who was not already
looking for it.

The worker is the right place for that check and no new service is needed. It
already runs forever, already heartbeats, and already has a log somebody opens
when something seems wrong. So the check rides the heartbeat it already sends:
a warning in the log for the person reading it, and a flag on the worker's own
row for anything querying the database.

Deliberately not a new table, not a new daemon, and not an alerting integration
-- each of those is a thing to operate, and the first version of a monitor
should cost less to run than the failure it catches.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from .supabase import SupabaseClient, SupabaseError

log = logging.getLogger("hermes.health")

# How far back a degradation still counts as *current*.
#
# `agent_llm_health` deliberately counts for all time -- it is the forensic
# record, and "this started on the 30th" is the sentence that identifies what
# changed. But an alert built on an all-time count never clears: one afternoon's
# outage, fixed the same hour, leaves the monitor red for the life of the
# system. A permanently red monitor is worse than none, because people stop
# reading it and then miss the real one.
#
# So the alert is windowed and the record is not. A day is long enough that a
# degradation spanning an overnight gap between jobs is still caught, and short
# enough that a fixed problem goes quiet on its own.
DEGRADATION_WINDOW_HOURS = 24


@dataclass(frozen=True)
class Degradation:
    """One job kind that has been answering without a model."""

    kind: str
    degraded: int
    model_ran: int
    first_degraded_at: str | None
    last_degraded_at: str | None

    @property
    def share(self) -> float:
        total = self.degraded + self.model_ran
        return self.degraded / total if total else 0.0


@dataclass(frozen=True)
class HealthReport:
    degraded: list[Degradation] = field(default_factory=list)
    checked: bool = True
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.checked and not self.degraded

    def summary(self) -> dict[str, Any]:
        """
        Small enough to live in the worker's heartbeat metadata.

        `agent_workers.metadata` is already read by the dashboard and by anyone
        debugging from a SQL prompt, so putting the verdict there costs one
        column nobody has to know about in advance.
        """
        if not self.checked:
            return {"llm_health": "unknown", "llm_health_error": self.error}
        if not self.degraded:
            return {"llm_health": "ok"}
        return {
            "llm_health": "degraded",
            "llm_degraded_kinds": {d.kind: d.degraded for d in self.degraded},
            "llm_degraded_since": min(
                (d.first_degraded_at for d in self.degraded if d.first_degraded_at),
                default=None,
            ),
        }


def check(supabase: SupabaseClient) -> HealthReport:
    """
    Read `agent_llm_health` and report the kinds answering without a model.

    Never raises. A monitor that can take the process down with it is worse
    than no monitor, and an unreachable database is already handled -- loudly
    -- by the loop this is called from.
    """
    try:
        rows = supabase.select(
            "agent_llm_health",
            columns="kind,degraded,model_ran,first_degraded_at,last_degraded_at",
        )
    except SupabaseError as error:
        # Distinguished from "healthy" on purpose. A check that failed to run
        # and a check that found nothing are not the same claim, and reporting
        # the second when the first happened is how monitoring lies.
        log.warning("llm health check could not run: %s %s", error.status, error.body)
        return HealthReport(checked=False, error=f"{error.status}")

    cutoff = datetime.now(timezone.utc) - timedelta(hours=DEGRADATION_WINDOW_HOURS)

    degraded = [
        item
        for row in rows
        if int(row.get("degraded") or 0) > 0
        for item in [
            Degradation(
                kind=row["kind"],
                degraded=int(row.get("degraded") or 0),
                model_ran=int(row.get("model_ran") or 0),
                first_degraded_at=row.get("first_degraded_at"),
                last_degraded_at=row.get("last_degraded_at"),
            )
        ]
        if _within_window(item.last_degraded_at, cutoff)
    ]

    return HealthReport(degraded=degraded)


def _within_window(timestamp: str | None, cutoff: datetime) -> bool:
    """
    Is this degradation recent enough to still be worth shouting about?

    An unparseable or missing timestamp is treated as current. The alternative
    is silently dropping a real degradation because a date format changed,
    which is the wrong way for a monitor to fail.
    """
    if not timestamp:
        return True
    try:
        # PostgREST renders timestamptz as ISO 8601; `fromisoformat` handles the
        # offset on 3.11+, and the Z spelling needs the one substitution.
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        log.warning("could not parse degradation timestamp %r; treating as current", timestamp)
        return True
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed >= cutoff


def build_alert(report: HealthReport, recovered: bool) -> dict[str, Any] | None:
    """
    The message body, or None when there is nothing worth sending.

    Carries `text` and `content` with the same sentence because Slack reads the
    first and Discord the second, and anything else reading JSON gets the
    structured fields alongside. One payload, three destinations, no adapter.

    Nothing customer-identifying goes out. Job kinds are schema, counts are
    integers; no workspace, dataset, filename or figure appears -- an alert
    channel is usually a group chat, and this one describes an operational
    fault rather than anybody's books.
    """
    if recovered:
        text = "DataEngine: AI explanations are back on the model."
        return {
            "text": text, "content": text,
            "status": "ok", "service": "dataengine-worker",
        }

    if not report.degraded:
        return None

    parts = ", ".join(f"{d.kind} x{d.degraded}" for d in report.degraded)
    since = min(
        (d.first_degraded_at for d in report.degraded if d.first_degraded_at),
        default=None,
    )
    text = (
        f"DataEngine: AI explanations are running WITHOUT a model ({parts}). "
        f"Jobs still succeed and figures are still correct -- the wording is "
        f"plainer. Since {since or 'unknown'}. Check the worker can reach the "
        f"agent's network; see docs/RUNBOOK.md."
    )
    return {
        "text": text, "content": text,
        "status": "degraded", "service": "dataengine-worker",
        "kinds": {d.kind: d.degraded for d in report.degraded},
        "since": since,
    }


def sign_alert(secret: str, body: bytes) -> dict[str, str]:
    """
    The headers a Hermes generic-webhook route requires.

    The V2 scheme from the Hermes webhook documentation: HMAC-SHA256 over
    ``<timestamp>.<body>``, sent as ``X-Webhook-Signature-V2`` alongside
    ``X-Webhook-Timestamp``. The gateway selects V2 purely on the presence of
    the signature header, and rejects it outright when the timestamp is absent
    -- so the two are always sent together or not at all.

    Seconds, not milliseconds. A receiver enforcing a replay window reads a
    millisecond timestamp as a date tens of thousands of years out and rejects
    it with the same 401 a wrong digest produces.
    """
    timestamp = str(int(time.time()))
    signed = timestamp.encode() + b"." + body
    digest = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return {
        "Content-Type": "application/json",
        "X-Webhook-Timestamp": timestamp,
        "X-Webhook-Signature-V2": digest,
        "X-Webhook-Event": "worker.health",
    }


def send_alert(
    url: str,
    payload: dict[str, Any],
    timeout: float = 10.0,
    secret: str = "",
) -> bool:
    """
    Post the alert. Never raises.

    A monitor that can take the worker down is worse than no monitor: this runs
    inside the loop that processes an accountant's month-end, and an unreachable
    webhook must cost a log line, not a job.

    Signed when a secret is configured. This posted a bare unsigned body until
    now, which is fine for a Slack-style URL where the URL *is* the credential,
    and is a guaranteed ``401 {"error": "Invalid signature"}`` against a Hermes
    route, where authentication is the HMAC. Both destinations are legitimate,
    so the signature is added when there is a secret to sign with rather than
    always or never.

    The body is serialised once and both signed and posted, because the digest
    covers exact bytes: re-serialising for the request could reorder keys and
    invalidate a signature that was correct when it was computed.
    """
    try:
        import httpx

        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        headers = (
            sign_alert(secret, body)
            if secret
            else {"Content-Type": "application/json"}
        )

        response = httpx.post(url, content=body, headers=headers, timeout=timeout)
        if response.status_code >= 400:
            # The URL is never logged -- a webhook URL is a bearer credential
            # for most providers, and log files travel further than they should.
            # Nor is the body: the signature is derived from the secret.
            log.warning("health alert rejected by webhook: HTTP %s", response.status_code)
            return False
        return True
    except Exception as error:  # noqa: BLE001 - an alert must never break the loop
        log.warning("health alert could not be delivered: %s", type(error).__name__)
        return False


def log_report(report: HealthReport) -> None:
    """
    Say it once, at a level that stands out in `docker logs`.

    Written for somebody scrolling a log at an unreasonable hour, so it names
    the kind, the count and the date rather than pointing at a dashboard they
    would then have to find.
    """
    if not report.checked or report.ok:
        return

    for item in report.degraded:
        log.warning(
            "LLM DEGRADED: %s has %s job(s) that succeeded with no model, "
            "%.0f%% of its runs since %s. The rule engine answered instead and "
            "nothing failed. See docs/RUNBOOK.md -- most often the worker has "
            "lost the agent's network.",
            item.kind,
            item.degraded,
            item.share * 100,
            item.first_degraded_at or "unknown",
        )
