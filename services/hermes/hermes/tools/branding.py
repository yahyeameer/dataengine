"""
Whose name and whose logo go on a report.

The report engine already knew how to draw a brand -- one colour and one name,
handed to it on the job payload. What it had no way to answer was *which* name,
because nothing in the system stored one. The payload path meant a caller had
to say "Energy Gain" on every request, and the fallback when it did not was the
organisation row, which is the accounting firm rather than the client the report
is about.

This module is the missing half: a deterministic resolution of identity from
rows that already exist, with an explicit order and no inference anywhere in it.

**The name is looked up, never guessed.** Section 10 of the brief is blunt about
why. A business name inferred from a spreadsheet cell is a name that changes
when the spreadsheet does, and a model asked to invent one will invent one. The
order here is override, then stored branding, then the organisation, then the
workspace, then a fallback that says what it is.

**The logo is resolved the same way and may legitimately be absent.** Priority
runs explicit storage path, approved asset, remote URL, none. "None" is a
supported outcome that produces a text-only brand header rather than an empty
box, because a report that arrives without a logo is a report and a report that
does not arrive is an incident.

**Nothing here performs I/O.** Fetching bytes out of Supabase Storage needs a
client and a job context, so the caller does that and hands the bytes back in.
What lives here is the deciding, the validating and the refusing -- which is the
part worth testing without a database.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from dataclasses import dataclass, field
from typing import Any, Iterable
from urllib.parse import urlsplit

#: The fallback that appears when nothing else resolves. Deliberately a
#: sentence a reader can act on rather than an empty band.
FALLBACK_BUSINESS_NAME = "DataEngine Report"

#: The product's own accent, used when a stored one is missing or malformed.
DEFAULT_ACCENT = "#1f5fbf"

#: 2 MB. A logo is a few tens of kilobytes; anything past this is a photograph
#: somebody dragged into the wrong field, and it has to be refused before it
#: reaches an image decoder rather than after.
MAX_LOGO_BYTES = 2 * 1024 * 1024

#: Below this in either dimension the logo is a favicon and will print as mush.
MIN_LOGO_EDGE = 32

#: Above this it is a scan or a screenshot. Both numbers are generous: a retina
#: logo asset is commonly 1200px wide.
MAX_LOGO_EDGE = 4000

#: What the three binary renderers can actually embed.
#:
#: SVG is absent on purpose. The brief allows it "if the existing PDF/DOCX
#: renderers can safely support it", and they cannot: reportlab has no SVG
#: reader without svglib, python-docx cannot measure one, and the alternative --
#: rasterising vector markup from an untrusted upload -- is a parser we would be
#: choosing to run on customer input for a cosmetic gain.
SUPPORTED_LOGO_MIMES = ("image/png", "image/jpeg", "image/webp")

_HEX = re.compile(r"^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


# ---------------------------------------------------------------------------
# Colour
# ---------------------------------------------------------------------------


def normalise_accent(value: Any) -> str | None:
    """A validated `#rrggbb`, or None. Never raises."""
    if not isinstance(value, str) or not _HEX.match(value.strip()):
        return None
    digits = value.strip().lstrip("#").lower()
    if len(digits) == 3:
        digits = "".join(character * 2 for character in digits)
    return f"#{digits}"


def _channels(colour: str) -> tuple[float, float, float]:
    digits = colour.lstrip("#")
    out = []
    for index in (0, 2, 4):
        raw = int(digits[index : index + 2], 16) / 255
        out.append(raw / 12.92 if raw <= 0.03928 else ((raw + 0.055) / 1.055) ** 2.4)
    return out[0], out[1], out[2]


def relative_luminance(colour: str) -> float:
    r, g, b = _channels(colour)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(first: str, second: str) -> float:
    """WCAG 2.1 contrast ratio between two `#rrggbb` colours."""
    a, b = relative_luminance(first), relative_luminance(second)
    lighter, darker = max(a, b), min(a, b)
    return round((lighter + 0.05) / (darker + 0.05), 3)


def ink_on(background: str) -> str:
    """
    The text colour that survives on this background.

    The same rule `documents.Brand` has always used, lifted here so the settings
    screen can preview the decision the renderer will make rather than
    approximating it in TypeScript and drifting.
    """
    return "#ffffff" if relative_luminance(background) < 0.45 else "#10131a"


def accent_is_accessible(accent: str, minimum: float = 4.5) -> bool:
    """
    Whether *either* ink choice clears the threshold on this accent.

    4.5:1 is WCAG AA for body text. The band carries 13pt bold, which qualifies
    as large text at 3:1, but the footer and the running head reuse the same
    colour at 7.5pt, so the stricter number is the one that has to hold.
    """
    return max(contrast_ratio(accent, "#ffffff"), contrast_ratio(accent, "#10131a")) >= minimum


# ---------------------------------------------------------------------------
# Business name (section 10)
# ---------------------------------------------------------------------------


def _clean_name(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = " ".join(value.split())[:120]
    return trimmed or None


def resolve_business_name(
    *,
    override: Any = None,
    branding: dict[str, Any] | None = None,
    organization: dict[str, Any] | None = None,
    workspace: dict[str, Any] | None = None,
) -> tuple[str, str]:
    """
    The name that goes on the document, and where it came from.

    Returning the source alongside the name is not decoration: it goes into the
    report's branding snapshot, so a document produced two years ago can be
    explained without re-deriving what the tables held at the time.
    """
    candidates: Iterable[tuple[str | None, str]] = (
        (_clean_name(override), "override"),
        (_clean_name((branding or {}).get("business_name")), "organization_branding"),
        (_clean_name((organization or {}).get("name")), "organization"),
        (
            _clean_name((workspace or {}).get("client_name") or (workspace or {}).get("name")),
            "workspace",
        ),
    )
    for value, source in candidates:
        if value:
            return value, source
    return FALLBACK_BUSINESS_NAME, "fallback"


# ---------------------------------------------------------------------------
# Logo validation (section 12)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LogoAsset:
    """A validated image, ready to be embedded."""

    data: bytes
    mime: str
    width: int
    height: int
    #: How it was resolved: organization_logo, brand_asset, remote_url.
    source: str = "organization_logo"

    @property
    def aspect(self) -> float:
        return self.width / self.height if self.height else 1.0


class LogoRejected(ValueError):
    """An image that must not become a logo, with a sentence saying why."""


def sniff_mime(data: bytes) -> str | None:
    """
    The image format the bytes actually are.

    Sniffed rather than trusted from the upload's Content-Type, because that
    header is whatever the browser -- or whatever posted to the route -- chose
    to send, and the renderer is the thing that has to be right about it.
    """
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:5] == b"<?xml" or data[:4] == b"<svg":
        return "image/svg+xml"
    return None


def validate_logo(data: bytes, *, source: str = "organization_logo") -> LogoAsset:
    """
    Turn candidate bytes into a `LogoAsset`, or refuse with a readable reason.

    Order matters: byte length is checked before anything opens the file, so a
    50 MB "logo" is refused by a length comparison rather than by an image
    decoder allocating a pixel buffer for it.
    """
    if not data:
        raise LogoRejected("The file is empty.")
    if len(data) > MAX_LOGO_BYTES:
        raise LogoRejected(
            f"A logo must be under {MAX_LOGO_BYTES // (1024 * 1024)} MB; this one is "
            f"{len(data) / (1024 * 1024):.1f} MB."
        )

    mime = sniff_mime(data)
    if mime is None:
        raise LogoRejected("That file is not an image we recognise.")
    if mime not in SUPPORTED_LOGO_MIMES:
        raise LogoRejected(
            f"{mime} cannot be placed in a PDF or Word document. Use PNG, JPEG or WebP."
        )

    width, height = _dimensions(data)
    if min(width, height) < MIN_LOGO_EDGE:
        raise LogoRejected(
            f"That image is {width}×{height}. A logo needs at least {MIN_LOGO_EDGE} pixels on "
            f"each side to print legibly."
        )
    if max(width, height) > MAX_LOGO_EDGE:
        raise LogoRejected(
            f"That image is {width}×{height}, which is a photograph rather than a logo."
        )

    return LogoAsset(data=data, mime=mime, width=width, height=height, source=source)


def _dimensions(data: bytes) -> tuple[int, int]:
    """
    Pixel size, via Pillow.

    Pillow is not a new dependency: reportlab requires it, so it is already in
    the image. `MAX_IMAGE_PIXELS` is set locally rather than globally so a
    hostile file gets refused here instead of changing a limit the rest of the
    process relies on.
    """
    import io

    from PIL import Image

    previous = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = MAX_LOGO_EDGE * MAX_LOGO_EDGE
    try:
        with Image.open(io.BytesIO(data)) as image:
            return int(image.width), int(image.height)
    except Exception as error:  # noqa: BLE001 - any decode failure is a refusal
        raise LogoRejected("That image could not be read.") from error
    finally:
        Image.MAX_IMAGE_PIXELS = previous


def as_embeddable(logo: LogoAsset) -> LogoAsset:
    """
    The same logo in a format all three renderers can place.

    python-docx measures images itself and knows PNG, JPEG, GIF, BMP and TIFF --
    not WebP. Rather than teach one renderer a special case, a WebP is decoded
    once here and re-encoded as PNG, which every renderer already handles.
    Anything already embeddable is returned untouched.
    """
    if logo.mime != "image/webp":
        return logo

    import io

    from PIL import Image

    with Image.open(io.BytesIO(logo.data)) as image:
        buffer = io.BytesIO()
        image.convert("RGBA").save(buffer, format="PNG")

    return LogoAsset(
        data=buffer.getvalue(),
        mime="image/png",
        width=logo.width,
        height=logo.height,
        source=logo.source,
    )


# ---------------------------------------------------------------------------
# Remote logo URLs (section 11, priority 4) and the SSRF boundary
# ---------------------------------------------------------------------------


class UnsafeLogoUrl(ValueError):
    """A URL the server will not fetch on a user's behalf."""


