"""
The store report, as a document.

`retail.py` decides what is true; this module decides what is said, in which
order, in English or Somali. It produces a `report.ReportDocument` -- the same
typed block list the month-end accounting report uses -- which means the four
renderings in `report.py` and `documents.py` (Markdown, PDF, Word, Excel) all
work here without a line of new rendering code. That reuse is the reason the
document model exists.

The order of the report is the argument it makes, and it is deliberate:

  1. **What the shop made.** Sales, cost of stock, gross profit, running costs,
     net profit. Five numbers, before anything else.
  2. **What changed** since the period before, because a figure with nothing to
     compare it to is not information.
  3. **What needs attention** -- the insights, worst first.
  4. **Where the money went**, by category.
  5. **The shape of trading** -- the series, the weekday pattern, the products.
  6. **What this covers**, including what could not be read.

A shopkeeper who reads only section 1 has the answer to the question they
asked. Everything after it is why.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any

from . import somali
from .report import (
    Bars,
    Block,
    Callout,
    Figure,
    Footnote,
    Heading,
    KeyFigures,
    Prose,
    ReportDocument,
    Table,
)
from .retail import FinancialSummary, Granularity, Period, ZakatEstimate

# Findings are shown worst first. A shopkeeper reading three lines should read
# the three that matter, not the three that were computed first.
_SEVERITY_ORDER = {"alert": 0, "watch": 1, "good": 2}

# The document model's tones, which the dashboard also uses. Mapping the
# insight severities onto them here keeps one vocabulary across screen and page.
_TONES = {"alert": "danger", "watch": "warning", "good": "info"}


def _fmt(
    value: Decimal | float | None, summary: FinancialSummary, secondary: dict[str, Any] | None
) -> str:
    if secondary:
        return somali.dual_money(
            value,
            summary.currency,
            secondary=secondary.get("code"),
            rate=secondary.get("rate"),
        )
    return somali.money(value, summary.currency)


def _secondary_currency(summary: FinancialSummary) -> dict[str, Any] | None:
    """
    The shilling column, when the connection states a rate for it.

    Read out of the FX rates the sync already recorded rather than configured
    separately: the rate that converted the entries is the rate the report
    quotes, and there is no second place for the two to disagree.
    """
    rates = (summary.fx or {}).get("rates") or {}
    for code in ("SOS", "SLSH"):
        raw = rates.get(code)
        if raw:
            try:
                return {"code": code, "rate": Decimal(str(raw))}
            except (ValueError, ArithmeticError):
                return None
    return None


def build_store_document(
    summary: FinancialSummary,
    *,
    store_name: str,
    workspace_name: str,
    version_no: int,
    language: somali.Language = "en",
    source: str = "",
    zakat: ZakatEstimate | None = None,
    series: list[Period] | None = None,
    series_granularity: Granularity | None = None,
    generated_at: dt.datetime | None = None,
) -> ReportDocument:
    """
    Everything a store report says, in the order it says it.

    `series` is the finer breakdown drawn inside the reported period, and it is
    a separate argument rather than `summary.periods` because the two answer
    different questions. A monthly report's headline and its month-on-month
    movement come from monthly buckets; the chart inside it is more useful cut
    by week or by day. Passing one summary and letting the renderer re-bucket it
    would put arithmetic in the rendering path, which is the one thing this
    split exists to prevent.
    """
    generated = generated_at or dt.datetime.now(dt.timezone.utc)
    secondary = _secondary_currency(summary)
    blocks: list[Block] = []

    def t(key: str) -> str:
        return somali.term(key, language)

    def money(value: Decimal | float | None) -> str:
        return _fmt(value, summary, secondary)

    total = summary.total
    current = summary.current

    if total is None or current is None:
        blocks.append(Prose(t("no_data")))
        return ReportDocument(
            title=store_name,
            workspace_name=workspace_name,
            version_no=version_no,
            generated_at=generated,
            blocks=blocks,
        )

    # -- 1. the figures ------------------------------------------------------

    headline = current if summary.granularity != "daily" else total
    period_name = somali.format_period_label(headline.label, summary.granularity, language)

    blocks.append(Heading(f"{t('headline')} — {period_name}"))
    profit_label = t("net_profit") if headline.net_profit >= 0 else t("net_loss")
    blocks.append(
        KeyFigures(
            [
                Figure(
                    t("revenue"),
                    money(headline.revenue),
                    (t("refunds"), money(headline.refunds)) if headline.refunds else None,
                ),
                Figure(t("cogs"), money(headline.cogs)),
                Figure(
                    t("gross_profit"),
                    money(headline.gross_profit),
                    (t("gross_margin"), somali.percent(headline.gross_margin)),
                ),
                Figure(t("expenses"), money(headline.expenses)),
                Figure(
                    profit_label,
                    money(abs(headline.net_profit)),
                    (t("net_margin"), somali.percent(headline.net_margin)),
                ),
                Figure(
                    t("average_daily_revenue"),
                    money(headline.average_daily_revenue),
                    (t("trading_days"), str(headline.trading_days)),
                ),
            ],
            headers=(t("measure"), t("value")),
        )
    )

    # -- 2. what changed -----------------------------------------------------

    if summary.movements and summary.previous:
        previous_name = somali.format_period_label(
            summary.previous.label, summary.granularity, language
        )
        blocks.append(Heading(f"{t('what_changed')} — {previous_name} → {period_name}"))
        blocks.append(
            Table(
                ["", t("previous"), t("current"), t("change")],
                [
                    [
                        t(movement.metric),
                        money(movement.previous),
                        money(movement.current),
                        f"{money(movement.difference)}  "
                        f"({somali.signed_percent(movement.percent_change)})",
                    ]
                    for movement in summary.movements
                ],
                numeric=(1, 2, 3),
            )
        )

    # -- 3. what needs attention --------------------------------------------

    findings = sorted(summary.insights, key=lambda item: _SEVERITY_ORDER.get(item.severity, 3))
    if findings:
        blocks.append(Heading(t("what_to_watch")))
        for insight in findings:
            sentence = (
                somali.translate_insight(
                    insight.code, insight.detail, insight.values, summary.currency
                )
                if language == "so"
                else insight.detail
            )
            blocks.append(
                Callout(
                    somali.term(insight.severity, language),
                    [sentence],
                    tone=_TONES.get(insight.severity, "info"),
                )
            )

    # -- 4. where the money went --------------------------------------------

    costs = [item for item in total.by_category if item.kind != "revenue"]
    if costs:
        blocks.append(Heading(t("by_category")))
        blocks.append(
            Table(
                [t("category"), t("amount"), t("share"), t("entries")],
                [
                    [
                        somali.category_label(item.category, language),
                        money(item.amount),
                        somali.percent(item.share),
                        str(item.entries),
                    ]
                    for item in costs
                ],
                numeric=(1, 2, 3),
            )
        )
        blocks.append(
            Bars(
                [
                    (somali.category_label(item.category, language)[:28], float(item.amount))
                    for item in costs[:8]
                ],
                [money(item.amount) for item in costs[:8]],
            )
        )

    income = [item for item in total.by_category if item.kind == "revenue"]
    if len(income) > 1:
        blocks.append(
            Table(
                [t("revenue"), t("amount"), t("share")],
                [
                    [
                        somali.category_label(item.category, language),
                        money(item.amount),
                        somali.percent(item.share),
                    ]
                    for item in income
                ],
                numeric=(1, 2),
            )
        )

    # -- 5. the shape of trading --------------------------------------------

    drawn = series if series is not None else summary.periods
    drawn_granularity = series_granularity or summary.granularity
    if len(drawn) > 1:
        blocks.append(
            Heading(
                f"{t('by_period')} ({somali.granularity_label(drawn_granularity, language).lower()})"
            )
        )
        # Trimmed to the last 24 buckets. A daily series over a year is 365
        # bars, which is a wall in every rendering and a table nobody reads;
        # the full series is still on the job result for anything that wants it.
        recent = drawn[-24:]
        blocks.append(
            Bars(
                [
                    (somali.format_period_label(p.label, drawn_granularity, language)[:22],
                     float(p.revenue))
                    for p in recent
                ],
                [money(p.revenue) for p in recent],
            )
        )
        blocks.append(
            Table(
                [t("period"), t("revenue"), t("cogs"), t("expenses"), t("net_profit")],
                [
                    [
                        somali.format_period_label(p.label, drawn_granularity, language),
                        money(p.revenue),
                        money(p.cogs),
                        money(p.expenses),
                        money(p.net_profit),
                    ]
                    for p in recent
                ],
                numeric=(1, 2, 3, 4),
            )
        )

    trading = [(name, amount) for name, amount in summary.weekday_revenue if amount != 0]
    if len(trading) > 1:
        blocks.append(Heading(t("best_days")))
        blocks.append(
            Bars(
                [(somali.weekday_label(name, language), float(amount)) for name, amount in trading],
                [money(amount) for _name, amount in trading],
            )
        )

    if summary.top_products:
        blocks.append(Heading(t("top_products")))
        blocks.append(
            Table(
                [t("product"), t("revenue"), t("share"), t("quantity")],
                [
                    [
                        item.label,
                        money(item.amount),
                        somali.percent(item.share),
                        f"{item.quantity:,.0f}" if item.quantity is not None else "—",
                    ]
                    for item in summary.top_products
                ],
                numeric=(1, 2, 3),
            )
        )

    if summary.top_customers:
        blocks.append(Heading(t("top_customers")))
        blocks.append(
            Table(
                [t("customer"), t("revenue"), t("share")],
                [
                    [item.label, money(item.amount), somali.percent(item.share)]
                    for item in summary.top_customers
                ],
                numeric=(1, 2),
            )
        )

    if summary.top_expenses:
        blocks.append(Heading(t("top_expenses")))
        blocks.append(
            Table(
                [t("account"), t("amount"), t("share")],
                [
                    [item.label, money(item.amount), somali.percent(item.share)]
                    for item in summary.top_expenses
                ],
                numeric=(1, 2),
            )
        )

    # -- zakat ---------------------------------------------------------------

    if zakat is not None:
        blocks.append(Heading(t("zakat")))
        if zakat.computed:
            blocks.append(
                Table(
                    ["", t("amount")],
                    [
                        ["Zakatable assets" if language == "en" else "Hantida zakada leh",
                         money(zakat.base)],
                        [f"{t('zakat')} (2.5%)", money(zakat.amount)],
                    ],
                    numeric=(1,),
                )
            )
        blocks.append(Prose(somali.zakat_note(zakat.computed, zakat.note, language)))

    # -- 6. what this covers -------------------------------------------------

    blocks.append(Heading(t("coverage")))
    coverage = summary.coverage
    rows = [
        [t("period"), f"{total.start.isoformat()} → {total.end.isoformat()}"],
        [t("entries"), f"{coverage.get('entries', 0):,}"],
        [t("trading_days"), str(coverage.get("trading_days", 0))],
    ]
    if source:
        rows.insert(0, [t("source"), source])
    fx = summary.fx or {}
    if fx.get("rates"):
        rates = ", ".join(f"1 {fx.get('base', 'USD')} = {rate} {code}"
                          for code, rate in sorted((fx.get("rates") or {}).items()))
        as_of = fx.get("as_of")
        rows.append(["Exchange rate" if language == "en" else "Sarrifka", rates])
        if as_of:
            rows.append(["Rate set" if language == "en" else "Sarrifka la dejiyay", as_of])
    blocks.append(Table(["", ""], rows))

    uncategorised = coverage.get("uncategorised_entries") or 0
    if uncategorised:
        blocks.append(
            Prose(
                f"{uncategorised} record(s) could not be matched to a category and are counted "
                f"under other costs."
                if language == "en"
                else f"{uncategorised} diiwaan qayb looma helin, waxaana lagu daray "
                f"'kharashyo kale'."
            )
        )

    blocks.append(
        Footnote(
            (
                f"Produced by the Hermes agent from {coverage.get('entries', 0):,} records read "
                f"directly from {source or 'the connected store'}. Every figure is computed from "
                f"those records, not estimated. A copilot, not an accountant — review before use."
            )
            if language == "en"
            else (
                f"Waxaa sameeyay wakiilka Hermes isagoo akhriyay {coverage.get('entries', 0):,} "
                f"diiwaan oo si toos ah looga soo qaatay {source or 'dukaanka la isku xiray'}. "
                f"Tiro kastaa waa mid laga xisaabiyay diiwaannadaas, lama qiyaasin. Kaaliye, ma "
                f"aha xisaabiye — fadlan dib u eeg intaadan isticmaalin."
            )
        )
    )

    return ReportDocument(
        title=store_name,
        workspace_name=workspace_name,
        version_no=version_no,
        generated_at=generated,
        blocks=blocks,
    )


def headline_figures(summary: FinancialSummary) -> dict[str, Any]:
    """
    The five numbers, unformatted, for the dashboard card and the job result.

    Separate from the document because the screen needs values it can style and
    the document needs strings it can print, and deriving one from the other
    would mean the dashboard parsing money out of prose.
    """
    period: Period | None = summary.current
    total = summary.total
    if period is None or total is None:
        return {"has_data": False}

    return {
        "has_data": True,
        "currency": summary.currency,
        "granularity": summary.granularity,
        "period": period.to_dict(),
        "total": total.to_dict(),
        "movements": [movement.to_dict() for movement in summary.movements],
        "insights": [insight.to_dict() for insight in summary.insights],
    }


__all__ = ["build_store_document", "headline_figures"]
