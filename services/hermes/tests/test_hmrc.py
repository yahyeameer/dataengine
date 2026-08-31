"""
The UK tax taxonomy, the rules that assign it, and the confidence attached.

Three things are worth holding still here, and they are not the same thing.

The **vocabulary** is a contract. `router.categorize_values` drops any category
outside the list it was given, so a rule naming a category the list does not
contain writes nothing at all -- a silent hole rather than a visible error. The
module checks that at import; this checks the module still checks it.

The **assignments** are judgements, and a test that pinned every one of them
would just be the rule table typed twice. What is asserted instead is the set of
cases where getting it wrong costs money: a personal transfer must not become an
allowable expense, a fine must never be deductible, an HMRC payment must not be
read as anything else, and the bank formatting noise must not stop a merchant
matching.

The **confidence** is the part this module exists for. A bank statement says who
was paid, not what was bought, and for a great many merchants that gap cannot be
closed from the row. The tests below are mostly about the agent being willing to
say so: `AMZN MKTP` must not become a confident Office Costs deduction, and a
supermarket must not become one at all.
"""

from __future__ import annotations

import pytest

from hermes.tools import hmrc


# -----------------------------------------------------------------------------
# The vocabulary
# -----------------------------------------------------------------------------


def test_every_rule_names_a_category_in_the_vocabulary():
    named = {rule.category for rule in hmrc._RULES_RAW}
    assert named <= set(hmrc.CATEGORY_NAMES), sorted(named - set(hmrc.CATEGORY_NAMES))


def test_every_rule_declares_a_confidence_and_a_reason():
    for rule in hmrc._RULES_RAW:
        assert rule.confidence in {hmrc.HIGH, hmrc.MEDIUM, hmrc.LOW}, rule.pattern
        # The evidence phrase is what an accountant reads in the review column.
        # A rule without one is a classification nobody can check.
        assert rule.evidence.strip(), rule.pattern
        assert rule.coa.strip(), rule.pattern


def test_the_fallback_is_part_of_the_vocabulary():
    # The applier writes this into every row nothing matched. If it were not in
    # the list, an approved mapping would produce a column holding a category
    # the proposal never declared.
    assert hmrc.FALLBACK in hmrc.CATEGORY_NAMES
    assert hmrc.UNKNOWN.category == hmrc.FALLBACK


def test_expense_categories_carry_the_box_they_file_to():
    # The box number is the entire reason to prefer this taxonomy to a model's
    # own vocabulary: without it the column is just a nicer set of labels.
    assert hmrc.BOX_BY_CATEGORY["Travel and Subsistence"] == "SA103F box 20"
    assert hmrc.BOX_BY_CATEGORY["Office Costs"] == "SA103F box 23"


@pytest.mark.parametrize(
    "category",
    [
        "Capital Expenditure",
        "HMRC and Tax Payments",
        "Owner Drawings",
        "Transfers Between Accounts",
        "Personal, Non-Business",
        "Uncategorised",
    ],
)
def test_what_is_not_a_business_expense_has_no_expense_box(category):
    # Capital is the one worth stating out loud: it is a real business cost and
    # it still does not go in an expense box, because it goes to capital
    # allowances. Putting it in box 30 would be a filing error, not a rounding.
    assert category in hmrc.CATEGORY_NAMES
    assert category not in hmrc.BOX_BY_CATEGORY


def test_category_names_are_unique():
    assert len(set(hmrc.CATEGORY_NAMES)) == len(hmrc.CATEGORY_NAMES)


# -----------------------------------------------------------------------------
# Normalisation
# -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "line",
    [
        "CARD PAYMENT TO TFL TRAVEL CH 08JUN CARD 1234",
        "TFL.GOV.UK/CP",
        "DIRECT DEBIT TFL TRAVEL REF 88231991",
        "tfl   travel",
        "TFL TRAVEL",
    ],
)
def test_a_merchant_survives_however_the_bank_spelled_it(line):
    # The same journey, five formats -- card prefix, dates, card tail, long
    # reference, doubled space, non-breaking space. A rule table that only
    # matched one of them would look like it worked on the developer fixture and
    # categorise a third of a real statement.
    decision = hmrc.categorise(line)
    assert decision is not None
    assert decision.category == "Travel and Subsistence"


