"""
UK tax categories, and the rules that assign them without asking a model.

Why this exists as its own module rather than as a prompt.

Categorising a bank statement for a UK tax return is not an open question. The
destination is fixed: HMRC's self-employment pages (SA103F) have numbered boxes,
and every deductible cost has to land in one of them. "Communications" and
"Telecoms & Utilities" are perfectly reasonable English and neither is a box on
the return, so a categorisation that invents its own vocabulary produces a
column an accountant then has to re-map by hand before it is worth anything.

So the vocabulary here is closed and it is HMRC's. `CATEGORIES` is the list, in
box order, with the box number kept alongside the name.

The second half is `RULES`: ordered patterns over the text of a transaction.
They matter for a reason beyond speed. The categorise job used to refuse to run
at all without a model configured, so a worker with no API key answered
"categorising needs a model" to the one question this product exists to answer.
Rules make the common case -- a UK current account full of the same two hundred
merchants -- decidable from a table, and leave the model for the tail.

**Every rule carries its own confidence, and that is the point of the module.**
A bank statement line says who was paid. It does not say what was bought or why,
and for a great many merchants that gap is unbridgeable: `TESCO STORES 3411` is
a weekly shop or it is client refreshments, and nothing in the row decides which.
Filing that as a confident business deduction is how a tool becomes a liability.
So `TFL TRAVEL` is high confidence and `AMZN MKTP` is not a category at all --
it is flagged, with the reason attached. The agent is allowed to be unsure; it is
not allowed to be unsure quietly.

Rules are matched against a *normalised* form of the value: lowercased, with
card-terminal noise ("CARD PAYMENT TO", trailing dates, four-digit card tails,
long references) stripped, because "TFL TRAVEL CH 08JUN" and "TFL.GOV.UK/CP" are
the same merchant to everyone except a regular expression.

Order is significant. The first matching rule wins, so the specific patterns are
listed before the general ones: `AMAZON WEB SERVICES` is matched before
`AMAZON`, an HMRC VAT payment before anything that merely mentions tax, and a
supermarket's petrol station before the supermarket.

Nothing here decides anything on its own. The rules produce a *mapping*, the job
turns that into a proposal, and the proposal is applied into a new immutable
version with an audit line behind it -- the same path the model's answers take,
for the same reason.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Literal

from .values import normalize_text

Confidence = Literal["high", "medium", "low"]

HIGH: Confidence = "high"
MEDIUM: Confidence = "medium"
LOW: Confidence = "low"


@dataclass(frozen=True)
class Category:
    """One destination: what it is called, and where it goes on the return."""

    name: str
    box: str
    note: str


@dataclass(frozen=True)
class Decision:
    """
    One value's classification, with the reasoning that produced it.

    Carries evidence rather than a bare label because the proposal, the output
    file and the audit trail all need to be able to answer "why" without anybody
    re-running the model. `source` separates the two authorities: a rule is
    prose somebody can read and argue with, a model answer is not.
    """

    category: str
    box: str
    confidence: Confidence
    evidence: str
    coa: str | None = None
    # "unplaced" is neither authority answering -- no rule matched and no
    # model placed it. Counted apart from both, because reporting it as a
    # rule match would inflate the number the run is judged on.
    source: Literal["rule", "model", "unplaced"] = "rule"

    @property
    def needs_review(self) -> bool:
        """
        Whether a person should look at this before it reaches a return.

        Low confidence or no category at all. A `medium` is not flagged: it means
        the evidence identified the merchant but not the purpose, which is the
        normal state of most of a bank statement and would make the flag
        meaningless if it counted.
        """
        return self.confidence == LOW or self.category == FALLBACK

    def to_row(self) -> dict[str, str]:
        """The three columns this writes into the customer's file."""
        return {
            CATEGORY_COLUMN: self.category,
            BOX_COLUMN: self.box,
            CONFIDENCE_COLUMN: CONFIDENCE_LABELS[self.confidence],
        }


# -----------------------------------------------------------------------------
# The vocabulary
# -----------------------------------------------------------------------------
#
# Boxes 15-30 are SA103F (self-employment, full). The six categories after them
# carry no box because they are not business expense figures: capital, money owed
# to HMRC, money the trader took out, money moved between their own accounts,
# private spending, and the honest admission that a value was not recognised.
#
# They exist so the column accounts for every row. A statement whose personal
# transfers are quietly filed under "other business expenses" is worse than one
# that says it does not know.

