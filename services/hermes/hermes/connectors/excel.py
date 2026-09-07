"""
The spreadsheet connector.

Most Somali retailers and warehouses keep their books in Excel, and the
spreadsheet is not a clean export -- it is a working document with a title
block, merged cells, a subtotal in the middle and a TOTAL at the bottom. That
problem is already solved in this codebase, so this module does not solve it
again: it hands the bytes to `tools.parse.parse_workbook`, which finds the
table, decides the header row, resolves DD/MM against MM/DD across the whole
column and reports its confidence.

What is left is the part that is specific to a store ledger: deciding which of
the parsed columns is the date, which is the money, and which says whether a
row is a sale or a cost. Three sheet shapes cover almost everything seen in
practice, and this module reads all three:

  1. **Signed ledger** -- one amount column, sales positive, costs negative.
  2. **Two-column** -- an "Income" column and an "Expenses" column side by side,
     both positive, at most one filled per row.
  3. **Typed ledger** -- one amount column and a "Type" column reading Sale,
     Purchase, Rent, Salary, and so on.

Detection is by header name in English and Somali, and it is overridable: a
connection may carry an explicit `column_map`, and when it does, that is used
without any guessing at all. Guessing is for the first sync, when nobody has
told us anything yet; once a shop has confirmed its mapping the report must not
change because somebody renamed a column.
"""

from __future__ import annotations

import datetime as dt
import logging
from decimal import Decimal
from typing import Any

from ..tools.parse import ParsedTable, parse_workbook
from ..tools.values import is_null_token, normalize_text, parse_date
from .ledger import (
    EntryKind,
    LedgerBatch,
    LedgerEntry,
    LedgerError,
    classify_account,
    to_decimal,
)

log = logging.getLogger("hermes.connectors.excel")

# Header keywords, English and Somali, most specific first within each role.
_DATE_HEADERS = ("date", "day", "taariikh", "taariikhda", "maalin")
_AMOUNT_HEADERS = ("amount", "total", "value", "net", "qiimo", "qiimaha", "wadar", "lacag")
_INCOME_HEADERS = ("income", "sales", "revenue", "credit", "in", "dakhli", "iib", "iibka", "soo gal")
_EXPENSE_HEADERS = ("expense", "expenses", "cost", "purchase", "debit", "out",
                    "kharash", "kharashaad", "iibsi", "bixin")
_TYPE_HEADERS = ("type", "kind", "category", "account", "nooc", "qaybta", "akoon")
_DESCRIPTION_HEADERS = ("description", "details", "narration", "note", "memo",
                        "sharaxaad", "faahfaahin")
_PRODUCT_HEADERS = ("product", "item", "goods", "sku", "alaab", "badeeco", "shay")
_QUANTITY_HEADERS = ("quantity", "qty", "units", "tirada", "xaddiga")
_CURRENCY_HEADERS = ("currency", "ccy", "lacagta")
_LOCATION_HEADERS = ("branch", "store", "shop", "location", "warehouse",
                     "laanta", "dukaanka", "bakhaarka")
_COUNTERPARTY_HEADERS = ("customer", "supplier", "vendor", "client", "party",
                         "macmiil", "alaab-qeybiye", "iibiye")

# Values a "Type" column uses to mean revenue. Everything else in such a column
# is treated as a cost and then classified by name, which is the right default:
# a shop's type vocabulary lists its cost lines in detail and its income in one
# or two words.
_REVENUE_TYPES = (
    "sale", "sales", "revenue", "income", "invoice", "receipt", "pos", "cash sale",
    "iib", "iibka", "dakhli",
)
_COGS_TYPES = ("purchase", "purchases", "stock", "goods", "cogs", "cost of sales",
               "iibsi", "alaab", "badeeco")


def _match(header: str, keywords: tuple[str, ...]) -> bool:
    text = header.lower().strip()
    if not text:
        return False
    return any(text == word or word in text.split() or text.startswith(word) for word in keywords)


def _find(headers: dict[str, str], keywords: tuple[str, ...]) -> str | None:
    """
    The first column whose header matches, preferring an exact match.

    Two passes rather than one because "Total" and "Total Cost" both match the
    amount keywords, and in a sheet that has both, the bare one is the row total
    and the other is a component. Taking the exact match first gets that right
    without a rule about it.
    """
    for name, header in headers.items():
        if header.lower().strip() in keywords:
            return name
    for name, header in headers.items():
        if _match(header, keywords):
            return name
    return None


class ColumnMap(dict):
    """A resolved mapping from role to column name. A dict so it serialises."""


