"""
Organisation branding: the name, the colour and the logo.

The rules under test are the ones that decide what a client sees on a document
with their accountant's name on it, so they are asserted directly rather than
through a rendered file. Three of them matter more than the rest:

  * the business name is *looked up*, in a fixed order, and never inferred;
  * a bad logo costs the logo and never the report;
  * a logo URL is a request this server makes on a user's behalf, so the
    refusals around it are security behaviour, not validation.
"""

from __future__ import annotations

import io

import pytest

from hermes.tools import branding


def _png(width: int = 240, height: int = 80, alpha: bool = True) -> bytes:
    from PIL import Image

    image = Image.new("RGBA" if alpha else "RGB", (width, height), (24, 80, 200, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _jpeg(width: int = 200, height: int = 200) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (200, 40, 40)).save(buffer, format="JPEG")
    return buffer.getvalue()


def _webp(width: int = 300, height: int = 90) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGBA", (width, height), (12, 140, 90, 255)).save(buffer, format="WEBP")
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# The name (section 10)
# ---------------------------------------------------------------------------


def test_the_resolution_order_is_the_one_the_brief_specifies():
    branding_row = {"business_name": "Energy Gain"}
    organization = {"name": "Acme Accounting"}
    workspace = {"name": "Acme ws", "client_name": "Kentex Cargo"}

    assert branding.resolve_business_name(
        override="Override Ltd",
        branding=branding_row,
        organization=organization,
        workspace=workspace,
    ) == ("Override Ltd", "override")

    assert branding.resolve_business_name(
        branding=branding_row, organization=organization, workspace=workspace
    ) == ("Energy Gain", "organization_branding")

    assert branding.resolve_business_name(
        organization=organization, workspace=workspace
    ) == ("Acme Accounting", "organization")

    assert branding.resolve_business_name(workspace=workspace) == ("Kentex Cargo", "workspace")

    assert branding.resolve_business_name() == (branding.FALLBACK_BUSINESS_NAME, "fallback")


def test_a_blank_name_does_not_count_as_a_name():
    # The difference between "set to empty" and "not set" decides whether the
    # report falls through to the organisation or prints whitespace in the band.
    name, source = branding.resolve_business_name(
        branding={"business_name": "   "}, organization={"name": "Acme Accounting"}
    )
    assert (name, source) == ("Acme Accounting", "organization")


def test_a_name_is_trimmed_and_bounded_rather_than_drawn_off_the_page():
    name, _source = branding.resolve_business_name(override="  Energy   Gain  ")
    assert name == "Energy Gain"

    long_name, _source = branding.resolve_business_name(override="A" * 400)
    assert len(long_name) == 120


# ---------------------------------------------------------------------------
# Colour and contrast
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        ("#8a1538", "#8a1538"),
        ("8A1538", "#8a1538"),
        ("#abc", "#aabbcc"),
        ("rgb(1,2,3)", None),
        ("", None),
        (None, None),
        (42, None),
        (["#fff"], None),
    ],
)
def test_only_a_real_hex_colour_survives_validation(value, expected):
    assert branding.normalise_accent(value) == expected


def test_contrast_matches_the_wcag_reference_values():
    # Black on white is 21:1 exactly; anything else in the product is compared
    # against the same formula, so this pins the formula rather than a colour.
    assert branding.contrast_ratio("#000000", "#ffffff") == 21.0
    assert branding.contrast_ratio("#ffffff", "#ffffff") == 1.0


def test_the_ink_flips_on_a_pale_brand_colour():
    assert branding.ink_on("#0b1f4b") == "#ffffff"
    assert branding.ink_on("#f5e6a8") == "#10131a"


def test_an_inaccessible_accent_is_reported_rather_than_refused():
    # A mid-grey that clears neither white nor near-black by 4.5:1. The report
    # is still produced; the warning is what reaches the settings screen.
    resolved = branding.resolve_branding(branding={"accent_color": "#7a7a7a", "business_name": "X"})
    assert resolved.accent == "#7a7a7a"
    assert any("4.5:1" in warning for warning in resolved.warnings)


