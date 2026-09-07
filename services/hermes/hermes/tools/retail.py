"""
Store financials: revenue, cost, profit, by day, week, month or year.

The input is a list of `LedgerEntry` -- whatever the source was -- and the
output is a `FinancialSummary` that the report renderer turns into a document.
No database, no network, no model. Every figure in a store report is computed
here, deterministically, from rows the customer's own system produced, which is
what makes "the agent analysed my shop" a claim that survives being checked.

Three decisions shape the whole module.

**Gross margin is the headline, not net profit.** A shopkeeper cannot do much
about rent this month, and can do something about pricing today. So revenue,
cost of goods and gross margin are computed and shown first, and operating
expenses come after -- which also means a shop whose expense categories are
half-mapped still gets a trustworthy margin figure.

**The week starts on Saturday.** The working week in Somalia runs Saturday to
Thursday, and Friday is the day of rest -- many shops open only in the
afternoon, if at all. A weekly report cut Monday-to-Sunday puts Friday in the
middle of one week and splits the actual trading week across two, so every
week-on-week comparison it produces is comparing six trading days against five.
`WEEK_START` is where that is fixed, and it is configurable because a warehouse
serving international customers may genuinely run a Monday week.

**A period with no rows is a period, not a gap.** A shop that took nothing on
Tuesday has a Tuesday with zero revenue, and the series says so. The
alternative -- omitting it -- makes a bar chart lie about the shape of a month
and makes "sales fell on Tuesdays" undiscoverable.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Iterable, Literal

from ..connectors.ledger import CATEGORY_KINDS, EntryKind, FxRates, LedgerEntry

Granularity = Literal["daily", "weekly", "monthly", "yearly"]

GRANULARITIES: tuple[Granularity, ...] = ("daily", "weekly", "monthly", "yearly")

# Saturday. `date.weekday()` numbers Monday 0 … Sunday 6.
WEEK_START = 5

ZERO = Decimal("0")


def _q(amount: Decimal) -> Decimal:
    """Two places, for money that is about to be compared or displayed."""
    return amount.quantize(Decimal("0.01"))


def _figure(amount: Decimal, currency: str) -> str:
    """
    A money figure inside a finding's own sentence.

    Grouped, because "10871.00 USD" is a number a reader has to count the digits
    of. Deliberately not the report's own formatter: this module knows nothing
    about symbols or languages, and the sentence it writes here is the English
    one -- the Somali sentence is built from `values` by `somali.py`, which does
    know.
    """
    return f"{abs(amount):,.2f} {currency}"


def _ratio(part: Decimal, whole: Decimal) -> float | None:
    """A share, or None when the denominator makes the question meaningless."""
    if whole == 0:
        return None
    return float(part / whole)


# -----------------------------------------------------------------------------
# Period boundaries
# -----------------------------------------------------------------------------


def period_start(day: dt.date, granularity: Granularity, week_start: int = WEEK_START) -> dt.date:
    if granularity == "daily":
        return day
    if granularity == "weekly":
        return day - dt.timedelta(days=(day.weekday() - week_start) % 7)
    if granularity == "monthly":
        return day.replace(day=1)
    return day.replace(month=1, day=1)


def period_end(start: dt.date, granularity: Granularity) -> dt.date:
    if granularity == "daily":
        return start
    if granularity == "weekly":
        return start + dt.timedelta(days=6)
    if granularity == "monthly":
        if start.month == 12:
            return start.replace(day=31)
        return start.replace(month=start.month + 1, day=1) - dt.timedelta(days=1)
    return start.replace(month=12, day=31)


def next_period(start: dt.date, granularity: Granularity) -> dt.date:
    return period_end(start, granularity) + dt.timedelta(days=1)


def period_label(start: dt.date, granularity: Granularity) -> str:
    """
    A label that sorts, and that a person can read without a legend.

    ISO week numbers are deliberately not used for the weekly label. An ISO week
    starts on Monday, so "2026-W32" would name a different seven days from the
    ones the row actually covers, and a report whose label disagrees with its
    own arithmetic is worse than one with a longer label.
    """
    if granularity == "daily":
        return start.isoformat()
    if granularity == "weekly":
        return f"{start.isoformat()} → {period_end(start, 'weekly').isoformat()}"
    if granularity == "monthly":
        return start.strftime("%Y-%m")
    return start.strftime("%Y")


def reporting_window(
    cadence: Granularity,
    today: dt.date,
    *,
    periods_back: int = 1,
    week_start: int = WEEK_START,
) -> tuple[dt.date, dt.date]:
    """
    The last *complete* period, plus the ones before it for comparison.

    Complete is the operative word. A monthly report fired on the 1st reports
    the month that just ended, not the few hours of the one that just began --
    and a weekly one fired on Saturday morning reports the week that closed on
    Friday. Reporting a period still in progress is the single easiest way to
    make a scheduled report useless: every figure is down, every month, because
    the month is one day old.

    Returns the whole span to load, from the start of the earliest comparison
    period to the end of the reported one, so `summarise` sees both.
    """
    current_start = period_start(today, cadence, week_start)
    # Step back one period to land inside the last complete one.
    reported_start = period_start(current_start - dt.timedelta(days=1), cadence, week_start)
    reported_end = period_end(reported_start, cadence)

    earliest = reported_start
    for _ in range(max(periods_back, 0)):
        earliest = period_start(earliest - dt.timedelta(days=1), cadence, week_start)

    return earliest, reported_end


# -----------------------------------------------------------------------------
# The figures
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class CategoryTotal:
    category: str
    kind: EntryKind
    amount: Decimal
    entries: int
    share: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "category": self.category,
            "kind": self.kind,
            "amount": float(self.amount),
            "entries": self.entries,
            "share": self.share,
        }


@dataclass(frozen=True)
class Period:
    """
    One day, week, month or year of trading.

    `refunds` is carried separately from `revenue` even though revenue is
    already net of it. A shop with $9,000 of sales and $1,000 of returns is a
    different business from one with $8,000 of sales and none, and both report
    $8,000 of revenue.
    """

    label: str
    start: dt.date
    end: dt.date
    revenue: Decimal = ZERO
    refunds: Decimal = ZERO
    cogs: Decimal = ZERO
    expenses: Decimal = ZERO
    entries: int = 0
    trading_days: int = 0
    by_category: tuple[CategoryTotal, ...] = ()
    uncategorised: Decimal = ZERO

    @property
    def gross_profit(self) -> Decimal:
        return self.revenue - self.cogs

    @property
    def net_profit(self) -> Decimal:
        return self.revenue - self.cogs - self.expenses

    @property
    def gross_margin(self) -> float | None:
        return _ratio(self.gross_profit, self.revenue)

    @property
    def net_margin(self) -> float | None:
        return _ratio(self.net_profit, self.revenue)

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    @property
    def average_daily_revenue(self) -> Decimal:
        return _q(self.revenue / self.days) if self.days else ZERO

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "revenue": float(self.revenue),
            "refunds": float(self.refunds),
            "cogs": float(self.cogs),
            "gross_profit": float(self.gross_profit),
            "expenses": float(self.expenses),
            "net_profit": float(self.net_profit),
            "gross_margin": self.gross_margin,
            "net_margin": self.net_margin,
            "entries": self.entries,
            "trading_days": self.trading_days,
            "uncategorised": float(self.uncategorised),
            "by_category": [item.to_dict() for item in self.by_category],
        }


@dataclass(frozen=True)
class Movement:
    """One figure, this period against last."""

    metric: str
    previous: Decimal
    current: Decimal

    @property
    def difference(self) -> Decimal:
        return self.current - self.previous

    @property
    def percent_change(self) -> float | None:
        """
        None when the previous figure was zero.

        A shop that took nothing last week and $400 this week has not grown by
        infinity percent, and printing a number there is how a report loses the
        reader's trust in one line.
        """
        if self.previous == 0:
            return None
        return float((self.current - self.previous) / abs(self.previous)) * 100

    def to_dict(self) -> dict[str, Any]:
        return {
            "metric": self.metric,
            "previous": float(self.previous),
            "current": float(self.current),
            "difference": float(self.difference),
            "percent_change": self.percent_change,
        }


@dataclass(frozen=True)
class Ranked:
    label: str
    amount: Decimal
    entries: int
    quantity: Decimal | None = None
    share: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "amount": float(self.amount),
            "entries": self.entries,
            "quantity": float(self.quantity) if self.quantity is not None else None,
            "share": self.share,
        }


@dataclass(frozen=True)
class Insight:
    """
    Something the report should say out loud, with the figures that justify it.

    `severity` uses the same three words as the dashboard and the report
    renderer -- alert, watch, good -- so a finding never changes urgency
    depending on where it is displayed. `code` is what the translator keys on;
    `detail` is the English sentence and the Somali one is looked up by code, so
    a report in Somali is not an English report with the numbers left in.
    """

    code: str
    severity: Literal["alert", "watch", "good"]
    detail: str
    values: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "severity": self.severity,
            "detail": self.detail,
            "values": self.values,
        }


@dataclass
class FinancialSummary:
    granularity: Granularity
    currency: str
    periods: list[Period]
    movements: list[Movement] = field(default_factory=list)
    top_products: list[Ranked] = field(default_factory=list)
    top_expenses: list[Ranked] = field(default_factory=list)
    top_customers: list[Ranked] = field(default_factory=list)
    weekday_revenue: list[tuple[str, Decimal]] = field(default_factory=list)
    insights: list[Insight] = field(default_factory=list)
    coverage: dict[str, Any] = field(default_factory=dict)
    fx: dict[str, Any] = field(default_factory=dict)

    @property
    def current(self) -> Period | None:
        return self.periods[-1] if self.periods else None

    @property
    def previous(self) -> Period | None:
        return self.periods[-2] if len(self.periods) > 1 else None

    @property
    def total(self) -> Period | None:
        """Every period in the window collapsed into one, for the headline."""
        if not self.periods:
            return None
        return _combine(self.periods, "Whole period")

    def to_dict(self) -> dict[str, Any]:
        total = self.total
        return {
            "granularity": self.granularity,
            "currency": self.currency,
            "total": total.to_dict() if total else None,
            "current": self.current.to_dict() if self.current else None,
            "previous": self.previous.to_dict() if self.previous else None,
            "periods": [period.to_dict() for period in self.periods],
            "movements": [movement.to_dict() for movement in self.movements],
            "top_products": [item.to_dict() for item in self.top_products],
            "top_expenses": [item.to_dict() for item in self.top_expenses],
            "top_customers": [item.to_dict() for item in self.top_customers],
            "weekday_revenue": [
                {"weekday": name, "revenue": float(amount)}
                for name, amount in self.weekday_revenue
            ],
            "insights": [insight.to_dict() for insight in self.insights],
            "coverage": self.coverage,
            "fx": self.fx,
        }


def _combine(periods: list[Period], label: str) -> Period:
    categories: dict[str, list[Any]] = {}
    for period in periods:
        for item in period.by_category:
            bucket = categories.setdefault(item.category, [item.kind, ZERO, 0])
            bucket[1] += item.amount
            bucket[2] += item.entries

    revenue = sum((p.revenue for p in periods), ZERO)
    costs = sum((p.cogs for p in periods), ZERO) + sum((p.expenses for p in periods), ZERO)
    by_category = tuple(
        CategoryTotal(
            category,
            kind,
            amount,
            entries,
            # A revenue line's share is of revenue and a cost line's is of
            # costs. Sharing one denominator would make "rent is 12%" a
            # sentence with no useful completion.
            share=_ratio(amount, revenue if kind == "revenue" else costs),
        )
        for category, (kind, amount, entries) in sorted(
            categories.items(), key=lambda pair: -abs(pair[1][1])
        )
    )
    return Period(
        label=label,
        start=min(p.start for p in periods),
        end=max(p.end for p in periods),
        revenue=revenue,
        refunds=sum((p.refunds for p in periods), ZERO),
        cogs=sum((p.cogs for p in periods), ZERO),
        expenses=sum((p.expenses for p in periods), ZERO),
        entries=sum(p.entries for p in periods),
        trading_days=sum(p.trading_days for p in periods),
        by_category=by_category,
        uncategorised=sum((p.uncategorised for p in periods), ZERO),
    )


# -----------------------------------------------------------------------------
# Building the summary
# -----------------------------------------------------------------------------

_WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def build_periods(
    entries: Iterable[LedgerEntry],
    rates: FxRates,
    granularity: Granularity,
    *,
    week_start: int = WEEK_START,
    window: tuple[dt.date, dt.date] | None = None,
) -> list[Period]:
    """
    Bucket entries into consecutive periods, filling the empty ones.

    `window` forces the range covered. Without it the range is the data's own
    first and last date, which is right for "report on what you synced" and
    wrong for "report on August" -- a shop that stopped trading on the 20th
    should see a month that ends on the 31st with ten empty days, because that
    is the fact worth seeing.
    """
    materialised = list(entries)
    buckets: dict[dt.date, dict[str, Any]] = {}

    for entry in materialised:
        start = period_start(entry.occurred_on, granularity, week_start)
        bucket = buckets.setdefault(
            start,
            {
                "revenue": ZERO,
                "refunds": ZERO,
                "cogs": ZERO,
                "expenses": ZERO,
                "entries": 0,
                "categories": {},
                "uncategorised": ZERO,
                "days": set(),
            },
        )
        amount = entry.in_base(rates)
        bucket["entries"] += 1
        bucket["days"].add(entry.occurred_on)

        if entry.kind == "revenue":
            bucket["revenue"] += amount
            if amount < 0:
                bucket["refunds"] += -amount
        elif entry.kind == "cogs":
            bucket["cogs"] += amount
        else:
            bucket["expenses"] += amount

        category = bucket["categories"].setdefault(entry.category, [entry.kind, ZERO, 0])
        category[1] += amount
        category[2] += 1

        if entry.classified_by == "unmatched" and entry.kind != "revenue":
            bucket["uncategorised"] += amount

    if not buckets and not window:
        return []

    first = min(buckets) if buckets else period_start(window[0], granularity, week_start)
    last = max(buckets) if buckets else period_start(window[1], granularity, week_start)
    if window:
        first = min(first, period_start(window[0], granularity, week_start))
        last = max(last, period_start(window[1], granularity, week_start))

    periods: list[Period] = []
    cursor = first
    while cursor <= last:
        bucket = buckets.get(cursor)
        if bucket is None:
            periods.append(
                Period(
                    label=period_label(cursor, granularity),
                    start=cursor,
                    end=period_end(cursor, granularity),
                )
            )
        else:
            revenue_total = bucket["revenue"]
            expense_total = bucket["expenses"] + bucket["cogs"]
            by_category = tuple(
                CategoryTotal(
                    category=name,
                    kind=kind,
                    amount=amount,
                    entries=count,
                    share=_ratio(
                        amount,
                        revenue_total if CATEGORY_KINDS.get(name) == "revenue" else expense_total,
                    ),
                )
                for name, (kind, amount, count) in sorted(
                    bucket["categories"].items(), key=lambda pair: -abs(pair[1][1])
                )
            )
            periods.append(
                Period(
                    label=period_label(cursor, granularity),
                    start=cursor,
                    end=period_end(cursor, granularity),
                    revenue=bucket["revenue"],
                    refunds=bucket["refunds"],
                    cogs=bucket["cogs"],
                    expenses=bucket["expenses"],
                    entries=bucket["entries"],
                    trading_days=len(bucket["days"]),
                    by_category=by_category,
                    uncategorised=bucket["uncategorised"],
                )
            )
        cursor = next_period(cursor, granularity)

    return periods


def _rank(
    entries: list[LedgerEntry],
    rates: FxRates,
    key: str,
    kinds: tuple[EntryKind, ...],
    limit: int,
) -> list[Ranked]:
    totals: dict[str, list[Any]] = {}
    for entry in entries:
        if entry.kind not in kinds:
            continue
        label = (getattr(entry, key, "") or "").strip()
        if not label:
            continue
        bucket = totals.setdefault(label, [ZERO, 0, ZERO])
        bucket[0] += entry.in_base(rates)
        bucket[1] += 1
        if entry.quantity is not None:
            bucket[2] += entry.quantity

    grand = sum((bucket[0] for bucket in totals.values()), ZERO)
    ranked = sorted(totals.items(), key=lambda pair: -pair[1][0])[:limit]
    return [
        Ranked(
            label=label,
            amount=amount,
            entries=count,
            quantity=quantity if quantity != 0 else None,
            share=_ratio(amount, grand),
        )
        for label, (amount, count, quantity) in ranked
    ]


def summarise(
    entries: Iterable[LedgerEntry],
    rates: FxRates,
    *,
    granularity: Granularity = "monthly",
    week_start: int = WEEK_START,
    window: tuple[dt.date, dt.date] | None = None,
    top_n: int = 8,
) -> FinancialSummary:
    """
    Everything the report needs, computed once.

    The report renderer is deliberately given no ability to compute: it formats
    what is here and nothing else. That is what makes the Somali report and the
    English one provably the same report -- there is no arithmetic in either
    rendering path that the other could get differently.
    """
    materialised = list(entries)
    periods = build_periods(
        materialised, rates, granularity, week_start=week_start, window=window
    )

    summary = FinancialSummary(
        granularity=granularity,
        currency=rates.base,
        periods=periods,
        fx=rates.describe(),
    )

    current, previous = summary.current, summary.previous
    if current and previous:
        summary.movements = [
            Movement("revenue", previous.revenue, current.revenue),
            Movement("cogs", previous.cogs, current.cogs),
            Movement("gross_profit", previous.gross_profit, current.gross_profit),
            Movement("expenses", previous.expenses, current.expenses),
            Movement("net_profit", previous.net_profit, current.net_profit),
        ]

    summary.top_products = _rank(materialised, rates, "product", ("revenue",), top_n)
    summary.top_customers = _rank(materialised, rates, "counterparty", ("revenue",), top_n)
    summary.top_expenses = _rank(materialised, rates, "account", ("expense", "cogs"), top_n)

    weekday: dict[int, Decimal] = {}
    for entry in materialised:
        if entry.kind != "revenue":
            continue
        index = entry.occurred_on.weekday()
        weekday[index] = weekday.get(index, ZERO) + entry.in_base(rates)
    # Ordered Saturday-first, matching the trading week rather than the
    # calendar library's Monday-first convention.
    summary.weekday_revenue = [
        (_WEEKDAYS[(WEEK_START + offset) % 7], weekday.get((WEEK_START + offset) % 7, ZERO))
        for offset in range(7)
    ]

    dates = [entry.occurred_on for entry in materialised]
    summary.coverage = {
        "entries": len(materialised),
        "first_date": min(dates).isoformat() if dates else None,
        "last_date": max(dates).isoformat() if dates else None,
        "trading_days": len({entry.occurred_on for entry in materialised}),
        "uncategorised_entries": sum(
            1 for entry in materialised if entry.classified_by == "unmatched"
        ),
        "weakly_categorised_entries": sum(
            1 for entry in materialised if entry.classified_by == "weak"
        ),
    }

    summary.insights = find_insights(summary)
    return summary


# -----------------------------------------------------------------------------
# Insights
#
# The line between this and a spreadsheet. A shopkeeper can add up a column;
# what they cannot easily do is notice that their margin fell two points while
# revenue rose, or that one supplier is now 60% of their costs.
#
# Every insight is a rule with a stated threshold and the figures that triggered
# it. None of them is generated by a model, and none of them is advice -- they
# say what happened and what it means arithmetically, and stop there.
# -----------------------------------------------------------------------------

# Below this, a percentage swing is noise. A shop whose transport cost went from
# $8 to $14 has not had a 75% cost increase worth a line in a report.
MATERIAL_AMOUNT = Decimal("50")

# Percentage points of gross margin. Two points on a retail margin is a real
# move; anything less is pricing noise and rounding.
MARGIN_POINTS = 2.0


def find_insights(summary: FinancialSummary) -> list[Insight]:
    insights: list[Insight] = []
    current, previous = summary.current, summary.previous
    total = summary.total
    if current is None or total is None:
        return insights

    # 1. Trading at a loss. First, because nothing else in the report matters
    #    as much, and a shopkeeper reading only the first line should see it.
    if current.net_profit < 0:
        insights.append(
            Insight(
                code="loss_making",
                severity="alert",
                detail=(
                    f"{current.label} ran at a loss of "
                    f"{_figure(current.net_profit, summary.currency)}: costs and expenses came "
                    f"to more than sales."
                ),
                values={
                    "period": current.label,
                    "net_profit": float(current.net_profit),
                    "revenue": float(current.revenue),
                },
            )
        )
    elif current.net_profit > 0 and current.revenue > 0:
        insights.append(
            Insight(
                code="profitable",
                severity="good",
                detail=(
                    f"{current.label} made {_figure(current.net_profit, summary.currency)} "
                    f"after all costs, on sales of "
                    f"{_figure(current.revenue, summary.currency)}."
                ),
                # `revenue` is here because the Somali sentence needs it. A
                # translation template that names a value the finding does not
                # carry cannot be filled, and the report silently falls back to
                # English -- which is how a Somali report ended up with one
                # English paragraph in the middle of its findings.
                values={
                    "period": current.label,
                    "net_profit": float(current.net_profit),
                    "revenue": float(current.revenue),
                    "net_margin": current.net_margin,
                },
            )
        )

    # 2. Margin, against the period before. Revenue can rise while the business
    #    gets worse, and this is the pair of numbers that shows it.
    if previous and current.gross_margin is not None and previous.gross_margin is not None:
        points = (current.gross_margin - previous.gross_margin) * 100
        if points <= -MARGIN_POINTS:
            insights.append(
                Insight(
                    code="margin_down",
                    severity="watch",
                    detail=(
                        f"Gross margin fell from {previous.gross_margin * 100:.1f}% to "
                        f"{current.gross_margin * 100:.1f}%. Either buying prices rose or "
                        f"selling prices fell — the stock cost per unit of sales changed."
                    ),
                    values={"points": points, "from": previous.gross_margin, "to": current.gross_margin},
                )
            )
        elif points >= MARGIN_POINTS:
            insights.append(
                Insight(
                    code="margin_up",
                    severity="good",
                    detail=(
                        f"Gross margin rose from {previous.gross_margin * 100:.1f}% to "
                        f"{current.gross_margin * 100:.1f}%."
                    ),
                    values={"points": points, "from": previous.gross_margin, "to": current.gross_margin},
                )
            )

    # 3. A cost line that moved. Reported per category rather than in total,
    #    because "expenses up 9%" is not actionable and "electricity up 60%" is.
    if previous:
        before = {item.category: item.amount for item in previous.by_category}
        for item in current.by_category:
            if item.kind == "revenue":
                continue
            was = before.get(item.category, ZERO)
            moved = item.amount - was
            if abs(moved) < MATERIAL_AMOUNT:
                continue
            if was > 0 and moved / was >= Decimal("0.4"):
                insights.append(
                    Insight(
                        code="expense_spike",
                        severity="watch",
                        detail=(
                            f"{item.category.replace('_', ' ')} rose from {_q(was)} to "
                            f"{_q(item.amount)} {summary.currency}, up "
                            f"{float(moved / was) * 100:.0f}%."
                        ),
                        values={
                            "category": item.category,
                            "previous": float(was),
                            "current": float(item.amount),
                        },
                    )
                )
            elif was == 0 and item.amount >= MATERIAL_AMOUNT:
                insights.append(
                    Insight(
                        code="new_expense",
                        severity="watch",
                        detail=(
                            f"{item.category.replace('_', ' ')} appears for the first time, at "
                            f"{_q(item.amount)} {summary.currency}."
                        ),
                        values={"category": item.category, "current": float(item.amount)},
                    )
                )

    # 4. Concentration. One product or one customer carrying the business is not
    #    a problem today and is the thing that ends it.
    if summary.top_products and summary.top_products[0].share and summary.top_products[0].share >= 0.4:
        leader = summary.top_products[0]
        insights.append(
            Insight(
                code="product_concentration",
                severity="watch",
                detail=(
                    f"{leader.label} is {leader.share * 100:.0f}% of all sales in this period. "
                    f"A supply problem with one product would take most of the revenue with it."
                ),
                values={"product": leader.label, "share": leader.share},
            )
        )
    if summary.top_customers and summary.top_customers[0].share and summary.top_customers[0].share >= 0.35:
        leader = summary.top_customers[0]
        insights.append(
            Insight(
                code="customer_concentration",
                severity="watch",
                detail=(
                    f"{leader.label} accounts for {leader.share * 100:.0f}% of sales."
                ),
                values={"customer": leader.label, "share": leader.share},
            )
        )

    # 5. Refunds. Cheap to compute, and a rising return rate is usually the
    #    first visible sign of a stock quality problem.
    if total.revenue > 0 and total.refunds > 0:
        rate = float(total.refunds / (total.revenue + total.refunds))
        if rate >= 0.05:
            insights.append(
                Insight(
                    code="refund_rate",
                    severity="watch",
                    detail=(
                        f"Refunds and credits are {rate * 100:.1f}% of gross sales "
                        f"({_q(total.refunds)} {summary.currency})."
                    ),
                    values={"rate": rate, "refunds": float(total.refunds)},
                )
            )

    # 6. Data quality, stated as a limit on the report rather than as a nag. A
    #    figure built on 30% uncategorised costs is not wrong, but the reader
    #    needs to know which part of it is a bucket rather than a category.
    costs = total.cogs + total.expenses
    if costs > 0 and total.uncategorised > 0:
        share = float(total.uncategorised / costs)
        if share >= 0.1:
            insights.append(
                Insight(
                    code="uncategorised_costs",
                    severity="watch",
                    detail=(
                        f"{share * 100:.0f}% of costs ({_q(total.uncategorised)} "
                        f"{summary.currency}) could not be matched to a category and are "
                        f"reported as other. Naming those accounts in your system makes the "
                        f"next report sharper."
                    ),
                    values={"share": share, "amount": float(total.uncategorised)},
                )
            )

    # 7. Days with no sales inside a period that has sales around them. Usually
    #    a closure, sometimes a till that was not exported — either way the
    #    reader should know before comparing the month to the last one.
    if summary.granularity in ("monthly", "yearly") and current.days > 7:
        silent = current.days - current.trading_days
        if current.trading_days > 0 and silent >= max(3, current.days // 4):
            insights.append(
                Insight(
                    code="quiet_days",
                    severity="watch",
                    detail=(
                        f"{silent} of the {current.days} days in {current.label} recorded no "
                        f"transactions at all. If the shop was open on those days, some data "
                        f"has not reached this report."
                    ),
                    values={"silent_days": silent, "days": current.days},
                )
            )

    return insights


# -----------------------------------------------------------------------------
# Zakat
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class ZakatEstimate:
    """
    An indicative zakat figure, or an honest refusal to produce one.

    Zakat on trade goods is levied on *assets* held for a lunar year -- stock,
    cash and recoverable receivables, less short-term liabilities -- at 2.5%.
    It is not a percentage of profit, and a ledger of revenue and expenses does
    not contain the figures it needs.

    So this returns `computed=False` unless the caller supplies those balances,
    and the report then says what is missing instead of printing a number that
    looks authoritative and is not. That is the entire design of this type: the
    tempting version computes 2.5% of net profit, and it would be wrong in a way
    the reader cannot detect.
    """

    computed: bool
    rate: Decimal = Decimal("0.025")
    base: Decimal = ZERO
    amount: Decimal = ZERO
    missing: tuple[str, ...] = ()
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "computed": self.computed,
            "rate": float(self.rate),
            "base": float(self.base),
            "amount": float(self.amount),
            "missing": list(self.missing),
            "note": self.note,
        }


def estimate_zakat(balances: dict[str, Any] | None) -> ZakatEstimate:
    """
    2.5% of net zakatable trading assets, when the balances are known.

    `balances` carries `inventory_value`, `cash`, `receivables` and
    `short_term_liabilities` in the report's base currency. They come from the
    connection's settings, entered by the business, because none of the three
    sources reliably exposes a stock valuation this connector could trust.
    """
    fields = ("inventory_value", "cash", "receivables")
    supplied = balances or {}

    missing = tuple(name for name in fields if supplied.get(name) is None)
    if missing:
        return ZakatEstimate(
            computed=False,
            missing=missing,
            note=(
                "Zakat is due on trading assets held for a lunar year — stock, cash and "
                "receivables, less short-term debts — not on profit. Enter those balances on "
                "the connection and this figure will be calculated. It remains an estimate to "
                "check with your own scholar."
            ),
        )

    def amount(name: str) -> Decimal:
        value = supplied.get(name)
        return Decimal(str(value)) if value is not None else ZERO

    base = amount("inventory_value") + amount("cash") + amount("receivables")
    base -= amount("short_term_liabilities")
    if base < 0:
        base = ZERO

    return ZakatEstimate(
        computed=True,
        base=_q(base),
        amount=_q(base * Decimal("0.025")),
        # English. `somali.zakat_note` holds the other one and is keyed on
        # `computed`, so a report in Somali does not print one English paragraph
        # under a Somali heading.
        note=(
            "2.5% of stock, cash and receivables less short-term debts, as entered on this "
            "connection. An estimate for planning, not a ruling — check it with your scholar, "
            "and note that the year is counted in lunar months."
        ),
    )


__all__ = [
    "CategoryTotal",
    "FinancialSummary",
    "GRANULARITIES",
    "Granularity",
    "Insight",
    "MATERIAL_AMOUNT",
    "Movement",
    "Period",
    "Ranked",
    "WEEK_START",
    "ZakatEstimate",
    "build_periods",
    "estimate_zakat",
    "find_insights",
    "period_end",
    "period_label",
    "period_start",
    "summarise",
]
