"""
Finding the images inside a customer's workbook, and refusing to guess.

Office formats are zip containers, so an uploaded .xlsx that has the client's
letterhead pasted into cell A1 is already carrying the logo we would otherwise
ask them to upload. Extracting it costs one zip read of a file we have just
downloaded anyway, and no new dependency.

**What this module will not do is decide.** A month-end workbook commonly holds
a logo, a product photograph, a chart exported as a picture and somebody's
scanned signature, and the difference between them is not reliably visible from
the bytes. So every image comes back as a *candidate* with a score and a
sentence saying why it scored that way, the highest scorer is not applied to
anything, and a person picks. That is the whole design: "images found in this
file, choose one" is a worse demo and a better product than a wrong logo on
every report a firm sends for a year.

The scoring exists to order the list, not to make the decision. It rewards the
things that are true of nearly every logo and false of most photographs --
modest pixel size, a sane aspect ratio, transparency, few distinct colours, an
early position in the container -- and the reasons are shown to the person
choosing so they can disagree with it.
"""

from __future__ import annotations

import hashlib
import io
import zipfile
from dataclasses import dataclass, field
from typing import Any

from .branding import (
    MAX_LOGO_EDGE,
    MIN_LOGO_EDGE,
    SUPPORTED_LOGO_MIMES,
    LogoRejected,
    sniff_mime,
    validate_logo,
)

#: Where each Office format keeps its embedded pictures.
MEDIA_PREFIXES = ("xl/media/", "word/media/", "ppt/media/")

#: Extensions whose container we know how to open. .xls is deliberately absent:
#: the legacy format is an OLE compound file, not a zip, and the parser refuses
#: those upstream anyway.
CONTAINER_EXTENSIONS = (".xlsx", ".xlsm", ".docx", ".pptx")

#: Total bytes we will read out of one container. A zip bomb is a zip whose
#: entries are small and whose contents are not, so the budget is spent on
#: decompressed size and checked as it is spent.
MAX_EXTRACTED_BYTES = 24 * 1024 * 1024

#: More images than this and the file is a picture library, not a document with
#: a letterhead. Ranking thousands of them would be slower than it is useful.
MAX_CANDIDATES = 24


@dataclass(frozen=True)
class ImageCandidate:
    """One image found inside an uploaded document."""

    name: str
    data: bytes
    mime: str
    width: int
    height: int
    score: float
    reasons: list[str] = field(default_factory=list)
    #: Set when the image is a real image we simply cannot use as a logo.
    rejected: str | None = None

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()

    def to_row(self) -> dict[str, Any]:
        """The shape `record_brand_asset_candidates` stores. Bytes excluded."""
        return {
            "source_name": self.name,
            "mime_type": self.mime,
            "width": self.width,
            "height": self.height,
            "byte_size": len(self.data),
            "sha256": self.sha256,
            "score": round(self.score, 3),
            "reasons": self.reasons,
            "usable": self.rejected is None,
            "rejected_reason": self.rejected,
        }


def is_container(filename: str) -> bool:
    return filename.lower().endswith(CONTAINER_EXTENSIONS)


def discover_images(data: bytes, filename: str) -> list[ImageCandidate]:
    """
    Every image in an uploaded Office file, best candidate first.

    Returns an empty list for anything that is not a readable container --
    a CSV, a legacy .xls, a truncated upload. Discovery is a bonus on top of an
    ingest that has already succeeded, so it never raises into the caller: a
    workbook whose zip directory is odd should still parse, profile and clean.
    """
    if not is_container(filename):
        return []

    candidates: list[ImageCandidate] = []
    budget = MAX_EXTRACTED_BYTES

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = [
                info
                for info in archive.infolist()
                if info.filename.startswith(MEDIA_PREFIXES) and not info.is_dir()
            ]
            # Container order, which is authoring order closely enough: the
            # header image of a template is usually media1.
            for position, info in enumerate(entries[:MAX_CANDIDATES]):
                if info.file_size > budget:
                    break
                budget -= info.file_size
                try:
                    payload = archive.read(info.filename)
                except Exception:  # noqa: BLE001 - one unreadable entry, not a failed upload
                    continue
                candidate = _describe(info.filename, payload, position)
                if candidate is not None:
                    candidates.append(candidate)
    except (zipfile.BadZipFile, OSError, ValueError):
        return []

    return sorted(candidates, key=lambda item: (-item.score, item.name))


