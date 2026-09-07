"""
Store financials: the ledger, the period engine, the findings, the two
languages.

These run with no database, no network and no model, against workbooks built
in the test itself. That is the point of the seam: everything a Somali shop
sees in its weekly report is decided by pure functions over `LedgerEntry`, so
the behaviour that matters most — is the profit figure right, does a refund
reduce sales, does the week start on Saturday — is checkable here rather than
only in a deployment.
"""

from __future__ import annotations

import datetime as dt
import io
from decimal import Decimal

import pytest
from openpyxl import Workbook

from hermes.connectors import excel
from hermes.connectors.ledger import (
    FxRates,
    LedgerEntry,
    classify_account,
    deduplicate,
)
from hermes.tools import somali, store_report
from hermes.tools.report import render_markdown
from hermes.tools.retail import (
    build_periods,
    estimate_zakat,
    period_start,
    summarise,
)

USD = FxRates(base="USD", rates={"SOS": Decimal("570")}, as_of=dt.date(2026, 8, 1))


def entry(day: str, kind: str, amount: str, **kwargs) -> LedgerEntry:
    defaults = {
        "occurred_on": dt.date.fromisoformat(day),
        "kind": kind,
        "category": kwargs.pop("category", "sales" if kind == "revenue" else "other_expense"),
        "amount": Decimal(amount),
        "currency": kwargs.pop("currency", "USD"),
    }
    defaults.update(kwargs)
    return LedgerEntry(**defaults)


# -----------------------------------------------------------------------------
# Classification
# -----------------------------------------------------------------------------


class TestClassification:
    def test_english_account_names_map_to_categories(self):
        assert classify_account("Shop Rent")[:2] == ("rent", "expense")
        assert classify_account("Staff Wages")[:2] == ("salaries", "expense")
        assert classify_account("Sales")[:2] == ("sales", "revenue")

    def test_somali_account_names_map_to_the_same_categories(self):
        """The whole reason this feature is not a translation of a UK product."""
        assert classify_account("Kirada dukaanka")[:2] == ("rent", "expense")
        assert classify_account("Mushaharka shaqaalaha")[:2] == ("salaries", "expense")
        assert classify_account("Iibka maanta")[:2] == ("sales", "revenue")
        assert classify_account("Korontada")[:2] == ("electricity", "expense")

    def test_costs_specific_to_somali_retail_have_their_own_categories(self):
        # Merged into "utilities" and "other", these three become invisible —
        # and they are among the largest controllable costs a shop here has.
        assert classify_account("Generator fuel")[0] == "electricity"
        assert classify_account("Guard salary — night")[0] == "security"
        assert classify_account("Hawala transfer fee")[0] == "remittance_fees"
        assert classify_account("Xawaalad fee")[0] == "remittance_fees"

    def test_freight_beats_transport_and_stock_beats_generic_cost(self):
        assert classify_account("Freight in from Dubai")[0] == "freight_in"
        assert classify_account("Customs duty")[0] == "customs_duty"

    def test_an_unmatched_account_is_reported_as_unmatched_not_guessed(self):
        category, kind, confidence = classify_account("Q4 misc 9931")
        assert (category, kind) == ("other_expense", "expense")
        assert confidence == "unmatched"

    def test_a_generic_word_is_weak_rather_than_confident(self):
        assert classify_account("Sundry expense")[2] == "weak"

    def test_the_source_decides_the_kind_and_the_words_decide_the_category(self):
        """
        The structure of the source is a fact; a description is a hint about it.

        Read the other way round, a row described "Cash sales" sitting in a
        spreadsheet's Expenses column became revenue — so the day's costs were
        added to its takings.
        """
        assert classify_account("Generator fuel", hint="expense")[:2] == (
            "electricity",
            "expense",
        )
        # The word says revenue, the column says cost. The column wins, and the
        # disagreement is reported rather than hidden.
        assert classify_account("Cash sales", hint="expense") == (
            "other_expense",
            "expense",
            "weak",
        )
        assert classify_account("", hint="revenue")[:2] == ("other_income", "revenue")


# -----------------------------------------------------------------------------
# The spreadsheet connector
# -----------------------------------------------------------------------------


def workbook(rows: list[list], title: str = "Ledger") -> bytes:
    book = Workbook()
    sheet = book.active
    sheet.title = title
    # A title block and a blank row, because a real shop's sheet has them and
    # the parser this connector delegates to is what handles them.
    sheet.append(["ACME Electronics — Bakaaraha"])
    sheet.append([])
    for row in rows:
        sheet.append(row)
    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


