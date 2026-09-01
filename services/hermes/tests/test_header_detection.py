"""
Finding the header row.

The fixture tests cover the accounting shape this was designed for: a title
block, a blank line, then a header over typed columns. This file covers the
shape that broke it.

A survey export has no typed columns to contrast against -- names, phone
numbers written as text, neighbourhoods, free answers -- and its headers are the
questions, which run well past the sixty characters a label is allowed. Both
halves of the original heuristic therefore pointed the wrong way at once: the
real header scored 0.40 on "looks like labels" while a row of short human
answers scored 0.88.

On a real file that meant the nineteenth respondent's answers became the column
names and the eighteen rows above her were discarded as though they sat above
the table. 204 rows in, 186 out, and nothing anywhere said so.

The signal that fixes it is contrast with the column rather than the shape of
the cell: a header does not resemble the values underneath it, and a data row
resembles them exactly, because it is one of them.
"""

from __future__ import annotations

import datetime as dt

from hermes.tools.parse import _column_contrast, detect_table, find_header_row


def _survey_grid() -> list[list[object]]:
    """
    A form export: long questions on top, short answers beneath.

    Deliberately built so every column is text. That is what removes the typed
    contrast the original scorer leaned on.
    """
    header = [
        "Timestamp",
        "1. What is your full name?",
        "2. Which neighbourhood do you currently live in, including the district?",
        "3. Do you have any specific training or certification relating to the role "
        "you have selected above?",
        "4. Are you willing to formally join the project protocol team and attend "
        "the regular training sessions?",
    ]
    answers = [
        ["2026-08-17 19:51:17", "Farxiya qorane cabdi", "Hodn hilis", "Haa", "Haa"],
        ["2026-08-17 19:54:11", "Amoun saed ahmed", "Jig jiga yar", "Maya", "Haa"],
        ["2026-08-17 19:54:24", "Hapi mowlid cali", "Jigjiga yar", "Haa", "Maya"],
        ["2026-08-17 20:01:02", "Sumaya mohmed ahmed", "Hodan", "Haa", "Haa"],
        ["2026-08-17 20:17:30", "Bushra Ali sahal muuse", "Jigjiga yar", "Maya", "Haa"],
        ["2026-08-17 20:20:23", "Rahma Xasan cabdilaahi", "Hodan", "Haa", "Haa"],
        ["2026-08-17 20:22:30", "Saamiya yuusuf adam", "Jig jiga yar", "Haa", "Maya"],
        ["2026-08-17 20:31:44", "Nimco cabdi warsame", "Hodan", "Maya", "Haa"],
    ]
    return [header, *answers]


def test_the_questions_are_the_header_not_the_first_respondent():
    """The whole bug, in one assertion."""
    grid = _survey_grid()

    index, score, reasons = find_header_row(grid)

    assert index == 0, (
        f"picked row {None if index is None else index + 1} instead of the questions; "
        f"reasons={reasons}"
    )
    assert score > 0


def test_a_long_question_still_counts_as_a_header():
    """
    Three of the five headers here are past the sixty-character ceiling that
    disqualifies a cell from looking like a label. The row has to win anyway.
    """
    grid = _survey_grid()
    long_ones = [cell for cell in grid[0] if len(str(cell)) > 60]

    assert len(long_ones) >= 3, "fixture no longer exercises the case it exists for"
    assert find_header_row(grid)[0] == 0


def test_a_header_does_not_resemble_its_own_column():
    grid = _survey_grid()
    assert _column_contrast(grid, 0) > 0.5


def test_a_data_row_resembles_the_rows_beneath_it():
    """The other half: a respondent must score low, or she can still win."""
    grid = _survey_grid()
    # Row 4 has four rows beneath it, enough for the comparison to run.
    assert _column_contrast(grid, 4) < 0.3


def test_a_title_block_is_still_not_a_header():
    """
    The case the original heuristic was built for, which must not regress.

    Free text above a typed table is a title, not a header -- and the header
    below it is the row that should win.
    """
    grid: list[list[object]] = [
        ["ACME Ltd", None, None, None],
        ["Sales ledger extract", None, None, None],
        [None, None, None, None],
        ["Date", "Vendor", "Net", "VAT"],
        ["2026-08-01", "ACME Ltd", 1250.5, 250.1],
        ["2026-08-02", "Globex", 980.0, 196.0],
        ["2026-08-03", "Initech", 415.25, 83.05],
        ["2026-08-04", "ACME Ltd", 1120.0, 224.0],
        ["2026-08-05", "Globex", 640.75, 128.15],
    ]

    index, _score, _reasons = find_header_row(grid)

    assert index == 3, f"expected the Date/Vendor/Net/VAT row, got row {index}"


