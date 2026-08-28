"""
Report generation.

The output is Markdown rather than PDF. An accountant's month-end pack goes
into an email, a working paper or a client portal, and Markdown survives all
three; PDF generation would add a rendering dependency to a VPS in exchange for
a format nobody can edit.

Every figure in a report comes from `analyze`, and every one of them carries
the row count behind it. Section 7's promise is that any displayed number can
be traced, so a report that states a total without saying how many rows it
covers is already outside the design.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import re
from typing import Any


# Column names that a naive .title() mangles. An accountant reading "Vat" in a
# report they are about to send to a client notices immediately.
_ACRONYMS = {"vat": "VAT", "gbp": "GBP", "usd": "USD", "eur": "EUR", "id": "ID", "po": "PO"}


def _money(value: float | None, symbol: str = "£") -> str:
    """
    Parentheses for negatives, which is what a set of accounts uses.

    The source files already write credit notes as `(150.00)`; rendering them
    back as `-£150.00` would be correct and still read as foreign to the person
    checking the report against their own spreadsheet.
    """
    if value is None:
        return "—"
    if value < 0:
        return f"({symbol}{abs(value):,.2f})"
    return f"{symbol}{value:,.2f}"


def _label(name: str) -> str:
    return " ".join(
        _ACRONYMS.get(word.lower(), word.title()) for word in name.replace("_", " ").split()
    )


def _table(headers: list[str], rows: list[list[str]]) -> str:
    if not rows:
        return "_No rows._\n"
    lines = [
        "| " + " | ".join(headers) + " |",
        "|" + "|".join("---" for _ in headers) + "|",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in rows)
    return "\n".join(lines) + "\n"


def _bar_chart(rows: list[tuple[str, float]], width: int = 32) -> str:
    """
    A bar chart drawn in text.

    Deliberately not a PNG. This report is Markdown because an accountant's
    month-end pack goes into an email, a working paper or a client portal, and
    an image would either travel as a second file that gets separated from it or
    as a base64 blob that half of those viewers refuse to render. A bar made of
    block characters survives all of them, including a plain-text paste, and
    needs no plotting dependency on the agent host.

    Scaled against the largest absolute value so a month of credits reads as a
    bar on the same axis rather than as an empty row. The number is always
    printed beside the bar: the bar is for the shape, the figure is the fact.
    """
    if not rows:
        return ""

    largest = max(abs(value) for _label, value in rows) or 1.0
    longest_label = max(len(label) for label, _value in rows)

    lines = ["```"]
    for label, value in rows:
        filled = int(round(abs(value) / largest * width))
        bar = ("█" * filled).ljust(width, "░")
        lines.append(f"{label.ljust(longest_label)}  {bar}  {_money(value)}")
    lines.append("```")
    return "\n".join(lines) + "\n"


def build_markdown_report(
    *,
    workspace_name: str,
    dataset_name: str,
    version_no: int,
    kpis: dict[str, Any],
    profile_signals: dict[str, Any],
    proposals_summary: dict[str, Any] | None = None,
    comparison: dict[str, Any] | None = None,
    provenance: dict[str, Any] | None = None,
    narrative: str | None = None,
    generated_at: dt.datetime | None = None,
) -> str:
    generated = generated_at or dt.datetime.now(dt.timezone.utc)
    parts: list[str] = []

    parts.append(f"# {dataset_name}\n")
    parts.append(
        f"**{workspace_name}** · dataset version {version_no} · "
        f"generated {generated.strftime('%d %B %Y %H:%M UTC')}\n"
    )

    # The caveat goes at the top, not in a footnote. A report whose totals do
    # not reconcile against the source file must say so before anyone reads the
    # totals -- section 5.3's blocking behaviour, carried into the document.
    totals = profile_signals.get("declared_totals", {})
    if totals.get("checked") and totals.get("all_reconcile") is False:
        failing = [check for check in totals.get("checks", []) if not check["reconciles"]]
        parts.append("\n> **These figures do not reconcile to the source file.**\n>")
        for check in failing:
            parts.append(
                f"> {check['column']}: computed {_money(check['computed'])} against a declared "
                f"{_money(check['declared'])} — a difference of {_money(check['difference'])}.\n>"
            )
        parts.append("> Resolve this before the figures are relied on.\n")

    if narrative:
        parts.append(f"\n## Summary\n\n{narrative}\n")

    parts.append("\n## Headline figures\n")
    rows: list[list[str]] = [["Rows", f"{kpis.get('row_count', 0):,}"]]

    period = kpis.get("period") or {}
    if period.get("earliest"):
        rows.append(["Period", f"{period['earliest']} to {period['latest']}"])

    for key, value in kpis.items():
        if not isinstance(value, dict) or "total" not in value:
            continue
        rows.append([_label(key), _money(value["total"])])
        if value.get("negative_rows"):
            rows.append(["— of which credits", f"{value['negative_rows']} row(s)"])

    parts.append(_table(["Measure", "Value"], rows))

    monthly = kpis.get("monthly") or {}
    series = monthly.get("series") or []
    if len(series) > 1:
        parts.append(f"\n## {_label(monthly['metric'])} by month\n")
        parts.append(_bar_chart([(item["month"], item["total"]) for item in series]))

    for key, value in kpis.items():
        if not key.startswith("top_by_") or not isinstance(value, list):
            continue
        dimension = key.removeprefix("top_by_").replace("_", " ")
        parts.append(f"\n## By {dimension}\n")
        parts.append(
            _table(
                [_label(dimension), "Total", "Rows"],
                [
                    [str(item["label"]), _money(item["total"]), str(item["rows"])]
                    for item in value
                ],
            )
        )
        parts.append("\n")
        parts.append(_bar_chart([(str(item["label"])[:28], item["total"]) for item in value[:8]]))

    if comparison:
        parts.append("\n## Period comparison\n")
        change = comparison.get("percent_change")
        change_text = f"{change:+.1f}%" if change is not None else "n/a"
        parts.append(
            f"{comparison['metric']}: {_money(comparison['total_a'])} → "
            f"{_money(comparison['total_b'])} "
            f"({_money(comparison['difference'])}, {change_text})\n"
        )
        if comparison.get("drivers"):
            parts.append("\nLargest movements:\n")
            parts.append(
                _table(
                    ["", "Previous", "Current", "Change"],
                    [
                        [
                            str(driver["label"]),
                            _money(driver["period_a"]),
                            _money(driver["period_b"]),
                            _money(driver["difference"]),
                        ]
                        for driver in comparison["drivers"]
                    ],
                )
            )

    parts.append("\n## Data quality\n")
    quality_rows: list[list[str]] = []

    duplicates = profile_signals.get("exact_duplicates", {})
    quality_rows.append(
        ["Exact duplicate rows", str(duplicates.get("duplicate_rows", 0))]
    )

    variants = profile_signals.get("entity_variants", {}).get("columns", [])
    quality_rows.append(
        ["Name-variant groups", str(sum(item["group_count"] for item in variants))]
    )

    vat = profile_signals.get("vat_consistency", {})
    if vat.get("checked"):
        quality_rows.append(["VAT rate anomalies", str(vat.get("anomaly_count", 0))])
        quality_rows.append(["VAT rates seen", str(vat.get("rate_distribution", {}))])

    dates = profile_signals.get("date_coverage", {})
    if dates.get("checked") and dates.get("ambiguous_dates"):
        quality_rows.append(
            [
                "Ambiguous dates",
                f"{dates['ambiguous_dates']} read as {str(dates.get('assumed_order', '')).upper()}",
            ]
        )

    if proposals_summary:
        quality_rows.append(
            [
                "Changes applied automatically",
                str(proposals_summary.get("auto", 0)),
            ]
        )
        quality_rows.append(
            ["Changes needing review", str(proposals_summary.get("review", 0))]
        )
        quality_rows.append(
            [
                "Value under review",
                _money(proposals_summary.get("review_materiality_gbp")),
            ]
        )

    parts.append(_table(["Check", "Result"], quality_rows))

    # Where these figures came from and what was done to them on the way.
    #
    # The question an accountant asks before signing anything is not "what is
    # the total" but "which file is this, and what changed before you counted".
    # Every fact needed to answer that was already in the database -- the source
    # workbook, the version chain, the changes a person approved -- and the
    # report simply never asked for any of it.
    if provenance:
        parts.append("\n## Provenance\n")
        trail: list[list[str]] = []

        if provenance.get("source_filename"):
            trail.append(["Source workbook", str(provenance["source_filename"])])
        if provenance.get("uploaded_at"):
            trail.append(["Uploaded", str(provenance["uploaded_at"])[:19].replace("T", " ")])
        trail.append(["Dataset version", f"v{version_no}"])
        if provenance.get("parsed_directly"):
            trail.append(["Produced by", "reading the source workbook"])
        elif provenance.get("parent_version_no") is not None:
            trail.append(["Derived from", f"v{provenance['parent_version_no']}"])
        if provenance.get("row_count") is not None:
            trail.append(["Rows in this version", f"{provenance['row_count']:,}"])

        parts.append(_table(["", ""], trail))

        applied = provenance.get("applied_changes") or []
        if applied:
            parts.append(
                f"\n{len(applied)} change(s) were approved by a person and applied to produce "
                f"this version:\n"
            )
            parts.append(
                _table(
                    ["Change", "Rows", "Decided"],
                    [
                        [
                            str(change.get("title", "")),
                            str(change.get("affected_rows", 0)),
                            str(change.get("decided_at", ""))[:10],
                        ]
                        for change in applied
                    ],
                )
            )
        elif provenance.get("parent_version_no") is not None:
            parts.append("\nNo changes were applied to produce this version.\n")

    # The claim is deliberately narrower than it was. It used to read "every
    # figure above is computed from the stored dataset" -- which is true of the
    # tables and not of the summary, because that paragraph is written by a
    # model from the profile. The numbers in it have been right in testing;
    # nothing in the code makes them right, and a blanket guarantee over
    # unvalidated prose is exactly the sentence that matters after something
    # goes wrong.
    claim = "Every figure in the tables above is computed from the stored dataset, not estimated."
    if narrative:
        claim += " The summary is written by a language model from those same figures and is not independently checked."

    parts.append(
        "\n---\n\n_Produced by the Hermes agent from dataset version "
        f"{version_no}. {claim} "
        "A copilot, not an autonomous accountant — review before use._\n"
    )

    return "\n".join(parts)


def rows_to_csv(rows: list[dict[str, Any]]) -> bytes:
    """Export helper for the `exports` bucket."""
    if not rows:
        return b""

    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=list(rows[0].keys()), extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    # BOM so Excel opens it as UTF-8 rather than mangling the pound sign, which
    # is the first thing anyone will notice in a UK accounting export.
    return b"\xef\xbb\xbf" + buffer.getvalue().encode("utf-8")


# Types openpyxl writes natively. Everything else -- a dict from a nested
# column, a Decimal, a UUID -- becomes its string form, because a cell that
# raises on write loses the whole export over one awkward value.
_XLSX_NATIVE = (str, int, float, bool, dt.datetime, dt.date, dt.time)


def _xlsx_cell(value: Any) -> Any:
    if value is None or isinstance(value, _XLSX_NATIVE):
        return value
    return str(value)


def rows_to_xlsx(rows: list[dict[str, Any]], sheet_name: str = "Data") -> bytes:
    """
    Export helper for the `exports` bucket, for people who open the file rather
    than parse it.

    csv survives everything and xlsx is what actually gets opened, so both
    exist. The difference that matters is types: a csv hands Excel a pile of
    text and lets it guess, which is how an account code of 0041 becomes 41 and
    how 03/04 becomes a date in March. Writing real cell types means the values
    arrive as the parser understood them.

    openpyxl is imported here rather than at module scope because the markdown
    path -- which every report job runs -- has no use for it.
    """
    # Imported lazily: see the docstring.
    from openpyxl import Workbook
    from openpyxl.styles import Font
    from openpyxl.utils import get_column_letter

    workbook = Workbook()
    sheet = workbook.active
    # Excel refuses >31 chars and the characters below; a dataset named after a
    # client file will hit both.
    sheet.title = re.sub(r"[\[\]:*?/\\]", "-", sheet_name)[:31] or "Data"

    if rows:
        headers = list(rows[0].keys())
        sheet.append(headers)
        for cell in sheet[1]:
            cell.font = Font(bold=True)

        for row in rows:
            sheet.append([_xlsx_cell(row.get(header)) for header in headers])

        # The header stays put while someone scrolls a few thousand rows. Cheap,
        # and its absence is the first thing anyone notices.
        sheet.freeze_panes = "A2"

        for index, header in enumerate(headers, start=1):
            width = max(len(str(header)), *(len(str(row.get(header, ""))) for row in rows))
            sheet.column_dimensions[get_column_letter(index)].width = min(max(width + 2, 10), 60)

    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


__all__ = ["build_markdown_report", "rows_to_csv", "rows_to_xlsx"]