class TestExcelConnector:
    def test_two_column_sheet_produces_two_entries_from_one_row(self):
        data = workbook(
            [
                ["Date", "Description", "Income", "Expenses"],
                ["2026-08-01", "Cash sales", 300, None],
                ["2026-08-01", "Transport", None, 40],
                ["2026-08-02", "Cash sales", 250, 15],
            ]
        )
        batch, columns = excel.fetch(data, "ledger.xlsx")

        assert excel.shape_of(columns) == "two_column"
        assert len(batch.entries) == 4
        revenue = sum(e.amount for e in batch.entries if e.kind == "revenue")
        assert revenue == Decimal("550")
        # A day that took $250 and spent $15 is two facts. Netting them to $235
        # destroys both the sales figure and the cost figure.
        assert sum(e.amount for e in batch.entries if e.kind != "revenue") == Decimal("55")

    def test_signed_sheet_reads_the_sign_as_the_direction(self):
        data = workbook(
            [
                ["Taariikh", "Sharaxaad", "Qiimaha"],
                ["2026-08-01", "Iibka", 300],
                ["2026-08-01", "Kirada", -150],
            ]
        )
        batch, columns = excel.fetch(data, "ledger.xlsx")

        assert excel.shape_of(columns) == "signed"
        kinds = {e.category: e.kind for e in batch.entries}
        assert kinds["sales"] == "revenue"
        assert kinds["rent"] == "expense"
        # Magnitude on the entry, direction in the kind: a cost is never a
        # negative number downstream.
        assert all(e.amount > 0 for e in batch.entries)

    def test_typed_sheet_uses_the_type_column(self):
        data = workbook(
            [
                ["Date", "Type", "Amount"],
                ["2026-08-01", "Sale", 900],
                ["2026-08-02", "Purchase", 400],
                ["2026-08-03", "Electricity", 60],
            ]
        )
        batch, _columns = excel.fetch(data, "ledger.xlsx")
        by_kind = {e.kind for e in batch.entries}
        assert by_kind == {"revenue", "cogs", "expense"}
        assert next(e for e in batch.entries if e.kind == "cogs").amount == Decimal("400")

    def test_a_somali_purchase_is_not_read_as_a_somali_sale(self):
        """
        `iib` is a sale and `iibsi` is a purchase, and the second contains the
        first. Tested for revenue before cost, an electronics shop's stock
        purchases were booked as sales: no cost of goods at all, a gross margin
        of 100%, and the Dubai wholesaler listed as its biggest customer.
        """
        data = workbook(
            [
                ["Taariikh", "Nooca", "Qiimaha"],
                ["2026-08-01", "Iib", 1800],
                ["2026-08-02", "Iibsi", 1100],
            ]
        )
        batch, _columns = excel.fetch(data, "iibka.xlsx")
        kinds = {e.kind: e.amount for e in batch.entries}
        assert kinds["revenue"] == Decimal("1800")
        assert kinds["cogs"] == Decimal("1100")

        summary = summarise(batch.entries, USD, granularity="monthly")
        assert summary.current.cogs == Decimal("1100")
        assert summary.current.gross_margin is not None
        assert summary.current.gross_margin < 1

    def test_a_sheet_with_no_date_column_says_so_in_a_sentence(self):
        data = workbook([["Item", "Amount"], ["Rice", 20]])
        with pytest.raises(Exception) as error:
            excel.fetch(data, "ledger.xlsx")
        assert "date column" in str(error.value)

    def test_an_explicit_column_map_overrides_detection(self):
        data = workbook(
            [
                ["Date", "Amount", "Total"],
                ["2026-08-01", 10, 999],
            ]
        )
        _batch, columns = excel.fetch(data, "l.xlsx", column_map={"amount": "total"})
        assert columns["amount"] == "total"

    def test_re_reading_the_same_sheet_is_idempotent(self):
        data = workbook([["Date", "Amount"], ["2026-08-01", 300]])
        first, _ = excel.fetch(data, "l.xlsx")
        second, _ = excel.fetch(data, "l.xlsx")
        combined, dropped = deduplicate(first.entries + second.entries)
        assert dropped == len(first.entries)
        assert len(combined) == len(first.entries)


# -----------------------------------------------------------------------------
# Periods
# -----------------------------------------------------------------------------


