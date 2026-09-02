"""
What a recipe is allowed to say, and what it is allowed to do without asking.

A recipe is a stored, replayable description of work. That makes it the most
dangerous row in the database: it is written once, by one person, and then runs
unattended against files nobody has looked at yet. Two rules follow, and this
module is both of them.

**A recipe references operations; it never carries code.** Every step names one
of the operations the cleaning engine already implements, and its parameters are
scalars and lists of scalars. There is no expression to evaluate, no SQL, no
Python, no shell, and nothing that becomes any of those further down. A step
naming an unknown operation is rejected at save time rather than skipped at run
time -- a recipe that quietly does less than it claims is worse than one that
will not save.

**Every operation carries a safety classification.** Section 7 of the brief:
trimming whitespace is safe, merging ambiguous customer names is not, and
changing financial values is not. The classification lives beside the operation
table rather than in the recipe, so it cannot be edited by whoever writes the
recipe -- a step cannot promote itself to `safe`.

`review_required` does not mean a step cannot run. It means the run stops and
reports rather than writing an output version, which is exactly what the replay
engine already does with a `review` deviation. What this classification adds is
the *static* answer: the recipe detail page can say "this recipe contains two
steps that will need approval" before anybody runs it.
"""

from __future__ import annotations

from typing import Any, Literal

from .clean import ADVISORY_OPERATIONS, OPERATIONS
from .documents import FORMATS

Safety = Literal["safe", "review_required", "blocked"]

#: Operations whose effect is fully determined by the data in front of them and
#: which cannot change a figure: whitespace, casing, exact duplicates, and the
#: advisory steps that transform nothing at all.
SAFE_OPERATIONS = frozenset(
    {
        "normalize_whitespace",
        "normalize_case",
        "drop_duplicate_rows",
        *ADVISORY_OPERATIONS,
    }
)

#: Operations that replay will apply, but whose result a person is expected to
#: look at. Each one either infers a mapping, changes how a value is read, or
#: assigns meaning that a wrong answer makes expensive.
#:
#: `coerce_number` and `normalize_date` are here rather than in `safe` for the
#: same reason: both rewrite what a cell *means*, and a date read in the wrong
#: order or a number that loses its parentheses is a wrong figure that looks
#: exactly like a right one.
REVIEW_OPERATIONS = frozenset(
    {
        "map_values",
        "coerce_number",
        "normalize_date",
        "assign_category",
        "assign_hmrc_categories",
    }
)

#: Names a recipe may not contain under any circumstances, listed explicitly so
#: the refusal reads as a policy rather than as "unknown operation". Anything
#: not in OPERATIONS is refused anyway; these are the ones worth naming.
BLOCKED_OPERATIONS = frozenset(
    {"sql", "execute_sql", "raw_sql", "python", "eval", "exec", "shell", "command", "http"}
)

#: Parameter values a step may carry. Deliberately not "any JSON": a nested
#: object is where an expression tree would live, and a recipe has no use for
#: one that the flat parameter list does not already serve.
_SCALARS = (str, int, float, bool, type(None))

MAX_STEPS = 60
MAX_PARAM_STRING = 500
MAX_MAPPING_ENTRIES = 5000


class RecipeInvalid(ValueError):
    """A recipe definition that must not be stored or executed."""


def safety_of(op: str) -> Safety:
    """The classification of one operation. Unknown names are blocked."""
    if op in BLOCKED_OPERATIONS:
        return "blocked"
    if op in SAFE_OPERATIONS:
        return "safe"
    if op in REVIEW_OPERATIONS:
        return "review_required"
    return "blocked"


def operation_catalogue() -> list[dict[str, str]]:
    """
    Every operation a recipe may name, with its classification.

    Derived from the cleaning engine's own handler table rather than typed out
    again, so an operation added there cannot be missing here -- that divergence
    is the failure mode the engine's own comment warns about.
    """
    return [
        {"op": name, "safety": safety_of(name), "advisory": name in ADVISORY_OPERATIONS}
        for name in sorted(OPERATIONS)
    ]


