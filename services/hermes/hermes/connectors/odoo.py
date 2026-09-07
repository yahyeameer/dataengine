"""
The Odoo connector.

Odoo is what a Somali business gets when a local integrator sets them up
properly, and it is the richest of the three sources: the general ledger is
already there, already posted, already tied to accounts with types. So this
connector reads `account.move.line` -- the ledger itself -- rather than sales
orders or POS lines.

That choice is worth stating because the alternative is tempting. `pos.order`
and `sale.order` are closer to what a shopkeeper thinks about, and reading them
would produce a revenue figure faster. But they are documents, not postings:
a draft order is not revenue, a cancelled one is not a refund, and a discount
applied at the till appears in one and not the other. Posted move lines are the
company's own accounting truth, they already net off cancellations, and when a
POS session is closed Odoo posts it into exactly these lines. Reading the
ledger means this connector agrees with the customer's own Odoo P&L, which is
the only comparison they will actually make.

**Sign.** Odoo stores `balance` as debit minus credit, so income accounts carry
negative balances and expenses positive ones. Every figure here is flipped for
income before it becomes a `LedgerEntry`, because a report that hands a
shopkeeper "revenue: -$4,200" has failed at the only job it had.
"""

from __future__ import annotations

import ipaddress
import logging
from typing import Any
from urllib.parse import urlparse

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

log = logging.getLogger("hermes.connectors.odoo")

# How many move lines to read per round trip. Odoo will happily return more; the
# limit is about this worker's memory on a small VPS, not about Odoo.
PAGE_SIZE = 2000

# Odoo's account types, mapped to what they mean for a P&L. Both the modern
# `account_type` values and the older `internal_group` are handled, because a
# customer's instance is whatever version their integrator installed and this
# connector should not require them to upgrade Odoo to see their revenue.
_INCOME_TYPES = {"income", "income_other"}
_COGS_TYPES = {"expense_direct_cost", "cost_of_revenue"}
_EXPENSE_TYPES = {"expense", "expense_depreciation"}


class OdooError(LedgerError):
    """An Odoo failure phrased for the person who connected the instance."""


def check_base_url(url: str, *, allow_plain_http: bool = False) -> str:
    """
    Refuse a base URL that points back inside our own network.

    The customer supplies this, and the worker holds the service-role key on a
    host that can reach things a customer cannot. Without this check, "my Odoo
    is at http://169.254.169.254/" is a request for the worker to fetch its own
    cloud metadata and hand the result back through a sync error message.

    A hostname that resolves to a private address at request time still gets
    through -- defeating that needs resolution-time pinning, which httpx does
    not offer -- so this is a floor rather than a ceiling. It costs nothing and
    it stops the literal case, which is the one that actually appears.
    """
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("https", "http"):
        raise OdooError(f"the Odoo address must start with https://, got {url!r}")
    if parsed.scheme == "http" and not allow_plain_http:
        raise OdooError(
            "this Odoo address uses http://, which would send the API key in clear text. "
            "Use https://, or set HERMES_STORE_ALLOW_PLAIN_HTTP for a trusted local instance."
        )
    if not parsed.hostname:
        raise OdooError(f"the Odoo address has no host: {url!r}")

    try:
        address = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        address = None
    if address is not None and (
        address.is_private or address.is_loopback or address.is_link_local or address.is_reserved
    ):
        raise OdooError(
            f"{parsed.hostname} is a private address. The agent will only connect to an Odoo "
            "instance reachable at a public address."
        )

    return f"{parsed.scheme}://{parsed.netloc}"