CATEGORIES: tuple[Category, ...] = (
    Category(
        "Business Income", "SA103F box 15", "Turnover: takings, fees, sales and commission"
    ),
    Category("Other Business Income", "SA103F box 16", "Business income outside turnover"),
    Category(
        "Cost of Goods Bought for Resale",
        "SA103F box 17",
        "Stock, materials and other direct costs",
    ),
    Category(
        "Construction Industry Subcontractors",
        "SA103F box 18",
        "Payments to subcontractors under CIS",
    ),
    Category(
        "Staff Costs",
        "SA103F box 19",
        "Wages, salaries, employer NIC and pension contributions",
    ),
    Category(
        "Travel and Subsistence",
        "SA103F box 20",
        "Vehicle running costs, fares, parking, hotels and meals away",
    ),
    Category("Premises Costs", "SA103F box 21", "Rent, business rates, power and insurance"),
    Category(
        "Repairs and Maintenance",
        "SA103F box 22",
        "Repairs and renewals of premises and equipment",
    ),
    Category(
        "Office Costs",
        "SA103F box 23",
        "Phone, internet, stationery, postage, software and small equipment",
    ),
    Category(
        "Advertising and Entertainment",
        "SA103F box 24",
        "Advertising and marketing; client entertaining is disallowable",
    ),
    Category("Interest on Loans", "SA103F box 25", "Interest on bank and other business loans"),
    Category(
        "Bank and Finance Charges",
        "SA103F box 26",
        "Bank charges, card processing fees, lease and HP charges",
    ),
    Category("Irrecoverable Debts", "SA103F box 27", "Bad debts written off"),
    Category(
        "Professional Fees", "SA103F box 28", "Accountancy, legal and other professional costs"
    ),
    Category(
        "Depreciation and Loss on Assets",
        "SA103F box 29",
        "Depreciation -- disallowable, added back in box 44",
    ),
    Category(
        "Other Business Expenses",
        "SA103F box 30",
        "Subscriptions, training and anything else allowable",
    ),
    # No box on purpose. Capital does not go in an expense box at all -- it goes
    # to capital allowances, and putting it in box 30 is a real filing error.
    Category(
        "Capital Expenditure",
        "",
        "Equipment and assets -- capital allowances, not an expense box",
    ),
    Category("HMRC and Tax Payments", "", "VAT, PAYE, Self Assessment and Corporation Tax"),
    Category("Owner Drawings", "", "Money taken out by the proprietor -- not an expense"),
    Category("Transfers Between Accounts", "", "Movement between the trader's own accounts"),
    Category("Personal, Non-Business", "", "Private spending -- not an allowable deduction"),
    Category("Uncategorised", "", "Not recognised with enough evidence; needs a person"),
)

CATEGORY_NAMES: tuple[str, ...] = tuple(category.name for category in CATEGORIES)

BOX_BY_CATEGORY: dict[str, str] = {
    category.name: category.box for category in CATEGORIES if category.box
}

NOTE_BY_CATEGORY: dict[str, str] = {category.name: category.note for category in CATEGORIES}

FALLBACK = "Uncategorised"

# The name this taxonomy is asked for by, on a job payload and in the dashboard.
TAXONOMY = "uk_hmrc"

# The three columns added to the customer's file. Named as an accountant would
# write them, not as the database would.
CATEGORY_COLUMN = "HMRC Category"
BOX_COLUMN = "HMRC Box"
CONFIDENCE_COLUMN = "Confidence"

OUTPUT_COLUMNS: tuple[str, ...] = (CATEGORY_COLUMN, BOX_COLUMN, CONFIDENCE_COLUMN)

CONFIDENCE_LABELS: dict[str, str] = {HIGH: "High", MEDIUM: "Medium", LOW: "Needs review"}

# What an unrecognised value becomes. Written rather than left blank, so a filter
# on the column finds it.
UNKNOWN = Decision(
    category=FALLBACK,
    box="",
    confidence=LOW,
    evidence="No rule matched and no model placed this value",
    coa="SUSPENSE_UNIDENTIFIED",
    source="unplaced",
)

