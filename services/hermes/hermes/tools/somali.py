"""
Somali localisation for store reports and for connecting a store.

Not a translation layer bolted onto an English report. The figures are computed
once in `retail.py` and this module decides only how they are *said*, so the
Somali report and the English one are provably the same report -- there is no
arithmetic on either path that the other could get differently.

Three things here are more than vocabulary.

**Two currencies, and the dollar is the base.** Somali retail and wholesale
price in US dollars; the shilling is used for small change and is quoted
against the dollar rather than the other way round. So money is formatted in
the base currency and, when a shilling rate is configured, the shilling figure
is shown *beside* it rather than instead of it. A report that showed only
shillings would be unusable to the supplier the shop buys from, and one that
showed only dollars would be unusable at the till.

**The week runs Saturday to Friday.** `retail.py` buckets on that; this module
names the days in that order, so a weekday table reads in the order the shop
actually trades.

**Numerals stay Western.** Somali is written in the Latin script and Somali
business writing uses 0-9. Rendering figures in Eastern Arabic numerals would
be a costume, not a localisation.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any, Literal

Language = Literal["en", "so"]

LANGUAGES: tuple[Language, ...] = ("en", "so")

# Currency display. `decimals` is the interesting column: a shilling price is
# quoted to the shilling, and printing 712,450.00 for a bottle of water reads as
# a machine that has never seen the currency.
CURRENCIES: dict[str, dict[str, Any]] = {
    "USD": {"symbol": "$", "decimals": 2, "en": "US dollars", "so": "Doolar Mareykan"},
    "SOS": {"symbol": "Sh", "decimals": 0, "en": "Somali shillings", "so": "Shilin Soomaali"},
    "SLSH": {"symbol": "SL", "decimals": 0, "en": "Somaliland shillings", "so": "Shilin Somaliland"},
    "AED": {"symbol": "AED", "decimals": 2, "en": "UAE dirhams", "so": "Dirham Imaaraadka"},
    "ETB": {"symbol": "Br", "decimals": 2, "en": "Ethiopian birr", "so": "Birta Itoobiya"},
    "KES": {"symbol": "KSh", "decimals": 2, "en": "Kenyan shillings", "so": "Shilin Kenya"},
    "EUR": {"symbol": "€", "decimals": 2, "en": "euro", "so": "Yuuro"},
    "GBP": {"symbol": "£", "decimals": 2, "en": "pounds", "so": "Bawon"},
}

# Saturday first: the working week.
WEEKDAYS: dict[Language, dict[str, str]] = {
    "en": {
        "Saturday": "Saturday", "Sunday": "Sunday", "Monday": "Monday", "Tuesday": "Tuesday",
        "Wednesday": "Wednesday", "Thursday": "Thursday", "Friday": "Friday",
    },
    "so": {
        "Saturday": "Sabti", "Sunday": "Axad", "Monday": "Isniin", "Tuesday": "Talaado",
        "Wednesday": "Arbaco", "Thursday": "Khamiis", "Friday": "Jimce",
    },
}

MONTHS_SO = (
    "Janaayo", "Febraayo", "Maarso", "Abriil", "Maajo", "Juun",
    "Luuliyo", "Agoosto", "Sebtembar", "Oktoobar", "Nofembar", "Diseembar",
)

# Every label the report can print, in both languages. One table rather than
# scattered strings: a term that appears in the headline, the table header and
# the footnote must be the same word in all three, and the only way to be sure
# of that is for there to be one place it is written down.
TERMS: dict[str, tuple[str, str]] = {
    # (English, Somali)
    "report": ("Store financial report", "Warbixinta maaliyadeed ee dukaanka"),
    "revenue": ("Sales", "Iibka"),
    "gross_sales": ("Gross sales", "Iibka guud"),
    "refunds": ("Refunds and credits", "Celinta iyo dib-u-celinta"),
    "cogs": ("Cost of goods sold", "Qiimaha alaabta la iibiyay"),
    "gross_profit": ("Gross profit", "Faa'iidada guud"),
    "gross_margin": ("Gross margin", "Boqolkiiba faa'iidada guud"),
    "expenses": ("Running costs", "Kharashyada shaqada"),
    "net_profit": ("Net profit", "Faa'iidada saafiga ah"),
    "net_loss": ("Net loss", "Khasaaraha saafiga ah"),
    "net_margin": ("Net margin", "Boqolkiiba faa'iidada saafiga ah"),
    "period": ("Period", "Muddada"),
    "total": ("Total", "Wadarta"),
    "entries": ("Records", "Diiwaannada"),
    "trading_days": ("Trading days", "Maalmaha ganacsiga"),
    "average_daily_revenue": ("Average sales per day", "Celceliska iibka maalintii"),
    "category": ("Category", "Qaybta"),
    "amount": ("Amount", "Qiimaha"),
    "measure": ("Measure", "Cabbirka"),
    "value": ("Value", "Qiimaha"),
    "share": ("Share", "Boqolkiiba"),
    "product": ("Product", "Alaabta"),
    "customer": ("Customer", "Macmiilka"),
    "supplier": ("Supplier", "Alaab-qeybiyaha"),
    "account": ("Account", "Akoonka"),
    "quantity": ("Quantity", "Tirada"),
    "previous": ("Previous", "Hore"),
    "current": ("This period", "Muddadan"),
    "change": ("Change", "Isbeddelka"),
    "what_changed": ("What changed", "Waxa isbeddelay"),
    "what_to_watch": ("What to watch", "Waxa la eegayo"),
    "headline": ("The figures", "Tirooyinka"),
    "by_category": ("Where the money went", "Halka lacagtu tagtay"),
    "by_period": ("Sales over time", "Iibka waqtiga"),
    "best_days": ("Sales by day of the week", "Iibka maalmaha toddobaadka"),
    "top_products": ("Best-selling products", "Alaabta ugu iibka badan"),
    "top_customers": ("Biggest customers", "Macaamiisha ugu waaweyn"),
    "top_expenses": ("Biggest cost lines", "Kharashyada ugu waaweyn"),
    "zakat": ("Zakat estimate", "Qiyaasta zakada"),
    "coverage": ("What this report covers", "Waxa warbixintan ay daboolayso"),
    "source": ("Source", "Isha xogta"),
    "generated": ("Produced", "La sameeyay"),
    "no_data": ("No records were found for this period.", "Muddadan wax diiwaan ah looma helin."),
    "alert": ("Needs attention", "Waxay u baahan tahay fiiro"),
    "watch": ("Worth watching", "Fiiro gaar ah"),
    "good": ("Going well", "Si wanaagsan u socota"),
}

# The category vocabulary, in both languages. Keys match
# `connectors.ledger.CATEGORY_KINDS` exactly; a category with no entry here
# falls back to its own name with underscores removed, which is ugly but never
# wrong.
CATEGORY_LABELS: dict[str, tuple[str, str]] = {
    "sales": ("Sales", "Iibka"),
    "wholesale": ("Wholesale", "Jumlada"),
    "services": ("Services", "Adeegyada"),
    "other_income": ("Other income", "Dakhli kale"),
    "purchases": ("Stock purchases", "Iibsiga alaabta"),
    "freight_in": ("Freight and shipping", "Xamuulka iyo raridda"),
    "customs_duty": ("Customs duty", "Canshuurta kastamka"),
    "inventory_adjustment": ("Stock adjustments", "Hagaajinta bakhaarka"),
    "rent": ("Rent", "Kirada"),
    "salaries": ("Wages", "Mushaharka"),
    "electricity": ("Electricity and generator", "Korontada iyo matoorka"),
    "water": ("Water", "Biyaha"),
    "security": ("Security", "Ammaanka"),
    "transport": ("Transport and fuel", "Gaadiidka iyo shidaalka"),
    "communications": ("Phone and internet", "Telefoonka iyo internetka"),
    "remittance_fees": ("Transfer fees", "Khidmadaha xawaaladda"),
    "bank_charges": ("Bank charges", "Khidmadaha bangiga"),
    "municipal_tax": ("Local taxes and licences", "Canshuuraha iyo ruqsadaha degmada"),
    "marketing": ("Advertising", "Xayeysiinta"),
    "repairs": ("Repairs and maintenance", "Dayactirka"),
    "supplies": ("Shop supplies", "Qalabka dukaanka"),
    "insurance": ("Insurance", "Caymiska"),
    "zakat_and_sadaqa": ("Zakat and sadaqa", "Zakada iyo sadaqada"),
    "other_expense": ("Other costs", "Kharashyo kale"),
}

GRANULARITY_LABELS: dict[str, tuple[str, str]] = {
    "daily": ("Daily", "Maalinle"),
    "weekly": ("Weekly", "Toddobaadle"),
    "monthly": ("Monthly", "Bishiiba"),
    "yearly": ("Yearly", "Sanadle"),
}

# The insight sentences, keyed by the `code` on `retail.Insight`. English is
# already on the insight; Somali is a template filled from its `values`, which
# is why the codes exist at all -- translating the finished English sentence
# would mean parsing numbers back out of prose.
INSIGHTS_SO: dict[str, str] = {
    "loss_making": "{period} waxay ku dhammaatay khasaare {net_profit}: kharashyadu way ka badnaayeen iibka.",
    "profitable": "{period} waxay dhalisay faa'iido saafi ah {net_profit}, iib ah {revenue} kadib.",
    "margin_down": "Boqolkiiba faa'iidada guud wuxuu ka soo degay {from_pct}% ilaa {to_pct}%. Ama qiimaha aad ku iibsato ayaa kordhay, ama kii aad ku iibiso ayaa hoos u dhacay.",
    "margin_up": "Boqolkiiba faa'iidada guud wuxuu ka kacay {from_pct}% ilaa {to_pct}%.",
    "expense_spike": "{category} wuxuu ka kacay {previous} ilaa {current}, kordh {percent}%.",
    "new_expense": "{category} ayaa markii ugu horreysay soo baxaya, oo ah {current}.",
    "product_concentration": "{product} waa {share}% iibka oo dhan. Haddii alaabtaas la waayo, iibka intiisa badan ayaa la baabba'aya.",
    "customer_concentration": "{customer} wuxuu keenayaa {share}% iibka.",
    "refund_rate": "Celinta alaabtu waa {rate}% iibka guud ({refunds}).",
    "uncategorised_costs": "{share}% kharashyada ({amount}) qayb looma helin, waxaana lagu soo warramay 'kharashyo kale'. Haddii aad magacyada akoonnada hagaajiso, warbixinta xigta way sii saxsanaan doontaa.",
    "quiet_days": "{silent_days} maalmood oo ka mid ah {days} maalmood lama diiwaangelin wax macaamil ah. Haddii dukaanku furnaa, xog ayaa ka maqan warbixintan.",
}


# The zakat paragraph, which the report prints verbatim rather than as a label.
# Keyed on whether a figure was produced, because the two say different things:
# one explains a number, the other explains why there is not one.
ZAKAT_NOTES: dict[str, str] = {
    "computed": (
        "2.5% hantida alaabta, lacagta iyo deynaha lagu leeyahay, ka dib markii laga jaray "
        "deynaha gaaban. Kani waa qiyaas qorshaynta loogu talagalay, ma aha fatwo — la tasho "
        "sheekhaaga, oo xusuuso in sannadka lagu tiriyo bilaha dayaxa."
    ),
    "missing": (
        "Zakada waxaa lagu bixiyaa hantida ganacsiga ee sannad-dayaxeed la hayay — alaabta, "
        "lacagta iyo deynaha lagu leeyahay, ka dib markii laga jaray deynaha gaaban — mana aha "
        "faa'iidada. Ku qor tirooyinkaas isku xirka dukaanka, waana la xisaabin doonaa. Weli waa "
        "qiyaas aad sheekhaaga la hubinayso."
    ),
}


def zakat_note(computed: bool, english: str, language: Language = "en") -> str:
    """
    The zakat paragraph in the report's language.

    Falls back to the English the estimator wrote rather than to a guess, on the
    same principle as `translate_insight`: an untranslated paragraph a reader can
    still parse beats a fluent one that says something the figures do not.
    """
    if language != "so":
        return english
    return ZAKAT_NOTES["computed" if computed else "missing"]


# The credential roles, named the way the person holding the file would name
# them. `client_id` is a role name in our code and a meaningless phrase to a
# shopkeeper, and the Somali gloss matters more here than anywhere else in the
# product: this is the one screen where someone is looking at a file they were
# handed and trying to work out which line is which.
FIELD_LABELS: dict[str, tuple[str, str]] = {
    "client_id": ("Client ID", "Client ID — aqoonsiga barnaamijka"),
    "client_secret": ("Client secret", "Client secret — furaha qarsoon ee barnaamijka"),
    "refresh_token": ("Refresh token", "Refresh token — furaha cusboonaysiinta"),
    "realm_id": ("Company ID", "Company ID — aqoonsiga shirkadda QuickBooks"),
    "base_url": ("Odoo address", "Cinwaanka Odoo — sida https://dukaankayga.odoo.com"),
    "database": ("Database name", "Magaca database-ka"),
    "username": ("Username", "Magaca isticmaalaha"),
    "api_key": ("API key", "API key — furaha Odoo"),
}

# What a connection test says when it is done. Keyed by code so the sentence a
# shop reads and the sentence stored on the job are the same fact in two
# languages, rather than an English message with a Somali caption.
CONNECTION_MESSAGES: dict[str, tuple[str, str]] = {
    "connected": (
        "Connected to {company}. The agent can read this store.",
        "Waa la isku xiray {company}. Wakiilku hadda wuu akhrisan karaa dukaankan.",
    ),
    "connected_unnamed": (
        "Connected. The agent can read this store.",
        "Waa la isku xiray. Wakiilku hadda wuu akhrisan karaa dukaankan.",
    ),
    "missing": (
        "Almost there. Still needed: {fields}.",
        "Waad ku dhowdahay. Wali waxaa loo baahan yahay: {fields}.",
    ),
    "nothing_understood": (
        "Nothing in what was pasted looks like a credential for this system. "
        "Paste the whole file or email you were sent, including the labels.",
        "Waxa la dhajiyay midna uma eka furayaal nidaamkan. Fadlan dhaji dhammaan faylka ama "
        "emailka lagu soo diray, magacyada oo dhan la socdaan.",
    ),
    "refused": (
        "{system} refused these credentials. {detail}",
        "{system} wuu diiday furayaashan. {detail}",
    ),
    "unreachable": (
        "The agent could not reach {system}. {detail}",
        "Wakiilku ma gaari karin {system}. {detail}",
    ),
    "no_credentials_needed": (
        "A spreadsheet store reads the files you upload here, so there is nothing to connect.",
        "Dukaanka warqadda Excel wuxuu akhriyaa faylasha aad halkan soo shubto, "
        "sidaas darteed wax la isku xiro ma jiro.",
    ),
}

# What to do next, which is the half a shopkeeper actually needs.
NEXT_STEPS: dict[str, tuple[str, str]] = {
    "ask_owner": (
        "Send the request below to whoever set up your system — your accountant, or the "
        "company that installed it. They will recognise what it asks for.",
        "Codsiga hoose u dir qofka nidaamkaaga sameeyay — xisaabiyahaaga, ama shirkadda "
        "kuu rakibtay. Way garan doonaan waxa la weydiinayo.",
    ),
    "reconnect": (
        "Reconnect the company and paste the new credentials. A QuickBooks refresh token "
        "expires after 100 days without use.",
        "Dib u xir shirkadda oo dhaji furayaasha cusub. Furaha QuickBooks wuu dhacaa haddii "
        "aan la isticmaalin 100 maalmood.",
    ),
    "check_address": (
        "Check the address is the one you use in a browser, and that it opens from outside "
        "your shop's own network.",
        "Hubi in cinwaanku yahay kan aad browser-ka ku isticmaasho, iyo inuu ka furmo meel "
        "ka baxsan shabakadda dukaanka.",
    ),
    "ready": (
        "Nothing else to do. Ask for a report whenever you like, or put one on a schedule.",
        "Wax kale ma jiraan. Warbixin codso markaad rabto, ama jadwal u samee.",
    ),
}


def field_label(role: str, language: Language = "en") -> str:
    pair = FIELD_LABELS.get(role)
    if not pair:
        return role.replace("_", " ")
    return pair[1] if language == "so" else pair[0]


def connection_message(code: str, language: Language = "en", **values: Any) -> str:
    """
    A connection-test verdict, in the reader's language.

    Falls back to the code's English rather than to a formatted string with a
    hole in it: a template that outgrew its values is a bug, and the reader
    should see a sentence either way.
    """
    pair = CONNECTION_MESSAGES.get(code)
    if not pair:
        return str(values.get("detail") or code)
    template = pair[1] if language == "so" else pair[0]
    try:
        return template.format(**values).strip()
    except (KeyError, IndexError):
        return (pair[0].format(**values) if language == "so" else template).strip()


def next_step(code: str, language: Language = "en") -> str:
    pair = NEXT_STEPS.get(code)
    if not pair:
        return ""
    return pair[1] if language == "so" else pair[0]


def term(key: str, language: Language = "en") -> str:
    pair = TERMS.get(key)
    if not pair:
        return key.replace("_", " ")
    return pair[1] if language == "so" else pair[0]


def category_label(category: str, language: Language = "en") -> str:
    pair = CATEGORY_LABELS.get(category)
    if not pair:
        return category.replace("_", " ").capitalize()
    return pair[1] if language == "so" else pair[0]


def granularity_label(granularity: str, language: Language = "en") -> str:
    pair = GRANULARITY_LABELS.get(granularity)
    if not pair:
        return granularity
    return pair[1] if language == "so" else pair[0]


def weekday_label(name: str, language: Language = "en") -> str:
    return WEEKDAYS.get(language, WEEKDAYS["en"]).get(name, name)


def _group(value: Decimal, decimals: int) -> str:
    quantised = f"{abs(value):,.{decimals}f}"
    return quantised


def money(
    value: Decimal | float | None,
    currency: str = "USD",
    *,
    language: Language = "en",
) -> str:
    """
    A figure in one currency.

    Negatives are parenthesised rather than signed, which is what a set of
    accounts uses and what the rest of this codebase already does -- the source
    workbooks write credits as `(150.00)` and a report that flips them to
    `-$150.00` reads as foreign to the person checking it against their own
    sheet.
    """
    if value is None:
        return "—"
    amount = value if isinstance(value, Decimal) else Decimal(str(value))
    spec = CURRENCIES.get(currency.upper(), {"symbol": currency.upper() + " ", "decimals": 2})
    text = f"{spec['symbol']}{_group(amount, int(spec['decimals']))}"
    return f"({text})" if amount < 0 else text


def dual_money(
    value: Decimal | float | None,
    base: str = "USD",
    *,
    secondary: str | None = None,
    rate: Decimal | None = None,
    language: Language = "en",
) -> str:
    """
    The base figure, and the same figure in shillings beside it.

    Only when a rate is configured. A converted figure with no stated rate is a
    number nobody can check, and the rate travels into the report's footnote for
    exactly that reason.
    """
    primary = money(value, base, language=language)
    if value is None or not secondary or rate is None or rate == 0:
        return primary
    amount = value if isinstance(value, Decimal) else Decimal(str(value))
    return f"{primary}  ·  {money(amount * rate, secondary, language=language)}"


def percent(value: float | None, *, places: int = 1) -> str:
    if value is None:
        return "—"
    return f"{value * 100:.{places}f}%"


def signed_percent(value: float | None, *, places: int = 1) -> str:
    if value is None:
        return "—"
    return f"{value:+.{places}f}%"


def format_date(day: dt.date, language: Language = "en") -> str:
    if language == "so":
        return f"{day.day} {MONTHS_SO[day.month - 1]} {day.year}"
    return day.strftime("%d %B %Y")


def format_period_label(label: str, granularity: str, language: Language = "en") -> str:
    """
    Make a machine label readable, in either language.

    `retail.period_label` produces sortable labels -- 2026-08, 2026-08-14, a
    date range. Sortable is what the data needs; this is what the reader needs,
    and the two are deliberately different strings rather than one compromise.
    """
    if language != "so":
        if granularity == "monthly" and len(label) == 7:
            try:
                return dt.date(int(label[:4]), int(label[5:7]), 1).strftime("%B %Y")
            except ValueError:
                return label
        return label

    if granularity == "monthly" and len(label) == 7:
        try:
            month = int(label[5:7])
            return f"{MONTHS_SO[month - 1]} {label[:4]}"
        except (ValueError, IndexError):
            return label
    if granularity == "daily":
        try:
            return format_date(dt.date.fromisoformat(label), "so")
        except ValueError:
            return label
    return label


def translate_insight(code: str, english: str, values: dict[str, Any], currency: str = "USD") -> str:
    """
    The Somali sentence for an insight, or the English one when there is none.

    Falling back to English rather than to a machine translation is deliberate:
    an untranslated finding that a Somali reader can still parse is better than
    a fluent sentence that says something the figures do not.
    """
    template = INSIGHTS_SO.get(code)
    if not template:
        return english

    filled: dict[str, Any] = {}
    for key, value in values.items():
        if key in ("net_profit", "revenue", "previous", "current", "refunds", "amount"):
            filled[key] = money(abs(Decimal(str(value))) if value is not None else None, currency)
        elif key == "share" or key == "rate":
            filled[key] = f"{float(value) * 100:.0f}"
        elif key == "category":
            filled[key] = category_label(str(value), "so")
        else:
            filled[key] = value

    if "from" in values and "to" in values:
        filled["from_pct"] = f"{float(values['from']) * 100:.1f}"
        filled["to_pct"] = f"{float(values['to']) * 100:.1f}"
    if "previous" in values and "current" in values and values.get("previous"):
        try:
            moved = (float(values["current"]) - float(values["previous"])) / abs(
                float(values["previous"])
            )
            filled["percent"] = f"{moved * 100:.0f}"
        except (ZeroDivisionError, ValueError, TypeError):
            filled["percent"] = "—"

    try:
        return template.format(**filled)
    except (KeyError, IndexError):
        # A template that outgrew its values is a bug, and the right behaviour
        # for the reader is the English sentence rather than a traceback or a
        # half-filled Somali one.
        return english


__all__ = [
    "CATEGORY_LABELS",
    "CONNECTION_MESSAGES",
    "FIELD_LABELS",
    "NEXT_STEPS",
    "CURRENCIES",
    "GRANULARITY_LABELS",
    "LANGUAGES",
    "Language",
    "MONTHS_SO",
    "TERMS",
    "WEEKDAYS",
    "ZAKAT_NOTES",
    "category_label",
    "connection_message",
    "dual_money",
    "format_date",
    "format_period_label",
    "field_label",
    "granularity_label",
    "money",
    "next_step",
    "percent",
    "signed_percent",
    "term",
    "translate_insight",
    "weekday_label",
    "zakat_note",
]
