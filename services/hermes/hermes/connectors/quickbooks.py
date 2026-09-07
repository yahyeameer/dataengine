"""
The QuickBooks Online connector.

Two halves, deliberately separated: `QuickBooksClient` talks HTTP and knows
nothing about ledgers, and `entries_from_documents` turns QuickBooks documents
into `LedgerEntry` and knows nothing about HTTP. The seam is a list of parsed
JSON documents, which is what makes the interesting half testable against
recorded payloads rather than against Intuit's servers.

**Why the transaction entities and not the Profit & Loss report.** The report
API would hand back the totals in one call, already grouped, and it was the
obvious first choice. It is the wrong one here for two reasons. A report row
carries no reference back to the transaction behind it, so section 7's promise
-- that any figure can be traced to its source -- would be broken the moment
this feature shipped. And a report is a rendering: its rows are whatever the
company's own P&L layout says, so two shops with the same trade produce
differently shaped reports and nothing downstream can compare them. Reading
Invoice, SalesReceipt, Purchase and their credit counterparts costs more calls
and yields facts instead of somebody's layout.

**Refunds are negative revenue.** QuickBooks records a CreditMemo or a
RefundReceipt as its own positive document; treating it as a cost would leave
sales overstated and expenses overstated together, so both margin and net
profit would look wrong in opposite directions. They are emitted here as
revenue with a negative amount, which is what a refund is.
"""

from __future__ import annotations

import base64
import logging
from typing import Any, Iterable

import httpx

from .ledger import (
    EntryKind,
    LedgerBatch,
    LedgerEntry,
    LedgerError,
    classify_account,
    parse_iso_date,
    to_decimal,
)

log = logging.getLogger("hermes.connectors.quickbooks")

PRODUCTION_HOST = "https://quickbooks.api.intuit.com"
SANDBOX_HOST = "https://sandbox-quickbooks.api.intuit.com"
TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"

# QuickBooks caps a query at 1,000 rows and pages with STARTPOSITION, which is
# 1-based. A shop doing 200 transactions a month reaches this in about four
# years, so the paging exists for the warehouse case and for a first sync that
# backfills history.
PAGE_SIZE = 1000

# Which document types are read, and what each one means. The mapping is data
# rather than a chain of ifs because it is the part a reader needs to check:
# "does a VendorCredit reduce costs" is answerable by looking at one line.
#
#   entity          -> (direction, sign)
#
# `direction` is the hint handed to the classifier; the account name on each
# line still decides the category.
DOCUMENTS: dict[str, tuple[EntryKind, int]] = {
    "Invoice": ("revenue", 1),
    "SalesReceipt": ("revenue", 1),
    "CreditMemo": ("revenue", -1),
    "RefundReceipt": ("revenue", -1),
    "Purchase": ("expense", 1),
    "Bill": ("expense", 1),
    "VendorCredit": ("expense", -1),
}

# Line detail shapes. A line that buys stock is cost of goods; a line that pays
# the electricity bill is an operating expense. QuickBooks distinguishes them by
# detail type, and that distinction is the one gross margin depends on.
_ITEM_DETAILS = ("SalesItemLineDetail", "ItemBasedExpenseLineDetail")
_ACCOUNT_DETAILS = ("AccountBasedExpenseLineDetail", "JournalEntryLineDetail", "DepositLineDetail")


class QuickBooksError(LedgerError):
    """A QuickBooks failure phrased for the person who connected the company."""


# -----------------------------------------------------------------------------
# Normalisation (no network)
# -----------------------------------------------------------------------------


def _ref_name(detail: dict[str, Any], key: str) -> str:
    ref = detail.get(key)
    if isinstance(ref, dict):
        return str(ref.get("name") or ref.get("value") or "").strip()
    return ""