def validate_steps(steps: Any) -> list[dict[str, Any]]:
    """
    Check a step list and return it normalised, or raise `RecipeInvalid`.

    Normalised, not repaired: the returned list has the same steps in the same
    order with ids filled in where they were absent. Anything that would change
    meaning is a refusal.
    """
    if not isinstance(steps, list):
        raise RecipeInvalid("A recipe's steps must be a list.")
    if not steps:
        raise RecipeInvalid("A recipe needs at least one step.")
    if len(steps) > MAX_STEPS:
        raise RecipeInvalid(f"A recipe may have at most {MAX_STEPS} steps.")

    seen_ids: set[str] = set()
    validated: list[dict[str, Any]] = []

    for index, raw in enumerate(steps, start=1):
        if not isinstance(raw, dict):
            raise RecipeInvalid(f"Step {index} is not an object.")

        op = raw.get("op")
        if not isinstance(op, str) or not op:
            raise RecipeInvalid(f"Step {index} does not name an operation.")

        safety = safety_of(op)
        if safety == "blocked":
            if op in BLOCKED_OPERATIONS:
                raise RecipeInvalid(
                    f"Step {index} asks for {op!r}. Recipes reference DataEngine operations; "
                    f"they never carry SQL, Python or shell."
                )
            raise RecipeInvalid(
                f"Step {index} names {op!r}, which is not a DataEngine operation."
            )

        step_id = raw.get("id")
        if step_id is not None and not isinstance(step_id, str):
            raise RecipeInvalid(f"Step {index} has a non-text id.")
        step_id = step_id or f"step_{index:02d}"
        if step_id in seen_ids:
            raise RecipeInvalid(f"Two steps share the id {step_id!r}.")
        seen_ids.add(step_id)

        params = raw.get("params")
        if params is None:
            params = {}
        if not isinstance(params, dict):
            raise RecipeInvalid(f"Step {step_id} has non-object parameters.")
        _validate_params(step_id, params)

        validated.append(
            {
                "id": step_id,
                "op": op,
                "params": params,
                "safety": safety,
                "confidence_tier": raw.get("confidence_tier", "review"),
                "on_ambiguous": raw.get("on_ambiguous", "review"),
                "enabled": bool(raw.get("enabled", True)),
                **(
                    {"learned_from_run": raw["learned_from_run"]}
                    if isinstance(raw.get("learned_from_run"), str)
                    else {}
                ),
                **(
                    {"group_key": raw["group_key"]}
                    if isinstance(raw.get("group_key"), str)
                    else {}
                ),
            }
        )

    return validated


def _validate_params(step_id: str, params: dict[str, Any]) -> None:
    for key, value in params.items():
        if not isinstance(key, str):
            raise RecipeInvalid(f"Step {step_id} has a non-text parameter name.")

        if key == "mapping":
            if not isinstance(value, dict):
                raise RecipeInvalid(f"Step {step_id}: mapping must be an object.")
            if len(value) > MAX_MAPPING_ENTRIES:
                raise RecipeInvalid(f"Step {step_id}: mapping is too large.")
            for source, target in value.items():
                if not isinstance(source, str) or not isinstance(target, str):
                    raise RecipeInvalid(f"Step {step_id}: mapping entries must be text.")
                if len(source) > MAX_PARAM_STRING or len(target) > MAX_PARAM_STRING:
                    raise RecipeInvalid(f"Step {step_id}: a mapping entry is too long.")
            continue

        if isinstance(value, list):
            if any(not isinstance(item, _SCALARS) for item in value):
                raise RecipeInvalid(
                    f"Step {step_id}: parameter {key!r} may only contain simple values."
                )
            if any(isinstance(item, str) and len(item) > MAX_PARAM_STRING for item in value):
                raise RecipeInvalid(f"Step {step_id}: a value in {key!r} is too long.")
            continue

        if not isinstance(value, _SCALARS):
            # The important refusal. A nested object is where an expression, a
            # query or a callable would be smuggled in, and no operation the
            # engine implements takes one.
            raise RecipeInvalid(
                f"Step {step_id}: parameter {key!r} must be a simple value, not a structure."
            )
        if isinstance(value, str) and len(value) > MAX_PARAM_STRING:
            raise RecipeInvalid(f"Step {step_id}: parameter {key!r} is too long.")


