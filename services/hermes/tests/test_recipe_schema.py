"""
What a recipe is allowed to say.

A recipe is written once and then runs unattended against files nobody has
looked at yet, which makes validation a safety property rather than input
hygiene. Two rules, and the tests below are mostly about the second:

  * a step names an operation the cleaning engine implements — never code;
  * the classification of an operation lives beside the operation table, so a
    step cannot promote itself to `safe`.
"""

from __future__ import annotations

import pytest

from hermes.tools.clean import ADVISORY_OPERATIONS, OPERATIONS
from hermes.tools.recipe_schema import (
    BLOCKED_OPERATIONS,
    RecipeInvalid,
    operation_catalogue,
    safety_of,
    safety_summary,
    validate_definition,
    validate_report_config,
    validate_steps,
)


def _step(op: str, **params):
    return {"op": op, "params": params}


# ---------------------------------------------------------------------------
# Classification (section 7)
# ---------------------------------------------------------------------------


def test_the_three_tiers_match_the_brief():
    assert safety_of("normalize_whitespace") == "safe"
    assert safety_of("drop_duplicate_rows") == "safe"
    assert safety_of("map_values") == "review_required"
    assert safety_of("coerce_number") == "review_required"
    assert safety_of("assign_category") == "review_required"


def test_an_unknown_operation_is_blocked_rather_than_assumed_harmless():
    assert safety_of("do_the_thing") == "blocked"
    assert safety_of("") == "blocked"


@pytest.mark.parametrize("name", sorted(BLOCKED_OPERATIONS))
def test_code_shaped_operations_are_blocked_by_name(name):
    assert safety_of(name) == "blocked"
    with pytest.raises(RecipeInvalid, match="never carry SQL, Python or shell"):
        validate_steps([_step(name, statement="select 1")])


def test_every_operation_the_engine_implements_has_a_classification():
    # The divergence this guards against is the one the engine's own comment
    # warns about: two lists of operation names, one of them easy to forget.
    catalogue = {entry["op"]: entry["safety"] for entry in operation_catalogue()}
    assert set(catalogue) == set(OPERATIONS)
    assert not any(safety == "blocked" for safety in catalogue.values())
    for advisory in ADVISORY_OPERATIONS:
        assert catalogue[advisory] == "safe"


def test_the_summary_counts_what_will_need_a_person():
    steps = validate_steps(
        [
            _step("normalize_whitespace", column="Customer"),
            _step("map_values", column="Customer", mapping_table_id="mt-1"),
            _step("drop_duplicate_rows"),
        ]
    )
    assert safety_summary(steps) == {"safe": 2, "review_required": 1, "blocked": 0}


# ---------------------------------------------------------------------------
# Step validation
# ---------------------------------------------------------------------------


def test_a_plain_recipe_validates_and_is_annotated():
    steps = validate_steps(
        [
            {"op": "normalize_whitespace", "params": {"column": "Customer"}},
            {"op": "drop_duplicate_rows"},
        ]
    )
    assert [step["id"] for step in steps] == ["step_01", "step_02"]
    assert steps[0]["safety"] == "safe"
    assert steps[1]["params"] == {}
    assert steps[0]["enabled"] is True


def test_an_existing_id_is_kept_so_a_run_can_still_be_matched_to_a_step():
    steps = validate_steps([{"id": "step_07", "op": "normalize_case", "params": {}}])
    assert steps[0]["id"] == "step_07"


def test_two_steps_may_not_share_an_id():
    with pytest.raises(RecipeInvalid, match="share the id"):
        validate_steps([{"id": "a", "op": "normalize_case"}, {"id": "a", "op": "normalize_case"}])


def test_an_empty_recipe_is_refused():
    with pytest.raises(RecipeInvalid, match="at least one step"):
        validate_steps([])
    with pytest.raises(RecipeInvalid, match="must be a list"):
        validate_steps({"op": "normalize_case"})


def test_a_nested_parameter_is_refused_because_that_is_where_an_expression_lives():
    with pytest.raises(RecipeInvalid, match="simple value, not a structure"):
        validate_steps([_step("normalize_case", column={"$expr": "1=1"})])


def test_a_list_parameter_may_hold_only_scalars():
    assert validate_steps([_step("coerce_number", columns=["Amount", "VAT"])])
    with pytest.raises(RecipeInvalid, match="only contain simple values"):
        validate_steps([_step("coerce_number", columns=[{"nested": True}])])


def test_a_mapping_is_the_one_object_a_step_may_carry():
    steps = validate_steps([_step("map_values", column="Customer", mapping={"ACME LTD": "Acme"})])
    assert steps[0]["params"]["mapping"] == {"ACME LTD": "Acme"}

    with pytest.raises(RecipeInvalid, match="mapping entries must be text"):
        validate_steps([_step("map_values", column="Customer", mapping={"a": {"b": 1}})])


def test_absurd_sizes_are_refused():
    with pytest.raises(RecipeInvalid, match="at most 60 steps"):
        validate_steps([_step("normalize_case") for _ in range(61)])
    with pytest.raises(RecipeInvalid, match="too long"):
        validate_steps([_step("normalize_case", column="x" * 600)])


# ---------------------------------------------------------------------------
# The deliverable
# ---------------------------------------------------------------------------


def test_a_report_configuration_names_real_formats():
    assert validate_report_config({"formats": ["pdf", "xlsx", "pdf"]}) == {
        "formats": ["pdf", "xlsx"]
    }
    assert validate_report_config({"formats": "pdf"}) == {"formats": ["pdf"]}
    assert validate_report_config(None) is None

    with pytest.raises(RecipeInvalid, match="not a report format"):
        validate_report_config({"formats": ["pptx"]})
    with pytest.raises(RecipeInvalid, match="at least one format"):
        validate_report_config({"formats": []})


def test_a_report_configuration_carries_no_branding():
    # Section 19: a recipe references the organisation's current branding rather
    # than copying it, so there is nothing here to go stale.
    config = validate_report_config({"formats": ["pdf"], "title": "  Monthly   pack "})
    assert config == {"formats": ["pdf"], "title": "Monthly pack"}
    assert "accent" not in config and "logo" not in config


# ---------------------------------------------------------------------------
# Whole definitions
# ---------------------------------------------------------------------------


def test_the_worked_example_from_the_brief_validates():
    definition = validate_definition(
        {
            "name": "Monthly Shipment Analysis",
            "input": {"expected_type": "shipment_export"},
            "steps": [
                {"type": "clean", "op": "drop_duplicate_rows"},
                {"type": "clean", "op": "map_values", "params": {"column": "Customer"}},
                {"type": "clean", "op": "normalize_date", "params": {"column": "Delivered"}},
            ],
            "report": {"formats": ["pdf"]},
        }
    )

    assert definition["name"] == "Monthly Shipment Analysis"
    assert definition["input"] == {"expected_type": "shipment_export"}
    assert len(definition["steps"]) == 3
    assert definition["report"] == {"formats": ["pdf"]}


def test_a_definition_needs_a_name():
    with pytest.raises(RecipeInvalid, match="needs a name"):
        validate_definition({"steps": [_step("normalize_case")]})


def test_a_definition_carrying_sql_is_refused_whole():
    with pytest.raises(RecipeInvalid):
        validate_definition(
            {
                "name": "Sneaky",
                "steps": [_step("normalize_case"), _step("sql", query="drop table datasets")],
            }
        )
