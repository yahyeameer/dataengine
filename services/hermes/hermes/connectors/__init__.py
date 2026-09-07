"""
Store connectors: three sources, one row shape.

`ledger` defines what every connector must produce; `excel`, `quickbooks` and
`odoo` are the three that produce it. Nothing outside this package imports a
connector module directly -- `SOURCES` below is the lookup, so adding a fourth
source is a new module and one line here rather than a search for every place
that enumerated the three.
"""

from __future__ import annotations

from .ledger import (
    CATEGORY_KINDS,
    EntryKind,
    FxRates,
    LedgerBatch,
    LedgerEntry,
    LedgerError,
    PARQUET_COLUMNS,
    classify_account,
    deduplicate,
    to_columns,
)

# The customer-facing names, which are also the values of the `store_source`
# enum in the database. Kept as a plain tuple rather than derived from the
# modules so that a half-written connector cannot advertise itself.
SOURCES: tuple[str, ...] = ("excel", "quickbooks", "odoo")

# Which sources hold credentials. An Excel connection reads files the customer
# has already uploaded through the dashboard, so there is nothing to store and
# nothing to leak -- which is also why it is the source a shop can start with in
# under a minute.
NEEDS_CREDENTIALS: frozenset[str] = frozenset({"quickbooks", "odoo"})

__all__ = [
    "CATEGORY_KINDS",
    "EntryKind",
    "FxRates",
    "LedgerBatch",
    "LedgerEntry",
    "LedgerError",
    "NEEDS_CREDENTIALS",
    "PARQUET_COLUMNS",
    "SOURCES",
    "classify_account",
    "deduplicate",
    "to_columns",
]
