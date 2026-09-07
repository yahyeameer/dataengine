"""
The one row shape every store connector produces.

A retail business in Mogadishu keeps its books in one of three places: a
spreadsheet somebody maintains by hand, a QuickBooks Online company, or an Odoo
instance a local integrator set up. Those three disagree about almost
everything -- what a line is called, which sign a refund carries, whether a
purchase is an expense or stock, what currency a number is in -- and the
reporting engine must not have to know any of it.

So each connector's whole job is to end at `LedgerEntry`: one dated, signed,
classified, currency-tagged amount with a reference back to the row or record
it came from. Everything after this module -- period rollups, margins, the
report in Somali or English -- reads only these, and is therefore identical
whether the shop exports XLSX or runs Odoo.

Two decisions here are load-bearing.

**Sign is normalised, kind is not inferred from sign.** Every entry carries a
positive `amount` for the ordinary case and a negative one only for a genuine
reversal -- a refund against revenue, a credit note against a purchase. A
refund is therefore *revenue of a negative amount*, not an expense, so a month
with heavy returns reports lower sales rather than inflated costs. QuickBooks
and Odoo each express that differently and each connector fixes it before this
type exists.

**Classification is evidence, not a guess dressed as fact.** `category` is
derived from the source system's own account name by the keyword table below,
and `classified_by` records whether that match was confident, weak or absent.
An unmatched line lands in `other_expense` and says so, which is what lets the
report show "$4,120 of costs we could not categorise" instead of silently
burying them in a bucket that looks deliberate.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Literal

# Revenue and COGS are separated from operating expenses because gross margin is
# the number a shopkeeper actually manages. "Profit" with stock purchases mixed
# into overheads tells them nothing about whether their pricing works.
EntryKind = Literal["revenue", "cogs", "expense", "other"]

Confidence = Literal["matched", "weak", "unmatched"]


# -----------------------------------------------------------------------------
# The category vocabulary.
#
# Deliberately shaped for Somali retail and warehousing rather than borrowed
# from a UK or US chart of accounts, because the cost lines that dominate here
# are not the ones those charts make room for.
#
# `electricity` is its own category and not a child of "utilities": most shops
# and warehouses buy power from a private generator company by the kilowatt or
# run their own, and it is frequently the largest controllable cost after stock.
# `security` is a routine monthly line, not an exception. `remittance_fees`
# exists because money moves by hawala and the transfer fee is a real cost of
# every supplier payment. `customs_duty` and `municipal_tax` are separated
# because they are levied by different authorities on different events, and a
# report that merges them cannot answer the question an importer is asking.
#
# Keywords are matched in both English and Somali. A shop whose spreadsheet
# column reads "Kiro dukaanka" gets the same report as one that reads "Shop
# rent", which is the difference between this being usable in Mogadishu and
# being a translation of something that is not.
# -----------------------------------------------------------------------------

CATEGORY_KINDS: dict[str, EntryKind] = {
    "sales": "revenue",
    "wholesale": "revenue",
    "services": "revenue",
    "other_income": "revenue",
    "purchases": "cogs",
    "freight_in": "cogs",
    "customs_duty": "cogs",
    "inventory_adjustment": "cogs",
    "rent": "expense",
    "salaries": "expense",
    "electricity": "expense",
    "water": "expense",
    "security": "expense",
    "transport": "expense",
    "communications": "expense",
    "remittance_fees": "expense",
    "bank_charges": "expense",
    "municipal_tax": "expense",
    "marketing": "expense",
    "repairs": "expense",
    "supplies": "expense",
    "insurance": "expense",
    "zakat_and_sadaqa": "expense",
    "other_expense": "expense",
}

# Ordered: the first category whose keyword appears wins, so the specific
# entries come before the general ones. "freight in" must beat "transport" and
# "generator fuel" must beat "supplies", which is only true because of where
# they sit in this list.
# Somali marks the definite article as a suffix that changes the final vowel --
# `koronto` becomes `korontada`, `kiro` becomes `kirada` -- so a keyword list
# written in dictionary forms matches almost nothing a shopkeeper actually types
# in a column. The Somali entries below are therefore stems, chosen long enough
# that no English accounting word contains them, and the forms with suffixes are
# listed where the stem would be too short to be safe.
_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("freight_in", ("freight", "shipping", "carriage", "xamuul", "raradd", "rarid")),
    ("customs_duty", ("customs", "import duty", "duty", "kastam", "dekedda")),
    ("remittance_fees", ("hawala", "xawaalad", "xawilaad", "xawaalad", "remittance",
                         "transfer fee", "zaad service", "evc plus")),
    ("electricity", ("electric", "power", "generator", "koront", "matoor", "janareyt")),
    ("water", ("water", "biyo", "biyah")),
    ("security", ("security", "guard", "ilaal", "ammaan", "amaan", "waardiye")),
    ("salaries", ("salar", "wage", "payroll", "staff cost", "mushahar", "shaqaale")),
    ("rent", ("rent", "lease", "kiro", "kirad", "kiray")),
    ("communications", ("telephone", "phone", "internet", "airtime", "data bundle",
                        "isgaarsiin", "telefoon")),
    ("transport", ("transport", "fuel", "diesel", "petrol", "vehicle", "delivery",
                   "gaadiid", "shidaal", "baabuur")),
    ("bank_charges", ("bank charge", "bank fee", "merchant fee", "khidmad bangi")),
    ("municipal_tax", ("municipal", "council", "licence", "license", "permit",
                       "canshuur", "degmada", "ruqsad")),
    ("marketing", ("marketing", "advertis", "promotion", "xayeysiin")),
    ("repairs", ("repair", "maintenance", "dayactir", "hagaajin")),
    ("insurance", ("insurance", "caymis")),
    ("zakat_and_sadaqa", ("zakat", "zakah", "sadaqa", "sadaqah", "zakad")),
    ("supplies", ("stationery", "supplies", "packaging", "consumable", "qalab")),
    ("inventory_adjustment", ("stock adjust", "inventory adjust", "shrinkage", "wastage",
                              "khasaare alaab")),
    ("purchases", ("purchase", "cost of goods", "cogs", "cost of sales", "stock", "inventory",
                   "supplier", "iibsi", "alaab", "badeec")),
    ("wholesale", ("wholesale", "jumlo", "jumlad")),
    ("services", ("service income", "service revenue", "repair income", "adeeg")),
    ("other_income", ("other income", "interest income", "commission", "dakhli kale")),
    ("sales", ("sales", "revenue", "turnover", "income", "invoice", "receipt", "pos",
               "iib", "dakhli")),
)

# Words that say "this is a cost" without saying which cost. Matching one of
# these is what separates `unmatched` from `weak`: we know the direction, we do
# not know the line, and the report says exactly that.
_GENERIC_EXPENSE = ("expense", "cost", "overhead", "kharash", "kharashaad")
_GENERIC_INCOME = ("income", "revenue", "dakhli")


def classify_account(
    account: str,
    description: str = "",
    hint: EntryKind | None = None,
) -> tuple[str, EntryKind, Confidence]:
    """
    Map a source system's own account name onto our category vocabulary.

    `hint` is what the source system already told us structurally -- Odoo's
    account type, QuickBooks' line detail, the column a figure sat in on a
    two-column spreadsheet. **The hint decides the kind; the keyword decides
    only the category within that kind.**

    That division is not obvious and it was wrong the other way round first. A
    two-column sheet whose expense column holds a row described "Cash sales"
    was classified from the word "sales" and became revenue -- so the day's
    costs were added to its takings. The structure of the source is a fact and
    the words in a description are a hint about it, not the reverse. When the
    two disagree the line is filed under the hint's generic category and
    reported as a weak match, which is what puts it in front of a person.

    Returned rather than raised on failure, because an unclassifiable line is
    normal -- charts of accounts contain things no vocabulary anticipates -- and
    losing it would be far worse than filing it as uncategorised.
    """
    haystack = f"{account} {description}".lower().strip()

    if haystack:
        for category, keywords in _KEYWORDS:
            if any(keyword in haystack for keyword in keywords):
                kind = CATEGORY_KINDS[category]
                if hint is None or hint == kind:
                    return category, kind, "matched"
                return _generic(hint, "weak")

        if any(word in haystack for word in _GENERIC_INCOME) and hint != "expense":
            return "other_income", "revenue", "weak"
        if any(word in haystack for word in _GENERIC_EXPENSE):
            return _generic(hint or "expense", "weak")

    return _generic(hint or "expense", "unmatched")


def _generic(kind: EntryKind, confidence: Confidence) -> tuple[str, EntryKind, Confidence]:
    """The catch-all category for a kind, when nothing more specific is known."""
    if kind == "revenue":
        return "other_income", "revenue", confidence
    if kind == "cogs":
        return "purchases", "cogs", confidence
    return "other_expense", "expense", confidence


# -----------------------------------------------------------------------------
# The entry
# -----------------------------------------------------------------------------


def to_decimal(value: Any) -> Decimal | None:
    """
    Money as Decimal, or None.

    Floats are accepted because the sources hand us floats, but they are
    converted through `str` rather than `Decimal(float)`: the second reads
    0.1 as 0.1000000000000000055511151231257827, and a month of those summed
    against a shop's own total is a reconciliation failure nobody can explain.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, ValueError, ArithmeticError):
        return None


