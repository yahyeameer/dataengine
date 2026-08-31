"""
Reading official guidance from GOV.UK, narrowly.

Why the agent is allowed on the network at all: a categorisation rule can go out
of date and nothing in this system would notice. UK tax parameters move at every
fiscal event, HMRC rewrites guidance between them, and a rule table written in
August 2026 will quietly still be answering as if it were August 2026 in three
years' time. The agent needs a way to find out that a page it depends on has
changed.

Why it is allowed on the network *this* narrowly:

- **One host.** `config.govuk.host`, checked on the built URL rather than on the
  caller's argument, so a path like `//evil.example.com/x` cannot slip past by
  looking relative.
- **The content API, not the website.** `https://www.gov.uk/api/content/<path>`
  returns JSON with a title, a canonical URL and GOV.UK's own
  `public_updated_at`. There is no HTML parsing here, which removes both a
  fragile dependency and the temptation to scrape prose we have no licence to
  store.
- **No redirects.** A redirect is how a single-host allowlist becomes no
  allowlist.
- **A byte cap and a short timeout**, because a worker blocked on a government
  website is a worker not doing the customer's work.
- **Off by default.** With `enabled` false nothing here opens a socket; every
  entry point returns `None` or an empty list. The categorisation path works
  exactly as well without it, which is the property that makes it safe to ship
  switched off.

What comes back is *evidence*, never a decision. A fetched page can annotate a
classification and can lower its confidence; it cannot change what a rule
returns. Rules change in `hmrc.py`, in code, with a test, through review. That
separation is the whole reason a government website changing overnight cannot
reclassify a customer's accounts.

Only a summary is kept: title, URL, publication date, and GOV.UK's own
`description` field. Not the body. What is hashed for change detection is the
body, but only the hash is stored.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from ..config import GovUKConfig

log = logging.getLogger("hermes.govuk")

# The topics the agent knows how to check, and which of our categories each one
# is evidence about.
#
# A closed list, not a search. The agent does not "look up HMRC guidance on X" --
# it re-reads pages somebody chose, which is what keeps the authority hierarchy
# meaningful and stops a bad query from becoming a bad citation.
TOPICS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "/expenses-if-youre-self-employed",
        (
            "Office Costs",
            "Premises Costs",
            "Travel and Subsistence",
            "Staff Costs",
            "Advertising and Entertainment",
            "Professional Fees",
            "Other Business Expenses",
        ),
    ),
    ("/simplified-expenses-if-youre-self-employed", ("Travel and Subsistence", "Premises Costs")),
    ("/capital-allowances", ("Capital Expenditure", "Depreciation and Loss on Assets")),
    ("/capital-allowances/annual-investment-allowance", ("Capital Expenditure",)),
    ("/guidance/business-entertaining-expenses", ("Advertising and Entertainment",)),
    ("/what-is-the-construction-industry-scheme", ("Construction Industry Subcontractors",)),
    ("/vat-rates", ("HMRC and Tax Payments",)),
)

# Categories worth verifying before a run leans on them. Deliberately short:
# these are the ones where the treatment genuinely moves, and checking the whole
# taxonomy on every run would be the expensive mistake this module is designed
# to avoid.
TAX_SENSITIVE: frozenset[str] = frozenset(
    {
        "Capital Expenditure",
        "Advertising and Entertainment",
        "Travel and Subsistence",
        "Construction Industry Subcontractors",
    }
)


@dataclass(frozen=True)
class Source:
    """One piece of official guidance, reduced to what may be stored."""

    content_path: str
    url: str
    title: str
    summary: str
    public_updated_at: str | None
    body_hash: str
    categories: tuple[str, ...]

    def as_evidence(self, checked_at: str) -> dict[str, Any]:
        """The shape attached to a proposal's evidence. Small on purpose."""
        return {
            "title": self.title,
            "url": self.url,
            "published": self.public_updated_at,
            "checked_at": checked_at,
            "summary": self.summary[:400],
        }


class GovUKError(RuntimeError):
    """A fetch that did not produce usable guidance. Never fatal to a job."""