def validate_report_config(config: Any) -> dict[str, Any] | None:
    """
    The report a recipe produces at the end of a run, if it produces one.

    Kept small on purpose. A recipe says which formats to render and, at most,
    what to call the deliverable; whose name and colour go on it is *not* stored
    here, because section 19 requires the recipe to reference the organisation's
    current branding rather than carry a copy of it.
    """
    if config is None:
        return None
    if not isinstance(config, dict):
        raise RecipeInvalid("A recipe's report configuration must be an object.")

    formats = config.get("formats", ["pdf"])
    if isinstance(formats, str):
        formats = [formats]
    if not isinstance(formats, list) or not formats:
        raise RecipeInvalid("A report configuration needs at least one format.")

    chosen: list[str] = []
    for value in formats:
        if not isinstance(value, str) or value not in FORMATS:
            raise RecipeInvalid(
                f"{value!r} is not a report format. Choose from {', '.join(FORMATS)}."
            )
        if value not in chosen:
            chosen.append(value)

    title = config.get("title")
    if title is not None and (not isinstance(title, str) or len(title) > 200):
        raise RecipeInvalid("A report title must be text of at most 200 characters.")

    return {
        "formats": chosen,
        **({"title": " ".join(title.split())} if isinstance(title, str) and title.strip() else {}),
    }


def validate_definition(definition: Any) -> dict[str, Any]:
    """
    A whole recipe definition, as the API accepts it.

    ```
    {"name": ..., "input": {"expected_type": ...}, "steps": [...],
     "invariants": [...], "report": {"formats": ["pdf"]}}
    ```

    Invariants are checked for shape but not for meaning: `check_invariants`
    already ignores a type it does not implement, and refusing to save a recipe
    because of an invariant a later version of the engine would understand is a
    worse failure than skipping it.
    """
    if not isinstance(definition, dict):
        raise RecipeInvalid("A recipe definition must be an object.")

    name = definition.get("name")
    if not isinstance(name, str) or not name.strip():
        raise RecipeInvalid("A recipe needs a name.")
    if len(name.strip()) > 200:
        raise RecipeInvalid("A recipe name must be at most 200 characters.")

    steps = validate_steps(definition.get("steps"))

    invariants = definition.get("invariants") or []
    if not isinstance(invariants, list) or any(
        not isinstance(item, dict) for item in invariants
    ):
        raise RecipeInvalid("A recipe's invariants must be a list of objects.")

    expected_input = definition.get("input") or {}
    if not isinstance(expected_input, dict):
        raise RecipeInvalid("A recipe's input description must be an object.")

    return {
        "name": name.strip(),
        "description": (definition.get("description") or "").strip()[:1000] or None,
        "input": expected_input,
        "steps": steps,
        "invariants": invariants,
        "report": validate_report_config(definition.get("report")),
    }


def safety_summary(steps: list[dict[str, Any]]) -> dict[str, int]:
    """How many steps in each tier, for the recipe detail page."""
    summary = {"safe": 0, "review_required": 0, "blocked": 0}
    for step in steps:
        summary[safety_of(step.get("op", ""))] += 1
    return summary


__all__ = [
    "BLOCKED_OPERATIONS",
    "REVIEW_OPERATIONS",
    "SAFE_OPERATIONS",
    "RecipeInvalid",
    "operation_catalogue",
    "safety_of",
    "safety_summary",
    "validate_definition",
    "validate_report_config",
    "validate_steps",
]
