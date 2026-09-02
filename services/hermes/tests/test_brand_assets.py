"""
Finding images inside an uploaded workbook, and declining to decide.

The behaviour worth protecting here is the refusal. A month-end workbook holds a
logo, a product photograph, a chart and sometimes a scanned signature, and the
product's answer is "here is what we found, you choose" rather than a confident
pick that ends up on a year of client documents.

So these tests check two things: that the list is complete and ordered
sensibly, and that nothing in the module ever promotes a candidate on its own.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

from hermes.tools import brand_assets

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures" / "messy"


def _image(width: int, height: int, *, colours: int = 2, alpha: bool = True, fmt: str = "PNG") -> bytes:
    """A synthetic picture with a controllable number of distinct colours."""
    from PIL import Image

    image = Image.new("RGBA" if alpha else "RGB", (width, height), (255, 255, 255, 0))
    pixels = image.load()
    for x in range(width):
        for y in range(height):
            index = (x + y) % max(colours, 1)
            shade = int(255 * index / max(colours - 1, 1))
            pixels[x, y] = (
                (shade, (shade * 3) % 256, (shade * 7) % 256, 255)
                if alpha
                else (shade, (shade * 3) % 256, (shade * 7) % 256)
            )
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return buffer.getvalue()


def _container(entries: dict[str, bytes], marker: str = "xl/workbook.xml") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(marker, "<workbook/>")
        for name, payload in entries.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


def test_a_workbook_with_no_images_yields_nothing():
    assert brand_assets.discover_images(_container({}), "book.xlsx") == []


def test_a_csv_is_not_opened_as_a_container():
    assert brand_assets.discover_images(b"a,b\n1,2\n", "ledger.csv") == []
    assert brand_assets.is_container("ledger.csv") is False
    assert brand_assets.is_container("Ledger.XLSX") is True


def test_a_corrupt_container_costs_the_suggestion_not_the_upload():
    # Discovery runs after a parse that has already succeeded. A zip directory
    # this module cannot read must not turn a good upload into a failure.
    assert brand_assets.discover_images(b"PK\x03\x04 truncated", "book.xlsx") == []


def test_every_embedded_image_is_listed():
    data = _container(
        {
            "xl/media/image1.png": _image(240, 80),
            "xl/media/image2.png": _image(600, 400, colours=64, alpha=False),
        }
    )
    found = brand_assets.discover_images(data, "January.xlsx")
    assert {candidate.name for candidate in found} == {"image1.png", "image2.png"}


def test_word_and_powerpoint_containers_are_read_too():
    for member, prefix, filename in (
        ("word/document.xml", "word/media/", "letter.docx"),
        ("ppt/presentation.xml", "ppt/media/", "deck.pptx"),
    ):
        data = _container({f"{prefix}logo.png": _image(240, 80)}, marker=member)
        found = brand_assets.discover_images(data, filename)
        assert [candidate.name for candidate in found] == ["logo.png"]


def test_a_logo_outranks_a_photograph():
    # The ordering the "images found in this file" list uses. A wordmark-shaped,
    # transparent, few-coloured PNG at the front of the container should sort
    # above a large opaque photograph, and neither is applied to anything.
    data = _container(
        {
            "xl/media/image1.png": _image(240, 80, colours=3),
            "xl/media/image2.jpeg": _image(900, 700, colours=4000, alpha=False, fmt="JPEG"),
        }
    )
    found = brand_assets.discover_images(data, "January.xlsx")

    assert found[0].name == "image1.png"
    assert found[0].score > found[1].score
    assert any("transparent" in reason for reason in found[0].reasons)


def test_every_candidate_explains_its_score():
    data = _container({"xl/media/image1.png": _image(240, 80, colours=3)})
    candidate = brand_assets.discover_images(data, "January.xlsx")[0]

    assert candidate.reasons, "a score with no reasons is a machine asking to be trusted"
    assert 0 < candidate.score <= 1


def test_an_image_that_cannot_be_a_logo_is_listed_and_marked_unusable():
    # A 12×12 icon is a real image and a bad logo. Listing it with the reason
    # beats silently dropping it, because the person looking for their logo
    # would otherwise wonder where the picture they can see in the file went.
    data = _container({"xl/media/image1.png": _image(12, 12)})
    candidate = brand_assets.discover_images(data, "January.xlsx")[0]

    assert candidate.rejected is not None
    assert candidate.score == 0.0
    assert candidate.to_row()["usable"] is False


def test_a_non_image_in_the_media_folder_is_ignored():
    data = _container({"xl/media/notes.txt": b"not a picture"})
    assert brand_assets.discover_images(data, "January.xlsx") == []


def test_the_row_carries_what_the_database_stores_and_not_the_bytes():
    data = _container({"xl/media/image1.png": _image(240, 80)})
    row = brand_assets.discover_images(data, "January.xlsx")[0].to_row()

    assert set(row) == {
        "source_name",
        "mime_type",
        "width",
        "height",
        "byte_size",
        "sha256",
        "score",
        "reasons",
        "usable",
        "rejected_reason",
    }
    assert len(row["sha256"]) == 64


def test_the_same_image_twice_has_the_same_digest():
    # What makes re-uploading January idempotent: the unique constraint on
    # (organization_id, sha256) turns twelve months of the same letterhead into
    # one row somebody has already dismissed.
    payload = _image(240, 80)
    first = brand_assets.discover_images(_container({"xl/media/a.png": payload}), "a.xlsx")[0]
    second = brand_assets.discover_images(_container({"xl/media/b.png": payload}), "b.xlsx")[0]
    assert first.sha256 == second.sha256


def test_a_real_customer_workbook_is_read_without_incident():
    # The fixtures carry no pictures. The assertion is that asking costs
    # nothing and returns an honest empty answer on a real file.
    workbook = FIXTURES / "acme-sales-2026-08.xlsx"
    assert brand_assets.discover_images(workbook.read_bytes(), workbook.name) == []


def test_a_picture_library_is_bounded():
    data = _container(
        {f"xl/media/image{index}.png": _image(240, 80) for index in range(1, 40)}
    )
    assert len(brand_assets.discover_images(data, "big.xlsx")) <= brand_assets.MAX_CANDIDATES
