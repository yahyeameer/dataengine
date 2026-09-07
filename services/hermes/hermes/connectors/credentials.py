"""
Working out what a shop just pasted.

The problem this solves is not technical. A shopkeeper in Bakaara does not know
what a "refresh token" is, and should not have to. What they have is whatever
their accountant, their Odoo integrator or Intuit's developer site gave them:
a JSON file, four lines of `KEY=value`, an email with the URL on one line and
the password on another, or a single API key with no label at all.

So the product asks for one thing — paste it — and this module works out what
it is. Four input shapes are read: JSON (nested or flat), `.env` lines,
`key: value` lines, and a bare value with no key at all.

Two rules run through every line of this file.

**A value is never logged, never returned to a caller, and never leaves the
process.** Everything reported outward is a *key name* or a mask. The
`CredentialDraft` a caller gets back can be put straight on a job result, shown
in a browser and written to an audit log without anything being redacted first,
because there is nothing in it to redact.

**Aliases are resolved against the roles the source actually needs.** A key
called `token` means the API key for Odoo and is dangerously ambiguous for
QuickBooks, where it could be the refresh token or the client secret. Matching
per source rather than globally removes most of that ambiguity before anything
has to guess -- and what is left is what `LLMRouter.map_credential_names` is for,
which sees the names and never the values.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

# What each source needs before a connection can be attempted at all.
REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "excel": (),
    "quickbooks": ("client_id", "client_secret", "refresh_token", "realm_id"),
    "odoo": ("base_url", "database", "username", "api_key"),
}

# Fields that belong on the connection's public settings rather than in the
# vault. They are not secret -- an Odoo address is on the shop's letterhead --
# and keeping them out of the secret means the settings screen can show them.
PUBLIC_FIELDS: frozenset[str] = frozenset({"base_url", "database", "username", "realm_id", "sandbox"})

# Alias tables, per role, matched after `_normalise_key` has stripped case,
# spaces, dashes, underscores and any vendor prefix. Ordered longest-first
# within each role so `client_secret` cannot be claimed by the bare `secret`
# entry while a more specific key is still unmatched.
_ALIASES: dict[str, tuple[str, ...]] = {
    "client_id": ("clientid", "oauthclientid", "consumerkey", "appkey", "applicationid", "appid"),
    "client_secret": (
        "clientsecret", "oauthclientsecret", "consumersecret", "appsecret", "secretkey", "secret",
    ),
    "refresh_token": ("refreshtoken", "oauthrefreshtoken", "refresh"),
    "realm_id": ("realmid", "companyid", "realm", "company"),
    "base_url": (
        "baseurl", "instanceurl", "serverurl", "odoourl", "siteurl", "url", "host", "server",
        "address", "link", "domain",
    ),
    "database": ("databasename", "dbname", "database", "db"),
    "username": ("username", "userlogin", "useremail", "login", "user", "email"),
    "api_key": ("apikey", "apitoken", "accesskey", "userkey", "key", "token", "password", "pass"),
}

# Prefixes vendors and .env files put in front of everything. Stripped before
# alias matching, so `QUICKBOOKS_CLIENT_ID` and `clientId` resolve identically.
_PREFIXES = (
    "quickbooks", "quickbook", "qbo", "qb", "intuit", "odoo", "erp", "store", "shop",
    "hermes", "dataengine", "next", "public",
)

_URL = re.compile(r"^https?://", re.IGNORECASE)


def _normalise_key(key: str) -> str:
    """Lowercase, alphanumeric only, with any vendor prefix removed."""
    cleaned = re.sub(r"[^a-z0-9]+", "", str(key).lower())
    for prefix in _PREFIXES:
        if cleaned.startswith(prefix) and len(cleaned) > len(prefix):
            cleaned = cleaned[len(prefix) :]
            break
    return cleaned


def role_for(key: str, source: str) -> str | None:
    """
    Which credential role a key name plays for this source, or None.

    Restricted to the roles the source needs, which is what makes `token`
    unambiguous for Odoo (the API key) while leaving it unresolved for
    QuickBooks, where it could be either of two things and a guess would lock
    the shop out with an error that looks like their fault.
    """
    wanted = REQUIRED_FIELDS.get(source, ())
    if not wanted:
        return None

    normalised = _normalise_key(key)
    if not normalised:
        return None

    # Exact alias first, across the roles this source cares about.
    for role in wanted:
        if normalised in _ALIASES.get(role, ()):
            return role
    # Then a containment match, longest alias first so `clientsecret` beats
    # `secret` when a key is called `myclientsecretvalue`.
    candidates: list[tuple[int, str]] = []
    for role in wanted:
        for alias in _ALIASES.get(role, ()):
            if alias in normalised:
                candidates.append((len(alias), role))
    if candidates:
        candidates.sort(reverse=True)
        return candidates[0][1]
    return None


def mask(value: str) -> str:
    """
    A value rendered safe to show and to store in an audit row.

    Four characters at each end for anything long enough to have ends, and
    nothing at all for anything short -- a six-character secret shown as
    `ab**ef` is a secret with two characters left to guess.
    """
    text = str(value)
    if len(text) <= 12:
        return "•" * len(text)
    return f"{text[:4]}{'•' * 8}{text[-4:]}"


@dataclass
class CredentialDraft:
    """
    What was understood, in terms that carry no secret.

    `fields` is the only member holding values, and it is the one a caller
    passes to a connector and to the vault. Everything else -- `understood`,
    `unresolved`, `missing`, `masked` -- is names and shapes, and is what goes
    on a job result, on screen and into the audit log.
    """

    source: str
    fields: dict[str, str] = field(default_factory=dict)
    # role -> the key name it was read from, so a person can see what we did.
    understood: dict[str, str] = field(default_factory=dict)
    # Key names present in the paste that matched no role.
    unresolved: list[str] = field(default_factory=list)
    input_format: str = "unknown"
    notes: list[str] = field(default_factory=list)

    @property
    def missing(self) -> list[str]:
        return [
            role for role in REQUIRED_FIELDS.get(self.source, ()) if not self.fields.get(role)
        ]

    @property
    def complete(self) -> bool:
        return not self.missing

    @property
    def masked(self) -> dict[str, str]:
        """
        What to show the owner: the secret half masked, the public half in full.

        Masking an Odoo address hides the one thing they most need to check.
        The whole point of showing this back is "is that your shop?", and
        `http••••••••.com` cannot be confirmed or corrected by anybody. The
        split is `PUBLIC_FIELDS`, which is the same split that decides what
        goes to the vault -- so a field is shown in full here exactly when it
        is a setting rather than a secret.
        """
        return {
            role: (value if role in PUBLIC_FIELDS else mask(value))
            for role, value in sorted(self.fields.items())
        }

    def public(self) -> dict[str, Any]:
        """The half that belongs on the connection's settings, not in the vault."""
        return {role: value for role, value in self.fields.items() if role in PUBLIC_FIELDS}

    def secret(self) -> dict[str, str]:
        """The half that belongs in the vault and nowhere else."""
        return {role: value for role, value in self.fields.items() if role not in PUBLIC_FIELDS}

    def summary(self) -> dict[str, Any]:
        """
        Safe to return to a browser, verbatim.

        Deliberately not "safe once someone remembers to strip it". There is no
        value in here to strip.
        """
        return {
            "source": self.source,
            "format": self.input_format,
            "understood": dict(sorted(self.understood.items())),
            "masked": self.masked,
            "unresolved": sorted(self.unresolved),
            "missing": self.missing,
            "complete": self.complete,
            "notes": self.notes,
        }