def test_a_malformed_accent_falls_back_and_says_so():
    resolved = branding.resolve_branding(branding={"accent_color": "not-a-colour"})
    assert resolved.accent == branding.DEFAULT_ACCENT
    assert any("malformed" in warning for warning in resolved.warnings)


# ---------------------------------------------------------------------------
# Logo validation (section 12)
# ---------------------------------------------------------------------------


def test_a_good_logo_is_accepted_with_its_real_dimensions():
    asset = branding.validate_logo(_png(240, 80))
    assert asset.mime == "image/png"
    assert (asset.width, asset.height) == (240, 80)
    assert asset.aspect == 3.0


def test_the_format_is_sniffed_not_taken_on_trust():
    assert branding.sniff_mime(_png()) == "image/png"
    assert branding.sniff_mime(_jpeg()) == "image/jpeg"
    assert branding.sniff_mime(_webp()) == "image/webp"
    assert branding.sniff_mime(b"<svg xmlns='http://www.w3.org/2000/svg'/>") == "image/svg+xml"
    assert branding.sniff_mime(b"not an image at all") is None


def test_an_svg_is_refused_because_no_renderer_can_place_one():
    with pytest.raises(branding.LogoRejected, match="PNG, JPEG or WebP"):
        branding.validate_logo(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>")


def test_a_file_that_is_not_an_image_is_refused():
    with pytest.raises(branding.LogoRejected, match="not an image"):
        branding.validate_logo(b"PK\x03\x04 this is a zip")


def test_an_empty_file_is_refused():
    with pytest.raises(branding.LogoRejected, match="empty"):
        branding.validate_logo(b"")


def test_an_oversized_file_is_refused_before_it_is_decoded():
    with pytest.raises(branding.LogoRejected, match="under 2 MB"):
        branding.validate_logo(b"\x89PNG\r\n\x1a\n" + b"\x00" * branding.MAX_LOGO_BYTES)


def test_a_favicon_sized_image_is_refused():
    with pytest.raises(branding.LogoRejected, match="16×16"):
        branding.validate_logo(_png(16, 16))


def test_a_photograph_sized_image_is_refused():
    with pytest.raises(branding.LogoRejected, match="photograph"):
        branding.validate_logo(_png(5000, 40))


def test_a_webp_is_re_encoded_so_word_can_place_it():
    # python-docx measures images itself and does not know WebP. Rather than
    # teach one renderer a special case, the conversion happens once here.
    asset = branding.as_embeddable(branding.validate_logo(_webp()))
    assert asset.mime == "image/png"
    assert asset.data[:8] == b"\x89PNG\r\n\x1a\n"
    assert (asset.width, asset.height) == (300, 90)


def test_a_png_is_left_alone():
    original = branding.validate_logo(_png())
    assert branding.as_embeddable(original) is original


# ---------------------------------------------------------------------------
# Remote logo URLs and SSRF (section 23)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/logo.png",
        "ftp://example.com/logo.png",
        "https://user:pass@example.com/logo.png",
        "https:///logo.png",
        "file:///etc/passwd",
    ],
)
def test_a_url_that_is_not_a_plain_https_url_is_refused(url):
    with pytest.raises(branding.UnsafeLogoUrl):
        branding.assert_safe_logo_url(url)


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.0.0.5",
        "192.168.1.10",
        "172.16.4.4",
        "169.254.169.254",  # the cloud metadata endpoint
        "0.0.0.0",
        "::1",
        "fd00::1",
        "fe80::1",
        "::ffff:10.0.0.5",  # a private v4 wearing a v6 costume
        "2002:0a00:0005::",  # 6to4 wrapping 10.0.0.5
        "not-an-address",
    ],
)
def test_no_private_or_special_address_is_ever_fetchable(address):
    assert branding.is_public_address(address) is False


@pytest.mark.parametrize("address", ["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"])
def test_ordinary_public_addresses_are_allowed(address):
    assert branding.is_public_address(address) is True