class TestPeriods:
    def test_the_week_starts_on_saturday(self):
        """
        The working week here runs Saturday to Thursday. A Monday-start week
        splits it across two buckets, so every week-on-week comparison the
        report makes would compare six trading days against five.
        """
        # 2026-08-15 is a Saturday.
        assert period_start(dt.date(2026, 8, 15), "weekly") == dt.date(2026, 8, 15)
        assert period_start(dt.date(2026, 8, 20), "weekly") == dt.date(2026, 8, 15)
        # Friday closes the week rather than opening one.
        assert period_start(dt.date(2026, 8, 21), "weekly") == dt.date(2026, 8, 15)
        assert period_start(dt.date(2026, 8, 22), "weekly") == dt.date(2026, 8, 22)

    def test_a_period_with_no_trading_is_a_zero_not_a_gap(self):
        entries = [entry("2026-08-01", "revenue", "100"), entry("2026-08-04", "revenue", "100")]
        periods = build_periods(entries, USD, "daily")
        assert [p.start.day for p in periods] == [1, 2, 3, 4]
        assert periods[1].revenue == Decimal("0")

    def test_a_window_extends_the_series_past_the_last_transaction(self):
        entries = [entry("2026-08-20", "revenue", "100")]
        periods = build_periods(
            entries, USD, "daily", window=(dt.date(2026, 8, 19), dt.date(2026, 8, 22))
        )
        assert len(periods) == 4
        assert periods[-1].revenue == Decimal("0")

    def test_monthly_buckets_carry_the_whole_calendar_month(self):
        periods = build_periods([entry("2026-08-14", "revenue", "10")], USD, "monthly")
        assert periods[0].start == dt.date(2026, 8, 1)
        assert periods[0].end == dt.date(2026, 8, 31)
        assert periods[0].days == 31


# -----------------------------------------------------------------------------
# The figures
# -----------------------------------------------------------------------------


class TestSummary:
    @pytest.fixture
    def two_months(self):
        entries = [
            # July: $4,000 of sales, $2,400 of stock, $600 of costs.
            entry("2026-07-05", "revenue", "2500", product="Rice 25kg", counterparty="Hodan"),
            entry("2026-07-18", "revenue", "1500", product="Sugar 50kg"),
            entry("2026-07-06", "cogs", "2400", category="purchases", account="Stock purchases"),
            entry("2026-07-01", "expense", "400", category="rent", account="Rent"),
            entry("2026-07-01", "expense", "200", category="electricity", account="Generator"),
            # August: same sales, worse buying, and the generator bill doubles.
            entry("2026-08-05", "revenue", "2500", product="Rice 25kg", counterparty="Hodan"),
            entry("2026-08-18", "revenue", "1500", product="Sugar 50kg"),
            entry("2026-08-06", "cogs", "2900", category="purchases", account="Stock purchases"),
            entry("2026-08-01", "expense", "400", category="rent", account="Rent"),
            entry("2026-08-01", "expense", "500", category="electricity", account="Generator"),
        ]
        return summarise(entries, USD, granularity="monthly")

    def test_the_five_headline_figures(self, two_months):
        august = two_months.current
        assert august.revenue == Decimal("4000")
        assert august.cogs == Decimal("2900")
        assert august.gross_profit == Decimal("1100")
        assert august.expenses == Decimal("900")
        assert august.net_profit == Decimal("200")

    def test_a_refund_reduces_sales_rather_than_raising_costs(self):
        """
        The single most consequential sign decision in the feature. Booked as a
        cost, a refund overstates sales and overstates expenses together, so
        margin and net profit are both wrong in opposite directions.
        """
        summary = summarise(
            [
                entry("2026-08-01", "revenue", "1000"),
                entry("2026-08-02", "revenue", "-150"),
            ],
            USD,
            granularity="monthly",
        )
        period = summary.current
        assert period.revenue == Decimal("850")
        assert period.refunds == Decimal("150")
        assert period.expenses == Decimal("0")

    def test_margins_are_none_rather_than_zero_when_nothing_was_sold(self):
        summary = summarise([entry("2026-08-01", "expense", "40")], USD, granularity="monthly")
        assert summary.current.gross_margin is None
        assert summary.current.net_profit == Decimal("-40")

    def test_movement_against_the_previous_period(self, two_months):
        moves = {m.metric: m for m in two_months.movements}
        assert moves["cogs"].difference == Decimal("500")
        assert moves["net_profit"].previous == Decimal("1000")
        assert moves["net_profit"].current == Decimal("200")

    def test_growth_from_nothing_is_reported_as_unknown_not_infinite(self):
        summary = summarise(
            [entry("2026-07-01", "expense", "10"), entry("2026-08-01", "revenue", "400")],
            USD,
            granularity="monthly",
        )
        revenue = next(m for m in summary.movements if m.metric == "revenue")
        assert revenue.previous == Decimal("0")
        assert revenue.percent_change is None

    def test_shillings_are_converted_at_the_stated_rate(self):
        summary = summarise(
            [entry("2026-08-01", "revenue", "570000", currency="SOS")],
            USD,
            granularity="monthly",
        )
        assert summary.current.revenue == Decimal("1000")

    def test_an_unconfigured_currency_is_refused_rather_than_treated_as_dollars(self):
        with pytest.raises(Exception) as error:
            summarise([entry("2026-08-01", "revenue", "500", currency="AED")], USD)
        assert "exchange rate" in str(error.value)

    def test_top_products_and_customers_are_ranked_with_their_share(self, two_months):
        assert two_months.top_products[0].label == "Rice 25kg"
        assert two_months.top_products[0].share == pytest.approx(0.625)
        assert two_months.top_customers[0].label == "Hodan"

    def test_the_weekday_table_starts_on_saturday(self, two_months):
        assert [name for name, _ in two_months.weekday_revenue][0] == "Saturday"
        assert len(two_months.weekday_revenue) == 7


