"""
The UK tax path, end to end through the categorise handler.

One property matters more than the rest here: asking for HMRC categories works
on an agent host with no API key. That was the reported failure -- a worker
running on rules answered "categorising needs a model" to the question this
product exists to answer -- so the test that carries the most weight is the one
where `llm` is switched off and a real proposal still comes out the other end.

The rest guard the boundary the rules sit behind. Deciding by pattern rather
than by model buys the job no extra authority: it writes a proposal, at the same
tier, into the same queue, and the column appears only when someone approves it
and apply_cleaning runs. And the vocabulary stays HMRC's whatever the caller
passes, because a taxonomy that can be widened by a request body is not a
taxonomy that maps onto boxes of a return.

The fakes are the smallest thing that lets the handler run: a Parquet file in
memory, and a Supabase that keeps the proposal instead of storing it.
"""

from __future__ import annotations

import io
from typing import Any

import polars as pl
import pytest

from hermes.config import Config, LLMConfig
from hermes.jobs import JobContext, JobError, handle_categorize_dataset
from hermes.tools import hmrc
from hermes.tools.clean import OPERATIONS, Table


# A month of a real-looking UK current account: one merchant per box that a
# statement actually hits, plus one line no rule can place.
_STATEMENT = [
    "CARD PAYMENT TO TFL TRAVEL CH 08JUN CARD 1234",
    "DIRECT DEBIT BRITISH GAS REF 8823991",
    "O2 UK LTD",
    "AMAZON* MKTPLCE EU-UK",
    "SCREWFIX DIRECT 0500414141",
    "HMRC VAT 1234567890",
    "TRANSFER TO SAVINGS",
    "NETFLIX.COM",
    "XERO SUBSCRIPTION",
    "QRZ TRADING 8891",
]

_UNPLACEABLE = "QRZ TRADING 8891"

# The same merchant as line three, spelled the way a value that has been through
# a word processor or a PDF arrives: a non-breaking space and a doubled one. It
# is here because the handler and the applier have to agree on how a value is
# keyed, and this is the value where they can disagree.
_AWKWARD = "O2\u00a0UK  LTD"

_ROWS = [*_STATEMENT, _AWKWARD]

# Every distinct value except the one nothing recognises. The awkward spelling
# collapses onto the plain one rather than counting twice.
_BY_RULE = len(_STATEMENT) - 1


def _statement_parquet() -> bytes:
    frame = pl.DataFrame(
        {
            "__source_row": list(range(2, len(_ROWS) + 2)),
            "transaction": _ROWS,
            "out": [12.5] * len(_ROWS),
        }
    )
    buffer = io.BytesIO()
    frame.write_parquet(buffer)
    return buffer.getvalue()


class _OfflineLLM:
    """An agent host with no API key. Reaching for it at all is the bug."""

    enabled = False

    def categorize_values(self, *a: Any, **k: Any):  # pragma: no cover - must not run
        raise AssertionError("the HMRC path asked a model that is not configured")


class _CategorizeSupabase:
    def __init__(self) -> None:
        self.proposals: list[dict[str, Any]] = []
        self.parquet = _statement_parquet()

    def select(self, table: str, **kwargs: Any) -> list[dict[str, Any]]:
        if table == "dataset_versions":
            return [
                {
                    "id": "version-1",
                    "dataset_id": "dataset-1",
                    "version_no": 1,
                    "kind": "parsed",
                    "parquet_path": "org/ws/2026-08/dataset-1__job.parquet",
                    "row_count": len(_ROWS),
                    "parent_version_id": None,
                    "produced_by_run_id": None,
                }
            ]
        return []

    def download(self, bucket: str, path: str, max_bytes: int) -> bytes:
        return self.parquet

    def rpc(self, function: str, params: dict[str, Any] | None = None) -> Any:
        if function == "append_proposed_changes":
            self.proposals = (params or {}).get("p_proposals", [])
            return len(self.proposals)
        return None


def _context(supabase: Any, payload: dict[str, Any], llm: Any) -> JobContext:
    return JobContext(
        config=Config(
            supabase_url="https://example.supabase.co",
            service_key="test",
            worker_id="test",
            hostname="test",
            llm=LLMConfig(),
        ),
        supabase=supabase,
        llm=llm,
        job={
            "id": "job-1",
            "workspace_id": "ws-1",
            "org_id": "org-1",
            "dataset_version_id": "version-1",
            "payload": payload,
            "requested_by": None,
        },
        heartbeat=lambda progress: None,
    )


def _run(payload: dict[str, Any] | None = None, llm: Any | None = None):
    supabase = _CategorizeSupabase()
    context = _context(
        supabase,
        {"column": "transaction", "taxonomy": hmrc.TAXONOMY, **(payload or {})},
        llm or _OfflineLLM(),
    )
    return supabase, handle_categorize_dataset(context)


# -----------------------------------------------------------------------------
# Running without a model
# -----------------------------------------------------------------------------


def test_uk_tax_categories_are_assigned_with_no_model_configured():
    supabase, result = _run()

    assert result["taxonomy"] == hmrc.TAXONOMY
    assert result["model_used"] is None
    assert result["matched_by_rule"] == _BY_RULE
    assert result["rows_uncovered"] == 1

    mapping = supabase.proposals[0]["operation"]["mapping"]
    # The three assignments where being wrong costs real money: tax owed, money
    # moved, and private spending. None of them is an allowable expense.
    assert mapping["hmrc vat 1234567890"] == "HMRC and Tax Payments"
    assert mapping["transfer to savings"] == "Transfers Between Accounts"
    assert mapping["netflix.com"] == "Personal, Non-Business"
    # A marketplace line names a shop and not a purchase, so the conservative
    # answer is no category rather than a confident Office Costs deduction.
    assert mapping["amazon* mktplce eu-uk"] == hmrc.FALLBACK