def _flatten(payload: Any, prefix: str = "") -> Iterable[tuple[str, str]]:
    """
    Every leaf of a JSON document as (key, value).

    Nested because vendors nest: Intuit's own download wraps the values in an
    object per environment, and an integrator's handover file usually has the
    shop's name at the top.
    """
    if isinstance(payload, dict):
        for key, value in payload.items():
            yield from _flatten(value, str(key))
    elif isinstance(payload, list):
        for item in payload:
            yield from _flatten(item, prefix)
    elif payload is not None and not isinstance(payload, bool) and prefix:
        text = str(payload).strip()
        if text:
            yield prefix, text


def _lines(text: str) -> Iterable[tuple[str, str]]:
    """`KEY=value`, `key: value`, and `key value` from a pasted email or note."""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        # `export FOO=bar` from a shell snippet.
        if line.lower().startswith("export "):
            line = line[7:].strip()

        for separator in ("=", ":"):
            # A URL contains a colon, so a colon only separates when what is to
            # its left looks like a key rather than a scheme.
            index = line.find(separator)
            if index <= 0:
                continue
            key, value = line[:index].strip(), line[index + 1 :].strip()
            if separator == ":" and _URL.match(line):
                continue
            if not key or not value:
                continue
            yield key, value.strip().strip('"').strip("'").rstrip(",")
            break