def test_normalise_keeps_nothing_but_the_merchant():
    assert hmrc.normalise("CARD PAYMENT TO SCREWFIX DIRECT 08/06/26 CARD 4417") == (
        "screwfix direct"
    )


def test_an_empty_value_matches_nothing():
    assert hmrc.categorise(None) is None
    assert hmrc.categorise("   ") is None


# -----------------------------------------------------------------------------
# The assignments that must not go wrong
# -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("line", "category"),
    [
        # Not deductible, and the expensive mistake is filing them as if they
        # were. A transfer and a drawing are separate answers: one moves money
        # the business still has, the other is money that has left it.
        ("TRANSFER TO SAVINGS ACCOUNT", "Transfers Between Accounts"),
        ("FASTER PAYMENT FROM SAVINGS", "Transfers Between Accounts"),
        ("CASH WITHDRAWAL LINK ATM", "Owner Drawings"),
        ("MONTHLY DRAWINGS", "Owner Drawings"),
        ("NETFLIX.COM", "Personal, Non-Business"),
        ("UBER EATS", "Personal, Non-Business"),
        # Money owed to HMRC is not an expense either, and it mentions words --
        # "VAT", "PAYE" -- that later rules read.
        ("HMRC VAT 1234567890", "HMRC and Tax Payments"),
        ("HMRC PAYE CUMBERNAULD", "HMRC and Tax Payments"),
        # The ordinary cases, one per box a statement actually hits.
        ("BRITISH GAS BUSINESS", "Premises Costs"),
        ("HISCOX INSURANCE", "Premises Costs"),
        ("O2 UK LTD", "Office Costs"),
        ("AMAZON WEB SERVICES", "Office Costs"),
        ("SCREWFIX DIRECT", "Cost of Goods Bought for Resale"),
        ("SHELL SERVICE STATION", "Travel and Subsistence"),
        ("UBER TRIP HELP.UBER.COM", "Travel and Subsistence"),
        ("XERO SUBSCRIPTION", "Professional Fees"),
        ("ACCA MEMBERSHIP", "Other Business Expenses"),
        ("FACEBK ADS", "Advertising and Entertainment"),
        ("PAYPAL FEE", "Bank and Finance Charges"),
        ("NEST PENSION CONTRIBUTION", "Staff Costs"),
        ("CIS SUBCONTRACTOR PAYMENT", "Construction Industry Subcontractors"),
    ],
)
def test_the_rules_place_a_real_statement_line(line, category):
    decision = hmrc.categorise(line)
    assert decision is not None
    assert decision.category == category


def test_a_fine_is_never_a_travel_cost():
    """
    The ordering test that matters most.

    `\\bparking\\b` in the travel block matches "PARKING FINE" perfectly well, so
    without the disallowables rule sitting above it a penalty is filed as a
    deductible parking charge -- a wrong number on a return, produced silently.
    """
    decision = hmrc.categorise("PARKING FINE PCN 8842")
    assert decision is not None
    assert decision.category == "Personal, Non-Business"
    assert decision.coa == "EXCL_FINES_PENALTIES"

    # And an ordinary car park is still an ordinary car park.
    assert hmrc.categorise("NCP CAR PARK").category == "Travel and Subsistence"


@pytest.mark.parametrize(
    ("specific", "general"),
    [
        ("AMAZON WEB SERVICES", "AMZN MKTP UK"),
        ("TESCO PETROL 4102", "TESCO STORES 3411"),
        ("UBER TRIP", "UBER EATS"),
        ("AMAZON PAYMENTS UK", "AMAZON.CO.UK"),
    ],
)
def test_the_specific_rule_is_read_before_the_general_one(specific, general):
    # Each pair shares a brand and means something completely different. Only the
    # ordering of the table keeps them apart; reorder it and this is the test
    # that says so.
    assert hmrc.categorise(specific).category != hmrc.categorise(general).category


# -----------------------------------------------------------------------------
# Confidence -- the agent being willing to say it does not know
# -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "line",
    ["TFL TRAVEL", "HMRC VAT", "BRITISH GAS", "O2 UK LTD", "TRANSFER TO SAVINGS"],
)
def test_an_unambiguous_merchant_is_high_confidence(line):
    assert hmrc.categorise(line).confidence == hmrc.HIGH