def _line_entries(
    document: dict[str, Any],
    entity: str,
    direction: EntryKind,
    sign: int,
    default_currency: str,
) -> Iterable[LedgerEntry]:
    occurred = parse_iso_date(document.get("TxnDate"))
    if occurred is None:
        return []

    currency = _ref_name(document, "CurrencyRef") or default_currency
    # CurrencyRef carries the code in `value` and the label in `name`; the label
    # is what _ref_name prefers, and "US Dollar" is not a currency code.
    ref = document.get("CurrencyRef")
    if isinstance(ref, dict) and ref.get("value"):
        currency = str(ref["value"])
    currency = (currency or default_currency).upper()

    counterparty = _ref_name(document, "CustomerRef") or _ref_name(document, "VendorRef")
    location = _ref_name(document, "DepartmentRef")
    doc_id = str(document.get("Id") or "")
    doc_number = str(document.get("DocNumber") or "")

    entries: list[LedgerEntry] = []
    for index, line in enumerate(document.get("Line") or []):
        if not isinstance(line, dict):
            continue
        detail_type = str(line.get("DetailType") or "")
        # Subtotal, discount and tax lines are summaries of the lines above
        # them. Counting them would double the document.
        if detail_type in ("SubTotalLineDetail", "DiscountLineDetail", "TaxLineDetail"):
            continue

        amount = to_decimal(line.get("Amount"))
        if amount is None or amount == 0:
            continue

        detail = line.get(detail_type) if isinstance(line.get(detail_type), dict) else {}
        account = _ref_name(detail, "AccountRef")
        product = _ref_name(detail, "ItemRef")
        quantity = to_decimal(detail.get("Qty")) if detail else None

        hint = direction
        if direction == "expense" and detail_type in _ITEM_DETAILS:
            # A purchase of an inventory item is stock, whatever account it was
            # posted to. This is the single most consequential line in the
            # module: it is what separates cost of goods from overheads, and
            # therefore what makes gross margin mean anything.
            hint = "cogs"

        category, kind, confidence = classify_account(
            account or product, str(line.get("Description") or ""), hint
        )

        entries.append(
            LedgerEntry(
                occurred_on=occurred,
                kind=kind,
                category=category,
                amount=amount * sign,
                currency=currency,
                account=account or product,
                description=str(line.get("Description") or "")[:500],
                # Entity, document and line: unique across the company file, and
                # stable across re-syncs, which is what makes an overlapping
                # window idempotent rather than double-counted.
                source_ref=f"qb:{entity}:{doc_id}:{line.get('Id') or index}",
                product=product,
                location=location,
                counterparty=counterparty,
                quantity=quantity,
                classified_by=confidence,
            )
        )

    if not entries and to_decimal(document.get("TotalAmt")):
        # A document with no readable lines but a real total is still money that
        # moved. Recording it whole, with the reference that says so, beats
        # dropping it -- and the missing detail shows up as an uncategorised
        # figure rather than as a silent hole in the month.
        total = to_decimal(document.get("TotalAmt")) or 0
        category, kind, confidence = classify_account(entity, doc_number, direction)
        entries.append(
            LedgerEntry(
                occurred_on=occurred,
                kind=kind,
                category=category,
                amount=total * sign,
                currency=currency,
                account=entity,
                description=f"{entity} {doc_number}".strip(),
                source_ref=f"qb:{entity}:{doc_id}:total",
                counterparty=counterparty,
                location=location,
                classified_by=confidence,
            )
        )

    return entries


def entries_from_documents(
    documents: dict[str, list[dict[str, Any]]],
    *,
    default_currency: str = "USD",
    batch: LedgerBatch | None = None,
) -> LedgerBatch:
    """
    Turn `{entity: [document, ...]}` into ledger entries.

    The whole of the QuickBooks-specific reasoning lives here and takes plain
    dictionaries, so the tests read a recorded payload and assert on the
    resulting month rather than mocking a client.
    """
    result = batch or LedgerBatch(source="quickbooks")

    for entity, rows in documents.items():
        if entity not in DOCUMENTS:
            result.skip("unknown_entity", entity)
            continue
        direction, sign = DOCUMENTS[entity]
        for document in rows:
            if not isinstance(document, dict):
                result.skip("malformed_document", entity)
                continue
            produced = list(
                _line_entries(document, entity, direction, sign, default_currency)
            )
            if not produced:
                result.skip("no_dated_lines", f"{entity} {document.get('Id', '')}")
            result.entries.extend(produced)

    dates = [entry.occurred_on for entry in result.entries]
    if dates:
        result.window_start = min(dates)
        result.window_end = max(dates)
    return result


# -----------------------------------------------------------------------------
# Transport
# -----------------------------------------------------------------------------