# -----------------------------------------------------------------------------
# Insights
# -----------------------------------------------------------------------------


def codes(summary) -> set[str]:
    return {insight.code for insight in summary.insights}


class TestInsights:
    def test_a_loss_is_the_first_thing_reported(self):
        summary = summarise(
            [entry("2026-08-01", "revenue", "500"), entry("2026-08-02", "expense", "900")],
            USD,
            granularity="monthly",
        )
        assert summary.insights[0].code == "loss_making"
        assert summary.insights[0].severity == "alert"

    def test_falling_margin_is_reported_even_when_sales_held_up(self):
        """Revenue flat, buying worse. The pair of numbers a total hides."""
        entries = [
            entry("2026-07-05", "revenue", "4000"),
            entry("2026-07-06", "cogs", "2400"),
            entry("2026-08-05", "revenue", "4000"),
            entry("2026-08-06", "cogs", "2900"),
        ]
        summary = summarise(entries, USD, granularity="monthly")
        assert "margin_down" in codes(summary)

    def test_a_cost_line_that_jumps_is_named_rather_than_buried_in_a_total(self):
        entries = [
            entry("2026-07-01", "revenue", "5000"),
            entry("2026-07-01", "expense", "200", category="electricity", account="Generator"),
            entry("2026-08-01", "revenue", "5000"),
            entry("2026-08-01", "expense", "500", category="electricity", account="Generator"),
        ]
        summary = summarise(entries, USD, granularity="monthly")
        spike = next(i for i in summary.insights if i.code == "expense_spike")
        assert spike.values["category"] == "electricity"

    def test_a_small_percentage_swing_is_not_reported(self):
        """$8 to $14 is a 75% rise and is not news."""
        entries = [
            entry("2026-07-01", "revenue", "5000"),
            entry("2026-07-01", "expense", "8", category="supplies", account="Bags"),
            entry("2026-08-01", "revenue", "5000"),
            entry("2026-08-01", "expense", "14", category="supplies", account="Bags"),
        ]
        assert "expense_spike" not in codes(summarise(entries, USD, granularity="monthly"))

    def test_one_product_carrying_the_shop_is_flagged(self):
        entries = [
            entry("2026-08-01", "revenue", "9000", product="Rice 25kg"),
            entry("2026-08-02", "revenue", "1000", product="Sugar"),
        ]
        summary = summarise(entries, USD, granularity="monthly")
        assert "product_concentration" in codes(summary)

    def test_uncategorised_costs_are_declared_as_a_limit_on_the_report(self):
        entries = [
            entry("2026-08-01", "revenue", "1000"),
            entry("2026-08-01", "expense", "400", account="Q4 misc", classified_by="unmatched"),
        ]
        summary = summarise(entries, USD, granularity="monthly")
        assert "uncategorised_costs" in codes(summary)


# -----------------------------------------------------------------------------
# Zakat
# -----------------------------------------------------------------------------