@dataclass(frozen=True)
class LedgerEntry:
    """
    One dated amount, classified, in the currency it was recorded in.

    `source_ref` is what makes a re-sync idempotent and a figure traceable: it
    is the identifier the source system itself uses (a QuickBooks line id, an
    Odoo move-line id, a workbook row number), so syncing the same month twice
    produces the same rows rather than double-counting, and any number in the
    report can be walked back to the record that produced it.
    """

    occurred_on: dt.date
    kind: EntryKind
    category: str
    amount: Decimal
    currency: str
    account: str = ""
    description: str = ""
    source_ref: str = ""
    product: str = ""
    location: str = ""
    counterparty: str = ""
    quantity: Decimal | None = None
    classified_by: Confidence = "matched"

    def in_base(self, rates: "FxRates") -> Decimal:
        return rates.convert(self.amount, self.currency)


@dataclass(frozen=True)
class FxRates:
    """
    How to state every entry in one currency.

    A single rate per currency, held on the connection and applied to every
    entry regardless of date. That is a real simplification and it is the right
    one here: the alternative is a dated rate table nobody in a shop will
    maintain, and a report whose figures move because a rate was backfilled is
    worse than one whose basis is stated plainly. The basis *is* stated -- the
    rate and the date it was set travel into the report's footnote.

    USD is the default base because it is what Somali wholesale, import and
    most retail pricing is denominated in; the shilling is priced against it
    rather than the other way round.
    """

    base: str = "USD"
    rates: dict[str, Decimal] = field(default_factory=dict)
    as_of: dt.date | None = None

    def convert(self, amount: Decimal, currency: str) -> Decimal:
        code = (currency or self.base).upper()
        if code == self.base:
            return amount
        rate = self.rates.get(code)
        if rate is None or rate == 0:
            # Refusing loudly rather than treating an unknown currency as
            # 1:1. A shilling figure silently counted as dollars would overstate
            # a month by a factor of about 570.
            raise LedgerError(
                f"no exchange rate configured for {code}; the connection states "
                f"rates for {', '.join(sorted(self.rates)) or 'nothing'} against {self.base}"
            )
        return amount / rate

    def describe(self) -> dict[str, Any]:
        return {
            "base": self.base,
            "rates": {code: str(rate) for code, rate in sorted(self.rates.items())},
            "as_of": self.as_of.isoformat() if self.as_of else None,
        }


