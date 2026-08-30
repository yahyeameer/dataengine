"""
Categorising a column.

The first thing in this pipeline whose answer is a judgement rather than a
measurement, and therefore the first place a model can be wrong in a way the
data cannot contradict. Two halves are worth testing for that reason.

The **operation** must add a column without touching the one it read, and must
account for every row -- a value nobody categorised has to arrive as
'Uncategorised' and be counted, because "47 rows were not classified" is the
sentence that stops someone trusting the column too much.

The **filter** on the model's reply is the security-relevant half. A model that
invents a supplier, or answers with a category outside the list it was given,
should cost the product that one row and nothing else. These assert on the
filtering rather than on the prompt: what the model is asked is a matter of
taste, what is accepted back is not.
"""

from __future__ import annotations

from typing import Any

from hermes.config import LLMConfig
from hermes.llm.router import LLMResult, LLMRouter
from hermes.tools.clean import OPERATIONS, Table


# -----------------------------------------------------------------------------
# The operation
# -----------------------------------------------------------------------------


def _table() -> Table:
    return Table(
        {
            "vendor": ["O2 Mobile", "British Gas", "O2 Mobile", "Screwfix", None],
            "amount": [40.0, 120.0, 40.0, 85.5, 12.0],
        },
        [2, 3, 4, 5, 6],
    )


def _mapping() -> dict[str, Any]:
    return {
        "op": "assign_category",
        "column": "vendor",
        "target": "vendor_category",
        "mapping": {"o2 mobile": "Communications", "british gas": "Utilities"},
        "fallback": "Uncategorised",
    }


def test_it_adds_a_column_without_touching_the_one_it_read():
    table = _table()
    before = list(table.columns["vendor"])

    result = OPERATIONS["assign_category"](table, _mapping())

    assert table.columns["vendor"] == before, "the source column was modified"
    assert table.columns["vendor_category"] == [
        "Communications",
        "Utilities",
        "Communications",
        "Uncategorised",
        "Uncategorised",
    ]
    assert result.column == "vendor_category"


def test_every_row_gets_a_category_and_the_gaps_are_counted():
    """
    Silence is the failure mode. A column that quietly leaves blanks reads as
    complete until somebody filters on it.
    """
    table = _table()
    result = OPERATIONS["assign_category"](table, _mapping())

    assert len(table.columns["vendor_category"]) == table.row_count
    assert result.rows_changed == 3, "three rows matched an approved category"
    assert any("2 row(s) had no approved category" in w for w in result.warnings)


def test_it_refuses_to_overwrite_an_existing_column():
    table = _table()
    table.columns["vendor_category"] = ["keep"] * table.row_count

    result = OPERATIONS["assign_category"](table, _mapping())

    assert table.columns["vendor_category"] == ["keep"] * table.row_count
    assert any("already exists" in warning for warning in result.warnings)


def test_an_empty_mapping_does_nothing():
    """An approval that carried no categories must not invent a column of fallbacks."""
    table = _table()
    params = _mapping() | {"mapping": {}}

    result = OPERATIONS["assign_category"](table, params)

    assert "vendor_category" not in table.columns
    assert result.rows_changed == 0


# -----------------------------------------------------------------------------
# What comes back from the model
# -----------------------------------------------------------------------------


def _router(reply: str) -> LLMRouter:
    router = LLMRouter(LLMConfig(openai_api_key="test"))
    router._complete = lambda *a, **k: LLMResult(  # type: ignore[method-assign]
        content=reply, provider="openai", model="test-model", ok=True
    )
    return router


def test_a_clean_reply_becomes_a_mapping():
    router = _router('{"assignments": {"O2 Mobile": "Communications", "British Gas": "Utilities"}}')
    try:
        mapping, categories, model, error = router.categorize_values(
            "vendor", ["O2 Mobile", "British Gas"]
        )
    finally:
        router.close()

    assert mapping == {"o2 mobile": "Communications", "british gas": "Utilities"}
    assert categories == ["Communications", "Utilities"]
    assert model == "test-model"
    assert error is None


def test_a_value_nobody_asked_about_is_dropped():
    """
    The model returning a supplier that is not in the column is a hallucination,
    and the cost of it must be one missing category rather than a row of data
    invented into somebody's accounts.
    """
    router = _router(
        '{"assignments": {"O2 Mobile": "Communications", "Acme Holdings Ltd": "Consulting"}}'
    )
    try:
        mapping, _categories, _model, _error = router.categorize_values("vendor", ["O2 Mobile"])
    finally:
        router.close()

    assert mapping == {"o2 mobile": "Communications"}