def test_a_hostname_resolving_into_a_private_network_is_refused(monkeypatch):
    # The interesting case: a perfectly ordinary public hostname whose DNS
    # answer points inside the VPC. Nothing about the URL looks wrong.
    monkeypatch.setattr(
        branding.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("10.0.0.5", 443))],
    )
    with pytest.raises(branding.UnsafeLogoUrl, match="private network"):
        branding.assert_safe_logo_url("https://logo.example.com/logo.png")


def test_a_host_with_one_bad_answer_among_several_is_refused(monkeypatch):
    # Taking the first answer would make the decision the resolver's ordering.
    monkeypatch.setattr(
        branding.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (2, 1, 6, "", ("93.184.216.34", 443)),
            (2, 1, 6, "", ("127.0.0.1", 443)),
        ],
    )
    with pytest.raises(branding.UnsafeLogoUrl):
        branding.assert_safe_logo_url("https://logo.example.com/logo.png")


def test_a_public_host_is_allowed_and_its_addresses_reported(monkeypatch):
    monkeypatch.setattr(
        branding.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("93.184.216.34", 443))],
    )
    assert branding.assert_safe_logo_url(" https://logo.example.com/logo.png ") == (
        "https://logo.example.com/logo.png"
    )
    assert branding.resolve_public_host("logo.example.com") == ["93.184.216.34"]


# ---------------------------------------------------------------------------
# Assembling the whole brand (sections 14 and 22)
# ---------------------------------------------------------------------------


def test_a_report_with_no_branding_at_all_still_resolves():
    resolved = branding.resolve_branding()
    assert resolved.business_name == branding.FALLBACK_BUSINESS_NAME
    assert resolved.accent == branding.DEFAULT_ACCENT
    assert resolved.logo is None
    assert resolved.logo_source == "none"


def test_a_broken_stored_logo_costs_the_logo_and_not_the_report():
    resolved = branding.resolve_branding(
        branding={"business_name": "Energy Gain"},
        logo_bytes=b"this is not an image",
        logo_source="organization_logo",
    )
    assert resolved.business_name == "Energy Gain"
    assert resolved.logo is None
    assert any("not usable" in warning for warning in resolved.warnings)


def test_a_good_logo_arrives_with_its_source_recorded():
    resolved = branding.resolve_branding(
        branding={"business_name": "Energy Gain"},
        logo_bytes=_png(),
        logo_source="brand_asset",
    )
    assert resolved.logo is not None
    assert resolved.logo_source == "brand_asset"
    assert resolved.snapshot()["logo_source"] == "brand_asset"


def test_a_private_logo_never_becomes_a_markdown_url():
    # Markdown cannot show a private object, and a signed URL is a credential.
    resolved = branding.resolve_branding(
        branding={
            "business_name": "Energy Gain",
            "logo_storage_path": "organizations/org-1/branding/logo",
            "logo_url": "https://cdn.example.com/logo.png",
        },
        logo_bytes=_png(),
    )
    assert resolved.public_logo_url is None


def test_an_unsafe_public_url_is_dropped_rather_than_printed(monkeypatch):
    monkeypatch.setattr(
        branding.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("127.0.0.1", 443))],
    )
    resolved = branding.resolve_branding(
        branding={"business_name": "Energy Gain", "logo_url": "https://logo.internal/logo.png"}
    )
    assert resolved.public_logo_url is None


def test_the_snapshot_records_what_the_document_actually_said():
    # Section 19: branding is referenced, not copied, so the only record of what
    # a historical document said is the snapshot taken when it was rendered.
    resolved = branding.resolve_branding(
        branding={
            "business_name": "Energy Gain",
            "accent_color": "#8a1538",
            "footer_text": "energygain.example",
        },
        logo_bytes=_png(),
    )
    snapshot = resolved.snapshot()
    assert snapshot["business_name"] == "Energy Gain"
    assert snapshot["accent"] == "#8a1538"
    assert snapshot["footer"] == "energygain.example"
    assert snapshot["name_source"] == "organization_branding"
    assert snapshot["logo_bytes"] > 0