class TestZakat:
    def test_it_refuses_to_invent_a_figure_from_profit_alone(self):
        """
        Zakat on trade is levied on assets, not profit. 2.5% of net profit would
        look authoritative and be wrong in a way the reader cannot detect.
        """
        estimate = estimate_zakat(None)
        assert estimate.computed is False
        assert "inventory_value" in estimate.missing
        assert "lunar year" in estimate.note

    def test_it_computes_from_balances_when_they_are_supplied(self):
        estimate = estimate_zakat(
            {
                "inventory_value": 12000,
                "cash": 3000,
                "receivables": 1000,
                "short_term_liabilities": 2000,
            }
        )
        assert estimate.computed is True
        assert estimate.base == Decimal("14000.00")
        assert estimate.amount == Decimal("350.00")

    def test_liabilities_cannot_push_the_base_below_zero(self):
        estimate = estimate_zakat(
            {"inventory_value": 100, "cash": 0, "receivables": 0, "short_term_liabilities": 900}
        )
        assert estimate.amount == Decimal("0.00")


# -----------------------------------------------------------------------------
# Language
# -----------------------------------------------------------------------------


class TestLanguage:
    def test_shillings_are_shown_without_decimals_and_dollars_with(self):
        assert somali.money(Decimal("1234.5"), "USD") == "$1,234.50"
        assert somali.money(Decimal("712450"), "SOS") == "Sh712,450"

    def test_a_negative_is_parenthesised_the_way_a_ledger_writes_it(self):
        assert somali.money(Decimal("-150"), "USD") == "($150.00)"

    def test_the_shilling_figure_sits_beside_the_dollar_one(self):
        text = somali.dual_money(
            Decimal("100"), "USD", secondary="SOS", rate=Decimal("570")
        )
        assert "$100.00" in text and "Sh57,000" in text

    def test_no_rate_means_no_invented_second_figure(self):
        assert somali.dual_money(Decimal("100"), "USD", secondary="SOS", rate=None) == "$100.00"

    def test_categories_and_terms_exist_in_both_languages(self):
        assert somali.category_label("rent", "so") == "Kirada"
        assert somali.category_label("electricity", "so") == "Korontada iyo matoorka"
        assert somali.term("net_profit", "so") == "Faa'iidada saafiga ah"

    def test_every_category_the_engine_can_produce_has_a_somali_label(self):
        from hermes.connectors.ledger import CATEGORY_KINDS

        missing = sorted(set(CATEGORY_KINDS) - set(somali.CATEGORY_LABELS))
        assert missing == []

    def test_a_finding_is_translated_from_its_values_not_from_its_english(self):
        text = somali.translate_insight(
            "loss_making",
            "August ran at a loss of 200 USD",
            {"period": "2026-08", "net_profit": -200.0, "revenue": 500.0},
        )
        assert "khasaare" in text
        assert "$200.00" in text

    def test_every_finding_the_engine_can_produce_can_be_said_in_somali(self):
        """
        A template that names a value its finding does not carry cannot be
        filled, and the report silently falls back to English — which is how a
        Somali report ended up with one English paragraph in its findings. This
        walks the codes the engine actually emits and proves each one fills.
        """
        import re

        from hermes.tools.retail import find_insights

        # Build a summary rich enough to trigger most of the rules at once.
        entries = [
            entry("2026-07-05", "revenue", "5000", product="Rice"),
            entry("2026-07-06", "cogs", "2000", category="purchases"),
            entry("2026-07-01", "expense", "200", category="electricity"),
            entry("2026-08-05", "revenue", "5000", product="Rice"),
            entry("2026-08-06", "cogs", "3500", category="purchases"),
            entry("2026-08-01", "expense", "600", category="electricity"),
            entry("2026-08-02", "revenue", "-400"),
            entry("2026-08-03", "expense", "900", account="Q4 misc", classified_by="unmatched"),
        ]
        summary = summarise(entries, USD, granularity="monthly")
        produced = {insight.code for insight in find_insights(summary)}
        # A guard on the test itself: if this stops covering the rules, it stops
        # proving anything.
        assert len(produced) >= 5

        for insight in summary.insights:
            somali_text = somali.translate_insight(
                insight.code, insight.detail, insight.values, summary.currency
            )
            assert somali_text != insight.detail, f"{insight.code} fell back to English"
            assert "{" not in somali_text, f"{insight.code} left a placeholder unfilled"

    def test_a_money_figure_in_a_finding_is_grouped_and_readable(self):
        summary = summarise(
            [entry("2026-08-01", "revenue", "500"), entry("2026-08-02", "expense", "11371")],
            USD,
            granularity="monthly",
        )
        loss = next(i for i in summary.insights if i.code == "loss_making")
        assert "10,871.00 USD" in loss.detail

    def test_an_untranslated_finding_falls_back_to_english_rather_than_guessing(self):
        assert somali.translate_insight("no_such_code", "English sentence", {}) == "English sentence"


