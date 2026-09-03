"""
The legacy .xls format.

This used to be a refusal. The upload path accepted `.xls`, the parser then
answered "re-save the workbook as .xlsx" — which is a reasonable sentence and a
terrible thing to meet in a demo, because the customer exporting from an older
system is exactly the customer whose data is worst and who needs this most.

What is asserted here is not "xlrd works" — that is xlrd's job. It is that an
.xls grid is **indistinguishable from an .xlsx grid** by the time the rest of the
parser sees it. Every difference between the two readers is a type-inference bug
that surfaces later, reported against a column rather than against the reader.

The fixture is committed rather than generated, so this suite needs no writer
library. Rebuild it with `python scripts/make_messy_fixture.py`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes.tools.parse import parse_workbook, read_grids
from hermes.tools.profile import profile_table

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures" / "messy"
LEGACY = FIXTURES / "acme-sales-2026-08.xls"


@pytest.fixture(scope="module")
def parsed():
    return parse_workbook(LEGACY.read_bytes(), LEGACY.name)


# ---------------------------------------------------------------------------
# It parses at all
# ---------------------------------------------------------------------------


def test_a_legacy_xls_is_no_longer_refused(parsed):
    # The regression this file exists for.
    assert parsed.primary.row_count > 0


def test_the_structure_detector_works_the_same_on_xls(parsed):
    # Title block above, header below it, and the detector finds the header
    # rather than reading "ACME TRADING LTD" as a column name.
    table = parsed.primary
    assert set(table.columns) >= {"date", "invoice", "supplier", "net_sales", "vat", "paid"}
    assert "acme_trading_ltd" not in table.columns


def test_the_trailing_total_row_is_not_a_transaction(parsed):
    # Four transactions and a TOTAL. Counting the total would double the month.
    assert parsed.primary.row_count == 4
    assert "TOTAL" not in parsed.primary.columns["supplier"]


def test_a_hidden_sheet_is_not_parsed_as_the_main_table(parsed):
    # Same rule the .xlsx reader follows: a hidden sheet is usually a lookup
    # table or last month's numbers.
    assert [table.interpretation.sheet_name for table in parsed.tables] == ["August"]


# ---------------------------------------------------------------------------
# The conversions that make an .xls grid look like an .xlsx grid
# ---------------------------------------------------------------------------


def test_dates_arrive_as_dates_and_not_as_floats(parsed):
    # The one that would be silently wrong. xlrd hands back a float plus a
    # workbook epoch; left alone it would be inferred as money and the column
    # would become a set of five-digit numbers that sum to something.
    profile = profile_table(parsed.primary)
    date_column = next(column for column in profile.columns if column.name == "date")

    assert date_column.inferred_type == "date"
    assert date_column.is_money is False
    assert parsed.primary.columns["date"][:2] == ["2026-08-03", "2026-08-07"]


def test_money_columns_are_still_recognised_as_money(parsed):
    profile = profile_table(parsed.primary)
    money = {column.name for column in profile.columns if column.is_money}
    assert {"net_sales", "vat"} <= money
    assert parsed.primary.columns["net_sales"][0] == 1240.50


def test_a_formula_error_cell_becomes_absent_rather_than_a_number(parsed):
    # `1/0` in a spreadsheet is `#DIV/0!`. xlrd reports error code 7. Returning
    # the code would put the number 7 in a boolean column and infer the whole
    # column as numeric.
    assert 7 not in parsed.primary.columns.get("paid", [])


def test_the_totals_reconcile_check_runs_on_xls_too(parsed):
    # The single most valuable finding in a demo has to work on this format as
    # well: the file's own TOTAL row is compared against the rows above it.
    signals = profile_table(parsed.primary).signals["declared_totals"]
    assert signals["checked"] is True


# ---------------------------------------------------------------------------
# Failure behaviour
# ---------------------------------------------------------------------------


def test_a_corrupt_xls_fails_with_a_sentence_a_person_can_act_on():
    # ValueError from the parser is always a message written for a human -- the
    # worker turns it into a JobError and shows it verbatim.
    with pytest.raises(ValueError, match="password-protected or damaged"):
        read_grids(b"\xd0\xcf\x11\xe0 not really a workbook", "broken.xls")


def test_an_unknown_extension_still_names_what_is_accepted():
    with pytest.raises(ValueError, match=r"\.xlsx, \.xlsm, \.xls or \.csv"):
        read_grids(b"whatever", "report.pdf")


# ---------------------------------------------------------------------------
# The point of the whole exercise
# ---------------------------------------------------------------------------


def test_an_xls_and_an_xlsx_of_the_same_shape_agree_on_their_signature():
    """
    A recipe learned from one format replays against the other.

    `source_signature` is a fingerprint of the file's *shape* — column names,
    types, header position — and it is what matches an upload to a recipe. If
    the two readers disagreed about any of that, a customer who switched from
    .xls to .xlsx mid-year would silently stop matching their own recipe and be
    asked to approve everything again.
    """
    import io

    from openpyxl import Workbook

    # The same table, written as .xlsx: same headers, same types, same header
    # row, different transactions.
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "August"
    sheet.append(["ACME TRADING LTD"])
    sheet.append(["Sales ledger — August 2026"])
    sheet.append([])
    sheet.append(["Date", "Invoice", "Supplier", "Net Sales", "VAT", "Paid"])

    import datetime as dt

    for index, (day, net, vat) in enumerate(
        [(4, 1500.00, 300.00), (8, 725.50, 145.10), (14, 2210.00, 442.00), (22, 980.75, 196.15)],
        start=1,
    ):
        sheet.append(
            [dt.datetime(2026, 8, day), f"INV-20{index:02d}", "Contoso Ltd", net, vat, True]
        )

    buffer = io.BytesIO()
    workbook.save(buffer)

    from_xlsx = parse_workbook(buffer.getvalue(), "August.xlsx")
    from_xls = parse_workbook(LEGACY.read_bytes(), LEGACY.name)

    assert from_xls.source_signature == from_xlsx.source_signature