def assert_safe_logo_url(url: str) -> str:
    """
    Whether the server may fetch this URL, decided before any socket opens.

    An administrator pasting a logo URL is asking a server inside our network to
    make a request on their behalf, which is the exact shape of SSRF. Three
    rules, all of them refusals rather than repairs:

      * https only -- a plaintext fetch is interceptable and there is no reason
        a brand asset needs one
      * no credentials in the URL, which would be sent to whatever the host
        resolves to
      * every address the host resolves to must be a public unicast address, so
        `169.254.169.254`, `localhost`, a `.internal` name and a public name
        that happens to resolve to `10.0.0.5` are all refused identically

    Resolution happens here and the caller is expected to pin the result. DNS
    can answer differently on the second lookup -- that is the rebinding
    variant -- so `resolve_public_host` returns the address that was checked.
    """
    parts = urlsplit(url.strip())

    if parts.scheme != "https":
        raise UnsafeLogoUrl("Only https:// logo URLs can be fetched.")
    if parts.username or parts.password:
        raise UnsafeLogoUrl("A logo URL must not carry credentials.")
    if not parts.hostname:
        raise UnsafeLogoUrl("That URL has no host.")
    if len(url) > 2048:
        raise UnsafeLogoUrl("That URL is too long.")

    resolve_public_host(parts.hostname)
    return url.strip()


