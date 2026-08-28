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

from hermes.tools.parse import _column_contrast, find_header_row


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