class GovUKClient:
    """
    A client that can only reach one host, and only when switched on.

    Constructed per job rather than kept open: this is used a handful of times a
    day at most, and a long-lived connection to a government website is state
    nobody wants to reason about at 3am.
    """

    def __init__(self, config: GovUKConfig, transport: httpx.BaseTransport | None = None):
        self._config = config
        # `transport` exists so the tests can exercise every guard without a
        # network. It does not widen anything: the host check below runs on the
        # URL regardless of who is carrying the bytes.
        self._transport = transport
        self._client: httpx.Client | None = None

    @property
    def enabled(self) -> bool:
        return self._config.enabled

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> GovUKClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    # -- the one request this module can make ---------------------------------

    def fetch(self, content_path: str, categories: tuple[str, ...] = ()) -> Source | None:
        """
        Read one content item, or None if it cannot be read.

        Returns None rather than raising for anything the caller cannot act on.
        A government website being slow is not a reason to fail an accountant's
        categorisation run, and every call site here is an enrichment.
        """
        if not self._config.enabled:
            return None

        try:
            url = self._url_for(content_path)
        except GovUKError as error:
            log.warning("govuk: refusing %r: %s", content_path, error)
            return None

        try:
            response = self._client_or_open().get(url, headers={"accept": "application/json"})
        except httpx.HTTPError as error:
            log.warning("govuk: %s unreachable: %s", url, error)
            return None

        # A redirect is not followed and is not a success. On a single-host
        # allowlist, following one is how the allowlist stops meaning anything.
        if response.is_redirect:
            log.warning("govuk: %s redirected; not following", url)
            return None
        if response.status_code != 200:
            log.warning("govuk: %s answered %s", url, response.status_code)
            return None

        body = response.content[: self._config.max_bytes]
        if len(response.content) > self._config.max_bytes:
            log.warning("govuk: %s exceeded the byte cap; treated as unreadable", url)
            return None

        try:
            document = json.loads(body)
        except ValueError:
            log.warning("govuk: %s did not return JSON", url)
            return None
        if not isinstance(document, dict):
            return None

        return self._to_source(content_path, url, document, body, categories)

    def check_topics(
        self, only: frozenset[str] | None = None
    ) -> list[Source]:
        """
        Read the topic list, or the subset relevant to given categories.

        Used by the knowledge monitor, which reads all of them, and by a
        categorisation run, which reads at most the tax-sensitive few.
        """
        if not self._config.enabled:
            return []

        found: list[Source] = []
        for path, categories in TOPICS:
            if only is not None and not (set(categories) & only):
                continue
            source = self.fetch(path, categories)
            if source is not None:
                found.append(source)
        return found

    # -- internals ------------------------------------------------------------

    def _client_or_open(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                timeout=httpx.Timeout(self._config.timeout_seconds, connect=10.0),
                # Not a convenience. See fetch(): a followed redirect defeats the
                # host allowlist, so the client must not do it behind our back.
                follow_redirects=False,
                transport=self._transport,
                headers={"user-agent": "DataEngine HMRC categorisation agent"},
            )
        return self._client

    def _url_for(self, content_path: str) -> str:
        """
        Build the content-API URL, and refuse anything that leaves the host.

        The check is on the *assembled* URL rather than on `content_path`,
        because that is the only string that decides where the socket goes. A
        path beginning `//` or carrying a scheme would otherwise be treated as
        absolute by every URL parser in the stack.
        """
        path = content_path.strip()
        if not path.startswith("/") or path.startswith("//") or "://" in path:
            raise GovUKError(f"{content_path!r} is not a GOV.UK content path")

        url = f"{self._config.host.rstrip('/')}/api/content{path}"

        allowed = urlsplit(self._config.host)
        built = urlsplit(url)
        if built.scheme != allowed.scheme or built.netloc != allowed.netloc:
            raise GovUKError(f"{url} is outside the allowed host {self._config.host}")
        if built.scheme != "https" and allowed.netloc != "localhost":
            raise GovUKError("official guidance is only read over https")

        return url

    @staticmethod
    def _to_source(
        content_path: str,
        url: str,
        document: dict[str, Any],
        body: bytes,
        categories: tuple[str, ...],
    ) -> Source:
        base = document.get("base_path")
        return Source(
            content_path=content_path,
            # GOV.UK's own canonical path, so a page that has moved is recorded
            # where it actually lives.
            url=f"https://www.gov.uk{base}" if isinstance(base, str) and base else url,
            title=str(document.get("title") or content_path),
            summary=str(document.get("description") or ""),
            public_updated_at=(
                str(document["public_updated_at"])
                if isinstance(document.get("public_updated_at"), str)
                else None
            ),
            # The hash is what change detection compares. The body itself is
            # never stored -- it is HMRC's text, and we only need to know that
            # it moved.
            body_hash=hashlib.sha256(body).hexdigest(),
            categories=categories,
        )