def detect_columns(table: ParsedTable, override: dict[str, Any] | None = None) -> ColumnMap:
    """
    Decide which parsed column plays which role.

    An override is applied first and completely: a role named there is taken as
    given even if the header looks like something else, because a person who
    opened the mapping screen and chose a column knows their sheet better than a
    keyword table does. Roles the override omits are still detected.
    """
    headers = {
        column.name: column.source_header or column.name
        for column in table.interpretation.columns
    }
    available = set(headers)

    resolved = ColumnMap()
    for role, value in (override or {}).items():
        if isinstance(value, str) and value in available:
            resolved[role] = value
        elif isinstance(value, str) and value:
            raise LedgerError(
                f"the column map names {value!r} for {role}, which is not a column in this "
                f"sheet. Columns found: {', '.join(sorted(available))}."
            )

    remaining = {name: header for name, header in headers.items() if name not in resolved.values()}

    def fill(role: str, keywords: tuple[str, ...]) -> None:
        if role in resolved:
            return
        found = _find(remaining, keywords)
        if found:
            resolved[role] = found
            remaining.pop(found, None)

    # Income and expense first: in a two-column sheet those headers would also
    # satisfy the generic amount keywords, and letting `amount` claim one of
    # them first would turn a two-column sheet into a broken signed one.
    fill("income", _INCOME_HEADERS)
    fill("expense", _EXPENSE_HEADERS)
    fill("date", _DATE_HEADERS)
    fill("amount", _AMOUNT_HEADERS)
    fill("type", _TYPE_HEADERS)
    fill("product", _PRODUCT_HEADERS)
    fill("quantity", _QUANTITY_HEADERS)
    fill("currency", _CURRENCY_HEADERS)
    fill("location", _LOCATION_HEADERS)
    fill("counterparty", _COUNTERPARTY_HEADERS)
    fill("description", _DESCRIPTION_HEADERS)

    if "date" not in resolved:
        # Fall back to whatever the parser typed as a date. A column headed
        # "Waqti" with nine parsed dates in it is the date column whatever this
        # module's keyword list says.
        dates = [c.name for c in table.interpretation.columns if c.inferred_type == "date"]
        if dates:
            resolved["date"] = dates[0]

    if "amount" not in resolved and "income" not in resolved and "expense" not in resolved:
        numbers = [
            c.name
            for c in table.interpretation.columns
            if c.inferred_type == "number" and c.name != resolved.get("quantity")
        ]
        if numbers:
            resolved["amount"] = numbers[0]

    return resolved


def shape_of(columns: ColumnMap) -> str:
    if "income" in columns or "expense" in columns:
        return "two_column"
    if "type" in columns:
        return "typed"
    return "signed"


def _cell(table: ParsedTable, column: str | None, index: int) -> Any:
    if not column:
        return None
    values = table.columns.get(column)
    if values is None or index >= len(values):
        return None
    return values[index]


def _date(table: ParsedTable, column: str | None, index: int) -> dt.date | None:
    """
    The date in a cell the parser has already typed.

    `parse_workbook` writes a date column back as ISO strings rather than as
    date objects -- it has already resolved DD/MM against MM/DD across the whole
    column, and the string is that decision made permanent. So the common path
    here is `date.fromisoformat`, and the object cases below are for a sheet
    whose column the parser typed as something else and a caller mapped to the
    date role by hand.
    """
    value = _cell(table, column, index)
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return dt.date.fromisoformat(value.strip()[:10])
        except ValueError:
            parsed = parse_date(value)
            return parsed.value
    return None


def _text(table: ParsedTable, column: str | None, index: int) -> str:
    value = _cell(table, column, index)
    if value is None or is_null_token(value):
        return ""
    return normalize_text(value)


def entries_from_table(
    table: ParsedTable,
    *,
    columns: ColumnMap,
    default_currency: str = "USD",
    batch: LedgerBatch | None = None,
) -> LedgerBatch:
    """
    Turn one parsed table into ledger entries.

    Separate from `fetch` so it is testable against a workbook with no
    connection, no database and no network -- which is how the sheet shapes
    above are actually verified.
    """
    result = batch or LedgerBatch(source="excel")
    shape = shape_of(columns)

    if "date" not in columns:
        raise LedgerError(
            "no date column was found in this sheet. A store ledger needs one column of "
            "dates; name it Date or Taariikh, or set it in the connection's column map."
        )
    if shape == "signed" and "amount" not in columns:
        raise LedgerError(
            "no amount column was found in this sheet. Name one Amount, Total or Qiimaha, "
            "or set it in the connection's column map."
        )

    for index in range(table.row_count):
        source_row = table.source_rows[index]
        occurred = _date(table, columns.get("date"), index)
        if occurred is None:
            result.skip("no_date", f"row {source_row}")
            continue

        account = _text(table, columns.get("type"), index)
        description = _text(table, columns.get("description"), index)
        currency = (_text(table, columns.get("currency"), index) or default_currency).upper()
        product = _text(table, columns.get("product"), index)
        location = _text(table, columns.get("location"), index)
        counterparty = _text(table, columns.get("counterparty"), index)
        quantity = to_decimal(_cell(table, columns.get("quantity"), index))

        for amount, hint in _amounts_for(table, columns, index, shape):
            if amount is None or amount == 0:
                continue
            category, kind, confidence = classify_account(
                account or description or _fallback_account(hint), description, hint
            )
            result.entries.append(
                LedgerEntry(
                    occurred_on=occurred,
                    kind=kind,
                    category=category,
                    # Magnitude on the entry, direction in the kind. A cost
                    # written as -450 and a cost written as 450 in an "Expenses"
                    # column are the same fact, and the report must not be able
                    # to tell them apart.
                    amount=abs(amount) if hint != "revenue" else amount,
                    currency=currency,
                    account=account,
                    description=description,
                    # The sheet row is the reference. It is what a shopkeeper
                    # would look up, and it makes a re-sync of the same file
                    # idempotent.
                    source_ref=f"row:{source_row}:{hint}",
                    product=product,
                    location=location,
                    counterparty=counterparty,
                    quantity=quantity,
                    classified_by=confidence,
                )
            )

    if not result.entries:
        result.warnings.append(
            "no usable rows were found in this sheet: every row was missing a date or an amount"
        )

    dates = [entry.occurred_on for entry in result.entries]
    if dates:
        result.window_start = min(dates)
        result.window_end = max(dates)
    return result