# Handed to the model as context when it is asked to finish what the rules could
# not. Short on purpose: the closed list does the real constraining, and the
# filter on the way back is what enforces it.
MODEL_HINT = (
    "These are lines from a UK business bank statement being prepared for a Self "
    "Assessment return. Assign each to the HMRC SA103F category it belongs in. Be "
    "conservative: a merchant name alone does not prove business purpose. Private "
    "spending goes to 'Personal, Non-Business', money the proprietor took out goes to "
    "'Owner Drawings', movement between the trader's own accounts goes to 'Transfers "
    "Between Accounts', and equipment goes to 'Capital Expenditure' rather than an "
    "expense box. If the description does not say what was bought, answer "
    "'Uncategorised' rather than guessing."
)


# -----------------------------------------------------------------------------
# Normalising a statement line
# -----------------------------------------------------------------------------

# What a bank puts in front of the merchant. Stripped so the same shop matches
# whether it arrived as a card payment, a direct debit or a standing order.
_PREFIXES = re.compile(
    r"^(card payment to|card payment|payment to|payment from|direct debit|"
    r"standing order|faster payment|bank giro credit|bgc|debit card payment|"
    r"contactless payment|pos|dd|so|chq|cheque)\b[\s:.-]*"
)

# The tail a terminal appends: a card's last four digits, a date, a long
# reference, an exchange-rate note. None of it identifies the merchant.
_NOISE = (
    re.compile(r"\bcard\s*\d{4}\b"),
    re.compile(r"\bref(?:erence)?[\s:.]*[a-z0-9-]{4,}\b"),
    re.compile(r"\b\d{1,2}[a-z]{3}\d{2,4}\b"),             # 08jun26
    re.compile(r"\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b"),  # 08/06, 08-06-26
    re.compile(r"\bgbp\b|\bnon[- ]?sterling\b"),
    re.compile(r"\b\d{6,}\b"),                              # long references
)