@pytest.mark.parametrize(
    ("line", "category"),
    [
        # The description does not say what was bought. This is the case the
        # brief singles out, and the honest answer is not a category.
        ("AMZN MKTP UK*2H4XY", hmrc.FALLBACK),
        ("EBAY O*12-34567", hmrc.FALLBACK),
        # A merchant name alone does not prove business purpose.
        ("TESCO STORES 3411", "Personal, Non-Business"),
        ("PRET A MANGER 445", "Personal, Non-Business"),
        ("PRIMARK 0122", "Personal, Non-Business"),
        # Capital or revenue is decided by the invoice, not by the shop.
        ("CURRYS PC WORLD", "Capital Expenditure"),
    ],
)
def test_an_ambiguous_merchant_is_flagged_rather_than_deducted(line, category):
    decision = hmrc.categorise(line)
    assert decision.category == category
    assert decision.confidence == hmrc.LOW
    assert decision.needs_review, "a low-confidence answer must reach a person"
    assert decision.evidence, "and must say why it is uncertain"


def test_a_cash_withdrawal_is_drawings_but_not_certainly():
    # Usually drawings, occasionally a genuine cash purchase. Medium says the
    # merchant is identified and the purpose is not -- which is the normal state
    # of most of a statement, so it is not flagged.
    decision = hmrc.categorise("CASH WITHDRAWAL")
    assert decision.category == "Owner Drawings"
    assert decision.confidence == hmrc.MEDIUM
    assert not decision.needs_review


def test_a_model_answer_never_outranks_a_rule():
    # The model is asked precisely because no rule recognised the value, so its
    # answer rests on weaker evidence by construction. Medium, never high.
    decision = hmrc.decision_for_model_answer("Office Costs")
    assert decision.source == "model"
    assert decision.confidence == hmrc.MEDIUM
    assert decision.box == "SA103F box 23"


def test_a_model_answering_uncategorised_is_taken_at_its_word():
    assert hmrc.decision_for_model_answer(hmrc.FALLBACK) is hmrc.UNKNOWN


# -----------------------------------------------------------------------------
# Running the rules over a column
# -----------------------------------------------------------------------------


def test_it_returns_a_mapping_the_applier_can_read():
    # The applier looks values up on `normalize_text(value).lower()`. A mapping
    # keyed any other way applies to nothing while looking perfectly correct in
    # the review queue.
    decisions, _ = hmrc.categorise_values(["  British   Gas  "])
    assert list(decisions) == ["british gas"]
    assert decisions["british gas"].category == "Premises Costs"


def test_what_no_rule_recognises_comes_back_to_be_asked_about():
    decisions, unmatched = hmrc.categorise_values(
        ["O2 UK LTD", "QRZ TRADING 8891", "TRANSFER TO SAVINGS"]
    )

    assert set(decisions) == {"o2 uk ltd", "transfer to savings"}
    # Returned in the order offered and in its original spelling, because it is
    # about to be shown to a model that has to recognise it.
    assert unmatched == ["QRZ TRADING 8891"]


def test_a_repeated_value_is_offered_once():
    decisions, unmatched = hmrc.categorise_values(["O2 UK", "O2 UK", "ZZZ", "ZZZ"])
    assert len(decisions) == 1
    assert unmatched == ["ZZZ"]


def test_boxes_are_reported_only_for_the_categories_used():
    boxes = hmrc.boxes_for(["Office Costs", "Personal, Non-Business", "Office Costs"])
    assert boxes == {"Office Costs": "SA103F box 23"}


def test_the_summary_counts_what_still_needs_a_person():
    decisions, _ = hmrc.categorise_values(
        ["TFL TRAVEL", "O2 UK LTD", "AMZN MKTP UK", "TESCO STORES"]
    )
    summary = hmrc.summarise(decisions.values())

    assert summary["values_total"] == 4
    assert summary["values_flagged"] == 2, "the marketplace and the supermarket"
    assert summary["values_confident"] == 2
    assert summary["values_by_rule"] == 4
    assert summary["values_by_model"] == 0


def test_a_decision_renders_the_three_columns_it_writes():
    row = hmrc.categorise("TFL TRAVEL").to_row()
    assert row == {
        hmrc.CATEGORY_COLUMN: "Travel and Subsistence",
        hmrc.BOX_COLUMN: "SA103F box 20",
        hmrc.CONFIDENCE_COLUMN: "High",
    }
