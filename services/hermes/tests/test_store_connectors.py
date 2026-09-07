"""
QuickBooks and Odoo, tested where they are actually likely to be wrong.

Neither test touches the network. Both connectors are split so that the half
that reasons about a source system's data takes plain dictionaries, and these
are recorded payloads of the shape those systems return -- which is what makes
the sign handling checkable at all. Sign is the thing: a refund booked as a
cost, or an Odoo income line left at its stored negative balance, produces a
report that is confidently and invisibly wrong.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest

from hermes.connectors import odoo, quickbooks
from hermes.connectors.ledger import FxRates
from hermes.tools.retail import summarise

USD = FxRates(base="USD")


# -----------------------------------------------------------------------------
# QuickBooks
# -----------------------------------------------------------------------------

INVOICE = {
    "Id": "1041",
    "DocNumber": "INV-1041",
    "TxnDate": "2026-08-04",
    "TotalAmt": 1250.00,
    "CurrencyRef": {"value": "USD", "name": "United States Dollar"},
    "CustomerRef": {"value": "12", "name": "Hodan Trading"},
    "Line": [
        {
            "Id": "1",
            "Amount": 1000.00,
            "DetailType": "SalesItemLineDetail",
            "Description": "Rice 25kg x 20",
            "SalesItemLineDetail": {"ItemRef": {"value": "3", "name": "Rice 25kg"}, "Qty": 20},
        },
        {
            "Id": "2",
            "Amount": 250.00,
            "DetailType": "SalesItemLineDetail",
            "Description": "Sugar 50kg x 5",
            "SalesItemLineDetail": {"ItemRef": {"value": "4", "name": "Sugar 50kg"}, "Qty": 5},
        },
        {"Amount": 1250.00, "DetailType": "SubTotalLineDetail", "SubTotalLineDetail": {}},
    ],
}

CREDIT_MEMO = {
    "Id": "1042",
    "TxnDate": "2026-08-09",
    "TotalAmt": 150.00,
    "CustomerRef": {"value": "12", "name": "Hodan Trading"},
    "Line": [
        {
            "Id": "1",
            "Amount": 150.00,
            "DetailType": "SalesItemLineDetail",
            "Description": "Returned — damaged",
            "SalesItemLineDetail": {"ItemRef": {"value": "3", "name": "Rice 25kg"}, "Qty": 3},
        }
    ],
}

PURCHASE = {
    "Id": "880",
    "TxnDate": "2026-08-02",
    "TotalAmt": 940.00,
    "VendorRef": {"value": "9", "name": "Bakaaraha Wholesale"},
    "Line": [
        {
            "Id": "1",
            "Amount": 800.00,
            "DetailType": "ItemBasedExpenseLineDetail",
            "Description": "Rice 25kg x 40",
            "ItemBasedExpenseLineDetail": {
                "ItemRef": {"value": "3", "name": "Rice 25kg"},
                "Qty": 40,
            },
        },
        {
            "Id": "2",
            "Amount": 140.00,
            "DetailType": "AccountBasedExpenseLineDetail",
            "Description": "Generator diesel",
            "AccountBasedExpenseLineDetail": {
                "AccountRef": {"value": "61", "name": "Electricity and generator"}
            },
        },
    ],
}


class TestQuickBooks:
    @pytest.fixture
    def batch(self):
        return quickbooks.entries_from_documents(
            {
                "Invoice": [INVOICE],
                "CreditMemo": [CREDIT_MEMO],
                "Purchase": [PURCHASE],
            }
        )

    def test_invoice_lines_become_revenue_with_the_product_on_them(self, batch):
        sales = [e for e in batch.entries if e.kind == "revenue" and e.amount > 0]
        assert sum(e.amount for e in sales) == Decimal("1250.00")
        assert {e.product for e in sales} == {"Rice 25kg", "Sugar 50kg"}
        assert sales[0].counterparty == "Hodan Trading"

    def test_a_subtotal_line_is_not_counted_a_second_time(self, batch):
        """The document totals 1,250 and contains a 1,250 subtotal line."""
        assert sum(e.amount for e in batch.entries if e.kind == "revenue") == Decimal("1100.00")

    def test_a_credit_memo_is_negative_revenue_not_an_expense(self, batch):
        credit = next(e for e in batch.entries if e.amount < 0)
        assert credit.kind == "revenue"
        assert credit.amount == Decimal("-150.00")

    def test_an_item_purchase_is_stock_and_an_account_purchase_is_an_overhead(self, batch):
        """
        The line gross margin depends on. An item-based purchase is stock
        whatever account it was posted to; an account-based one is an overhead.
        """
        stock = next(e for e in batch.entries if e.product == "Rice 25kg" and e.kind == "cogs")
        assert stock.amount == Decimal("800.00")
        overhead = next(e for e in batch.entries if e.category == "electricity")
        assert overhead.kind == "expense"
        assert overhead.amount == Decimal("140.00")

    def test_the_month_reads_correctly_end_to_end(self, batch):
        summary = summarise(batch.entries, USD, granularity="monthly")
        period = summary.current
        assert period.revenue == Decimal("1100.00")   # 1,250 sold less 150 returned
        assert period.cogs == Decimal("800.00")
        assert period.expenses == Decimal("140.00")
        assert period.net_profit == Decimal("160.00")

    def test_references_are_stable_so_a_repeated_window_is_idempotent(self):
        first = quickbooks.entries_from_documents({"Invoice": [INVOICE]})
        second = quickbooks.entries_from_documents({"Invoice": [INVOICE]})
        assert [e.source_ref for e in first.entries] == [e.source_ref for e in second.entries]
        assert first.entries[0].source_ref == "qb:Invoice:1041:1"

    def test_the_currency_code_is_used_and_not_the_currency_name(self, batch):
        assert {e.currency for e in batch.entries} == {"USD"}

    def test_a_document_with_no_readable_lines_is_kept_at_its_total(self):
        batch = quickbooks.entries_from_documents(
            {"Purchase": [{"Id": "9", "TxnDate": "2026-08-01", "TotalAmt": 60.0, "Line": []}]}
        )
        assert len(batch.entries) == 1
        assert batch.entries[0].amount == Decimal("60.0")
        assert batch.entries[0].source_ref.endswith(":total")

    def test_an_undated_document_is_skipped_with_a_reason_rather_than_dropped(self):
        batch = quickbooks.entries_from_documents({"Invoice": [{"Id": "5", "Line": []}]})
        assert batch.entries == []
        assert batch.summary()["skipped_reasons"] == {"no_dated_lines": 1}

    def test_an_unknown_entity_is_reported_not_silently_ignored(self):
        batch = quickbooks.entries_from_documents({"TimeActivity": [{}]})
        assert batch.summary()["skipped_reasons"] == {"unknown_entity": 1}


# -----------------------------------------------------------------------------
# Odoo
# -----------------------------------------------------------------------------

ACCOUNTS = {
    400: {"id": 400, "name": "Product Sales", "code": "400000", "account_type": "income"},
    500: {"id": 500, "name": "Cost of Goods Sold", "code": "500000",
          "account_type": "expense_direct_cost"},
    600: {"id": 600, "name": "Kirada dukaanka", "code": "600000", "account_type": "expense"},
    100: {"id": 100, "name": "Bank", "code": "100000", "account_type": "asset_cash"},
    200: {"id": 200, "name": "Account Payable", "code": "200000",
          "account_type": "liability_payable"},
}

MOVE_LINES = [
    # A sale: income is a credit, so Odoo stores it as a negative balance.
    {"id": 9001, "date": "2026-08-04", "name": "Rice 25kg", "debit": 0.0, "credit": 1250.0,
     "balance": -1250.0, "account_id": [400, "400000 Product Sales"],
     "partner_id": [12, "Hodan Trading"], "product_id": [3, "Rice 25kg"],
     "journal_id": [1, "Sales"], "quantity": 20.0,
     "company_currency_id": [2, "USD"]},
    # Its counterpart in the bank. Must not be counted.
    {"id": 9002, "date": "2026-08-04", "name": "Rice 25kg", "debit": 1250.0, "credit": 0.0,
     "balance": 1250.0, "account_id": [100, "100000 Bank"], "partner_id": [12, "Hodan Trading"],
     "product_id": False, "journal_id": [1, "Sales"], "quantity": 0.0,
     "company_currency_id": [2, "USD"]},
    {"id": 9003, "date": "2026-08-02", "name": "Rice 25kg", "debit": 800.0, "credit": 0.0,
     "balance": 800.0, "account_id": [500, "500000 Cost of Goods Sold"],
     "partner_id": [9, "Bakaaraha Wholesale"], "product_id": [3, "Rice 25kg"],
     "journal_id": [3, "Purchases"], "quantity": 40.0, "company_currency_id": [2, "USD"]},
    {"id": 9004, "date": "2026-08-01", "name": "Bishii Agoosto", "debit": 400.0, "credit": 0.0,
     "balance": 400.0, "account_id": [600, "600000 Kirada dukaanka"], "partner_id": False,
     "product_id": False, "journal_id": [4, "Miscellaneous"], "quantity": 0.0,
     "company_currency_id": [2, "USD"]},
    # A refund: income debited, so a positive balance on an income account.
    {"id": 9005, "date": "2026-08-09", "name": "Returned — damaged", "debit": 150.0,
     "credit": 0.0, "balance": 150.0, "account_id": [400, "400000 Product Sales"],
     "partner_id": [12, "Hodan Trading"], "product_id": [3, "Rice 25kg"],
     "journal_id": [1, "Sales"], "quantity": -3.0, "company_currency_id": [2, "USD"]},
]


class TestOdoo:
    @pytest.fixture
    def batch(self):
        return odoo.entries_from_move_lines(MOVE_LINES, ACCOUNTS)

    def test_only_income_and_expense_accounts_reach_the_ledger(self, batch):
        """
        The balance-sheet side of every posting is the majority of the rows.
        Counting them would double or triple every figure in the report.
        """
        assert len(batch.entries) == 4
        assert all("Bank" not in e.account for e in batch.entries)

    def test_the_sign_is_flipped_for_income_so_revenue_reads_positive(self, batch):
        sale = next(e for e in batch.entries if e.source_ref == "odoo:aml:9001")
        assert sale.kind == "revenue"
        assert sale.amount == Decimal("1250.0")

    def test_a_debit_to_an_income_account_is_a_refund_and_stays_negative(self, batch):
        refund = next(e for e in batch.entries if e.source_ref == "odoo:aml:9005")
        assert refund.kind == "revenue"
        assert refund.amount == Decimal("-150.0")

    def test_direct_cost_accounts_are_stock_and_other_expenses_are_overheads(self, batch):
        assert next(e for e in batch.entries if e.source_ref == "odoo:aml:9003").kind == "cogs"
        rent = next(e for e in batch.entries if e.source_ref == "odoo:aml:9004")
        assert rent.kind == "expense"
        # The account is named in Somali, and it is classified as rent anyway.
        assert rent.category == "rent"

    def test_the_month_reads_correctly_end_to_end(self, batch):
        summary = summarise(batch.entries, USD, granularity="monthly")
        period = summary.current
        assert period.revenue == Decimal("1100.0")
        assert period.cogs == Decimal("800.0")
        assert period.expenses == Decimal("400.0")
        assert period.net_profit == Decimal("-100.0")

    def test_both_odoo_field_conventions_are_understood(self):
        modern = odoo.direction_for({"account_type": "expense_direct_cost"})
        legacy = odoo.direction_for({"internal_group": "expense"})
        assert modern == "cogs"
        assert legacy == "expense"
        assert odoo.direction_for({"account_type": "asset_current"}) is None

    def test_a_line_with_no_balance_falls_back_to_debit_minus_credit(self):
        batch = odoo.entries_from_move_lines(
            [{"id": 1, "date": "2026-08-01", "debit": 0.0, "credit": 90.0,
              "account_id": [400, "Sales"]}],
            ACCOUNTS,
        )
        assert batch.entries[0].amount == Decimal("90.0")

    def test_an_undated_line_is_skipped_with_a_reason(self):
        batch = odoo.entries_from_move_lines(
            [{"id": 1, "balance": -10.0, "account_id": [400, "Sales"]}], ACCOUNTS
        )
        assert batch.entries == []
        assert batch.summary()["skipped_reasons"] == {"no_date": 1}


class TestOdooAddressGuard:
    """
    The worker holds the service-role key and sits on a host that can reach
    things a customer cannot. The Odoo address is customer-supplied, so it is
    the one input in this feature that could be pointed back at us.
    """

    def test_a_public_https_address_is_accepted(self):
        assert odoo.check_base_url("https://acme.odoo.com/") == "https://acme.odoo.com"

    def test_cloud_metadata_and_loopback_are_refused(self):
        for address in (
            "https://169.254.169.254/",
            "https://127.0.0.1:8069/",
            "https://10.0.0.5/",
            "https://192.168.1.10/",
        ):
            with pytest.raises(odoo.OdooError):
                odoo.check_base_url(address)

    def test_plain_http_is_refused_unless_deliberately_allowed(self):
        with pytest.raises(odoo.OdooError) as error:
            odoo.check_base_url("http://acme.odoo.com/")
        assert "clear text" in str(error.value)
        assert (
            odoo.check_base_url("http://acme.odoo.com/", allow_plain_http=True)
            == "http://acme.odoo.com"
        )

    def test_a_non_http_scheme_is_refused(self):
        for address in ("file:///etc/passwd", "gopher://x/", "ftp://acme.odoo.com/"):
            with pytest.raises(odoo.OdooError):
                odoo.check_base_url(address)


class TestCredentialErrors:
    """A missing credential must read as a sentence, not a KeyError at 3am."""

    def test_quickbooks_says_what_is_missing(self):
        with pytest.raises(quickbooks.QuickBooksError) as error:
            quickbooks.QuickBooksClient(
                client_id="a", client_secret="b", refresh_token="", realm_id="d"
            )
        assert "refresh token" in str(error.value)

    def test_odoo_says_what_is_missing(self):
        with pytest.raises(odoo.OdooError) as error:
            odoo.OdooClient(base_url="https://a.odoo.com", database="", username="u", api_key="k")
        assert "database name" in str(error.value)