def test_the_approved_mapping_actually_lands_on_every_row_it_covers():
    """
    The one bug this whole flow can have and still look completely correct.

    The handler keys its mapping by one rule and `_op_assign_category` looks a
    row up by another, so if the two disagree the review queue shows a perfect
    categorisation, the accountant approves it, and the applied column reads
    'Uncategorised' for the rows where the spellings differed. Nothing anywhere
    reports an error. Running the real operation against the real proposal is
    the only assertion that catches it.
    """
    supabase, _ = _run()
    operation = supabase.proposals[0]["operation"]

    table = Table({"transaction": list(_ROWS)}, list(range(2, len(_ROWS) + 2)))
    OPERATIONS["assign_category"](table, operation)
    assigned = table.columns["transaction_category"]

    # The word-processor spelling of a merchant the rules placed.
    assert assigned[-1] == "Office Costs"
    # Two rows read 'Uncategorised' and they get there differently: the
    # marketplace line was *decided* to be unclassifiable by a rule, and the
    # unknown trader simply matched nothing and took the fallback. Both are
    # visible to the reviewer, which is the point.
    assert assigned[_ROWS.index(_UNPLACEABLE)] == hmrc.FALLBACK
    assert assigned[_ROWS.index("AMAZON* MKTPLCE EU-UK")] == hmrc.FALLBACK
    assert assigned.count(hmrc.FALLBACK) == 2


def test_deciding_by_rule_still_only_produces_a_proposal():
    supabase, _ = _run()
    proposal = supabase.proposals[0]

    assert proposal["step_type"] == "assign_category"
    assert proposal["confidence"] == "medium", "Review tier, never Auto"
    assert proposal["operation"]["target"] == "transaction_category"
    assert proposal["operation"]["fallback"] == hmrc.FALLBACK


def test_the_vocabulary_is_hmrcs_whatever_the_caller_asked_for():
    supabase, _ = _run({"categories": ["Good", "Bad"]})
    used = set(supabase.proposals[0]["operation"]["mapping"].values())

    assert used <= set(hmrc.CATEGORY_NAMES)
    assert not used & {"Good", "Bad"}


def test_the_evidence_says_which_box_each_category_files_to():
    supabase, _ = _run()
    evidence = supabase.proposals[0]["evidence"]

    assert evidence["taxonomy"] == hmrc.TAXONOMY
    assert evidence["boxes"]["Office Costs"] == "SA103F box 23"
    assert evidence["matched_by_model"] == 0


# -----------------------------------------------------------------------------
# Running with one
# -----------------------------------------------------------------------------


def test_the_model_is_asked_only_about_what_no_rule_placed():
    seen: dict[str, Any] = {}

    class _Tail:
        enabled = True

        def categorize_values(self, column, values, categories=None, hint=None):
            seen["values"] = list(values)
            seen["categories"] = list(categories or [])
            return {"qrz trading 8891": "Other Business Expenses"}, [], "test-model", None

    supabase, result = _run(llm=_Tail())

    assert seen["values"] == [_UNPLACEABLE], "the model was shown values the rules had placed"
    assert seen["categories"] == list(hmrc.CATEGORY_NAMES)
    assert result["matched_by_rule"] == _BY_RULE
    assert supabase.proposals[0]["evidence"]["matched_by_model"] == 1


def test_the_rules_win_where_both_have_an_opinion():
    class _Contrarian:
        enabled = True

        def categorize_values(self, column, values, categories=None, hint=None):
            # Answering about a value it was never shown. The router drops those
            # itself; this is the second line of defence, and it matters because
            # a rule is reviewable prose and a model answer is not.
            return {"hmrc vat 1234567890": "Office Costs"}, [], "test-model", None

    supabase, _ = _run(llm=_Contrarian())
    mapping = supabase.proposals[0]["operation"]["mapping"]

    assert mapping["hmrc vat 1234567890"] == "HMRC and Tax Payments"


def test_a_model_failure_does_not_throw_away_what_the_rules_decided():
    class _Broken:
        enabled = True

        def categorize_values(self, *a: Any, **k: Any):
            return {}, [], "test-model", "429 rate limited"

    supabase, result = _run(llm=_Broken())

    assert result["matched_by_rule"] == _BY_RULE, "the rules survived the model failing"
    assert supabase.proposals[0]["evidence"]["model_error"] == "429 rate limited"


# -----------------------------------------------------------------------------
# Refusals
# -----------------------------------------------------------------------------


def test_an_unknown_taxonomy_is_refused_rather_than_ignored():
    # Silently falling back to the open vocabulary would hand somebody a column
    # they believe files to a return and does not.
    context = _context(
        _CategorizeSupabase(), {"column": "transaction", "taxonomy": "irs"}, _OfflineLLM()
    )

    with pytest.raises(JobError) as caught:
        handle_categorize_dataset(context)

    assert "unknown taxonomy" in str(caught.value)


def test_without_a_taxonomy_a_missing_model_still_says_so():
    context = _context(_CategorizeSupabase(), {"column": "transaction"}, _OfflineLLM())

    with pytest.raises(JobError) as caught:
        handle_categorize_dataset(context)

    # And the message now names the way out, which is the point of the rules.
    assert "UK tax categories" in str(caught.value)
