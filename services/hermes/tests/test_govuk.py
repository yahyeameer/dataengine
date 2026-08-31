"""
Reading official guidance, and the guards that keep it narrow.

This is the only module in the worker that talks to something other than
Supabase and the model endpoint, so it is the only one where "what can this
reach" is a security question rather than a design one. The tests below are
almost entirely about what it refuses.

The other half is the authority boundary. A change on a government website must
never reclassify a customer's accounts, so `handle_hmrc_knowledge_check` is
tested for what it does *not* do: it writes reports and it does not touch a rule.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from hermes.config import Config, GovUKConfig, LLMConfig
from hermes.jobs import JobContext, JobError, handle_hmrc_knowledge_check
from hermes.tools import govuk, hmrc


_DOCUMENT = {
    "base_path": "/expenses-if-youre-self-employed",
    "title": "Expenses if you are self-employed",
    "description": "Business expenses you can claim if you are self-employed.",
    "public_updated_at": "2026-04-06T09:00:00Z",
}


def _transport(
    handler: Any = None, document: dict[str, Any] | None = None
) -> httpx.MockTransport:
    """A transport that records what was asked for and answers with GOV.UK JSON."""

    def _respond(request: httpx.Request) -> httpx.Response:
        if handler is not None:
            return handler(request)
        return httpx.Response(200, json=document if document is not None else _DOCUMENT)

    return httpx.MockTransport(_respond)


def _client(**overrides: Any) -> govuk.GovUKClient:
    config = GovUKConfig(enabled=True, **{k: v for k, v in overrides.items() if k != "transport"})
    return govuk.GovUKClient(config, transport=overrides.get("transport") or _transport())


# -----------------------------------------------------------------------------
# Switched off means switched off
# -----------------------------------------------------------------------------


def test_nothing_reaches_the_network_when_it_is_disabled():
    def _explode(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("a request was made with GOV.UK access disabled")

    client = govuk.GovUKClient(GovUKConfig(enabled=False), transport=_transport(_explode))
    with client:
        assert client.fetch("/expenses-if-youre-self-employed") is None
        assert client.check_topics() == []
        assert client.enabled is False


def test_the_categorisation_path_does_not_need_it():
    # Stated as a test because it is the property that makes shipping this
    # switched off safe: every call site is an enrichment, and the default
    # config is the one customers will run.
    assert GovUKConfig().enabled is False


# -----------------------------------------------------------------------------
# One host, one shape of URL
# -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "//evil.example.com/steal",          # protocol-relative: absolute to a parser
        "https://evil.example.com/steal",    # outright absolute
        "expenses",                          # not rooted
        "http://www.gov.uk/x",               # downgrade
        "",
    ],
)
def test_it_refuses_anything_that_is_not_a_govuk_content_path(path):
    seen: list[str] = []

    def _record(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        seen.append(str(request.url))
        return httpx.Response(200, json=_DOCUMENT)

    with _client(transport=_transport(_record)) as client:
        assert client.fetch(path) is None

    assert seen == [], f"{path!r} reached the network"


def test_it_asks_the_content_api_and_not_the_website():
    seen: list[str] = []

    def _record(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json=_DOCUMENT)

    with _client(transport=_transport(_record)) as client:
        client.fetch("/expenses-if-youre-self-employed")

    assert seen == ["https://www.gov.uk/api/content/expenses-if-youre-self-employed"]


def test_a_redirect_is_not_followed():
    # On a single-host allowlist, following a redirect is how the allowlist
    # stops meaning anything.
    def _redirect(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://evil.example.com/x"})

    with _client(transport=_transport(_redirect)) as client:
        assert client.fetch("/expenses-if-youre-self-employed") is None


def test_an_oversized_response_is_treated_as_unreadable():
    def _huge(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 5000)

    with _client(max_bytes=1024, transport=_transport(_huge)) as client:
        assert client.fetch("/expenses-if-youre-self-employed") is None


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(404),
        httpx.Response(500),
        httpx.Response(200, content=b"<html>not json</html>"),
        httpx.Response(200, json=["not", "an", "object"]),
    ],
)
def test_an_unusable_answer_is_none_rather_than_an_exception(response):
    # Every call site is an enrichment on somebody's categorisation run. GOV.UK
    # being slow, moved or briefly broken is not a reason to fail an accountant.
    with _client(transport=_transport(lambda request: response)) as client:
        assert client.fetch("/expenses-if-youre-self-employed") is None


def test_a_network_failure_is_none_rather_than_an_exception():
    def _drop(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    with _client(transport=_transport(_drop)) as client:
        assert client.fetch("/expenses-if-youre-self-employed") is None


# -----------------------------------------------------------------------------
# What is kept
# -----------------------------------------------------------------------------


def test_it_keeps_a_citation_and_not_the_page():
    with _client() as client:
        source = client.fetch("/expenses-if-youre-self-employed", ("Office Costs",))

    assert source is not None
    assert source.title == "Expenses if you are self-employed"
    assert source.url == "https://www.gov.uk/expenses-if-youre-self-employed"
    assert source.public_updated_at == "2026-04-06T09:00:00Z"
    assert source.categories == ("Office Costs",)

    # A hash, not the text. Change detection needs to know that the page moved;
    # it does not need HMRC's prose, which we have no licence to store.
    assert len(source.body_hash) == 64
    for field in vars(source).values():
        assert "Business expenses you can claim" not in str(field) or field == source.summary


def test_the_evidence_shape_is_small_and_cites_its_source():
    with _client() as client:
        source = client.fetch("/expenses-if-youre-self-employed")

    evidence = source.as_evidence("2026-09-01T10:00:00Z")
    assert set(evidence) == {"title", "url", "published", "checked_at", "summary"}
    assert evidence["url"].startswith("https://www.gov.uk/")
    assert len(evidence["summary"]) <= 400


def test_a_run_checks_only_the_topics_relevant_to_it():
    seen: list[str] = []

    def _record(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json=_DOCUMENT)

    with _client(transport=_transport(_record)) as client:
        client.check_topics(only=frozenset({"Capital Expenditure"}))

    assert seen, "the capital topics should have been read"
    # And not the whole list. A page per transaction is the expensive mistake
    # this design exists to avoid; a page per relevant topic is the point.
    assert len(seen) < len(govuk.TOPICS)


def test_every_topic_names_categories_that_exist():
    for path, categories in govuk.TOPICS:
        assert path.startswith("/"), path
        for category in categories:
            assert category in hmrc.CATEGORY_NAMES, f"{path}: {category}"

    assert govuk.TAX_SENSITIVE <= set(hmrc.CATEGORY_NAMES)


# -----------------------------------------------------------------------------
# The monitor reports; it does not act
# -----------------------------------------------------------------------------


class _MonitorSupabase:
    def __init__(self, changed: bool = False):
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.changed = changed

    def rpc(self, function: str, params: dict[str, Any] | None = None) -> Any:
        self.calls.append((function, params or {}))
        if function == "record_hmrc_source":
            return {
                "source_id": "source-1",
                "changed": self.changed,
                "change_report_id": "report-1" if self.changed else None,
            }
        return None


def _monitor_context(supabase: Any, enabled: bool = True) -> JobContext:
    return JobContext(
        config=Config(
            supabase_url="https://example.supabase.co",
            service_key="test",
            worker_id="test",
            hostname="test",
            llm=LLMConfig(),
            govuk=GovUKConfig(enabled=enabled),
        ),
        supabase=supabase,
        llm=None,
        job={
            "id": "job-1",
            "workspace_id": "ws-1",
            "org_id": "org-1",
            "payload": {},
            "requested_by": None,
        },
        heartbeat=lambda progress: None,
    )


def test_a_changed_page_produces_a_report_and_changes_no_rule(monkeypatch):
    before = {rule.category for rule in hmrc._RULES_RAW}

    monkeypatch.setattr(
        govuk.GovUKClient,
        "_client_or_open",
        lambda self: httpx.Client(transport=_transport(), follow_redirects=False),
    )

    supabase = _MonitorSupabase(changed=True)
    result = handle_hmrc_knowledge_check(_monitor_context(supabase))

    assert result["sources_checked"] == len(govuk.TOPICS)
    assert result["changes_detected"] == len(govuk.TOPICS)
    assert result["reports"][0]["change_report_id"] == "report-1"

    # The assertion this whole feature turns on.
    assert result["rules_changed"] == 0
    assert {rule.category for rule in hmrc._RULES_RAW} == before

    # And every write it made was a source or a report -- nothing that applies.
    assert {name for name, _ in supabase.calls} == {"record_hmrc_source"}


def test_an_unchanged_page_reports_nothing(monkeypatch):
    monkeypatch.setattr(
        govuk.GovUKClient,
        "_client_or_open",
        lambda self: httpx.Client(transport=_transport(), follow_redirects=False),
    )

    result = handle_hmrc_knowledge_check(_monitor_context(_MonitorSupabase(changed=False)))
    assert result["changes_detected"] == 0
    assert result["reports"] == []


def test_the_monitor_says_so_when_it_is_switched_off():
    with pytest.raises(JobError) as caught:
        handle_hmrc_knowledge_check(_monitor_context(_MonitorSupabase(), enabled=False))

    assert "HERMES_GOVUK_ENABLED" in str(caught.value)