class OdooClient:
    """
    JSON-RPC against `/jsonrpc`, which is the one endpoint every Odoo exposes.

    XML-RPC is the more commonly documented path and is deliberately not used:
    it would mean parsing XML from a customer-controlled server in the most
    privileged process in the deployment, and the JSON endpoint has been present
    since Odoo 8 and returns the same data.
    """

    def __init__(
        self,
        *,
        base_url: str,
        database: str,
        username: str,
        api_key: str,
        timeout: float = 60.0,
        allow_plain_http: bool = False,
    ):
        if not (base_url and database and username and api_key):
            raise OdooError(
                "this Odoo connection is missing part of its credentials. It needs the "
                "instance address, the database name, a username and an API key."
            )
        self._base = check_base_url(base_url, allow_plain_http=allow_plain_http)
        self._db = database
        self._username = username
        self._api_key = api_key
        self._uid: int | None = None
        self._http = httpx.Client(
            timeout=httpx.Timeout(timeout, connect=15.0),
            transport=httpx.HTTPTransport(retries=2),
            # A redirect is how an SSRF check gets walked around, so the
            # connector does not follow one. An Odoo that redirects its own
            # JSON-RPC endpoint is misconfigured anyway.
            follow_redirects=False,
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "OdooClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _call(self, service: str, method: str, args: list[Any]) -> Any:
        response = self._http.post(
            f"{self._base}/jsonrpc",
            json={
                "jsonrpc": "2.0",
                "method": "call",
                "params": {"service": service, "method": method, "args": args},
                "id": 1,
            },
            headers={"Content-Type": "application/json"},
        )
        if response.status_code >= 400:
            raise OdooError(
                f"the Odoo instance answered HTTP {response.status_code}. Check that the "
                "address is right and that /jsonrpc is reachable from the internet."
            )
        try:
            payload = response.json()
        except ValueError as error:
            raise OdooError(
                "the Odoo address returned something that is not JSON-RPC. It may be a "
                "login page or a proxy rather than the Odoo API."
            ) from error

        if "error" in payload:
            error = payload["error"] or {}
            data = error.get("data") or {}
            # Odoo's own message is the useful one and is safe: it is the
            # customer's server describing the customer's own request.
            message = str(data.get("message") or error.get("message") or "unknown error")
            raise OdooError(f"Odoo refused the request: {message[:300]}")

        return payload.get("result")

    def authenticate(self) -> int:
        uid = self._call("common", "login", [self._db, self._username, self._api_key])
        if not isinstance(uid, int) or uid <= 0:
            raise OdooError(
                "Odoo rejected the username or API key for database "
                f"{self._db!r}. Generate a new API key in Odoo under Preferences → Account "
                "Security."
            )
        self._uid = uid
        return uid

    def execute(self, model: str, method: str, args: list[Any], kwargs: dict[str, Any] | None = None) -> Any:
        if self._uid is None:
            self.authenticate()
        return self._call(
            "object",
            "execute_kw",
            [self._db, self._uid, self._api_key, model, method, args, kwargs or {}],
        )

    def search_read(
        self, model: str, domain: list[Any], fields: list[str], *, limit: int, offset: int
    ) -> list[dict[str, Any]]:
        rows = self.execute(
            model,
            "search_read",
            [domain, fields],
            {"limit": limit, "offset": offset, "order": "date asc, id asc"},
        )
        return rows if isinstance(rows, list) else []

    def read_accounts(self) -> dict[int, dict[str, Any]]:
        """
        The chart of accounts, id-keyed.

        Read once per sync and reused for every line, which turns what would be
        one lookup per move line into a single call. `account_type` is requested
        first and `internal_group` second: instances differ on which exists, and
        asking for a missing field is an error rather than a null, so the two
        are tried separately.
        """
        for fields in (["name", "code", "account_type"], ["name", "code", "internal_group"]):
            try:
                rows = self.execute(
                    "account.account", "search_read", [[], fields], {"limit": 5000}
                )
            except OdooError:
                continue
            if isinstance(rows, list):
                return {int(row["id"]): row for row in rows if isinstance(row, dict) and row.get("id")}
        raise OdooError(
            "could not read the chart of accounts from Odoo. The API user needs read access "
            "to Accounting."
        )


# -----------------------------------------------------------------------------
# Normalisation (no network)
# -----------------------------------------------------------------------------


def _many2one(value: Any) -> tuple[int | None, str]:
    """Odoo returns a many2one as `[id, "display name"]`, or False when unset."""
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        try:
            return int(value[0]), str(value[1])
        except (TypeError, ValueError):
            return None, str(value[1])
    return None, ""


def direction_for(account: dict[str, Any]) -> EntryKind | None:
    """
    What kind of line an account produces, or None for a balance-sheet account.

    None is the common answer and the important one: most move lines are the
    other side of a transaction -- cash, receivables, stock, tax payable -- and
    counting them would double or triple every figure. A P&L is built from
    income and expense accounts alone.
    """
    kind = str(account.get("account_type") or account.get("internal_group") or "").strip().lower()
    if kind in _INCOME_TYPES or kind == "income":
        return "revenue"
    if kind in _COGS_TYPES:
        return "cogs"
    if kind in _EXPENSE_TYPES or kind == "expense":
        return "expense"
    return None


def entries_from_move_lines(
    lines: list[dict[str, Any]],
    accounts: dict[int, dict[str, Any]],
    *,
    default_currency: str = "USD",
    batch: LedgerBatch | None = None,
) -> LedgerBatch:
    """
    Turn posted `account.move.line` records into ledger entries.

    Takes plain dictionaries so the sign handling -- the part most likely to be
    wrong and least likely to be noticed -- is tested against recorded rows.
    """
    result = batch or LedgerBatch(source="odoo")

    for line in lines:
        if not isinstance(line, dict):
            result.skip("malformed_line", "")
            continue

        occurred = parse_iso_date(line.get("date"))
        if occurred is None:
            result.skip("no_date", str(line.get("id", "")))
            continue

        account_id, account_name = _many2one(line.get("account_id"))
        account = accounts.get(account_id or -1) or {}
        direction = direction_for(account)
        if direction is None:
            # Not an error and not worth a skip reason a customer would read:
            # the balance-sheet side of every posting lands here, and it is the
            # majority of the ledger by row count.
            continue

        balance = to_decimal(line.get("balance"))
        if balance is None:
            debit = to_decimal(line.get("debit")) or 0
            credit = to_decimal(line.get("credit")) or 0
            balance = debit - credit
        if balance == 0:
            continue

        # The flip. Income is a credit, so its balance is negative, and revenue
        # is the negation of it. Expenses are debits and are already positive.
        amount = -balance if direction == "revenue" else balance

        _product_id, product = _many2one(line.get("product_id"))
        _partner_id, counterparty = _many2one(line.get("partner_id"))
        _journal_id, journal = _many2one(line.get("journal_id"))
        currency = default_currency
        _currency_id, currency_name = _many2one(line.get("company_currency_id"))
        if currency_name:
            currency = currency_name.strip().upper()

        source_name = account.get("name") or account_name
        category, kind, confidence = classify_account(
            str(source_name), str(line.get("name") or ""), direction
        )

        result.entries.append(
            LedgerEntry(
                occurred_on=occurred,
                kind=kind,
                category=category,
                amount=amount,
                currency=currency,
                account=str(source_name),
                description=str(line.get("name") or "")[:500],
                source_ref=f"odoo:aml:{line.get('id')}",
                product=product,
                location=journal,
                counterparty=counterparty,
                quantity=to_decimal(line.get("quantity")),
                classified_by=confidence,
            )
        )

    dates = [entry.occurred_on for entry in result.entries]
    if dates:
        result.window_start = min(dates)
        result.window_end = max(dates)
    return result


MOVE_LINE_FIELDS = [
    "id",
    "date",
    "name",
    "debit",
    "credit",
    "balance",
    "account_id",
    "partner_id",
    "product_id",
    "journal_id",
    "quantity",
    "company_currency_id",
]


def fetch(
    client: OdooClient,
    start: str,
    end: str,
    *,
    default_currency: str = "USD",
    max_lines: int = 200_000,
    progress: Any = None,
) -> LedgerBatch:
    """Read a posted-ledger window into a ledger batch."""
    accounts = client.read_accounts()

    # `parent_state = posted` is the whole difference between the customer's
    # accounts and a draft somebody is still typing. A draft invoice is not
    # revenue and must never appear in a report they act on.
    domain = [
        ["date", ">=", start],
        ["date", "<=", end],
        ["parent_state", "=", "posted"],
    ]

    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        if callable(progress):
            progress({"stage": "fetching", "lines": len(rows)})
        page = client.search_read(
            "account.move.line", domain, MOVE_LINE_FIELDS, limit=PAGE_SIZE, offset=offset
        )
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
        if len(rows) >= max_lines:
            raise OdooError(
                f"this window contains more than {max_lines:,} ledger lines. Sync a shorter "
                "period -- a month at a time -- rather than the whole history at once."
            )

    batch = entries_from_move_lines(rows, accounts, default_currency=default_currency)
    batch.source = "odoo"
    return batch


__all__ = [
    "MOVE_LINE_FIELDS",
    "OdooClient",
    "OdooError",
    "check_base_url",
    "direction_for",
    "entries_from_move_lines",
    "fetch",
]