def test_a_category_outside_the_allowed_list_is_dropped():
    """When the accountant fixes the vocabulary, it is fixed."""
    router = _router(
        '{"assignments": {"O2 Mobile": "Communications", "British Gas": "Something Else"}}'
    )
    try:
        mapping, categories, _model, _error = router.categorize_values(
            "vendor",
            ["O2 Mobile", "British Gas"],
            categories=["Communications", "Utilities"],
        )
    finally:
        router.close()

    assert mapping == {"o2 mobile": "Communications"}
    assert categories == ["Communications"]


def test_a_reply_that_is_not_json_yields_nothing():
    router = _router("Sure! Here are the categories you asked for.")
    try:
        mapping, categories, _model, error = router.categorize_values("vendor", ["O2 Mobile"])
    finally:
        router.close()

    assert mapping == {}
    assert categories == []
    assert error, "a malformed reply must be reported, not read as an empty column"


def test_no_model_configured_means_no_call():
    """Without a key the router must decline rather than half-run."""
    router = LLMRouter(LLMConfig())
    try:
        assert router.categorize_values("vendor", ["O2 Mobile"]) == (
            {},
            [],
            None,
            "no model configured",
        )
    finally:
        router.close()


# -----------------------------------------------------------------------------
# The quality gate
#
# The router's filter is silent by design: a value it will not accept is simply
# skipped. That is right for one bad row and wrong for four hundred, because the
# result arrives looking clean and the reviewer is shown eight examples of it.
#
# These assert on the two answers that are not categorisations at all, and on
# the numbers a reviewer needs in order to know whether the sample they are
# shown is representative. They do not assert on the model's judgement, which is
# not testable and not the point.
# -----------------------------------------------------------------------------

import pytest

from hermes.jobs import JobError, categorize_quality


def test_it_reports_values_the_router_silently_discarded():
    quality = categorize_quality(
        column="vendor",
        offered=500,
        mapping={str(i): f"Cat{i % 5}" for i in range(100)},
        categories=[f"Cat{i}" for i in range(5)],
        rows_total=1000,
        rows_covered=900,
    )

    assert quality["values_dropped"] == 400, "a reply that lost 400 values looked clean"
    assert quality["values_offered"] == 500
    assert quality["values_mapped"] == 100


def test_it_counts_singleton_categories_because_that_is_where_a_wrong_answer_hides():
    quality = categorize_quality(
        column="vendor",
        offered=5,
        mapping={"a": "Utilities", "b": "Utilities", "c": "Comms", "d": "Comms", "e": "Travel"},
        categories=["Utilities", "Comms", "Travel"],
        rows_total=100,
        rows_covered=95,
    )

    assert quality["singleton_categories"] == 1, "Travel holds one value and should be flagged"


def test_it_refuses_a_mapping_that_reaches_almost_no_rows():
    with pytest.raises(JobError) as caught:
        categorize_quality(
            column="notes",
            offered=50,
            mapping={"a": "X"},
            categories=["X"],
            rows_total=1000,
            rows_covered=50,
        )

    assert "too thin" in str(caught.value)
    assert caught.value.retryable is False, "the same column will fail identically next time"


def test_it_refuses_one_category_per_value():
    with pytest.raises(JobError) as caught:
        categorize_quality(
            column="notes",
            offered=20,
            mapping={str(i): f"C{i}" for i in range(20)},
            categories=[f"C{i}" for i in range(20)],
            rows_total=100,
            rows_covered=100,
        )

    assert "groups nothing" in str(caught.value)
    assert caught.value.retryable is False


def test_a_genuinely_small_column_is_not_mistaken_for_degeneracy():
    # Three payment types in three categories is a correct answer, and the
    # ratio check must not reject it just because the ratio is 1.0.
    quality = categorize_quality(
        column="type",
        offered=3,
        mapping={"a": "A", "b": "B", "c": "C"},
        categories=["A", "B", "C"],
        rows_total=10,
        rows_covered=10,
    )

    assert quality["category_count"] == 3
    assert quality["row_coverage"] == 1.0