class LedgerError(ValueError):
    """A connector or conversion failure whose message is safe to show a user."""


@dataclass
class LedgerBatch:
    """
    What a connector returns: the entries, plus what it could not read.

    `skipped` is not an error list. Every real export contains rows that are not
    transactions -- an opening balance, a blank separator, a line with no date --
    and dropping them silently is how a report ends up 3% light with nothing
    anywhere to say why. The count and the reasons travel with the data and land
    in the sync run, so "we read 1,204 of 1,231 lines" is answerable.
    """

    entries: list[LedgerEntry] = field(default_factory=list)
    skipped: list[dict[str, Any]] = field(default_factory=list)
    source: str = ""
    window_start: dt.date | None = None
    window_end: dt.date | None = None
    warnings: list[str] = field(default_factory=list)

    def skip(self, reason: str, detail: str = "") -> None:
        self.skipped.append({"reason": reason, "detail": detail[:200]})

    def extend(self, entries: Iterable[LedgerEntry]) -> None:
        self.entries.extend(entries)

    @property
    def row_count(self) -> int:
        return len(self.entries)

    def summary(self) -> dict[str, Any]:
        reasons: dict[str, int] = {}
        for item in self.skipped:
            reasons[item["reason"]] = reasons.get(item["reason"], 0) + 1
        unmatched = sum(1 for entry in self.entries if entry.classified_by == "unmatched")
        return {
            "source": self.source,
            "entries": len(self.entries),
            "skipped": len(self.skipped),
            "skipped_reasons": reasons,
            "uncategorised": unmatched,
            "window_start": self.window_start.isoformat() if self.window_start else None,
            "window_end": self.window_end.isoformat() if self.window_end else None,
            "warnings": self.warnings,
        }


# -----------------------------------------------------------------------------
# Parquet
#
# The ledger is stored exactly like every other dataset in this system: as an
# immutable Parquet version in the `parquet` bucket, never as rows in Postgres.
# That is not just consistency. It means a synced ledger inherits the whole of
# the existing machinery for free -- versioning with a parent pointer, the
# question engine in `analyze`, exports, and the tenancy boundary that storage
# paths already enforce -- and it keeps customer transaction rows out of the
# database that the dashboard queries with a user session.
# -----------------------------------------------------------------------------

# Written as floats, not Decimals. Every consumer downstream -- Polars, DuckDB,
# the report -- works in floats, and a Decimal column that half the readers
# coerce anyway buys precision that is lost at the first `sum()`. The Decimal
# arithmetic that matters happens before this point, on the way in.
PARQUET_COLUMNS = (
    "occurred_on",
    "kind",
    "category",
    "amount",
    "currency",
    "amount_base",
    "account",
    "description",
    "product",
    "location",
    "counterparty",
    "quantity",
    "source_ref",
    "classified_by",
)