def parse_credentials(text: str, source: str) -> CredentialDraft:
    """
    Read a pasted credential in whatever shape it arrived in.

    Never raises on unreadable input. A shop that pasted the wrong half of an
    email gets a draft that says what it found and what is still missing, which
    is a thing they can act on; an exception is not.
    """
    draft = CredentialDraft(source=source)
    blob = (text or "").strip()
    if not blob:
        draft.notes.append("nothing was pasted")
        return draft

    pairs: list[tuple[str, str]] = []

    try:
        parsed = json.loads(blob)
    except (TypeError, ValueError):
        parsed = None

    if parsed is not None and isinstance(parsed, (dict, list)):
        draft.input_format = "json"
        pairs = list(_flatten(parsed))
    else:
        pairs = list(_lines(blob))
        draft.input_format = "lines" if pairs else "value"

    if not pairs:
        # A bare value with no key. Only actionable when the source needs
        # exactly one secret, which is the Odoo case and the common one: an
        # integrator sends the API key on its own and everything else is
        # already on the connection.
        wanted = REQUIRED_FIELDS.get(source, ())
        if _URL.match(blob) and "base_url" in wanted:
            draft.fields["base_url"] = blob
            draft.understood["base_url"] = "(the address on its own)"
            draft.input_format = "url"
        elif len(wanted) == 4 and source == "odoo" and "\n" not in blob and len(blob) < 200:
            draft.fields["api_key"] = blob
            draft.understood["api_key"] = "(a key on its own)"
        else:
            draft.notes.append(
                "this does not look like a credential file. Paste the whole thing your "
                "accountant or integrator sent, including the labels."
            )
        return draft

    for key, value in pairs:
        role = role_for(key, source)
        if role is None:
            if key not in draft.unresolved:
                draft.unresolved.append(key)
            continue
        # First match wins. A file that lists a key twice usually lists the
        # live one first and a commented example second.
        if role not in draft.fields:
            draft.fields[role] = value
            draft.understood[role] = key

    if "base_url" in draft.fields and not _URL.match(draft.fields["base_url"]):
        # An integrator writes `mystore.odoo.com` as often as the full address.
        draft.fields["base_url"] = f"https://{draft.fields['base_url'].lstrip('/')}"
        draft.notes.append("the address had no https:// on it, so one was added")

    return draft


def apply_mapping(draft: CredentialDraft, mapping: dict[str, str], raw: str) -> CredentialDraft:
    """
    Fill roles from a name-to-role mapping decided elsewhere.

    The mapping comes from `LLMRouter.map_credential_names`, which is given the
    key names and never the values. This is where those names are turned back
    into values, inside this process, against the text that never left it.
    """
    pairs = dict(_lines(raw))
    if not pairs:
        try:
            pairs = dict(_flatten(json.loads(raw)))
        except (TypeError, ValueError):
            pairs = {}

    for key, role in mapping.items():
        if role not in REQUIRED_FIELDS.get(draft.source, ()):
            continue
        if draft.fields.get(role):
            continue
        value = pairs.get(key)
        if not value:
            continue
        draft.fields[role] = value
        draft.understood[role] = key
        if key in draft.unresolved:
            draft.unresolved.remove(key)
        draft.notes.append(f"{key} was read as the {role.replace('_', ' ')} by the agent")

    return draft


__all__ = [
    "PUBLIC_FIELDS",
    "REQUIRED_FIELDS",
    "CredentialDraft",
    "apply_mapping",
    "mask",
    "parse_credentials",
    "role_for",
]