class QuickBooksClient:
    """
    A minimal QuickBooks Online client: refresh a token, run a query, page.

    Written by hand for the same reason `supabase.py` is: this uses three
    endpoints, and a wrapper we can read end to end beats a library whose
    retry and error semantics we would be reverse-engineering the first time a
    sync fails during someone's month end.

    The client is constructed with a refresh token and never with a password.
    Intuit rotates the refresh token on every use, so `rotated_refresh_token`
    is read after a sync and written back to the vault -- a connector that
    ignores it works for exactly one refresh cycle and then locks the customer
    out with an error that looks like a credential problem on their side.
    """

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        realm_id: str,
        sandbox: bool = False,
        timeout: float = 60.0,
        minor_version: str = "70",
    ):
        if not (client_id and client_secret and refresh_token and realm_id):
            raise QuickBooksError(
                "this QuickBooks connection is missing part of its credentials. It needs a "
                "client id, a client secret, a refresh token and the company (realm) id."
            )
        self._client_id = client_id
        self._client_secret = client_secret
        self._refresh_token = refresh_token
        self._realm_id = realm_id
        self._host = SANDBOX_HOST if sandbox else PRODUCTION_HOST
        self._minor_version = minor_version
        self._access_token: str | None = None
        self.rotated_refresh_token: str | None = None
        self._http = httpx.Client(
            timeout=httpx.Timeout(timeout, connect=15.0),
            transport=httpx.HTTPTransport(retries=2),
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "QuickBooksClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def authenticate(self) -> None:
        basic = base64.b64encode(
            f"{self._client_id}:{self._client_secret}".encode("utf-8")
        ).decode("ascii")
        response = self._http.post(
            TOKEN_URL,
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
            data={"grant_type": "refresh_token", "refresh_token": self._refresh_token},
        )
        if response.status_code >= 400:
            # The body can contain the token on some error shapes, so it is not
            # echoed. The status is the diagnostic, and 400 here means one
            # thing in practice: the refresh token has expired or been revoked.
            raise QuickBooksError(
                "QuickBooks refused the stored credentials"
                + (
                    ". Reconnect the company to grant access again -- a refresh token expires "
                    "after 100 days without use."
                    if response.status_code in (400, 401)
                    else f" (HTTP {response.status_code})."
                )
            )
        payload = response.json()
        self._access_token = payload.get("access_token")
        if not self._access_token:
            raise QuickBooksError("QuickBooks returned no access token")
        rotated = payload.get("refresh_token")
        if rotated and rotated != self._refresh_token:
            self.rotated_refresh_token = rotated

    def query(self, statement: str) -> dict[str, Any]:
        if not self._access_token:
            self.authenticate()
        response = self._http.get(
            f"{self._host}/v3/company/{self._realm_id}/query",
            headers={
                "Authorization": f"Bearer {self._access_token}",
                "Accept": "application/json",
            },
            params={"query": statement, "minorversion": self._minor_version},
        )
        if response.status_code == 401:
            # One retry after a re-auth: an access token lives an hour and a
            # long backfill can outlive it.
            self.authenticate()
            response = self._http.get(
                f"{self._host}/v3/company/{self._realm_id}/query",
                headers={
                    "Authorization": f"Bearer {self._access_token}",
                    "Accept": "application/json",
                },
                params={"query": statement, "minorversion": self._minor_version},
            )
        if response.status_code == 429:
            raise QuickBooksError(
                "QuickBooks is rate-limiting this company. The sync will be retried; "
                "no data has been lost."
            )
        if response.status_code >= 400:
            raise QuickBooksError(
                f"QuickBooks rejected a query (HTTP {response.status_code}). "
                "This usually means the connected company no longer grants access."
            )
        return response.json() or {}

    def fetch_entity(self, entity: str, start: str, end: str) -> list[dict[str, Any]]:
        """
        Every document of one type in a date window, paged to exhaustion.

        The window is inclusive at both ends and filtered on TxnDate, which is
        the date the shop would recognise -- not the creation timestamp, which
        moves when somebody edits last month's invoice in this month.
        """
        rows: list[dict[str, Any]] = []
        position = 1
        while True:
            statement = (
                f"select * from {entity} "
                f"where TxnDate >= '{start}' and TxnDate <= '{end}' "
                f"startposition {position} maxresults {PAGE_SIZE}"
            )
            payload = self.query(statement)
            page = (payload.get("QueryResponse") or {}).get(entity) or []
            rows.extend(row for row in page if isinstance(row, dict))
            if len(page) < PAGE_SIZE:
                return rows
            position += PAGE_SIZE
            if position > 100_000:
                # A guard, not a limit anyone should hit: a company with 100,000
                # documents of one type in one window is a sign the window is
                # wrong, and looping forever on it would hold a job lease open
                # until the worker is killed.
                log.warning("stopping %s paging at %d rows", entity, len(rows))
                return rows


def verify(client: QuickBooksClient) -> dict[str, Any]:
    """
    Prove the credentials work, and say whose company they open.

    The company name is the point. "Connected" is a claim a shop owner cannot
    check; "connected to Suuqa Hodan Electronics" is one they can, and it is
    also the check that catches the real mistake here — credentials that work
    perfectly against the wrong company file, which would otherwise be found
    at the end of the month by a report full of somebody else's numbers.

    CompanyInfo is the cheapest read in the API and needs no date window, so a
    test costs one call and never touches a transaction.
    """
    client.authenticate()
    payload = client.query("select * from CompanyInfo")
    rows = (payload.get("QueryResponse") or {}).get("CompanyInfo") or []
    company = rows[0] if rows and isinstance(rows[0], dict) else {}

    address = company.get("CompanyAddr") or {}
    return {
        "company_name": str(company.get("CompanyName") or "").strip(),
        "country": str(address.get("Country") or "").strip(),
        "currency": str((company.get("Country") or "")).strip(),
        "fiscal_year_start": str(company.get("FiscalYearStartMonth") or "").strip(),
        "rotated_refresh_token": bool(client.rotated_refresh_token),
    }


def fetch(
    client: QuickBooksClient,
    start: str,
    end: str,
    *,
    default_currency: str = "USD",
    entities: tuple[str, ...] = tuple(DOCUMENTS),
    progress: Any = None,
) -> LedgerBatch:
    """Read a window from a connected company into a ledger batch."""
    documents: dict[str, list[dict[str, Any]]] = {}
    for entity in entities:
        if callable(progress):
            progress({"stage": "fetching", "entity": entity})
        documents[entity] = client.fetch_entity(entity, start, end)

    batch = entries_from_documents(documents, default_currency=default_currency)
    batch.source = "quickbooks"
    return batch


__all__ = [
    "DOCUMENTS",
    "QuickBooksClient",
    "QuickBooksError",
    "entries_from_documents",
    "fetch",
    "verify",
]