def to_columns(entries: list[LedgerEntry], rates: FxRates) -> dict[str, list[Any]]:
    """Column-major, in the order `PARQUET_COLUMNS` declares."""
    columns: dict[str, list[Any]] = {name: [] for name in PARQUET_COLUMNS}
    for entry in entries:
        columns["occurred_on"].append(entry.occurred_on)
        columns["kind"].append(entry.kind)
        columns["category"].append(entry.category)
        columns["amount"].append(float(entry.amount))
        columns["currency"].append(entry.currency)
        columns["amount_base"].append(float(entry.in_base(rates)))
        columns["account"].append(entry.account)
        columns["description"].append(entry.description)
        columns["product"].append(entry.product)
        columns["location"].append(entry.location)
        columns["counterparty"].append(entry.counterparty)
        columns["quantity"].append(float(entry.quantity) if entry.quantity is not None else None)
        columns["source_ref"].append(entry.source_ref)
        columns["classified_by"].append(entry.classified_by)
    return columns


def from_columns(columns: dict[str, list[Any]]) -> list[LedgerEntry]:
    """
    Read a stored ledger back out of Parquet.

    The inverse of `to_columns`, and deliberately forgiving about what it finds:
    a version written by an older build may be missing a column this one added,
    and refusing to report on last quarter because a column arrived since is a
    worse failure than reporting it with that field blank.

    `amount_base` is not read back. It was computed from the rates in force when
    the sync ran, and the report re-derives it from the rates the *connection*
    states now -- so a corrected exchange rate fixes every past period rather
    than only the ones synced after the correction.
    """
    count = len(columns.get("occurred_on") or [])
    entries: list[LedgerEntry] = []

    def column(name: str) -> list[Any]:
        values = columns.get(name)
        return values if values is not None else [None] * count

    dates = column("occurred_on")
    kinds = column("kind")
    categories = column("category")
    amounts = column("amount")
    currencies = column("currency")
    accounts = column("account")
    descriptions = column("description")
    products = column("product")
    locations = column("location")
    counterparties = column("counterparty")
    quantities = column("quantity")
    refs = column("source_ref")
    confidences = column("classified_by")

    for index in range(count):
        occurred = dates[index]
        if isinstance(occurred, str):
            occurred = parse_iso_date(occurred)
        elif isinstance(occurred, dt.datetime):
            occurred = occurred.date()
        amount = to_decimal(amounts[index])
        if occurred is None or amount is None:
            continue

        entries.append(
            LedgerEntry(
                occurred_on=occurred,
                kind=kinds[index] or "expense",
                category=categories[index] or "other_expense",
                amount=amount,
                currency=(currencies[index] or "USD"),
                account=accounts[index] or "",
                description=descriptions[index] or "",
                source_ref=refs[index] or "",
                product=products[index] or "",
                location=locations[index] or "",
                counterparty=counterparties[index] or "",
                quantity=to_decimal(quantities[index]),
                classified_by=confidences[index] or "matched",
            )
        )

    return entries


def deduplicate(entries: list[LedgerEntry]) -> tuple[list[LedgerEntry], int]:
    """
    Drop entries that repeat a `source_ref` already seen.

    A sync window almost always overlaps the previous one -- a shop asks for
    "this month" twice, or a scheduled run re-reads a week that a manual run
    already covered -- and the source systems hand back the same records. The
    reference is the source's own identifier, so equality here means "the same
    record", not "a similar amount", and dropping the repeat is safe in a way
    that de-duplicating on value never is.

    Entries with no reference are always kept. A connector that cannot identify
    its records must not have those records silently collapsed together: two
    identical cash sales on the same day are two sales.
    """
    seen: set[str] = set()
    kept: list[LedgerEntry] = []
    dropped = 0
    for entry in entries:
        if not entry.source_ref:
            kept.append(entry)
            continue
        if entry.source_ref in seen:
            dropped += 1
            continue
        seen.add(entry.source_ref)
        kept.append(entry)
    return kept, dropped


def parse_iso_date(value: Any) -> dt.date | None:
    """A date from an API's string, without a dependency and without guessing."""
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    # Both QuickBooks and Odoo emit ISO; Odoo appends a time for some models.
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", text)
    if not match:
        return None
    try:
        return dt.date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


__all__ = [
    "CATEGORY_KINDS",
    "Confidence",
    "EntryKind",
    "FxRates",
    "LedgerBatch",
    "LedgerEntry",
    "LedgerError",
    "PARQUET_COLUMNS",
    "classify_account",
    "deduplicate",
    "from_columns",
    "parse_iso_date",
    "to_columns",
    "to_decimal",
]