def _bank_export_grid() -> list[list[object]]:
    """
    A real bank export: an account title over a header with unused columns.

    The shape that matters is the width mismatch. The bank labels every column
    its format defines -- eighteen of them -- and fills in the six that apply to
    a cash account, so the header is three times wider than its own data. The
    title above it is two cells wide.
    """
    return [
        ["123456789 - CASH MANAGEMENT ACCOUNT", "ABC Super Fund", *[None] * 5],
        ["Date", "Category", "Description", "Debit", "Credit", "Balance", "ASX Code"],
        ["2017-04-28", "DEPOSIT", "MACQUARIE CMA INTEREST", None, 0.02, "$3.08 CR", None],
        ["2017-04-18", "WITHDRAWAL", "BPAY To ASIC", 47, None, "$3.06 CR", None],
        ["2017-03-31", "DEPOSIT", "MACQUARIE CMA INTEREST", None, 0.05, "$50.06 CR", None],
        ["2017-02-28", "DEPOSIT", "MACQUARIE CMA INTEREST", None, 0.01, "$50.01 CR", None],
        ["2017-02-20", "DEPOSIT", "Trustee Non- Con Contr", None, 50, "$50.00 CR", None],
    ]


def test_a_header_wider_than_its_data_still_wins():
    """
    The bug this exists for, and it cost a customer their upload.

    Width agreement was computed with abs(), so a header spanning *more* columns
    than its body was punished exactly as hard as one spanning fewer. Eighteen
    labels over six used columns scored 0.0 for width; the two-cell account
    title above scored 0.333 and took the row by two hundredths.

    The file then parsed with 'ABC Super Fund' as a column name and the real
    header as its first row of data, and the categorise job refused it with
    'we could not find a column of transaction descriptions'.
    """
    grid = _bank_export_grid()

    index, _score, reasons = find_header_row(grid)

    assert index == 1, (
        f"picked row {None if index is None else index + 1} -- the account title, "
        f"not the header; reasons={reasons}"
    )


def test_the_account_title_above_it_loses():
    """The other side of the same comparison, stated directly."""
    grid = _bank_export_grid()

    title_width = len([cell for cell in grid[0] if cell is not None])
    header_width = len([cell for cell in grid[1] if cell is not None])

    assert title_width == 2 and header_width == 7, "fixture no longer has the width gap"
    assert find_header_row(grid)[0] != 0


# =============================================================================
# Amounts that arrive as bare numbers
# =============================================================================


def _deposits_grid() -> list[list[object]]:
    """A deposits table whose amounts are whole pounds."""
    return [
        ["Deposit No.", "Date", "Amount", "Description", "Reconciled"],
        [1, dt.date(2013, 6, 2), 1500, "job 1, check 1", "yes"],
        [2, dt.date(2013, 6, 15), 1200, "job 2, check 1", "yes"],
        [3, dt.date(2013, 6, 16), 1500, "job 1, check 2", "yes"],
        [4, dt.date(2013, 6, 20), 1200, "job 2, check 2", "yes"],
    ]


def test_whole_pound_amounts_do_not_become_dates():
    """
    `parse_date` reads any bare integer from 61 to 60000 as an Excel serial, and
    that range is most of the money on a bank statement. Dates won ties against
    numbers, so a deposits column of 1500, 1200, 1500 was typed `date` and left
    the pipeline as 1904-02-08, 1903-04-14, 1904-02-08.

    Nothing failed. The export just had plausible dates where the amounts should
    have been, in a file an accountant files a return from.

    Excel hands openpyxl a real `datetime` for anything it has formatted as a
    date, so a column whose every date hit came from a bare number is one Excel
    itself does not treat as dates.
    """
    interpretation, _skipped = detect_table(_deposits_grid(), "Deposits")
    types = {column.name: column.inferred_type for column in interpretation.columns}

    assert types["amount"] == "number", (
        f"the amount column was typed {types['amount']!r}; whole-pound amounts "
        "have been read as Excel serials again"
    )


def test_a_real_date_column_is_still_a_date():
    """The tie-break the exception must not undo."""
    interpretation, _skipped = detect_table(_deposits_grid(), "Deposits")
    types = {column.name: column.inferred_type for column in interpretation.columns}

    assert types["date"] == "date"


def test_a_serial_column_named_like_a_date_is_still_a_date():
    """
    The one case where reading a bare number as a serial was right all along: a
    column labelled `Date` that arrived as raw serials because the exporter
    never formatted it. The header gets the deciding vote.
    """
    grid: list[list[object]] = [
        ["Date", "Payee", "Amount"],
        [42000, "ACME Ltd", 1500],
        [42010, "Globex", 1200],
        [42020, "Initech", 1500],
        [42030, "ACME Ltd", 1200],
    ]

    interpretation, _skipped = detect_table(grid, "Ledger")
    types = {column.name: column.inferred_type for column in interpretation.columns}

    assert types["date"] == "date"
    assert types["amount"] == "number"