# -----------------------------------------------------------------------------
# The document
# -----------------------------------------------------------------------------


class TestDocument:
    @pytest.fixture
    def summary(self):
        return summarise(
            [
                entry("2026-07-05", "revenue", "4000", product="Rice"),
                entry("2026-07-06", "cogs", "2400", category="purchases", account="Stock"),
                entry("2026-08-05", "revenue", "4200", product="Rice"),
                entry("2026-08-06", "cogs", "2900", category="purchases", account="Stock"),
                entry("2026-08-01", "expense", "400", category="rent", account="Rent"),
            ],
            USD,
            granularity="monthly",
        )

    def test_the_english_report_leads_with_the_five_figures(self, summary):
        document = store_report.build_store_document(
            summary, store_name="Suuqa Hodan", workspace_name="Hodan", version_no=3
        )
        text = render_markdown(document)
        assert "Suuqa Hodan" in text
        for label in ("Sales", "Cost of goods sold", "Gross profit", "Running costs", "Net profit"):
            assert label in text

    def test_the_somali_report_is_in_somali_including_the_findings(self, summary):
        document = store_report.build_store_document(
            summary,
            store_name="Suuqa Hodan",
            workspace_name="Hodan",
            version_no=3,
            language="so",
            source="Excel",
        )
        text = render_markdown(document)
        assert "Iibka" in text
        assert "Faa'iidada saafiga ah" in text
        assert "Kirada" in text
        # The footnote is the claim the customer relies on; leaving it in
        # English would be the tell that this is a translated skin.
        assert "Kaaliye, ma aha xisaabiye" in text

    def test_both_languages_report_the_same_numbers(self, summary):
        english = render_markdown(
            store_report.build_store_document(
                summary, store_name="S", workspace_name="W", version_no=1
            )
        )
        somali_text = render_markdown(
            store_report.build_store_document(
                summary, store_name="S", workspace_name="W", version_no=1, language="so"
            )
        )
        for figure in ("$4,200.00", "$2,900.00", "$1,300.00", "$400.00"):
            assert figure in english, figure
            assert figure in somali_text, figure

    def test_an_empty_period_produces_a_document_that_says_so(self):
        document = store_report.build_store_document(
            summarise([], USD), store_name="S", workspace_name="W", version_no=0
        )
        assert "No records" in render_markdown(document)

    def test_the_bar_charts_are_labelled_in_the_report_currency(self, summary):
        """
        `Bars` carries the caller's own formatting of each figure, and the
        Markdown renderer ignored it — so a store report priced in dollars drew
        its charts labelled in sterling.
        """
        text = render_markdown(
            store_report.build_store_document(
                summary, store_name="S", workspace_name="W", version_no=1
            )
        )
        assert "£" not in text

    def test_the_somali_report_has_no_english_headers_left_in_it(self, summary):
        text = render_markdown(
            store_report.build_store_document(
                summary, store_name="S", workspace_name="W", version_no=1, language="so"
            )
        )
        # The key-figures table header, which the shared renderer used to
        # hard-code, and the zakat paragraph, which comes from the estimator.
        assert "Measure" not in text
        assert "Cabbirka" in text

    def test_the_zakat_paragraph_is_written_in_the_report_language(self, summary):
        from hermes.tools.retail import estimate_zakat

        for zakat in (estimate_zakat(None), estimate_zakat({"inventory_value": 100, "cash": 0, "receivables": 0})):
            text = render_markdown(
                store_report.build_store_document(
                    summary,
                    store_name="S",
                    workspace_name="W",
                    version_no=1,
                    language="so",
                    zakat=zakat,
                )
            )
            assert "zakada" in text.lower()
            assert "sheekhaaga" in text, "the Somali zakat note is missing"
            assert "lunar" not in text, "the English zakat note reached a Somali report"

    def test_the_shilling_column_appears_when_a_rate_is_configured(self, summary):
        document = store_report.build_store_document(
            summary, store_name="S", workspace_name="W", version_no=1
        )
        text = render_markdown(document)
        assert "Sh" in text
        # And the rate itself is stated, so the converted figure is checkable.
        assert "570" in text

    def test_headline_figures_are_returned_unformatted_for_the_dashboard(self, summary):
        figures = store_report.headline_figures(summary)
        assert figures["has_data"] is True
        assert figures["period"]["net_profit"] == 900.0
        assert figures["currency"] == "USD"