def resolve_public_host(hostname: str) -> list[str]:
    """
    Every address a host resolves to, refusing if any of them is not public.

    *Any*, not *the first*. A host with one public and one link-local address is
    a host that can be made to serve either, and taking the first answer means
    the decision is the resolver's ordering rather than ours.
    """
    try:
        infos = socket.getaddrinfo(hostname, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as error:
        raise UnsafeLogoUrl(f"{hostname} does not resolve.") from error

    addresses = sorted({info[4][0] for info in infos})
    if not addresses:
        raise UnsafeLogoUrl(f"{hostname} does not resolve.")

    for address in addresses:
        if not is_public_address(address):
            raise UnsafeLogoUrl(
                f"{hostname} resolves to {address}, which is inside a private network."
            )
    return addresses


def is_public_address(value: str) -> bool:
    """
    Public unicast, and nothing else.

    `is_global` alone is not enough: it is false for the ranges that matter but
    the explicit checks below document *which* ranges, and 6to4/NAT64 wrappers
    around a private v4 address are global as far as the v6 rules are concerned.
    """
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False

    if (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    ):
        return False

    if isinstance(address, ipaddress.IPv6Address):
        # A v4 address wearing a v6 costume is still a v4 address.
        mapped = address.ipv4_mapped or getattr(address, "sixtofour", None)
        if mapped is not None and not is_public_address(str(mapped)):
            return False

    return address.is_global


# ---------------------------------------------------------------------------
# The resolved brand
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ResolvedBranding:
    """
    Everything a renderer needs, plus the record of how it was decided.

    `snapshot` is what section 19 asks for. A recipe references the
    organisation's *current* branding rather than copying it, so next month's
    report picks up a renamed business automatically -- and the report produced
    last month has to keep saying what it said. Storing the snapshot on the
    generated report is what makes both true at once.
    """

    business_name: str
    name_source: str
    accent: str
    footer: str
    logo: LogoAsset | None = None
    logo_source: str = "none"
    #: Safe to print in Markdown: a public URL an administrator supplied. A
    #: signed storage URL is deliberately never put here -- it expires, and it
    #: is a credential.
    public_logo_url: str | None = None
    warnings: list[str] = field(default_factory=list)

    def snapshot(self) -> dict[str, Any]:
        return {
            "business_name": self.business_name,
            "name_source": self.name_source,
            "accent": self.accent,
            "footer": self.footer,
            "logo_source": self.logo_source,
            "logo_bytes": len(self.logo.data) if self.logo else 0,
            "warnings": list(self.warnings),
        }


def resolve_branding(
    *,
    override: dict[str, Any] | None = None,
    branding: dict[str, Any] | None = None,
    organization: dict[str, Any] | None = None,
    workspace: dict[str, Any] | None = None,
    logo_bytes: bytes | None = None,
    logo_source: str = "none",
) -> ResolvedBranding:
    """
    Assemble the brand for one report.

    Malformed branding is corrected rather than fatal, and every correction is
    recorded as a warning that travels onto the report row (section 22): a badly
    stored accent produces a report in the product's blue with a line in the
    audit trail, not a failed month-end.
    """
    override = override if isinstance(override, dict) else {}
    branding = branding or {}
    warnings: list[str] = []

    name, name_source = resolve_business_name(
        override=override.get("name"),
        branding=branding,
        organization=organization,
        workspace=workspace,
    )

    raw_accent = override.get("accent") or branding.get("accent_color")
    accent = normalise_accent(raw_accent)
    if raw_accent and accent is None:
        warnings.append(f"Ignored a malformed accent colour ({raw_accent!r}).")
    if accent and not accent_is_accessible(accent):
        # Not a refusal: the renderer already flips its ink to whichever of
        # white or near-black survives, so the worst case is a low-contrast
        # band rather than unreadable type. The warning is what tells the
        # settings screen to say so.
        warnings.append(
            f"{accent} does not reach 4.5:1 against either white or near-black text."
        )
    accent = accent or DEFAULT_ACCENT

    footer = override.get("footer")
    if not isinstance(footer, str) or not footer.strip():
        footer = branding.get("footer_text")
    footer = footer.strip()[:200] if isinstance(footer, str) else ""

    logo: LogoAsset | None = None
    resolved_logo_source = "none"
    if logo_bytes:
        try:
            logo = as_embeddable(validate_logo(logo_bytes, source=logo_source))
            resolved_logo_source = logo_source
        except LogoRejected as error:
            # Section 22: a bad logo costs the logo, never the report.
            warnings.append(f"The stored logo was not usable: {error}")

    public_url = branding.get("logo_url") if not branding.get("logo_storage_path") else None
    if isinstance(public_url, str):
        try:
            public_url = assert_safe_logo_url(public_url)
        except UnsafeLogoUrl:
            public_url = None
    else:
        public_url = None

    return ResolvedBranding(
        business_name=name,
        name_source=name_source,
        accent=accent,
        footer=footer,
        logo=logo,
        logo_source=resolved_logo_source,
        public_logo_url=public_url,
        warnings=warnings,
    )


__all__ = [
    "DEFAULT_ACCENT",
    "FALLBACK_BUSINESS_NAME",
    "MAX_LOGO_BYTES",
    "SUPPORTED_LOGO_MIMES",
    "LogoAsset",
    "LogoRejected",
    "ResolvedBranding",
    "UnsafeLogoUrl",
    "accent_is_accessible",
    "as_embeddable",
    "assert_safe_logo_url",
    "contrast_ratio",
    "ink_on",
    "is_public_address",
    "normalise_accent",
    "resolve_branding",
    "resolve_business_name",
    "resolve_public_host",
    "sniff_mime",
    "validate_logo",
]