def _describe(name: str, payload: bytes, position: int) -> ImageCandidate | None:
    mime = sniff_mime(payload)
    if mime is None:
        return None

    width = height = 0
    rejected: str | None = None
    try:
        asset = validate_logo(payload)
        width, height = asset.width, asset.height
    except LogoRejected as error:
        rejected = str(error)
        if mime in SUPPORTED_LOGO_MIMES:
            # Still worth listing with its real size so the reason on screen is
            # "that image is 12×12" rather than a bare refusal.
            width, height = _best_effort_dimensions(payload)

    score, reasons = _score(payload, mime, width, height, position)
    if rejected:
        score = 0.0

    return ImageCandidate(
        name=name.rsplit("/", 1)[-1],
        data=payload,
        mime=mime,
        width=width,
        height=height,
        score=score,
        reasons=reasons,
        rejected=rejected,
    )


def _best_effort_dimensions(payload: bytes) -> tuple[int, int]:
    try:
        from PIL import Image

        with Image.open(io.BytesIO(payload)) as image:
            return int(image.width), int(image.height)
    except Exception:  # noqa: BLE001
        return 0, 0


def _score(
    payload: bytes, mime: str, width: int, height: int, position: int
) -> tuple[float, list[str]]:
    """
    How much this image looks like a logo, and why.

    Every term is a statement about logos that a person can check: they are
    small, they are wider than they are tall but not by much, they are usually
    transparent PNGs, they use few colours, and the one in the header is
    usually the first picture in the file. None of them is decisive, which is
    why the result is an ordering and not a decision.
    """
    reasons: list[str] = []
    score = 0.0

    if width and height:
        edge = max(width, height)
        if MIN_LOGO_EDGE <= edge <= 900:
            score += 0.3
            reasons.append(f"{width}×{height} is a typical logo size")
        elif edge > 1600:
            reasons.append(f"{width}×{height} is larger than a logo usually is")

        aspect = width / height if height else 0
        if 0.4 <= aspect <= 6.0:
            score += 0.2
            reasons.append("its proportions suit a header")
        else:
            reasons.append("its proportions are unusual for a logo")

    size = len(payload)
    if size <= 200 * 1024:
        score += 0.15
        reasons.append(f"{size // 1024 or 1} KB, small enough to be artwork rather than a photo")
    elif size > 900 * 1024:
        reasons.append("large enough to be a photograph")

    if mime == "image/png":
        score += 0.1
        reasons.append("PNG, the format artwork is usually saved in")

    if _has_alpha(payload, mime):
        score += 0.15
        reasons.append("has a transparent background")

    colours = _distinct_colours(payload)
    if colours is not None and colours <= 64:
        score += 0.15
        reasons.append(f"uses only {colours} distinct colours")
    elif colours is not None and colours > 4000:
        reasons.append("uses thousands of colours, like a photograph")

    if position == 0:
        score += 0.1
        reasons.append("it is the first image in the file")

    return min(score, 1.0), reasons


def _has_alpha(payload: bytes, mime: str) -> bool:
    if mime == "image/jpeg":
        return False
    try:
        from PIL import Image

        with Image.open(io.BytesIO(payload)) as image:
            return image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info
    except Exception:  # noqa: BLE001
        return False


def _distinct_colours(payload: bytes) -> int | None:
    """
    How many colours the image uses, counted on a thumbnail.

    Downsampling first bounds the work: the answer only has to separate "a
    wordmark in two colours" from "a photograph", and both survive being looked
    at 64 pixels wide.
    """
    try:
        from PIL import Image

        with Image.open(io.BytesIO(payload)) as image:
            small = image.convert("RGB")
            small.thumbnail((64, 64))
            colours = small.getcolors(maxcolors=1 << 16)
            return len(colours) if colours is not None else 1 << 16
    except Exception:  # noqa: BLE001
        return None


__all__ = [
    "CONTAINER_EXTENSIONS",
    "MAX_CANDIDATES",
    "ImageCandidate",
    "discover_images",
    "is_container",
]