def normalise(value: object) -> str:
    """
    A statement line reduced to the part that names a merchant.

    Not a display transform. The original value is what the accountant reviews
    and what the applied mapping is keyed on; this exists only so the rules below
    can be written against merchants rather than against every way a bank has
    ever spelled one.
    """
    text = normalize_text(value).lower()
    if not text:
        return ""

    text = _PREFIXES.sub("", text)
    for pattern in _NOISE:
        text = pattern.sub(" ", text)
    # Punctuation to spaces, so "tfl.gov.uk/cp" and "amazon*mktplce" break into
    # words a pattern can anchor on.
    text = re.sub(r"[^a-z0-9& ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


# -----------------------------------------------------------------------------
# The rules
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class Rule:
    """
    One pattern and what it means, including how sure it makes us.

    `evidence` is written to be read by an accountant reviewing the column, so it
    names the reason rather than the regex. `coa` is the chart-of-accounts code
    from the agent's own taxonomy, carried for downstream mapping and never shown
    to the customer.
    """

    pattern: str
    category: str
    confidence: Confidence
    evidence: str
    coa: str


# Read top to bottom; the first match wins.
#
# The patterns are word-anchored on purpose. An unanchored "bp" matches "bpost"
# and an unanchored "ee" matches almost everything, so a token short enough to be
# dangerous is required to stand alone.
_RULES_RAW: tuple[Rule, ...] = (
    # -- HMRC and statutory, first: these mention words later rules also read --
    Rule(r"\bhmrc\b|\bhm revenue\b|\bcumbernauld\b|\bshipley\b",
         "HMRC and Tax Payments", HIGH, "HMRC payment reference", "EXCL_TAX_PAYMENTS"),
    Rule(r"\bvat (?:return|payment|bill|quarter)\b|\bself assessment\b|"
         r"\bcorporation tax\b|\bcompanies house\b",
         "HMRC and Tax Payments", HIGH, "Tax or filing payment", "EXCL_TAX_PAYMENTS"),
    Rule(r"\bpaye\b|\bnational insurance\b|\bstudent loan\b",
         "HMRC and Tax Payments", HIGH, "PAYE or NIC payment", "EXCL_TAX_PAYMENTS"),

    # -- Statutory disallowables, before anything that could claim them --------
    # A parking fine is a parking cost by every pattern below and is never
    # allowable (SOUL step 4). Ordered here rather than beside the other personal
    # rules because `\bparking\b` in the travel block would otherwise reach it
    # first and file a penalty as a business expense.
    Rule(r"\bparking fine\b|\bpenalty charge\b|\bpcn\b|\bspeeding\b|\bfixed penalty\b",
         "Personal, Non-Business", HIGH,
         "Fine or penalty -- never allowable", "EXCL_FINES_PENALTIES"),

    # -- Money that is not a business cost at all ------------------------------
    # Two separate answers, deliberately. A transfer moves money the business
    # still has; a drawing is money that has left it. Filing one as the other
    # misstates the capital account.
    Rule(r"\btransfer\b|\btfr\b|\bto savings\b|\bfrom savings\b|\bown account\b|\bisa\b",
         "Transfers Between Accounts", HIGH, "Movement between own accounts",
         "EXCL_INTER_ACCOUNT_TRANSFER"),
    Rule(r"\bdrawings\b|\bowner draw\w*\b|\bpersonal draw\w*\b",
         "Owner Drawings", HIGH, "Described as drawings", "EXCL_DRAWINGS"),
    # Medium, not high: a cash withdrawal is usually drawings and is occasionally
    # a genuine cash purchase. The row cannot tell us which.
    Rule(r"\bcash withdrawal\b|\batm\b|\blink atm\b|\bcashpoint\b",
         "Owner Drawings", MEDIUM, "Cash withdrawal; purpose not evidenced",
         "EXCL_DRAWINGS"),
    Rule(r"\bdividend\b", "Owner Drawings", HIGH, "Dividend payment", "EXCL_DIVIDENDS"),

    # -- Income ---------------------------------------------------------------
    Rule(r"\bsalary\b|\bwages in\b|\bpayroll credit\b",
         "Business Income", MEDIUM, "Salary credit", "EXCL_PERSONAL"),
    Rule(r"\bstripe\b(?!.*\bfee\b)|\bsquare up\b|\bsumup\b(?!.*\bfee\b)|\bzettle\b|"
         r"\bshopify payout\b|\betsy deposit\b|\bamazon payments uk\b",
         "Business Income", HIGH, "Card acquirer or marketplace payout", "COGS_STOCK_MOVEMENT"),
    Rule(r"\binvoice\b|\bsales receipt\b|\bcustomer payment\b|\bcommission received\b|"
         r"\btakings\b",
         "Business Income", HIGH, "Described as sales income", "COGS_STOCK_MOVEMENT"),
    Rule(r"\bgrant\b|\binterest paid\b|\brefund\b|\brebate\b|\bcashback\b",
         "Other Business Income", MEDIUM, "Refund, grant or interest received",
         "COGS_STOCK_MOVEMENT"),

    # -- Staff ----------------------------------------------------------------
    Rule(r"\bpayroll\b|\bwages\b|\bsalaries\b|\bnest pension\b|\bsmart pension\b|"
         r"\bpeoples pension\b|\bnow pensions\b|\bsage payroll\b",
         "Staff Costs", HIGH, "Payroll or pension provider", "STAFF_GROSS_WAGES"),

    # -- Construction ---------------------------------------------------------
    Rule(r"\bcis\b|\bsub ?contractor\w*\b",
         "Construction Industry Subcontractors", HIGH, "CIS subcontractor payment",
         "COGS_SUBCONTRACTORS"),

    # -- Fuel before supermarkets, and before the parent brands ---------------
    Rule(r"\btesco petrol\b|\bmorrisons petrol\b|\bsainsburys petrol\b|\basda petrol\b|"
         r"\bshell\b|\besso\b|\btexaco\b|\bgulf\b|\bbp\b(?!\w)|\bjet filling\b|"
         r"\bfuel\b|\bpetrol\b|\bdiesel\b|\bev charge\b|\bpodpoint\b|\binstavolt\b|"
         r"\bbp pulse\b",
         "Travel and Subsistence", HIGH, "Fuel or vehicle charging", "MOTOR_FUEL"),

    # -- Cloud and software before the retail brands they share a name with ---
    Rule(r"\baws\b|\bamazon web services\b|\bdigitalocean\b|\bheroku\b|\bcloudflare\b|"
         r"\bgodaddy\b|\b123 reg\b|\bionos\b|\bnamecheap\b|\bhostinger\b|\bwix\b|"
         r"\bsquarespace\b|\bwordpress\b",
         "Office Costs", HIGH, "Hosting or domain provider", "OFFICE_SOFTWARE_SUBS"),

    # -- Travel and subsistence ----------------------------------------------
    Rule(r"\btfl\b|\boyster\b|\btrainline\b|\bnational rail\b|\bgwr\b|\bavanti\b|\blner\b|"
         r"\bnorthern rail\b|\bscotrail\b|\bstagecoach\b|\bfirst bus\b|\bmegabus\b|"
         r"\bnational express\b",
         "Travel and Subsistence", HIGH, "Public transport operator", "TRAVEL_RAIL_AIR"),
    Rule(r"\buber\b(?!.*\beats\b)|\bbolt\b|\bfreenow\b|\baddison lee\b|\btaxi\b|\bminicab\b",
         "Travel and Subsistence", HIGH, "Licensed taxi or private hire", "TRAVEL_RAIL_AIR"),
    Rule(r"\bncp\b|\bringgo\b|\bpaybyphone\b|\bparking\b|\bcongestion charge\b|"
         r"\bdart charge\b|\bulez\b|\bm6toll\b|\bmersey flow\b",
         "Travel and Subsistence", HIGH, "Parking, toll or road charge",
         "TRAVEL_PARKING_TOLLS"),
    Rule(r"\beasyjet\b|\bryanair\b|\bbritish airways\b|\bjet2\b|\bpremier inn\b|"
         r"\btravelodge\b|\bbooking com\b|\bairbnb\b|\bexpedia\b|\bhotel\b",
         "Travel and Subsistence", MEDIUM, "Travel or accommodation; purpose not evidenced",
         "TRAVEL_ACCOMMODATION"),
    Rule(r"\bhalfords\b|\bkwik fit\b|\bnational tyres\b|\bmot\b|\bcar service\b|"
         r"\bbreakdown cover\b|\bthe aa\b|\brac\b|\bgreen flag\b|\bdvla\b",
         "Travel and Subsistence", MEDIUM, "Vehicle running cost; private use not known",
         "MOTOR_REPAIRS"),

    # -- Premises -------------------------------------------------------------
    Rule(r"\brent\b|\bbusiness rates\b|\bservice charge\b|\bground rent\b|\bwework\b|"
         r"\bregus\b|\bstorage\b|\bbig yellow\b|\bsafestore\b",
         "Premises Costs", HIGH, "Rent, rates or workspace", "PREM_RENT"),
    Rule(r"\bbritish gas\b|\be ?on\b|\bedf\b|\bnpower\b|\bscottish power\b|\bsse\b|"
         r"\bovo energy\b|\boctopus energy\b|\bbulb\b|\bshell energy\b|\butilita\b|"
         r"\butility warehouse\b",
         "Premises Costs", HIGH, "Energy supplier", "PREM_UTILITIES"),
    Rule(r"\bthames water\b|\bsevern trent\b|\banglian water\b|\bunited utilities\b|"
         r"\byorkshire water\b|\bwessex water\b|\bsouthern water\b|\bscottish water\b|"
         r"\bwater plus\b",
         "Premises Costs", HIGH, "Water supplier", "PREM_UTILITIES"),
    Rule(r"\bhiscox\b|\bsimply business\b|\baxa\b|\baviva\b(?!.*\bpension\b)|"
         r"\bdirect line\b|\bzurich\b|\ballianz\b|\badmiral\b|\bchurchill\b|\binsurance\b",
         "Premises Costs", HIGH, "Insurance premium (box 21 covers insurance)",
         "PREM_INSURANCE"),

    # -- Repairs --------------------------------------------------------------
    Rule(r"\brepair\w*\b|\bmaintenance\b|\bservicing\b|\bboiler service\b|\bcleaning\b|"
         r"\bwaste collection\b",
         "Repairs and Maintenance", MEDIUM, "Repair or maintenance work",
         "PREM_REPAIRS_MAINTENANCE"),

    # -- Office costs ---------------------------------------------------------
    Rule(r"\bo2\b|\bee\b|\bvodafone\b|\bthree uk\b|\bgiffgaff\b|\bid mobile\b|"
         r"\btesco mobile\b|\bsky mobile\b|\blebara\b|\blycamobile\b",
         "Office Costs", HIGH, "Mobile network operator", "OFFICE_TELECOMS"),
    Rule(r"\bbt\b|\bbt group\b|\bvirgin media\b|\bplusnet\b|\btalktalk\b|\bsky broadband\b|"
         r"\bhyperoptic\b|\bcommunity fibre\b|\bzen internet\b|\bbroadband\b",
         "Office Costs", HIGH, "Broadband or line rental", "OFFICE_TELECOMS"),
    Rule(r"\bmicrosoft\b|\boffice 365\b|\bgoogle workspace\b|\bgoogle\b(?!.*\bads\b)|"
         r"\badobe\b|\bdropbox\b|\bslack\b|\bzoom\b|\bnotion\b|\batlassian\b|\bgithub\b|"
         r"\bopenai\b|\banthropic\b|\bxero\b(?=.*\bsub\b)",
         "Office Costs", HIGH, "Business software subscription", "OFFICE_SOFTWARE_SUBS"),
    Rule(r"\broyal mail\b|\bpost office\b|\bparcelforce\b|\bdpd\b|\bevri\b|"
         r"\bhermes parcel\b|\byodel\b|\bups\b|\bfedex\b|\bdhl\b|\bpostage\b",
         "Office Costs", HIGH, "Postage or courier", "OFFICE_POSTAGE"),
    Rule(r"\bryman\b|\bviking direct\b|\bstaples\b|\bstationery\b",
         "Office Costs", HIGH, "Stationery supplier", "OFFICE_STATIONERY"),

    # -- Capital, and the fork that decides it --------------------------------
    # Low on purpose. An electronics retailer sells a £40 cable and a £1,800
    # laptop, and the treatment is completely different: one is box 23, the other
    # is capital allowances. SOUL step 2 calls this the most consequential fork
    # in the procedure, and the invoice is what settles it -- not the merchant.
    Rule(r"\bcurrys\b|\bpc world\b|\bjohn lewis\b|\bapple store\b|\bdell\b|\blenovo\b|"
         r"\bnovatech\b|\bscan computers\b|\bebuyer\b",
         "Capital Expenditure", LOW,
         "Equipment retailer -- capital or revenue needs the invoice", "CAP_COMPUTER_EQUIPMENT"),

    # -- Stock and materials --------------------------------------------------
    Rule(r"\bscrewfix\b|\btoolstation\b|\btravis perkins\b|\bjewson\b|\bselco\b|\bhowdens\b|"
         r"\bb ?& ?q\b|\bwickes\b|\bcity plumbing\b|\bplumbase\b|\bbuildbase\b",
         "Cost of Goods Bought for Resale", HIGH, "Trade or builders merchant",
         "COGS_MATERIALS"),
    Rule(r"\bbooker\b|\bmakro\b|\bcostco\b|\bbestway\b|\bwholesale\b|\bstock purchase\b|"
         r"\bmaterials\b",
         "Cost of Goods Bought for Resale", HIGH, "Wholesaler or stock purchase",
         "COGS_MATERIALS"),

    # -- Advertising ----------------------------------------------------------
    # "FACEBK" and "FB.ME" are what the card terminal sends; "facebook" is what a
    # person would have searched the table for.
    Rule(r"\bfacebook\b|\bfacebk\b|\bfb ads\b|\bmeta platforms\b|\bgoogle ads\b|\badwords\b|"
         r"\blinkedin\b|\btiktok ads\b|\bmailchimp\b|\bcanva\b|\bvistaprint\b|\bmoo com\b|"
         r"\badvertising\b|\bmarketing\b",
         "Advertising and Entertainment", HIGH, "Advertising or marketing platform",
         "MKT_ADVERTISING"),
    Rule(r"\bentertain\w*\b|\bclient lunch\b|\bcorporate hospitality\b",
         "Advertising and Entertainment", HIGH,
         "Client entertaining -- allowable in the accounts, disallowed for tax",
         "MKT_CLIENT_ENTERTAINING"),

    # -- Interest and finance -------------------------------------------------
    Rule(r"\bloan interest\b|\binterest charged\b|\boverdraft interest\b|"
         r"\bmortgage interest\b",
         "Interest on Loans", HIGH, "Interest charged", "FIN_LOAN_INTEREST"),
    Rule(r"\bbank charge\b|\baccount fee\b|\bservice fee\b|\bcard fee\b|\bstripe fee\b|"
         r"\bpaypal fee\b|\bsumup fee\b|\bgocardless\b|\bworldpay\b|\bbarclaycard\b|"
         r"\bnon sterling fee\b|\bfinance lease\b|\bhire purchase\b",
         "Bank and Finance Charges", HIGH, "Bank or card processing charge",
         "FIN_BANK_CHARGES"),

    # -- Bad debts ------------------------------------------------------------
    Rule(r"\bbad debt\b|\bwritten off\b|\birrecoverable\b",
         "Irrecoverable Debts", HIGH, "Debt written off", "FIN_BAD_DEBTS"),

    # -- Professional fees ----------------------------------------------------
    Rule(r"\baccountant\b|\baccountancy\b|\bbookkeep\w*\b|\bsolicitor\w*\b|\blegal fees\b|"
         r"\bconveyanc\w*\b|\bconsultancy\b|\bxero\b|\bquickbooks\b|\bfreeagent\b|"
         r"\bsage\b|\bfreshbooks\b",
         "Professional Fees", HIGH, "Accountancy, legal or bookkeeping", "PROF_ACCOUNTANCY"),

    # -- Depreciation ---------------------------------------------------------
    Rule(r"\bdepreciation\b|\bamortisation\b|\bloss on disposal\b",
         "Depreciation and Loss on Assets", HIGH, "Depreciation entry",
         "CAP_PLANT_MACHINERY"),

    # -- Subscriptions and training -------------------------------------------
    Rule(r"\bacca\b|\bicaew\b|\bcima\b|\baat\b|\bcipd\b|\briba\b|\brics\b|\bgmc\b|\bnmc\b|"
         r"\bsra\b|\blaw society\b|\bico\b|\bsubscription\w*\b|\bmembership\w*\b",
         "Other Business Expenses", HIGH, "Professional body or subscription",
         "SUBS_MEMBERSHIPS"),
    Rule(r"\btraining\b|\bcourse\b|\bconference\b|\bcpd\b|\bprotective clothing\b|"
         r"\bworkwear\b|\bppe\b",
         "Other Business Expenses", HIGH, "Training or protective equipment",
         "STAFF_TRAINING"),

    # -- Where certainty runs out ---------------------------------------------
    #
    # Everything below this line is a merchant we recognise and a purpose we do
    # not. Section 22 of the brief is explicit: the merchant name alone does not
    # prove business purpose, and inventing one is the failure mode that matters.
    #
    # A marketplace is the clearest case. "AMZN MKTP" is a printer, a birthday
    # present, or a box of copier paper, and the row does not say. It is filed as
    # Uncategorised with the reason attached, not as Office Costs.
    Rule(r"\bamazon\b|\bamzn\b|\bebay\b|\betsy\b|\baliexpress\b|\btemu\b|\bwish com\b",
         FALLBACK, LOW, "Marketplace purchase -- the description does not say what was bought",
         "SUSPENSE_UNIDENTIFIED"),
    Rule(r"\btesco\b|\bsainsbury\w*\b|\basda\b|\baldi\b|\blidl\b|\bmorrisons\b|"
         r"\bwaitrose\b|\bco op\b|\bcoop\b|\biceland\b|\bmarks ?& ?spencer\b|\bm & s\b",
         "Personal, Non-Business", LOW,
         "Supermarket -- treated as private unless a business purpose is evidenced",
         "EXCL_PERSONAL"),
    Rule(r"\bdeliveroo\b|\buber eats\b|\bjust eat\b|\bmcdonalds\b|\bkfc\b|\bnandos\b|"
         r"\bgreggs\b|\bcosta\b|\bpret\b|\bstarbucks\b|\bwetherspoon\w*\b|\brestaurant\b|"
         r"\bcafe\b|\bpub\b",
         "Personal, Non-Business", LOW,
         "Food and drink -- subsistence only if away on business, which the row cannot show",
         "EXCL_PERSONAL"),
    Rule(r"\bnext retail\b|\bprimark\b|\bh & m\b|\bzara\b|\buniqlo\b|\bsports direct\b|"
         r"\bjd sports\b|\bclothing\b",
         "Personal, Non-Business", LOW,
         "Ordinary clothing -- duality of purpose, not allowable", "EXCL_PERSONAL"),
    Rule(r"\bnetflix\b|\bspotify\b|\bdisney\b|\bnow tv\b|\bapple music\b|\bplaystation\b|"
         r"\bxbox\b|\bsteam games\b|\bpuregym\b|\bthe gym group\b|\bdavid lloyd\b|"
         r"\bnuffield health\b",
         "Personal, Non-Business", HIGH, "Personal entertainment or gym", "EXCL_PERSONAL"),
    Rule(r"\btv licence\b|\bcouncil tax\b|\bchild benefit\b",
         "Personal, Non-Business", HIGH, "Household charge", "EXCL_PERSONAL"),
)

RULES: tuple[tuple[re.Pattern[str], Rule], ...] = tuple(
    (re.compile(rule.pattern), rule) for rule in _RULES_RAW
)

# A rule naming a category outside the vocabulary would write a value the
# proposal's own allowed-list then rejects -- a silent hole rather than an error.
# Checked at import, so a typo fails the build instead of a customer's run.
_unknown = sorted({rule.category for rule in _RULES_RAW} - set(CATEGORY_NAMES))
if _unknown:  # pragma: no cover -- a developer mistake, caught at import
    raise RuntimeError(f"hmrc rules name categories outside the vocabulary: {_unknown}")


def categorise(value: object) -> Decision | None:
    """
    The decision for one value, or None if no rule recognises it.

    None rather than `UNKNOWN` deliberately: the caller has somewhere else to try
    -- the model -- and has to be able to tell "no rule matched" from "a rule
    decided this cannot be placed with confidence". The marketplace rule returns
    a real Decision for `Uncategorised`, and that is a conclusion, not a gap.
    """
    text = normalise(value)
    if not text:
        return None

    for pattern, rule in RULES:
        if pattern.search(text):
            return Decision(
                category=rule.category,
                box=BOX_BY_CATEGORY.get(rule.category, ""),
                confidence=rule.confidence,
                evidence=rule.evidence,
                coa=rule.coa,
                source="rule",
            )
    return None


def decision_for_model_answer(category: str) -> Decision:
    """
    Wrap a model's answer, which the caller has already checked against the list.

    Medium, never high. The model is being asked precisely because no rule
    recognised the merchant, so the evidence behind its answer is weaker than the
    evidence behind any rule by construction -- and a confidence score the model
    supplied for itself would be a number about a number.
    """
    if category == FALLBACK:
        return UNKNOWN
    return Decision(
        category=category,
        box=BOX_BY_CATEGORY.get(category, ""),
        confidence=MEDIUM,
        evidence="Classified by model; no deterministic rule matched",
        coa=None,
        source="model",
    )


def categorise_values(values: Iterable[object]) -> tuple[dict[str, Decision], list[str]]:
    """
    Run the rules over a column's distinct values.

    Returns the decisions the rules could make -- keyed the way the applier reads
    them, on `normalize_text(value).lower()` -- and the values left over, in the
    order they were offered, for whoever wants to try harder.
    """
    decisions: dict[str, Decision] = {}
    unmatched: list[str] = []
    seen: set[str] = set()

    for value in values:
        key = normalize_text(value).lower()
        if not key or key in seen:
            continue
        seen.add(key)

        decision = categorise(value)
        if decision is None:
            unmatched.append(str(value))
        else:
            decisions[key] = decision

    return decisions, unmatched


def boxes_for(categories: Iterable[str]) -> dict[str, str]:
    """Box numbers for the categories actually used, for the proposal's evidence."""
    return {
        name: BOX_BY_CATEGORY[name]
        for name in dict.fromkeys(categories)
        if name in BOX_BY_CATEGORY
    }


def summarise(decisions: Iterable[Decision]) -> dict[str, int]:
    """
    The three numbers the result screen shows.

    `flagged` is what a person still has to look at: anything low confidence or
    unplaced. It is reported rather than hidden because the alternative -- a
    single "2,481 categorised" -- is the claim this agent is built not to make.
    """
    total = 0
    flagged = 0
    by_rule = 0
    by_model = 0

    for decision in decisions:
        total += 1
        if decision.needs_review:
            flagged += 1
        if decision.source == "rule":
            by_rule += 1
        elif decision.source == "model":
            by_model += 1

    return {
        "values_total": total,
        "values_flagged": flagged,
        "values_confident": total - flagged,
        "values_by_rule": by_rule,
        "values_by_model": by_model,
        "values_unplaced": total - by_rule - by_model,
    }