def _fallback_account(hint: EntryKind | None) -> str:
    return "sales" if hint == "revenue" else ""


def _amounts_for(
    table: ParsedTable, columns: ColumnMap, index: int, shape: str
) -> list[tuple[Decimal | None, EntryKind | None]]:
    """
    The (amount, direction hint) pairs a single sheet row contributes.

    A two-column sheet can contribute two entries from one row -- a day that
    took $300 and spent $40 on transport is two facts, and collapsing them to
    $260 destroys both the revenue figure and the cost figure. Every other shape
    contributes exactly one.
    """
    if shape == "two_column":
        pairs: list[tuple[Decimal | None, EntryKind | None]] = []
        income = to_decimal(_cell(table, columns.get("income"), index))
        expense = to_decimal(_cell(table, columns.get("expense"), index))
        if income is not None and income != 0:
            pairs.append((income, "revenue"))
        if expense is not None and expense != 0:
            pairs.append((expense, "expense"))
        return pairs

    amount = to_decimal(_cell(table, columns.get("amount"), index))
    if amount is None:
        return []

    if shape == "typed":
        label = _text(table, columns.get("type"), index).lower()
        # Cost first, and the order is load-bearing rather than stylistic.
        # Somali derives the word for buying from the word for selling: `iib` is
        # a sale and `iibsi` is a purchase, so a revenue test that merely looks
        # for "iib" matches both. Tested the other way round, an electronics
        # shop's stock purchases were booked as sales -- which reported no cost
        # of goods at all, a gross margin of 100%, and the Dubai wholesaler as
        # its biggest customer.
        if any(word in label for word in _COGS_TYPES):
            return [(amount, "cogs")]
        if any(word in label for word in _REVENUE_TYPES):
            return [(amount, "revenue")]
        return [(amount, "expense")]

    # Signed: the sign is the whole statement. Positive is money in.
    return [(amount, "revenue" if amount > 0 else "expense")]


def fetch(
    data: bytes,
    filename: str,
    *,
    column_map: dict[str, Any] | None = None,
    default_currency: str = "USD",
    sheet: str | None = None,
) -> tuple[LedgerBatch, ColumnMap]:
    """
    Read a workbook's bytes into a ledger batch.

    Returns the resolved column map alongside the entries so the sync can store
    it on the connection: the second month should not re-guess what the first
    month worked out, and a mapping that is written down is a mapping a
    shopkeeper can correct.
    """
    try:
        parsed = parse_workbook(data, filename)
    except ValueError as error:
        # `parse_workbook` raises a bare ValueError for a file it cannot find a
        # table in -- a sheet with headers and no rows yet, most often, which is
        # an ordinary thing for a shop to have. Letting it through as-is would
        # reach the worker's catch-all and reach the shopkeeper as "the agent
        # hit an unexpected error", which is both frightening and useless.
        raise LedgerError(
            f"{filename} could not be read as a store ledger: {error}"
        ) from error

    table = parsed.primary
    if sheet:
        matches = [t for t in parsed.tables if t.interpretation.sheet_name == sheet]
        if not matches:
            names = ", ".join(t.interpretation.sheet_name for t in parsed.tables)
            raise LedgerError(f"this workbook has no sheet named {sheet!r}. It has: {names}.")
        table = matches[0]

    columns = detect_columns(table, column_map)
    batch = LedgerBatch(source="excel")
    batch.warnings.extend(parsed.warnings)
    entries_from_table(
        table, columns=columns, default_currency=default_currency, batch=batch
    )
    return batch, columns


__all__ = ["ColumnMap", "detect_columns", "entries_from_table", "fetch", "shape_of"]
