"""
Job handlers: one per kind in the queue.

Each handler takes a claimed job and returns a JSON-serialisable result that
lands in `agent_jobs.result` and is read straight by the dashboard. The
handlers are where the tools in `hermes/tools/` meet the database, and they are
deliberately the only place that does both -- a tool never talks to Supabase,
and a handler never implements a transformation.

The pipeline chains rather than doing everything in one job, and after the
first month it takes a different route entirely:

    month 1   parse -> profile -> propose -> (a person approves) -> apply
                                                                      |
                                                             a recipe is saved
                                                                      |
    month 2+  parse -> (signature matches the recipe) -> replay -> deviations only

Which route a file takes is decided by `parse_workbook`, from the source
signature it computes. That branch is MVP criterion 6.

Each step is separately retryable and separately visible. A profiling failure
does not discard a four-minute parse, and the dashboard can show which stage a
dataset has reached instead of one opaque "working…".
"""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any, Callable

from .job_types import JobContext, JobDeferred, JobError
from .llm.redact import build_context
from .supabase import SupabaseError
from .tools import analyze, autopilot, documents, govuk, hmrc, report
from .tools import brand_assets
from .tools import recipe_schema
from .tools import branding as branding_tools
from .tools.clean import ADVISORY_OPERATIONS, apply_operations, column_hash, to_parquet
from .tools.parse import ParsedTable, SheetInterpretation, SkippedRow, parse_workbook
from .tools.profile import Profile, profile_table
from .tools.propose import build_proposals, summarise
from .tools.recipe import (
    build_vocabulary_entries,
    capture_steps,
    check_invariants,
    default_invariants,
    invariant_status,
    replay,
)
from .tools.values import normalize_text

log = logging.getLogger("hermes.jobs")

RAW_BUCKET = "raw"
PARQUET_BUCKET = "parquet"
EXPORTS_BUCKET = "exports"
BRANDING_BUCKET = "branding"

# -----------------------------------------------------------------------------
# Categorisation quality floors.
#
# Categorisation is the only job where the model decides rather than describes,
# and the only one whose wrong answers are both plausible and unreviewable at
# scale -- five hundred mappings shown to a human as eight examples. These are
# the structural floors below which a result is not worth a reviewer's time.
#
# They are deliberately loose. The aim is to reject the two answers that are
# obviously not categorisations -- one that reaches almost no rows, and one that
# invents a category per value -- without second-guessing a model that grouped a
# messy vendor list in a way an accountant would recognise but a rule would not.
# -----------------------------------------------------------------------------

# Below this share of rows the mapping is a handful of guesses, not a column.
MIN_CATEGORY_COVERAGE = 0.30

# A category per value groups nothing. Only checked once there are enough
# values for the ratio to mean anything -- three values in three categories is
# perfectly reasonable, three hundred in two hundred and ninety is not.
MAX_CATEGORY_RATIO = 0.80
MIN_VALUES_FOR_DEGENERACY_CHECK = 10


def categorize_quality(
    *,
    column: str,
    offered: int,
    mapping: dict[str, str],
    categories: list[str],
    rows_total: int,
    rows_covered: int,
    taxonomy: str | None = None,
) -> dict[str, Any]:
    """
    Structural facts about a categorisation, and the two floors it must clear.

    `router.categorize_values` already refuses anything that was not offered and
    anything outside a fixed vocabulary -- but it refuses them *silently*, by
    skipping the entry. So a reply that mangled four hundred of five hundred
    values arrives looking like a clean hundred-value mapping, and the reviewer
    is shown eight examples of it.

    Everything returned here is derived from the answer's shape. None of it is a
    confidence score: the model is never asked how sure it is, because it does
    not know, and a number invented at this layer would be worse than none --
    a reviewer trusts a percentage far more than they trust prose.

    Raises `JobError` for the two answers that are not categorisations at all.
    Both are deliberately non-retryable: the same column and the same values
    will produce the same shape on the next attempt, and burning two more
    attempts only delays the message the accountant needs to read.

    `taxonomy` names a closed vocabulary if one was used. It changes two things:
    the degeneracy floor is dropped, because "almost one category per value"
    cannot be a symptom when the categories were fixed before anything ran and
    there are twenty of them; and the message says who fell short, since a thin
    result from a rule table is a different problem from a thin one from a model.
    """
    dropped = offered - len(mapping)
    coverage = rows_covered / rows_total if rows_total else 0.0

    # Categories holding exactly one value are where a wrong assignment hides:
    # a plausible-looking bucket nobody else fell into. Counting them gives the
    # reviewer somewhere to start that is better than the top of the list.
    per_category: dict[str, int] = {}
    for category in mapping.values():
        per_category[category] = per_category.get(category, 0) + 1
    singletons = sum(1 for count in per_category.values() if count == 1)

    # A mapping that reaches almost none of the rows is not a categorisation, it
    # is a handful of guesses. Applying it adds a column reading 'Uncategorised'
    # for nearly every line -- which reads as the tool failing rather than as
    # the answer being thin, and costs trust that is hard to get back.
    if coverage < MIN_CATEGORY_COVERAGE:
        who = "The UK tax rules recognised" if taxonomy else "The model categorised"
        remedy = (
            "the column may hold references rather than descriptions of what was bought"
            if taxonomy
            else "the column may be free text, or the values may need a hint about what "
            "the categories should be"
        )
        raise JobError(
            f"{who} only {rows_covered} of {rows_total} row(s) ({coverage:.0%}) in "
            f"{column!r}. That is too thin to be worth reviewing -- {remedy}.",
            retryable=False,
        )

    # One category per value is the degenerate answer: technically a mapping,
    # semantically a rename. A model handed free text and trying to be helpful
    # produces it, and it is indistinguishable from a real result until somebody
    # opens it.
    if (
        not taxonomy
        and len(mapping) >= MIN_VALUES_FOR_DEGENERACY_CHECK
        and len(categories) > len(mapping) * MAX_CATEGORY_RATIO
    ):
        raise JobError(
            f"The model produced {len(categories)} categories for "
            f"{len(mapping)} distinct value(s) in {column!r} -- close to one "
            f"category per value, which groups nothing. Supply the categories "
            f"you want and run it again.",
            retryable=False,
        )

    return {
        "values_offered": offered,
        "values_mapped": len(mapping),
        "values_dropped": dropped,
        "rows_total": rows_total,
        "rows_covered": rows_covered,
        "rows_uncovered": rows_total - rows_covered,
        "row_coverage": round(coverage, 4),
        "category_count": len(categories),
        "singleton_categories": singletons,
    }


# -----------------------------------------------------------------------------
# Shared helpers
# -----------------------------------------------------------------------------


def _load_version(context: JobContext, version_id: str) -> dict[str, Any]:
    rows = context.supabase.select(
        "dataset_versions",
        columns=(
            "id,dataset_id,version_no,kind,parquet_path,row_count,"
            "parent_version_id,produced_by_run_id,raw_upload_id"
        ),
        filters={"id": f"eq.{version_id}"},
        limit=1,
    )
    if not rows:
        raise JobError(f"dataset version {version_id} no longer exists")
    return rows[0]


def _load_parquet(context: JobContext, version: dict[str, Any]) -> bytes:
    path = version.get("parquet_path")
    if not path:
        raise JobError(
            "This dataset version has no parsed data yet. Run the parser on the upload first."
        )

    try:
        return context.supabase.download(
            PARQUET_BUCKET, path, context.config.max_download_bytes
        )
    except SupabaseError as error:
        # A missing object is a different problem from an unreachable one, and
        # conflating them sends the reader to the wrong place. Storage returns
        # the "not found" inside a 400 body rather than as a 404 status, so the
        # body is what has to be inspected.
        missing = error.status == 404 or "not_found" in (error.body or "")
        if missing:
            raise JobError(
                "The stored data for this dataset version is missing from storage. "
                "Re-run the parser on the original upload to rebuild it."
            ) from error
        # Anything else is transient until proven otherwise, so it retries.
        raise JobError(
            f"Could not read the stored data for this version ({error.status}). "
            f"This will be retried.",
            retryable=True,
        ) from error


def _parquet_path(org_id: str, workspace_id: str, dataset_id: str, job_id: str) -> str:
    """
    Mirrors the raw bucket's layout: org first, then workspace.

    The storage policy reads the tenant out of the first two path segments, so
    a derived object that did not follow the same shape would be unreadable by
    the very users who own it.

    Keyed by job rather than by version number. The version number is allocated
    inside the database transaction that records the version, which is *after*
    the object has to exist -- so naming the object by a predicted version
    number is a guess, and two uploads into one dataset would guess the same
    number and silently overwrite each other's Parquet. The job id is already
    unique, and it makes the object traceable back to the run that wrote it.
    """
    period = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")
    return f"{org_id}/{workspace_id}/{period}/{dataset_id}__{job_id}.parquet"


def _stored_interpretation(context: JobContext, version: dict[str, Any]) -> dict[str, Any] | None:
    """
    Recover the parser's structural findings for a version.

    Parquet stores the table. It cannot store what the parser *learned* getting
    there -- that the header was on row 5, that rows 12 and 19 were summary
    rows declaring their own totals, that the date column was ambiguous and
    read day-first, that the amounts arrived as text with parentheses.

    Losing that is not cosmetic. The declared-totals invariant reads the
    summary rows, and it is the check that catches a file whose own arithmetic
    disagrees with ours -- the single most valuable finding the parser makes.
    Without this lookup, profiling a stored version silently skips it.

    `dataset_versions.produced_by_run_id` already points at the job that wrote
    the version, and that job's result holds the interpretation, so nothing new
    needs storing -- it only needs reading.

    Restricted to parse jobs on purpose. A version produced by *cleaning* has
    deliberately different rows from the file it came from, so re-running the
    file's own totals check against it would report a discrepancy that the
    accountant themselves approved.
    """
    job_id = version.get("produced_by_run_id")
    if not job_id:
        return None

    rows = context.supabase.select(
        "agent_jobs", columns="id,kind,result", filters={"id": f"eq.{job_id}"}, limit=1
    )
    if not rows or rows[0].get("kind") != "parse_workbook":
        return None

    result = rows[0].get("result") or {}
    sheets = (result.get("interpretation") or {}).get("sheets") or []
    return sheets[0] if sheets else None


def _profile_from_parquet(
    parquet_bytes: bytes, stored_interpretation: dict[str, Any] | None = None
) -> tuple[Profile, ParsedTable]:
    """
    Rebuild a profile from a stored version.

    Profiling reads the same code path whether the data has just been parsed or
    was written last month, which is what keeps a month-2 profile comparable
    with a month-1 one. Anything else and the invariants in section 5.3 would
    be comparing two different measurements.
    """
    import io

    import polars as pl

    frame = pl.read_parquet(io.BytesIO(parquet_bytes))
    source_rows = (
        frame["__source_row"].to_list() if "__source_row" in frame.columns else list(range(frame.height))
    )
    columns = {
        name: frame[name].to_list() for name in frame.columns if name != "__source_row"
    }
    return _profile_from_columns(columns, source_rows, stored_interpretation)


def _profile_from_columns(
    columns: dict[str, list[Any]],
    source_rows: list[int],
    stored_interpretation: dict[str, Any] | None = None,
) -> tuple[Profile, ParsedTable]:
    """
    Profile an in-memory table.

    Split out from the Parquet path so that a result that has just been
    computed can be profiled without a serialise-and-reread round trip. Recipe
    capture needs exactly that: the invariants for the recipe are derived from
    the cleaned output, which at that point exists only as columns in memory.
    """
    # A synthetic interpretation: the structural work happened at parse time and
    # is recorded on the version, but profiling only needs the column list and
    # the types.
    from .tools.parse import ColumnInterpretation

    business = [name for name in columns if not name.startswith("__raw_")]
    row_count = len(source_rows)

    column_interpretations = []
    for index, name in enumerate(business):
        values = columns[name]
        non_null = [value for value in values if value is not None]
        inferred = "text"
        if non_null and all(isinstance(value, bool) for value in non_null):
            inferred = "boolean"
        elif non_null and all(
            isinstance(value, (int, float)) and not isinstance(value, bool) for value in non_null
        ):
            inferred = "number"
        elif _looks_iso_date(values):
            inferred = "date"

        column_interpretations.append(
            ColumnInterpretation(
                index=index,
                source_header=name.replace("_", " ").title(),
                name=name,
                inferred_type=inferred,  # type: ignore[arg-type]
                type_confidence=1.0,
                non_null=len(non_null),
                parse_failures=0,
            )
        )

    skipped: list[SkippedRow] = []
    notes: list[str] = []

    if stored_interpretation:
        _restore_column_metadata(column_interpretations, stored_interpretation)
        skipped = [
            SkippedRow(
                source_row=int(entry.get("source_row", 0)),
                reason=entry.get("reason", "blank"),
                preview=entry.get("preview", ""),
            )
            for entry in stored_interpretation.get("skipped") or []
        ]
        notes = list(stored_interpretation.get("notes") or [])

    interpretation = SheetInterpretation(
        sheet_name=(stored_interpretation or {}).get("sheet_name") or "dataset",
        header_row=(stored_interpretation or {}).get("header_row") or 1,
        first_data_row=2,
        last_data_row=row_count + 1,
        first_column=1,
        last_column=len(column_interpretations),
        data_rows=row_count,
        columns=column_interpretations,
        skipped=skipped,
        confidence=(stored_interpretation or {}).get("confidence") or 1.0,
        notes=notes,
    )

    table = ParsedTable(interpretation=interpretation, columns=columns, source_rows=source_rows)
    return profile_table(table, context_max_samples()), table


def _restore_column_metadata(
    columns: list[Any], stored_interpretation: dict[str, Any]
) -> None:
    """
    Put the parser's per-column findings back onto the rebuilt columns.

    Matched by name, not position: a cleaning step may have dropped a column,
    and re-applying the fourth column's date convention to what is now a
    different fourth column would be worse than having no metadata at all.

    The *type* is not restored. Parquet's schema is the authority on what the
    stored data actually is, and if a cleaning step turned a text column into
    numbers then the stored type is right and the parse-time one is stale.
    """
    by_name = {
        column.get("name"): column for column in stored_interpretation.get("columns") or []
    }

    for column in columns:
        stored = by_name.get(column.name)
        if not stored:
            continue
        column.source_header = stored.get("source_header") or column.source_header
        column.type_confidence = stored.get("type_confidence", column.type_confidence)
        column.number_styles = list(stored.get("number_styles") or [])
        column.date_order = stored.get("date_order")
        column.ambiguous_dates = stored.get("ambiguous_dates", 0)
        column.parse_failures = stored.get("parse_failures", 0)
        column.failure_samples = list(stored.get("failure_samples") or [])


def context_max_samples() -> int:
    return 5


def _looks_iso_date(values: list[Any]) -> bool:
    sample = [value for value in values if isinstance(value, str)][:20]
    if not sample:
        return False
    return all(
        len(value) == 10 and value[4] == "-" and value[7] == "-" for value in sample
    )


def _money_columns(profile: Profile) -> list[str]:
    return [column.name for column in profile.columns if column.is_money and column.inferred_type == "number"]


def _first_of(profile: Profile, kind: str) -> str | None:
    return next((column.name for column in profile.columns if column.inferred_type == kind), None)


def _categorical(profile: Profile) -> str | None:
    """The best column to break figures down by: text, repeated, not a reference."""
    candidates = [
        column
        for column in profile.columns
        if column.inferred_type == "text"
        and column.non_null
        and 1 < column.distinct_count < max(2, column.non_null * 0.8)
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda column: column.distinct_count).name


# -----------------------------------------------------------------------------
# parse_workbook
# -----------------------------------------------------------------------------


def handle_parse_workbook(context: JobContext) -> dict[str, Any]:
    upload_id = context.job.get("raw_upload_id")
    if not upload_id:
        raise JobError("this job has no upload attached")

    uploads = context.supabase.select(
        "raw_uploads",
        columns="id,workspace_id,dataset_id,storage_path,original_filename,status,byte_size",
        filters={"id": f"eq.{upload_id}"},
        limit=1,
    )
    if not uploads:
        raise JobError("the upload no longer exists")
    upload = uploads[0]

    if upload["status"] != "stored":
        raise JobError(f"the upload is {upload['status']}, not stored; nothing to parse")
    if not upload.get("dataset_id"):
        raise JobError("this upload is not attached to a dataset")

    # Refused before the download, not after the parser has already allocated
    # for it. A file past this size does not fail slowly -- it exhausts the
    # container's memory, and the kernel kills the worker rather than the job,
    # taking whatever else that worker was doing with it.
    #
    # Non-retryable on purpose: the file will be the same size on the second
    # attempt and on the third, and three OOM kills is three outages for
    # everybody sharing the box. See Config.max_process_bytes for the
    # measurements behind the number.
    size = upload.get("byte_size") or 0
    if size > context.config.max_process_bytes:
        limit_mb = context.config.max_process_bytes / (1024 * 1024)
        raise JobError(
            f"This file is {size / (1024 * 1024):.0f} MB, and this agent processes files up "
            f"to {limit_mb:.0f} MB. Split it by period or by entity and upload the parts.",
            retryable=False,
        )

    context.heartbeat({"stage": "downloading", "file": upload["original_filename"]})
    data = context.supabase.download(
        RAW_BUCKET, upload["storage_path"], context.config.max_download_bytes
    )

    context.heartbeat({"stage": "parsing", "bytes": len(data)})
    try:
        parsed = parse_workbook(data, upload["original_filename"])
    except ValueError as error:
        # ValueError from the parser is always a message written for a human.
        raise JobError(str(error)) from error

    table = parsed.primary

    context.heartbeat({"stage": "writing", "rows": table.row_count})

    org_id = context.job["org_id"]
    dataset_id = upload["dataset_id"]

    # Allocate the version first so the object key can carry its number, then
    # upload, then... except that ordering would leave a version pointing at an
    # object that failed to upload. So: upload to a path derived from the row
    # count and time, then record the version pointing at it. A stray object
    # with no version is inert; a version with no object is not.
    parquet_bytes = to_parquet(table.columns, table.source_rows)
    object_path = _parquet_path(org_id, context.workspace_id, dataset_id, context.job_id)
    stored = context.supabase.upload(
        PARQUET_BUCKET,
        object_path,
        parquet_bytes,
        content_type="application/vnd.apache.parquet",
        upsert=True,
    )

    version = context.supabase.rpc(
        "record_dataset_version",
        {
            "p_dataset_id": dataset_id,
            "p_kind": "cleaned",
            "p_parquet_path": stored.path,
            "p_row_count": table.row_count,
            "p_column_hash": column_hash(table.columns),
            "p_raw_upload_id": upload_id,
            "p_produced_by_job": context.job_id,
            "p_created_by": context.requested_by(),
            "p_metadata": {
                "stage": "parsed",
                "source_signature": parsed.source_signature,
                "confidence": table.interpretation.confidence,
                "sheet": table.interpretation.sheet_name,
                "header_row": table.interpretation.header_row,
                "excluded_rows": len(table.interpretation.skipped),
            },
        },
    )

    context.supabase.rpc(
        "set_dataset_signature",
        {"p_dataset_id": dataset_id, "p_signature": parsed.source_signature},
    )

    # Autopilot short-circuits both branches below, and deliberately.
    #
    # A file uploaded through the categorise screen has one destination: a
    # categorised workbook. Profiling and proposing would produce a review queue
    # nobody on that path is going to open, and a recipe replay would apply last
    # month's cleaning decisions to a file whose owner never saw them. Neither is
    # wrong in itself; both are answers to a question this customer did not ask.
    #
    # The flag comes from the job payload rather than from a workspace setting,
    # so the same workspace can carry both paths -- one upload categorised
    # straight through, the next reviewed step by step.
    autopilot_requested = bool(context.payload.get("autopilot"))

    recipe = None
    if autopilot_requested:
        next_kind = "categorise_statement"
    else:
        # The branch that makes month 2 cheap (MVP criterion 6). If this file's
        # shape matches a recipe the workspace already has, replay it and surface
        # only what deviates; otherwise fall through to profiling and proposing
        # from scratch, which is what month 1 needs.
        matched = context.supabase.rpc(
            "match_recipe",
            {
                "p_workspace_id": context.workspace_id,
                "p_source_signature": parsed.source_signature,
            },
        )
        recipe = matched[0] if isinstance(matched, list) and matched else None
        next_kind = "replay_recipe" if recipe else "profile_dataset"

    # Higher priority than a fresh parse so a pipeline in flight finishes
    # before another one starts, which keeps the dashboard's per-dataset
    # progress monotonic.
    context.supabase.rpc(
        "enqueue_agent_job_internal",
        {
            "p_workspace_id": context.workspace_id,
            "p_kind": next_kind,
            "p_dataset_id": dataset_id,
            "p_dataset_version_id": version["id"],
            # Carried forward rather than re-derived. A hint the accountant typed
            # about what the business does is worth as much to the categoriser as
            # it was to the parse that was asked for.
            "p_payload": (
                {
                    key: context.payload[key]
                    for key in ("hint", "column")
                    if context.payload.get(key)
                }
                if autopilot_requested
                else {}
            ),
            "p_requested_by": context.requested_by(),
            "p_priority": 50,
        },
    )

    # Images the workbook was carrying (section 11, priority 3). Last, and
    # never fatal: this is a bonus on top of an ingest that has already
    # succeeded, and a workbook whose zip directory is odd must still parse.
    brand_candidates = _discover_brand_assets(context, upload, data)

    return {
        "dataset_version_id": version["id"],
        "version_no": version["version_no"],
        "parquet_path": stored.path,
        "brand_asset_candidates": brand_candidates,
        "autopilot": autopilot_requested,
        "rows": table.row_count,
        "columns": len(table.interpretation.columns),
        "source_signature": parsed.source_signature,
        "confidence": table.interpretation.confidence,
        "interpretation": parsed.to_dict(),
        "matched_recipe": (
            {
                "recipe_id": recipe["recipe_id"],
                "name": recipe["recipe_name"],
                "version_no": recipe["version_no"],
                "previous_runs": recipe["run_count"],
            }
            if recipe
            else None
        ),
        "next": next_kind,
    }


def _discover_brand_assets(
    context: JobContext, upload: dict[str, Any], data: bytes
) -> int:
    """
    Store the images found inside an uploaded workbook, as candidates.

    None of them becomes the logo here. The bytes go into the organisation's
    branding prefix and a row records what was found and how much it looks like
    a logo; a person picks one on the branding screen, and until they do the
    reports carry a text header. Section 11 is explicit that this is the right
    trade -- "this is preferable to hallucinating" -- and it is also the only
    version of the feature that survives a workbook containing a logo, a product
    photograph, a chart and somebody's signature.

    Returns how many new candidates were recorded. Every failure is a zero: a
    picture nobody can extract costs a branding suggestion, not an upload.
    """
    filename = upload.get("original_filename") or ""
    if not brand_assets.is_container(filename):
        return 0

    try:
        candidates = brand_assets.discover_images(data, filename)
    except Exception:  # noqa: BLE001
        log.warning("image discovery failed for %s", filename)
        return 0

    if not candidates:
        return 0

    org_id = context.job["org_id"]
    rows: list[dict[str, Any]] = []

    for candidate in candidates:
        if candidate.rejected:
            # Recorded so the screen can say "we found this and cannot use it",
            # but not stored: there is no reason to keep bytes nothing can use.
            rows.append({**candidate.to_row(), "storage_path": f"unstored/{candidate.sha256}"})
            continue
        path = f"organizations/{org_id}/branding/candidates/{candidate.sha256}"
        try:
            context.supabase.upload(
                BRANDING_BUCKET,
                path,
                candidate.data,
                content_type=candidate.mime,
                upsert=True,
            )
        except Exception:  # noqa: BLE001
            log.warning("could not store candidate logo %s", candidate.name)
            continue
        rows.append({**candidate.to_row(), "storage_path": path})

    if not rows:
        return 0

    try:
        recorded = context.supabase.rpc(
            "record_brand_asset_candidates",
            {
                "p_organization_id": org_id,
                "p_workspace_id": context.workspace_id,
                "p_raw_upload_id": upload.get("id"),
                "p_candidates": rows,
            },
        )
    except Exception:  # noqa: BLE001
        log.warning("could not record brand asset candidates")
        return 0

    return int(recorded or 0)


# -----------------------------------------------------------------------------
# profile_dataset
# -----------------------------------------------------------------------------


def handle_profile_dataset(context: JobContext) -> dict[str, Any]:
    version_id = context.job.get("dataset_version_id")
    if not version_id:
        raise JobError("this job has no dataset version attached")

    version = _load_version(context, version_id)
    context.heartbeat({"stage": "downloading"})
    parquet_bytes = _load_parquet(context, version)

    context.heartbeat({"stage": "profiling"})
    profile, _table = _profile_from_parquet(
        parquet_bytes, _stored_interpretation(context, version)
    )

    context.supabase.rpc(
        "record_dataset_profile",
        {
            "p_dataset_version_id": version_id,
            "p_row_count": profile.row_count,
            "p_column_count": profile.column_count,
            "p_columns": [column.__dict__ for column in profile.columns],
            "p_signals": profile.signals,
            "p_job_id": context.job_id,
        },
    )

    # Profiling a version the accountant has just cleaned is worth doing -- the
    # profile is the evidence behind the next month's comparison. Proposing
    # against it is not.
    #
    # apply_cleaning chains here so the new version gets a profile, and this
    # step used to chain onward to propose_cleaning unconditionally. The result
    # was a treadmill: approve a queue, apply it, and a fresh queue appears on
    # the version that was just cleaned to your approval. Some of it recurs
    # verbatim, because a step like review_key_conflicts flags a condition
    # rather than removing it, so applying can never satisfy it and it is
    # re-proposed on every pass. The reviewer sees no end to the work and, worse,
    # an apply aimed at the version they were looking at fails with "nothing has
    # been approved for this version yet" -- the new proposals are all pending.
    #
    # So the caller decides. A profile that follows a parse proposes; one that
    # follows an apply does not.
    if context.payload.get("propose", True):
        context.supabase.rpc(
            "enqueue_agent_job_internal",
            {
                "p_workspace_id": context.workspace_id,
                "p_kind": "propose_cleaning",
                "p_dataset_id": version["dataset_id"],
                "p_dataset_version_id": version_id,
                "p_requested_by": context.requested_by(),
                "p_priority": 50,
            },
        )

    return {
        "dataset_version_id": version_id,
        "rows": profile.row_count,
        "columns": profile.column_count,
        "signals": profile.signals,
        "next": "propose_cleaning" if context.payload.get("propose", True) else None,
    }


# -----------------------------------------------------------------------------
# propose_cleaning
# -----------------------------------------------------------------------------


def handle_propose_cleaning(context: JobContext) -> dict[str, Any]:
    version_id = context.job.get("dataset_version_id")
    if not version_id:
        raise JobError("this job has no dataset version attached")

    version = _load_version(context, version_id)
    parquet_bytes = _load_parquet(context, version)

    context.heartbeat({"stage": "profiling"})
    profile, table = _profile_from_parquet(
        parquet_bytes, _stored_interpretation(context, version)
    )

    context.heartbeat({"stage": "proposing"})
    proposals = build_proposals(table, profile)
    rows = [
        proposal.to_row(context.workspace_id, version_id, context.job_id)
        for proposal in proposals
    ]

    # The model rewrites the wording, never the decision. Failure here costs
    # prose and nothing else.
    model_used = None
    if proposals and context.llm.enabled:
        context.heartbeat({"stage": "explaining"})
        redacted = build_context(
            profile,
            max_sample_values=context.config.max_sample_values,
            redact_samples=context.config.redact_samples,
        )
        rationales, model_used = context.llm.explain_proposals(redacted, rows)
        for row in rows:
            improved = rationales.get(row["group_key"])
            if improved:
                row["rationale"] = improved

    count = context.supabase.rpc(
        "replace_proposed_changes",
        {
            "p_dataset_version_id": version_id,
            "p_job_id": context.job_id,
            "p_proposals": rows,
        },
    )

    summary = summarise(proposals)
    summary["model_used"] = model_used
    summary["stored"] = count

    return {
        "dataset_version_id": version_id,
        "proposals": count,
        "summary": summary,
    }


# -----------------------------------------------------------------------------
# apply_cleaning
# -----------------------------------------------------------------------------


def handle_apply_cleaning(context: JobContext) -> dict[str, Any]:
    """
    Apply what a human approved, and nothing else.

    The approved set is read from the database rather than taken from the job
    payload. A payload could be stale, or could name a group the accountant
    rejected thirty seconds ago; the table is the record of what was decided.
    """
    version_id = context.job.get("dataset_version_id")
    if not version_id:
        raise JobError("this job has no dataset version attached")

    version = _load_version(context, version_id)

    approved = context.supabase.select(
        "proposed_changes",
        columns="id,group_key,step_type,operation,confidence,affected_rows",
        filters={
            "dataset_version_id": f"eq.{version_id}",
            "status": "eq.approved",
        },
        order="created_at.asc",
    )
    if not approved:
        raise JobError("nothing has been approved for this version yet")

    blocking = context.supabase.select(
        "proposed_changes",
        columns="id,group_key,title",
        filters={
            "dataset_version_id": f"eq.{version_id}",
            "confidence": "eq.low",
            "status": "eq.pending",
        },
    )
    if blocking and not context.payload.get("override_block"):
        # Section 5.1: a Block-tier finding halts the run. It can be overridden,
        # but only deliberately and only with the override recorded on the job.
        titles = "; ".join(item["title"] for item in blocking)
        raise JobError(
            f"{len(blocking)} blocking issue(s) are unresolved and must be approved or rejected "
            f"first: {titles}"
        )

    # An advisory records that somebody looked at a finding. It moves no data,
    # and the condition it describes is still true afterwards.
    #
    # So an approved set containing nothing else has nothing to apply. Writing a
    # version for it would add a child byte-identical to its parent while
    # claiming a cleaning happened, burn a version number and a Parquet object
    # on a copy, and -- since the finding is still there -- offer the same item
    # again on the next profile. Acknowledge them against the version on screen
    # and stop, which is also the version the reviewer was looking at.
    #
    # Advisories approved *alongside* real changes still travel into the recipe
    # below: the recipe is meant to be a complete record of what was decided,
    # including the decisions that were "look at this and confirm".
    transforms = [item for item in approved if item["step_type"] not in ADVISORY_OPERATIONS]
    advisories = [item for item in approved if item["step_type"] in ADVISORY_OPERATIONS]

    if not transforms:
        context.supabase.rpc(
            "mark_changes_applied",
            {
                "p_dataset_version_id": version_id,
                "p_group_keys": [item["group_key"] for item in advisories],
            },
        )
        return {
            "dataset_version_id": version_id,
            "new_dataset_version_id": None,
            "acknowledged": [item["group_key"] for item in advisories],
            "rows_changed": 0,
            "rows_removed": 0,
            "note": (
                f"{len(advisories)} review item(s) acknowledged. Review items record that "
                f"someone has seen a finding; they do not change the data, so no new version "
                f"was written."
            ),
        }

    context.heartbeat({"stage": "downloading"})
    parquet_bytes = _load_parquet(context, version)
    _profile, table = _profile_from_parquet(
        parquet_bytes, _stored_interpretation(context, version)
    )

    context.heartbeat(
        {"stage": "applying", "operations": len(transforms), "review_items": len(advisories)}
    )
    operations = [item["operation"] for item in approved]
    result = apply_operations(table, operations)

    context.heartbeat({"stage": "writing", "rows": result.row_count})
    new_parquet = to_parquet(result.columns, result.source_rows)
    path = _parquet_path(
        context.job["org_id"],
        context.workspace_id,
        version["dataset_id"],
        context.job_id,
    )
    stored = context.supabase.upload(
        PARQUET_BUCKET, path, new_parquet, content_type="application/vnd.apache.parquet", upsert=True
    )

    new_version = context.supabase.rpc(
        "record_dataset_version",
        {
            "p_dataset_id": version["dataset_id"],
            "p_kind": "cleaned",
            "p_parquet_path": stored.path,
            "p_row_count": result.row_count,
            "p_column_hash": column_hash(result.columns),
            "p_parent_version_id": version_id,
            "p_produced_by_job": context.job_id,
            "p_created_by": context.requested_by(),
            "p_metadata": {
                "stage": "cleaned",
                "applied_groups": [item["group_key"] for item in approved],
                "rows_in": table.row_count,
                "rows_out": result.row_count,
                "override_block": bool(context.payload.get("override_block")),
            },
        },
    )

    context.supabase.rpc(
        "mark_changes_applied",
        {
            "p_dataset_version_id": version_id,
            "p_group_keys": [item["group_key"] for item in approved],
        },
    )

    # Profile the output too. Section 5.3's invariants compare a run's result
    # against what came before, and that comparison needs both sides measured
    # the same way.
    context.supabase.rpc(
        "enqueue_agent_job_internal",
        {
            "p_workspace_id": context.workspace_id,
            "p_kind": "profile_dataset",
            "p_dataset_id": version["dataset_id"],
            "p_dataset_version_id": new_version["id"],
            # Profile it, but do not turn round and propose against it. See the
            # note in handle_profile_dataset: this version is the output of a
            # review that just finished, not an inbox for a new one.
            "p_payload": {"propose": False},
            "p_requested_by": context.requested_by(),
            "p_priority": 50,
        },
    )

    # Capture what was approved as a recipe (MVP criterion 5). This is the
    # moment month 1 becomes reusable, and it is deliberately automatic: an
    # accountant who has just spent twenty minutes approving changes should not
    # then have to remember to press "save as recipe".
    recipe = _capture_recipe_from(context, version, approved, table, result)

    summary = result.summary()
    summary["dataset_version_id"] = new_version["id"]
    summary["version_no"] = new_version["version_no"]
    summary["rows_in"] = table.row_count
    summary["recipe"] = recipe
    return summary


def _capture_recipe_from(
    context: JobContext,
    version: dict[str, Any],
    approved: list[dict[str, Any]],
    table: ParsedTable,
    result: Any,
) -> dict[str, Any] | None:
    """
    Write the approved operations down as a recipe.

    The one non-obvious step is what happens to an entity merge. Approving
    "merge CONTOSO LIMITED into Contoso Ltd." produces an inline mapping, and
    freezing that into the recipe would mean every new supplier next month
    needs a new recipe version. Instead the pairs go into a workspace mapping
    table and the step keeps only a reference to it — so the step reads
    whatever the table knows at replay time, and section 4's "shared, growable"
    requirement is satisfied by construction rather than by intent.
    """
    dataset_id = version["dataset_id"]

    datasets = context.supabase.select(
        "datasets", columns="id,name,source_signature", filters={"id": f"eq.{dataset_id}"}, limit=1
    )
    if not datasets:
        return None
    dataset = datasets[0]
    signature = dataset.get("source_signature")

    # Move every inline entity mapping into a workspace mapping table.
    mapping_table_ids: dict[str, str] = {}
    for item in approved:
        operation = item.get("operation") or {}
        if operation.get("op") != "map_values":
            continue
        column = operation.get("column")
        mapping = operation.get("mapping") or {}
        if not column or not mapping:
            continue

        table_row = context.supabase.rpc(
            "ensure_mapping_table",
            {
                "p_workspace_id": context.workspace_id,
                "p_name": f"{column} mappings",
                "p_kind": "entity",
                "p_created_by": context.requested_by(),
            },
        )
        table_id = table_row["id"]
        mapping_table_ids[column] = table_id

        # Both halves of the vocabulary: the merges a person approved, and an
        # identity entry for every value that survived cleaning. Without the
        # second half the table holds only corrections, and next month every
        # supplier that was always spelled correctly would be reported as new.
        entries = build_vocabulary_entries(result.columns.get(column, []), mapping)

        confirmed = [entry for entry in entries if entry.get("confirmed")]
        observed = [entry for entry in entries if not entry.get("confirmed")]

        if confirmed:
            context.supabase.rpc(
                "upsert_mapping_entries",
                {
                    "p_mapping_table_id": table_id,
                    "p_entries": confirmed,
                    # A person approved this merge, which is stronger evidence
                    # than anything the run inferred on its own.
                    "p_confirmed_by": context.requested_by(),
                },
            )
        if observed:
            context.supabase.rpc(
                "upsert_mapping_entries",
                {"p_mapping_table_id": table_id, "p_entries": observed, "p_confirmed_by": None},
            )

    steps = capture_steps(approved, mapping_table_ids)
    if not steps:
        return None

    # The same validation a hand-written recipe goes through, applied to one
    # the system wrote itself. Not defensive theatre: `capture_steps` copies
    # operation parameters out of approved proposals, so an operation the
    # cleaning engine gained without a safety classification would otherwise
    # reach a stored recipe and be replayed unattended. Refusing to save is the
    # right outcome -- the cleaning already happened and is already versioned;
    # what is lost is the shortcut for next month, not this month's work.
    try:
        steps = recipe_schema.validate_steps(steps)
    except recipe_schema.RecipeInvalid as error:
        log.warning("declining to capture a recipe: %s", error)
        return None

    # Invariants are derived from the cleaned output, because that is the shape
    # future months are expected to match.
    cleaned_profile, _cleaned_table = _profile_from_columns(result.columns, result.source_rows)
    invariants = default_invariants(cleaned_profile)

    captured = context.supabase.rpc(
        "capture_recipe",
        {
            "p_workspace_id": context.workspace_id,
            "p_dataset_id": dataset_id,
            "p_source_signature": signature,
            "p_name": f"{dataset['name']} cleanup",
            "p_steps": steps,
            "p_invariants": invariants,
            "p_change_note": f"Learned from the review of version {version['version_no']}",
            "p_learned_from": context.job_id,
            "p_created_by": context.requested_by(),
        },
    )

    return {
        "recipe_version_id": captured["id"],
        "version_no": captured["version_no"],
        "steps": len(steps),
        "invariants": len(invariants),
        "mapping_tables": mapping_table_ids,
    }


# -----------------------------------------------------------------------------
# replay_recipe
# -----------------------------------------------------------------------------


def handle_replay_recipe(context: JobContext) -> dict[str, Any]:
    """
    Month 2 (MVP criterion 6).

    Instead of profiling from scratch and asking the accountant to approve the
    same eight things again, the recipe learned last month runs against this
    month's file and reports only what it could not handle.

    The order of the last three operations is the part that matters. Apply the
    steps, then check the invariants, and only then decide whether to write an
    output version. A run that fails an invariant must produce nothing: a
    cleaned version sitting in storage is a version something downstream will
    eventually read, and "we wrote it but marked the run blocked" is the shape
    of every silent-failure incident this product exists to prevent.
    """
    version_id = context.job.get("dataset_version_id")
    if not version_id:
        raise JobError("this job has no dataset version attached")

    version = _load_version(context, version_id)

    datasets = context.supabase.select(
        "datasets",
        columns="id,name,source_signature",
        filters={"id": f"eq.{version['dataset_id']}"},
        limit=1,
    )
    signature = datasets[0].get("source_signature") if datasets else None

    matched = context.supabase.rpc(
        "match_recipe",
        {"p_workspace_id": context.workspace_id, "p_source_signature": signature},
    )
    recipe = matched[0] if isinstance(matched, list) and matched else None
    if not recipe:
        raise JobError(
            "No recipe matches this file's layout. Analyse it from scratch and approve the "
            "changes; that will save a recipe for next month."
        )

    context.heartbeat({"stage": "downloading", "recipe": recipe["recipe_name"]})
    parquet_bytes = _load_parquet(context, version)
    profile, table = _profile_from_parquet(
        parquet_bytes, _stored_interpretation(context, version)
    )

    # Everything the workspace currently knows about this client's vocabulary.
    # Read now rather than baked into the recipe: that is the whole point of a
    # growable mapping table, and it is what makes last month's resolutions
    # apply to this month's file.
    mappings = _load_mappings(context, recipe["steps"])

    run = context.supabase.rpc(
        "start_recipe_run",
        {
            "p_workspace_id": context.workspace_id,
            "p_recipe_version_id": recipe["recipe_version_id"],
            "p_dataset_version_in": version_id,
            "p_job_id": context.job_id,
        },
    )

    # A scheduled firing recorded which job it created; this is the other half
    # of that link, written now rather than at the end so a run that fails still
    # traces back to the schedule that started it. The schedule screen's "last
    # run" reads through it.
    #
    # Nothing about the execution below changes because a schedule started it.
    # That is the point: the scheduled path and the manual path are the same
    # path, and this is the only line that knows the difference.
    if context.payload.get("scheduled"):
        try:
            context.supabase.rpc(
                "attach_schedule_run",
                {"p_job_id": context.job_id, "p_recipe_run_id": run["id"]},
            )
        except SupabaseError as error:
            # A broken link is a worse audit trail, not a worse run.
            log.warning("could not link run %s to its schedule: %s", run["id"], error)

    summary_report: dict[str, Any] | None = None

    try:
        context.heartbeat({"stage": "replaying", "steps": len(recipe["steps"])})
        # The recipe already records the columns it was learned against, in its
        # columns_present invariant. Reusing that beats inferring the
        # expectation from step parameters, which would report every column
        # that needed no cleaning as new, every month.
        expected_columns = next(
            (
                invariant.get("columns")
                for invariant in (recipe.get("invariants") or [])
                if invariant.get("type") == "columns_present"
            ),
            None,
        )
        result = replay(
            table, recipe["steps"], profile, mappings, expected_columns=expected_columns
        )

        context.heartbeat({"stage": "checking invariants"})
        outcomes, invariant_deviations = check_invariants(
            recipe.get("invariants") or [], result.cleaned, profile
        )
        result.deviations.extend(invariant_deviations)
        result.invariants = outcomes

        deviation_rows = [deviation.to_row() for deviation in result.deviations]
        if deviation_rows:
            context.supabase.rpc(
                "record_deviations", {"p_run_id": run["id"], "p_deviations": deviation_rows}
            )

        # Bump hit counts so a mapping entry can show it is earning its keep.
        for table_id, keys in result.mapping_hits.items():
            context.supabase.rpc(
                "record_mapping_hits", {"p_mapping_table_id": table_id, "p_source_keys": keys}
            )

        summary = result.summary()
        status_text = invariant_status(outcomes)

        # A deviation the accountant has already decided on must not stop the
        # run a second time. Without this, resolving one changes nothing: the
        # next replay recomputes the same finding from the same file, sets
        # needs_review again, and writes no version -- so the workflow has no
        # way to finish and the resolution UI is decoration.
        #
        # Scoped to the input version rather than the workspace, because group
        # keys are deliberately coarse. Every new column in a run shares the key
        # "new_column" so they arrive as one screen rather than eleven; matching
        # workspace-wide would let this month's decision silently suppress next
        # month's different new column, which is the failure this whole feature
        # exists to prevent.
        #
        # The deviations are still recorded either way. What a prior resolution
        # changes is whether the run stops, not whether the finding is reported.
        decided = _resolved_deviation_keys(context, version_id)
        outstanding = [
            deviation for deviation in result.deviations if deviation.group_key not in decided
        ]

        if any(deviation.severity == "block" for deviation in outstanding):
            status = "blocked"
            output_version = None
        elif any(deviation.severity == "review" for deviation in outstanding):
            status = "needs_review"
            output_version = None
        else:
            context.heartbeat({"stage": "writing", "rows": result.cleaned.row_count})
            new_parquet = to_parquet(result.cleaned.columns, result.cleaned.source_rows)
            path = _parquet_path(
                context.job["org_id"],
                context.workspace_id,
                version["dataset_id"],
                context.job_id,
            )
            stored = context.supabase.upload(
                PARQUET_BUCKET,
                path,
                new_parquet,
                content_type="application/vnd.apache.parquet",
                upsert=True,
            )
            written = context.supabase.rpc(
                "record_dataset_version",
                {
                    "p_dataset_id": version["dataset_id"],
                    "p_kind": "cleaned",
                    "p_parquet_path": stored.path,
                    "p_row_count": result.cleaned.row_count,
                    "p_column_hash": column_hash(result.cleaned.columns),
                    "p_parent_version_id": version_id,
                    "p_produced_by_job": context.job_id,
                    "p_created_by": context.requested_by(),
                    "p_metadata": {
                        "stage": "cleaned",
                        "replayed_recipe": recipe["recipe_name"],
                        "recipe_version_no": recipe["version_no"],
                        "automation_rate": result.automation_rate,
                    },
                },
            )
            status = "succeeded"
            output_version = written["id"]

            # The deliverable (section 6, steps 7 and 8).
            #
            # Only on a clean run, and only after the output version exists,
            # because a report is a statement about a dataset version -- one
            # produced from a run that stopped for review would describe rows
            # nobody has approved yet, in a document with the client's name on
            # it. A recipe with no report configuration produces no report,
            # which is the ordinary case for a recipe that only cleans.
            report_config = recipe.get("report_config") or {}
            formats = report_config.get("formats") if isinstance(report_config, dict) else None
            if formats:
                context.heartbeat({"stage": "reporting"})
                summary_report = _report_for_run(
                    context,
                    output_version_id=output_version,
                    formats=formats,
                    recipe_id=recipe["recipe_id"],
                    recipe_version_id=recipe["recipe_version_id"],
                    run_id=run["id"],
                )

        context.supabase.rpc(
            "finish_recipe_run",
            {
                "p_run_id": run["id"],
                "p_status": status,
                "p_dataset_version_out": output_version,
                "p_rows_processed": result.rows_processed,
                "p_rows_matched": result.rows_matched,
                "p_auto_corrections": result.auto_corrections,
                "p_deviations_count": len(result.deviations),
                "p_automation_rate": result.automation_rate,
                "p_invariant_status": status_text,
                "p_summary": {**summary, **({"report": summary_report} if summary_report else {})},
            },
        )

    except Exception as error:
        # A run row that stays 'running' forever is worse than one marked
        # failed: the dashboard cannot tell it apart from work in progress.
        context.supabase.rpc(
            "finish_recipe_run",
            {
                "p_run_id": run["id"],
                "p_status": "failed",
                "p_summary": {"error": str(error)[:500]},
            },
        )
        raise

    return {
        "run_id": run["id"],
        "recipe": recipe["recipe_name"],
        "recipe_version_no": recipe["version_no"],
        "status": status,
        "dataset_version_out": output_version,
        "rows_processed": result.rows_processed,
        "auto_corrections": result.auto_corrections,
        "deviations": len(result.deviations),
        "automation_rate": result.automation_rate,
        "invariants": status_text,
        "summary": summary,
        "report": summary_report,
    }


def _report_for_run(
    context: JobContext,
    *,
    output_version_id: str,
    formats: list[str],
    recipe_id: str,
    recipe_version_id: str,
    run_id: str,
) -> dict[str, Any] | None:
    """
    The report a recipe run produces, attached to the run that produced it.

    Deliberately forgiving in one direction only. A report that cannot be
    rendered must not undo a replay that worked: the cleaned version is written,
    the lineage is recorded, and the failure is reported as a failure of the
    report rather than of the run (section 22). What it is not forgiving about
    is silence -- a run whose report failed says so on the run's summary, so
    nobody goes looking in the exports bucket for a document that was never
    produced.
    """
    try:
        version = _load_version(context, output_version_id)
        document, _extras = _assemble_report(context, version)
        brand, resolved = _brand_for(context, None, period=document.period)
        stored = _store_report(
            context,
            document=document,
            version=version,
            formats=formats,
            brand=brand,
            resolved=resolved,
            recipe_id=recipe_id,
            recipe_version_id=recipe_version_id,
        )
    except Exception as error:  # noqa: BLE001 - the run succeeded; the report did not
        log.exception("recipe run %s produced no report", run_id)
        return {"status": "failed", "error": f"{type(error).__name__}: {error}"[:300]}

    if stored.get("report_artifact_id"):
        context.supabase.rpc(
            "attach_run_report",
            {"p_run_id": run_id, "p_report_artifact_id": stored["report_artifact_id"]},
        )

    return {
        "status": stored["status"],
        "report_artifact_id": stored["report_artifact_id"],
        "formats": stored["formats"],
        "branding": resolved.snapshot(),
    }


def _resolved_deviation_keys(context: JobContext, dataset_version_in: str) -> set[str]:
    """
    Group keys already decided by a person for this particular input file.

    Read from the deviations of every earlier run over the same input version.
    That is the scope that matches how a replay is retried: the accountant
    resolves what run 1 found, presses replay again, and run 2 sees the same
    file -- so it necessarily rediscovers the same findings, and has to know
    they have been answered.

    A 'mapped' resolution additionally teaches the mapping table, so unmapped
    values genuinely stop recurring on their own. The other resolutions
    (accepted, rejected, ignored) record a judgement and teach nothing, which is
    exactly why they need to be remembered here.
    """
    runs = context.supabase.select(
        "recipe_runs",
        columns="id",
        filters={"dataset_version_in": f"eq.{dataset_version_in}"},
    )
    run_ids = [run["id"] for run in runs if run.get("id")]
    if not run_ids:
        return set()

    rows = context.supabase.select(
        "deviations",
        columns="group_key,resolution",
        filters={
            "run_id": f"in.({','.join(run_ids)})",
            "resolution": "neq.pending",
        },
    )
    return {row["group_key"] for row in rows if row.get("group_key")}


def _source_filename(context: JobContext, version: dict[str, Any]) -> str | None:
    """
    The name of the workbook this version ultimately came from.

    A cleaned version is two or three links down a chain from the upload --
    parse wrote one, apply wrote another on top -- and only the first carries
    raw_upload_id. So walk up the parents until one does.

    Worth the two extra reads. An accountant recognises "Dheddig_Contacts", not
    the dataset name someone typed once in a form, and certainly not a version
    number: the file that lands in their Downloads folder has to be findable
    next to the file they sent.
    """
    seen: set[str] = set()
    current: dict[str, Any] | None = version

    while current is not None and current["id"] not in seen:
        seen.add(current["id"])
        upload_id = current.get("raw_upload_id")
        if upload_id:
            uploads = context.supabase.select(
                "raw_uploads",
                columns="id,original_filename",
                filters={"id": f"eq.{upload_id}"},
                limit=1,
            )
            if uploads:
                return uploads[0].get("original_filename")
            return None

        parent_id = current.get("parent_version_id")
        if not parent_id:
            return None
        try:
            current = _load_version(context, parent_id)
        except JobError:
            return None

    return None


def _load_mappings(context: JobContext, steps: list[dict[str, Any]]) -> dict[str, dict[str, str]]:
    """Current contents of every mapping table the recipe's steps refer to."""
    table_ids = {
        step.get("params", {}).get("mapping_table_id")
        for step in steps
        if step.get("params", {}).get("mapping_table_id")
    }

    mappings: dict[str, dict[str, str]] = {}
    for table_id in table_ids:
        entries = context.supabase.select(
            "mapping_entries",
            columns="source_key,canonical_value",
            filters={"mapping_table_id": f"eq.{table_id}"},
            limit=10000,
        )
        mappings[table_id] = {
            entry["source_key"]: entry["canonical_value"] for entry in entries
        }

    return mappings


# -----------------------------------------------------------------------------
# query_dataset
# -----------------------------------------------------------------------------


def handle_query_dataset(context: JobContext) -> dict[str, Any]:
    """
    Answer a question about a dataset.

    Two entry points, one execution path. A caller may pass a structured `query`
    directly (the dashboard's chart builder does), or a natural-language
    `question` for the model to translate. Either way the spec is compiled and
    validated here before any SQL exists.
    """
    version_id = context.job.get("dataset_version_id")
    if not version_id:
        raise JobError("this job has no dataset version attached")

    version = _load_version(context, version_id)
    parquet_bytes = _load_parquet(context, version)

    spec = context.payload.get("query")
    question = context.payload.get("question")
    model_used = None

    if not spec:
        if not question:
            raise JobError("ask a question or supply a structured query")
        if not context.llm.enabled:
            raise JobError(
                "No reasoning model is configured, so questions in plain English cannot be "
                "translated. Set OPENAI_API_KEY or KIMI_API_KEY on the agent host."
            )

        context.heartbeat({"stage": "planning"})
        profile, _table = _profile_from_parquet(parquet_bytes)
        redacted = build_context(
            profile,
            max_sample_values=context.config.max_sample_values,
            redact_samples=context.config.redact_samples,
        )
        spec, model_used, error = context.llm.plan_query(question, redacted)
        if not spec:
            raise JobError(error or "the question could not be turned into a query")

    context.heartbeat({"stage": "querying"})
    try:
        result = analyze.run_query(parquet_bytes, spec)
    except analyze.QueryError as error:
        raise JobError(str(error)) from error

    run = context.supabase.rpc(
        "record_analysis_run",
        {
            "p_dataset_version_id": version_id,
            "p_question": question,
            "p_executed_sql": result.sql,
            "p_result": {"rows": result.rows, "spec": spec},
            "p_row_refs": result.row_refs,
            "p_model_used": model_used,
            "p_duration_ms": result.duration_ms,
            "p_job_id": context.job_id,
            "p_created_by": context.requested_by(),
        },
    )

    return {
        "analysis_run_id": run["id"],
        "question": question,
        "query": spec,
        "sql": result.sql,
        "rows": result.rows,
        "row_refs": result.row_refs,
        "row_count": result.row_count,
        "duration_ms": result.duration_ms,
        "model_used": model_used,
    }


# -----------------------------------------------------------------------------
# reconcile_sources
# -----------------------------------------------------------------------------


def handle_reconcile_sources(context: JobContext) -> dict[str, Any]:
    version_a = context.job.get("dataset_version_id")
    version_b = context.payload.get("compare_to_version_id")
    if not version_a or not version_b:
        raise JobError("reconciliation needs two dataset versions")

    left = _load_version(context, version_a)
    right = _load_version(context, version_b)

    # Both versions must belong to this workspace. The enqueue RPC checked the
    # first; the second arrived in the payload and has not been checked by
    # anything yet.
    allowed = {
        row["id"]
        for row in context.supabase.select(
            "datasets", columns="id", filters={"workspace_id": f"eq.{context.workspace_id}"}
        )
    }
    if left["dataset_id"] not in allowed or right["dataset_id"] not in allowed:
        raise JobError("both datasets must belong to this workspace")

    context.heartbeat({"stage": "downloading"})
    parquet_a = _load_parquet(context, left)
    parquet_b = _load_parquet(context, right)

    keys = context.payload.get("key_columns")
    amount = context.payload.get("amount_column")

    if not keys or not amount:
        profile, _table = _profile_from_parquet(parquet_a)
        if not keys:
            key = next(
                (
                    column.name
                    for column in profile.columns
                    if column.inferred_type == "text"
                    and column.distinct_count == column.non_null
                    and column.non_null > 0
                ),
                None,
            )
            if not key:
                raise JobError("no unique key column found; name one in key_columns")
            keys = [key]
        if not amount:
            amount = next((name for name in _money_columns(profile)), None)
            if not amount:
                raise JobError("no money column found; name one in amount_column")

    context.heartbeat({"stage": "reconciling"})
    try:
        result = analyze.reconcile(
            parquet_a,
            parquet_b,
            key_columns=keys,
            amount_column=amount,
            tolerance=float(context.payload.get("tolerance", 0.01)),
        )
    except analyze.QueryError as error:
        raise JobError(str(error)) from error

    result["version_a"] = version_a
    result["version_b"] = version_b
    return result


# -----------------------------------------------------------------------------
# generate_report
# -----------------------------------------------------------------------------


def _report_provenance(context: JobContext, version: dict[str, Any]) -> dict[str, Any]:
    """
    Where this version came from and what a person approved on the way.

    Assembled from rows that already existed. The source workbook is two or
    three parent hops away, the approved changes are recorded against the
    *parent* version -- they were proposals about that version, and applying
    them is what produced this one -- and the lineage is the parent pointer.

    None of it was in the report, which is the gap that matters most for
    someone signing off: the totals were traceable and the file they came from
    was not.
    """
    provenance: dict[str, Any] = {
        "source_filename": _source_filename(context, version),
        "row_count": version.get("row_count"),
    }

    # A version carrying raw_upload_id was produced by parsing that upload, and
    # is therefore not derived from anything -- it is a fresh reading of the
    # workbook.
    #
    # Worth stating because the parent pointer does not distinguish the two.
    # record_dataset_version fills an absent parent with whatever version was
    # latest, so a re-parse silently chains itself to the cleaned version that
    # happened to precede it. Reporting that as "derived from v2" would put a
    # lineage in an accountant's hands that never happened, and the applied
    # changes hanging off that parent belong to a different chain entirely.
    if version.get("raw_upload_id"):
        uploads = context.supabase.select(
            "raw_uploads",
            columns="created_at",
            filters={"id": f"eq.{version['raw_upload_id']}"},
            limit=1,
        )
        if uploads:
            provenance["uploaded_at"] = uploads[0].get("created_at")
        provenance["parsed_directly"] = True
        return provenance

    parent_id = version.get("parent_version_id")
    if not parent_id:
        return provenance

    try:
        parent = _load_version(context, parent_id)
    except JobError:
        return provenance

    provenance["parent_version_no"] = parent.get("version_no")

    # Proposals live against the version they were made about, so the changes
    # that produced *this* version are the applied ones on its parent.
    applied = context.supabase.select(
        "proposed_changes",
        columns="title,affected_rows,decided_at,step_type",
        filters={"dataset_version_id": f"eq.{parent_id}", "status": "eq.applied"},
        order="decided_at.asc",
    )
    provenance["applied_changes"] = applied or []

    uploads = context.supabase.select(
        "raw_uploads",
        columns="created_at",
        filters={"id": f"eq.{parent.get('raw_upload_id') or version.get('raw_upload_id') or ''}"},
        limit=1,
    ) if (parent.get("raw_upload_id") or version.get("raw_upload_id")) else []
    if uploads:
        provenance["uploaded_at"] = uploads[0].get("created_at")

    return provenance


def _organization_branding(context: JobContext) -> dict[str, Any]:
    """The organisation's stored branding row, or an empty dict."""
    rows = context.supabase.select(
        "organization_branding",
        columns=(
            "organization_id,business_name,legal_name,logo_storage_path,logo_mime_type,"
            "logo_width,logo_height,logo_url,accent_color,footer_text"
        ),
        filters={"organization_id": f"eq.{context.job['org_id']}"},
        limit=1,
    )
    return rows[0] if rows else {}


def _logo_bytes(context: JobContext, branding: dict[str, Any]) -> tuple[bytes | None, str]:
    """
    The logo's bytes, and which priority produced them (section 11).

    Priorities 1 and 2 are the same fetch: an explicit logo and an approved
    discovery both end up as an object in the `branding` bucket, because
    approving a discovered image is a metadata write rather than a copy. What
    separates them is only which screen set the path, and the report does not
    care.

    Priority 4 -- an administrator's URL -- is fetched here, behind
    `assert_safe_logo_url`. Every failure in this function is a missing logo,
    never a failed report: section 22 is explicit that a report without a logo
    is the correct outcome when the logo cannot be had.
    """
    path = branding.get("logo_storage_path")
    if isinstance(path, str) and path:
        try:
            return context.supabase.download(
                BRANDING_BUCKET, path, max_bytes=branding_tools.MAX_LOGO_BYTES
            ), "organization_logo"
        except Exception:  # noqa: BLE001
            log.warning("branding logo %s could not be downloaded", path)
            return None, "none"

    url = branding.get("logo_url")
    if isinstance(url, str) and url:
        try:
            safe = branding_tools.assert_safe_logo_url(url)
        except branding_tools.UnsafeLogoUrl as error:
            log.warning("refusing to fetch logo url: %s", error)
            return None, "none"
        try:
            import httpx

            with httpx.Client(
                timeout=8.0,
                # No redirect following. A redirect is a second URL that the
                # safety check never saw, and "https://cdn.example/logo.png"
                # answering 302 to http://169.254.169.254 is the whole trick.
                follow_redirects=False,
            ) as client:
                response = client.get(safe)
            if response.status_code != 200:
                return None, "none"
            payload = response.content[: branding_tools.MAX_LOGO_BYTES + 1]
            if len(payload) > branding_tools.MAX_LOGO_BYTES:
                return None, "none"
            return payload, "remote_url"
        except Exception:  # noqa: BLE001
            log.warning("logo url fetch failed")
            return None, "none"

    return None, "none"


def _resolve_branding(
    context: JobContext, override: Any = None
) -> branding_tools.ResolvedBranding:
    """
    Whose name and whose logo go on this document (sections 10, 11 and 14).

    The caller no longer has to send a name. A report knows its organisation,
    the organisation has a stored identity, and this walks the resolution order
    in one place -- which is what makes "the name on the PDF" a fact about the
    tenant rather than a property of whichever screen happened to enqueue the
    job.

    An explicit override is still honoured, because an internal or admin
    workflow producing a document on someone else's behalf is a real case. It is
    first in the order, not a replacement for it: an override that names only a
    colour still gets the organisation's name.
    """
    branding = _organization_branding(context)

    organization = None
    rows = context.supabase.select(
        "organizations", columns="id,name", filters={"id": f"eq.{context.job['org_id']}"}, limit=1
    )
    if rows:
        organization = rows[0]

    workspace = None
    workspace_rows = context.supabase.select(
        "workspaces",
        columns="id,name,client_name",
        filters={"id": f"eq.{context.workspace_id}"},
        limit=1,
    )
    if workspace_rows:
        workspace = workspace_rows[0]

    logo_bytes, logo_source = _logo_bytes(context, branding)

    return branding_tools.resolve_branding(
        override=override if isinstance(override, dict) else None,
        branding=branding,
        organization=organization,
        workspace=workspace,
        logo_bytes=logo_bytes,
        logo_source=logo_source,
    )


def _brand_for(
    context: JobContext, branding: Any, period: str = ""
) -> tuple[documents.Brand, branding_tools.ResolvedBranding]:
    """
    The renderer's `Brand`, plus the resolution that produced it.

    Both are returned because the report row needs the second one. Section 19
    has the recipe reference current branding rather than copy it, so the only
    record of what a document actually said is the snapshot taken when it was
    rendered.
    """
    resolved = _resolve_branding(context, branding)
    brand = documents.Brand.for_client(
        name=resolved.business_name,
        accent=resolved.accent,
        footer=resolved.footer,
        logo=resolved.logo,
        logo_url=resolved.public_logo_url,
        period=period,
    )
    return brand, resolved


def _requested_formats(payload: dict[str, Any]) -> list[str]:
    """
    Which formats to render.

    `format` (one) and `formats` (several) both work: the dashboard sends the
    first, a recipe's report configuration sends the second, and neither should
    have to know about the other.
    """
    several = payload.get("formats")
    if isinstance(several, list) and several:
        chosen = [value for value in several if isinstance(value, str)]
    else:
        one = payload.get("format")
        chosen = [one] if isinstance(one, str) else ["md"]

    ordered: list[str] = []
    for value in chosen:
        if value in documents.FORMATS and value not in ordered:
            ordered.append(value)
    return ordered or ["md"]


def _assemble_report(
    context: JobContext, version: dict[str, Any]
) -> tuple[report.ReportDocument, dict[str, Any]]:
    """
    Everything a month-end report says, for one dataset version.

    Split out of the job handler so a recipe run can produce the same document
    at the end of a replay without a second copy of the assembly. The handler
    keeps the parts that are about *the job* -- which formats, where the bytes
    go, what the result row says.
    """
    version_id = version["id"]
    parquet_bytes = _load_parquet(context, version)

    context.heartbeat({"stage": "profiling"})
    profile, _table = _profile_from_parquet(
        parquet_bytes, _stored_interpretation(context, version)
    )

    money = _money_columns(profile)
    date_column = _first_of(profile, "date")
    breakdown = _categorical(profile)

    context.heartbeat({"stage": "computing"})
    kpis = analyze.headline_kpis(parquet_bytes, money, date_column, breakdown)

    comparison: dict[str, Any] | None = None
    compare_to = context.payload.get("compare_to_version_id")
    periods = context.payload.get("periods")

    if compare_to and date_column and money:
        # Explicit: compare against another version of the same dataset.
        other = _load_version(context, compare_to)
        other_parquet = _load_parquet(context, other)
        combined = _concat_parquet(parquet_bytes, other_parquet)
        if combined and periods and len(periods) == 2:
            result = analyze.compare_periods(
                combined, date_column, money[0],
                tuple(periods[0]), tuple(periods[1]),
                breakdown_column=breakdown,
            )
            comparison = result.__dict__

    elif date_column and money:
        # Nothing asked for a comparison, so derive one from the data.
        #
        # "Revenue up 12% on last month" is the line an accountant reads first,
        # and it was unreachable: the code required a caller to name a second
        # version *and* both date ranges, and nothing in the product ever did.
        # A ledger spanning two months already contains the comparison -- the
        # report just never looked.
        #
        # The two most recent months with data, which is what month-on-month
        # means. Gaps are skipped rather than filled: comparing March against
        # January is still a real comparison, and inventing an empty February
        # to sit between them would not be.
        series = (kpis.get("monthly") or {}).get("series") or []
        source = parquet_bytes

        if len(series) < 2:
            # One month in this file, which is the ordinary case here: a client
            # sends one workbook per month. The previous month is a sibling
            # version of the same dataset, so borrow it and compare across the
            # two -- that pairing is the whole point of the recipe workflow.
            siblings = context.supabase.select(
                "dataset_versions",
                columns="id,parquet_path,created_at",
                filters={
                    "dataset_id": f"eq.{version['dataset_id']}",
                    "id": f"neq.{version_id}",
                    "parquet_path": "not.is.null",
                },
                order="created_at.desc",
                limit=1,
            )
            if siblings:
                try:
                    combined = _concat_parquet(
                        parquet_bytes, _load_parquet(context, siblings[0])
                    )
                except JobError:
                    combined = None
                if combined:
                    merged = analyze.headline_kpis(combined, money, date_column, breakdown)
                    merged_series = (merged.get("monthly") or {}).get("series") or []
                    if len(merged_series) > 1:
                        series, source = merged_series, combined

        if len(series) > 1:
            previous, current = series[-2]["month"], series[-1]["month"]
            result = analyze.compare_periods(
                source, date_column, money[0],
                (f"{previous}-01", f"{previous}-31"),
                (f"{current}-01", f"{current}-31"),
                breakdown_column=breakdown,
            )
            comparison = result.__dict__

    narrative = None
    model_used = None
    if context.llm.enabled:
        context.heartbeat({"stage": "drafting"})
        redacted = build_context(
            profile,
            max_sample_values=context.config.max_sample_values,
            redact_samples=context.config.redact_samples,
        )
        narrative, model_used = context.llm.narrate(
            redacted, {"kpis": kpis, "comparison": comparison}
        )

    dataset_rows = context.supabase.select(
        "datasets", columns="id,name", filters={"id": f"eq.{version['dataset_id']}"}, limit=1
    )
    workspace_rows = context.supabase.select(
        "workspaces", columns="id,name", filters={"id": f"eq.{context.workspace_id}"}, limit=1
    )

    provenance = _report_provenance(context, version)

    document = report.build_report_document(
        workspace_name=workspace_rows[0]["name"] if workspace_rows else "Workspace",
        dataset_name=dataset_rows[0]["name"] if dataset_rows else "Dataset",
        version_no=version["version_no"],
        kpis=kpis,
        profile_signals=profile.signals,
        comparison=comparison,
        provenance=provenance,
        narrative=narrative,
    )

    return document, {
        "kpis": kpis,
        "comparison": comparison,
        "narrative": narrative,
        "model_used": model_used,
        "dataset_name": dataset_rows[0]["name"] if dataset_rows else "Report",
    }


def _store_report(
    context: JobContext,
    *,
    document: report.ReportDocument,
    version: dict[str, Any],
    formats: list[str],
    brand: documents.Brand,
    resolved: branding_tools.ResolvedBranding,
    recipe_id: str | None = None,
    recipe_version_id: str | None = None,
) -> dict[str, Any]:
    """
    Render the requested formats, store what worked, and record what happened.

    Section 22's failure rule is the shape of this function: one renderer
    failing marks that format failed and keeps the others. A pack of a PDF and a
    workbook where the workbook hits a bad chart is still a PDF the client can
    be sent, and throwing it away to raise cleanly would be a worse outcome
    dressed as a stricter one.
    """
    if any(fmt != "md" for fmt in formats):
        context.heartbeat({"stage": "rendering"})

    rendered = documents.render_all(document, formats, brand)

    period_folder = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")
    entries: list[dict[str, Any]] = []
    primary: dict[str, Any] | None = None

    for item in rendered:
        if not item.ok:
            log.warning("report format %s failed: %s", item.format, item.error)
            entries.append({"format": item.format, "ok": False, "error": item.error})
            continue

        path = (
            f"{context.job['org_id']}/{context.workspace_id}/{period_folder}/"
            f"{version['dataset_id']}__v{version['version_no']}__report.{item.format}"
        )
        stored = context.supabase.upload(
            EXPORTS_BUCKET, path, item.payload, content_type=item.content_type, upsert=True
        )
        entry = {
            "format": item.format,
            "ok": True,
            "path": stored.path,
            "bytes": len(item.payload or b""),
        }
        entries.append(entry)
        if primary is None:
            primary = entry

    succeeded = [entry for entry in entries if entry["ok"]]
    if not succeeded:
        status = "failed"
    elif len(succeeded) < len(entries):
        status = "partial"
    else:
        status = "succeeded"

    artifact = context.supabase.rpc(
        "record_report_artifact",
        {
            "p_workspace_id": context.workspace_id,
            "p_dataset_id": version["dataset_id"],
            "p_dataset_version_id": version["id"],
            "p_recipe_id": recipe_id,
            "p_recipe_version_id": recipe_version_id,
            "p_job_id": context.job_id,
            "p_formats": entries,
            "p_bucket": EXPORTS_BUCKET,
            "p_status": status,
            "p_error": "; ".join(
                str(entry.get("error")) for entry in entries if not entry["ok"]
            )[:500]
            or None,
            "p_branding_snapshot": resolved.snapshot(),
            "p_title": document.title,
            "p_period": document.period,
            "p_created_by": context.requested_by(),
        },
    )

    return {
        "report_artifact_id": (artifact or {}).get("id"),
        "status": status,
        "formats": entries,
        "primary": primary,
    }


def handle_generate_report(context: JobContext) -> dict[str, Any]:
    version_id = context.job.get("dataset_version_id")
    if not version_id:
        raise JobError("this job has no dataset version attached")

    version = _load_version(context, version_id)
    document, extras = _assemble_report(context, version)

    # Branding is resolved from the organisation rather than sent by the
    # caller (section 14). The payload override survives for the internal case
    # and is now the first step of a resolution order rather than the only
    # source of a name.
    brand, resolved = _brand_for(
        context, context.payload.get("branding"), period=document.period
    )

    # Markdown is still what goes back on the job row: the assistant renders it
    # in the thread, and it costs nothing to produce. The chosen formats are
    # what go into the bucket for the client.
    markdown = report.render_markdown(document, brand)

    formats = _requested_formats(context.payload)
    stored = _store_report(
        context,
        document=document,
        version=version,
        formats=formats,
        brand=brand,
        resolved=resolved,
    )

    primary = stored["primary"]
    if primary is None:
        raise JobError(
            "The report could not be rendered in any of the requested formats. "
            + "; ".join(str(entry.get("error")) for entry in stored["formats"])[:300]
        )

    return {
        "report_path": primary["path"],
        "bucket": EXPORTS_BUCKET,
        "format": primary["format"],
        "formats": stored["formats"],
        "report_artifact_id": stored["report_artifact_id"],
        "report_status": stored["status"],
        "branding": resolved.snapshot(),
        # Carried so the download route can name the saved file after the
        # dataset rather than after its uuid. See downloadName() in
        # apps/web/src/app/api/exports/route.ts.
        "dataset_name": extras["dataset_name"],
        "version_no": version["version_no"],
        "markdown": markdown,
        "kpis": extras["kpis"],
        "comparison": extras["comparison"],
        "narrative": extras["narrative"],
        "model_used": extras["model_used"],
    }



def _concat_parquet(first: bytes, second: bytes) -> bytes | None:
    """
    Stack two versions so one query can span both periods.

    Returns None when the schemas disagree, which is itself the answer: a
    month-on-month comparison across a changed schema is not a comparison, and
    reporting "columns changed" beats reporting a number built from a
    best-effort alignment.
    """
    import io

    import polars as pl

    try:
        left = pl.read_parquet(io.BytesIO(first))
        right = pl.read_parquet(io.BytesIO(second))
        shared = [name for name in left.columns if name in right.columns]
        if not shared:
            return None
        combined = pl.concat([left.select(shared), right.select(shared)], how="vertical_relaxed")
        buffer = io.BytesIO()
        combined.write_parquet(buffer, compression="zstd")
        return buffer.getvalue()
    except Exception as error:  # noqa: BLE001
        log.warning("could not combine versions for comparison: %s", error)
        return None


# -----------------------------------------------------------------------------
# export_dataset
# -----------------------------------------------------------------------------

_EXPORT_CONTENT_TYPES = {
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "csv": "text/csv",
}


def _rows_from_parquet(parquet_bytes: bytes) -> list[dict[str, Any]]:
    """
    A stored version as plain rows, in column order.

    `__source_row` is dropped. It is the provenance link back into the original
    workbook and it is why an approved change can be traced to a line the
    accountant can point at -- but it is an internal join key, and a column of
    integers labelled `__source_row` in a file someone is about to send a client
    is noise at best and confusing at worst.
    """
    import io

    import polars as pl

    frame = pl.read_parquet(io.BytesIO(parquet_bytes))
    # `__source_row` is the provenance key and `__raw_*` holds each coerced
    # column's original text, kept so a change can be shown as before/after.
    # Both are machinery. Six of them shipped in a customer's export before this
    # filter existed, next to the columns they duplicate -- Table.business_columns
    # has always drawn exactly this line, and the export simply was not asking.
    columns = [
        name
        for name in frame.columns
        if name != "__source_row" and not name.startswith("__raw_")
    ]
    return frame.select(columns).to_dicts()


def handle_export_dataset(context: JobContext) -> dict[str, Any]:
    """
    Write a cleaned version out in a format a person can open.

    Deliberately not a new table. An export is derived from a version that is
    already immutable, so re-running this job on the same version reproduces the
    same file -- there is nothing to record that the version and the format do
    not already say. The path goes onto the job result, which is where
    generate_report puts its own output and where the download route reads from.
    """
    version_id = context.job.get("dataset_version_id")
    if not version_id:
        raise JobError("this job has no dataset version attached")

    fmt = str(context.payload.get("format") or "xlsx").strip().lower()
    if fmt not in _EXPORT_CONTENT_TYPES:
        raise JobError(f"unknown export format {fmt!r}; expected 'xlsx' or 'csv'")

    version = _load_version(context, version_id)
    parquet_bytes = _load_parquet(context, version)

    context.heartbeat({"stage": "reading"})
    rows = _rows_from_parquet(parquet_bytes)

    dataset_rows = context.supabase.select(
        "datasets", columns="id,name", filters={"id": f"eq.{version['dataset_id']}"}, limit=1
    )
    dataset_name = dataset_rows[0]["name"] if dataset_rows else "Dataset"
    source_filename = _source_filename(context, version)

    context.heartbeat({"stage": "writing"})
    if fmt == "xlsx":
        body = report.rows_to_xlsx(rows, sheet_name=dataset_name)
    else:
        body = report.rows_to_csv(rows)

    period = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")
    path = (
        f"{context.job['org_id']}/{context.workspace_id}/{period}/"
        f"{version['dataset_id']}__v{version['version_no']}__export.{fmt}"
    )
    stored = context.supabase.upload(
        EXPORTS_BUCKET,
        path,
        body,
        content_type=_EXPORT_CONTENT_TYPES[fmt],
        upsert=True,
    )

    return {
        "export_path": stored.path,
        "bucket": EXPORTS_BUCKET,
        "format": fmt,
        "row_count": len(rows),
        "byte_size": stored.size,
        "dataset_name": dataset_name,
        # What the accountant originally sent us, so the download can be named
        # after it rather than after the dataset someone named in a form.
        "source_filename": source_filename,
        "version_no": version["version_no"],
    }


# -----------------------------------------------------------------------------
# categorize_dataset
# -----------------------------------------------------------------------------


def handle_categorize_dataset(context: JobContext) -> dict[str, Any]:
    """
    Sort one column's values into categories, as a proposal.

    The only job here whose answer is a judgement. Every other finding is
    decidable from the data -- a duplicate is duplicated, a total reconciles or
    it does not -- whereas whether a supplier is a utility or a communications
    cost is a question about how this practice keeps its books.

    That does not earn the model any new authority. It returns a mapping; this
    writes a proposal; the accountant approves it in the same queue as
    everything else; apply_cleaning writes the column from the mapping that was
    approved. The column that appears is the column somebody read.

    Filed at the Review tier deliberately, never Auto. A rule that trims
    whitespace can be trusted to a confidence score. A judgement about somebody
    else's accounts cannot, however good the model is on the day.

    Two ways to run it, and the difference is where the vocabulary comes from.

    Ask for the **UK HMRC taxonomy** (`payload.taxonomy = "uk_hmrc"`) and the
    categories are fixed to the SA103F boxes, `tools.hmrc` decides everything its
    rules recognise, and the model is asked only about the values left over --
    constrained to the same closed list on the way back. That path runs with no
    model at all, which matters: an agent host with no API key used to answer
    "categorising needs a model" to the question this product exists to answer.

    Leave it off and the behaviour is what it was: the model proposes the
    vocabulary as well as the assignments, and a model is required.
    """
    version_id = context.job.get("dataset_version_id")
    if not version_id:
        raise JobError("this job has no dataset version attached")

    column = str(context.payload.get("column") or "").strip()
    if not column:
        raise JobError("no column was chosen to categorise")

    taxonomy = str(context.payload.get("taxonomy") or "").strip().lower()
    if taxonomy and taxonomy != hmrc.TAXONOMY:
        raise JobError(f"unknown taxonomy {taxonomy!r}; expected {hmrc.TAXONOMY!r}")

    if not taxonomy and not context.llm.enabled:
        raise JobError(
            "Categorising into categories the agent invents needs a model, and none is "
            "configured. Either set OPENAI_API_KEY or KIMI_API_KEY on the agent host, or "
            "choose the UK tax categories -- those are decided by rules and need no model."
        )

    version = _load_version(context, version_id)
    parquet_bytes = _load_parquet(context, version)

    context.heartbeat({"stage": "reading"})
    rows = _rows_from_parquet(parquet_bytes)
    if not rows:
        raise JobError("this version has no rows to categorise")
    if column not in rows[0]:
        available = ", ".join(sorted(rows[0].keys())[:20])
        raise JobError(f"there is no column called {column!r} in this version. Columns: {available}")

    # Distinct values and how many rows each covers. The counts are what make
    # the proposal reviewable -- "312 rows" is the number that decides whether
    # this is worth anybody's attention.
    #
    # Keyed on `normalize_text(...).lower()`, which is not merely tidier: it is
    # the exact key `_op_assign_category` looks a row up by when the approved
    # mapping is applied. Keying on `str(value).strip().lower()` here and on the
    # normalised form there agrees for almost every value and silently disagrees
    # for the ones that have been through Word or a PDF -- a non-breaking space
    # or a doubled space is invisible on screen, and the row it belongs to falls
    # through to 'Uncategorised' after a reviewer has approved a category for it.
    counts: dict[str, int] = {}
    originals: dict[str, str] = {}
    for row in rows:
        value = row.get(column)
        if value is None:
            continue
        text = normalize_text(value)
        if not text:
            continue
        key = text.lower()
        counts[key] = counts.get(key, 0) + 1
        originals.setdefault(key, text)

    if not counts:
        raise JobError(f"column {column!r} is empty, so there is nothing to categorise")

    # Most frequent first: if the column has more distinct values than one
    # prompt should carry, the ones covering the most rows are the ones worth
    # spending it on.
    ordered = sorted(originals.values(), key=lambda text: -counts[text.lower()])

    context.heartbeat({"stage": "categorising", "values": len(ordered)})
    requested = context.payload.get("categories")
    categories_in = [str(item) for item in requested] if isinstance(requested, list) else None
    hint = str(context.payload.get("hint") or "") or None

    rule_mapping: dict[str, str] = {}
    model_used: str | None = None
    llm_error: str | None = None

    if taxonomy == hmrc.TAXONOMY:
        # The vocabulary is HMRC's, whatever the caller typed. A closed list is
        # the whole point of filing to a return: an extra category invented for
        # one supplier is a row that has no box to go in.
        categories_in = list(hmrc.CATEGORY_NAMES)
        hint = f"{hmrc.MODEL_HINT} {hint}".strip() if hint else hmrc.MODEL_HINT

        # This job writes a single category column, so it takes the category off
        # each decision and drops the box and the confidence. That is the older,
        # narrower answer and it stays that way on purpose: this is the control
        # in the advanced workspace view, where somebody is choosing a column by
        # hand, and widening its output would change a column shape people
        # already have recipes against. The three-column form lives on
        # `categorise_statement`, which owns the whole file.
        rule_decisions, unmatched = hmrc.categorise_values(ordered)
        rule_mapping = {key: decision.category for key, decision in rule_decisions.items()}
        context.heartbeat(
            {"stage": "categorising", "values": len(ordered), "by_rule": len(rule_mapping)}
        )

        # The model only ever sees what the rules could not place, so a column of
        # familiar UK merchants costs one small call or none at all.
        mapping = dict(rule_mapping)
        if unmatched and context.llm.enabled:
            extra, _used, model_used, llm_error = context.llm.categorize_values(
                column, unmatched, categories=categories_in, hint=hint
            )
            if llm_error:
                # Not fatal here, unlike the model-only path below. The rules
                # already produced a real answer; failing the whole job because
                # the tail could not be reached would throw that away and leave
                # the accountant with nothing.
                log.warning(
                    "job %s: hmrc tail not categorised by model: %s", context.job_id, llm_error
                )
            # Rules win on conflict. They are the reviewable half -- a pattern
            # somebody can read -- and the model is filling gaps, not arbitrating.
            for key, category in extra.items():
                mapping.setdefault(key, category)

        categories = sorted(set(mapping.values()))
        if not mapping:
            raise JobError(
                f"Nothing in {column!r} matched a UK tax rule"
                + (
                    "."
                    if context.llm.enabled
                    else ", and no model is configured to judge the rest."
                )
                + " It may be a reference or free-text column rather than a description of "
                "what was bought."
            )
    else:
        mapping, categories, model_used, llm_error = context.llm.categorize_values(
            column, ordered, categories=categories_in, hint=hint
        )

        if llm_error:
            # Transient by default. A busy free tier, a timeout and a dropped
            # connection all land here, and telling an accountant their column
            # has no categories in it because a shared rate limit was hit is a
            # lie the retry would have corrected.
            raise JobError(f"The model could not be reached: {llm_error}", retryable=True)

        if not mapping:
            raise JobError(
                "The model answered but categorised nothing in this column. It may be free text "
                "rather than something with categories in it."
            )

    target = str(context.payload.get("target") or "").strip() or f"{column}_category"
    covered = sum(counts.get(key, 0) for key in mapping)
    uncovered = len(rows) - covered

    quality = categorize_quality(
        column=column,
        offered=len(ordered),
        mapping=mapping,
        categories=categories,
        rows_total=len(rows),
        rows_covered=covered,
        taxonomy=taxonomy or None,
    )
    dropped = quality["values_dropped"]
    singletons = quality["singleton_categories"]

    if dropped:
        log.warning(
            "job %s: categorize dropped %s of %s value(s) as unusable",
            context.job_id, dropped, len(ordered),
        )

    examples = [
        {"value": originals[key], "category": mapping[key], "rows": counts.get(key, 0)}
        for key in sorted(mapping, key=lambda k: -counts.get(k, 0))[:8]
    ]

    rationale = (
        f"{len(mapping)} distinct value(s) in {column!r}, covering {covered} row(s), were sorted "
        f"into {len(categories)} categor{'y' if len(categories) == 1 else 'ies'}: "
        f"{', '.join(categories[:8])}"
        f"{'…' if len(categories) > 8 else ''}. "
        f"Approving adds a new {target!r} column and leaves {column!r} untouched."
    )
    if taxonomy == hmrc.TAXONOMY:
        # Where each figure ends up is the reason to use this taxonomy at all,
        # so it is said in the sentence rather than left in the evidence blob.
        by_model = len(mapping) - len(rule_mapping)
        rationale += (
            f" Categories are HMRC's SA103F boxes: {len(rule_mapping)} value(s) were matched "
            f"by UK tax rules"
            + (f" and {by_model} by the model" if by_model > 0 else "")
            + ". Personal spending and transfers are labelled as such rather than deducted."
        )
    if uncovered:
        rationale += f" {uncovered} row(s) had no category and would read 'Uncategorised'."
    if dropped:
        # Said out loud rather than left in the evidence blob. A reply that lost
        # a third of its values is one a reviewer should look at harder, and
        # they will not go looking if nothing tells them to.
        #
        # The same number means two different things. On the open path it is
        # what the model returned and the filter refused; on the HMRC path
        # nothing was refused -- those values simply matched no rule and no
        # model placed them, which is a gap to fill, not an answer to distrust.
        rationale += (
            f" {dropped} value(s) matched no rule and were left uncategorised."
            if taxonomy == hmrc.TAXONOMY
            else f" {dropped} value(s) the model returned were unusable and were discarded."
        )
    if singletons:
        rationale += (
            f" {singletons} categor{'y holds' if singletons == 1 else 'ies hold'} "
            f"a single value -- worth checking first."
        )

    proposal = {
        "group_key": f"category:{column}",
        "step_type": "assign_category",
        "column_name": column,
        "title": (
            f"Add {target}: {len(categories)} HMRC tax categories across {covered} rows"
            if taxonomy == hmrc.TAXONOMY
            else f"Add {target}: {len(categories)} categories across {covered} rows"
        ),
        "rationale": rationale,
        "operation": {
            "op": "assign_category",
            "column": column,
            "target": target,
            "mapping": mapping,
            "fallback": "Uncategorised",
        },
        "evidence": {
            "categories": categories,
            "examples": examples,
            "distinct_values": len(counts),
            # The reviewer sees eight examples out of up to five hundred
            # mappings. These numbers are what tells them whether those eight
            # are representative -- and `singleton_categories` is where a wrong
            # assignment hides, so it is the first thing worth reading.
            "quality": quality,
            # The whole mapping, so a reviewer who wants to check the other
            # four hundred and ninety-two can, rather than being asked to trust
            # a sample.
            "mapping": {originals[key]: mapping[key] for key in mapping},
            "model_used": model_used,
            # Absent on the open-vocabulary path, so a reviewer can tell at a
            # glance whether the column they are approving is filing-ready or
            # somebody's ad-hoc grouping.
            **(
                {
                    "taxonomy": hmrc.TAXONOMY,
                    "boxes": hmrc.boxes_for(categories),
                    "matched_by_rule": len(rule_mapping),
                    "matched_by_model": len(mapping) - len(rule_mapping),
                    "model_error": llm_error,
                }
                if taxonomy == hmrc.TAXONOMY
                else {}
            ),
        },
        # Review, never Auto: a model's judgement about somebody else's books is
        # exactly the thing a person is here to check.
        "confidence": "medium",
        "affected_rows": covered,
    }

    count = context.supabase.rpc(
        "append_proposed_changes",
        {
            "p_dataset_version_id": version_id,
            "p_job_id": context.job_id,
            "p_proposals": [proposal],
        },
    )

    return {
        "dataset_version_id": version_id,
        "column": column,
        "target": target,
        "categories": categories,
        "distinct_values": len(counts),
        "categorised_values": len(mapping),
        "rows_covered": covered,
        "rows_uncovered": uncovered,
        "model_used": model_used,
        "taxonomy": taxonomy or None,
        "matched_by_rule": len(rule_mapping),
        "proposals": count,
    }



# -----------------------------------------------------------------------------
# categorise_statement -- the whole simple product, in one job
# -----------------------------------------------------------------------------


def _model_tail(
    context: JobContext, column: str, unmatched: list[str], hint: str | None
) -> tuple[dict[str, hmrc.Decision], str | None, str | None]:
    """
    Ask the model about the values no rule placed, and about nothing else.

    Three properties, and each one is a rule the brief is explicit about.

    It sees only the tail, so a statement full of familiar UK merchants costs
    one small call or none at all. It is constrained to the closed HMRC
    vocabulary, and `router.categorize_values` drops anything outside it. And
    whatever it returns comes back at medium confidence via
    `hmrc.decision_for_model_answer` -- it is answering precisely because the
    evidence was too thin for a rule, so it does not get to claim a certainty
    the rule could not.
    """
    if not unmatched or not context.llm.enabled:
        return {}, None, None

    mapping, _used, model, error = context.llm.categorize_values(
        column,
        unmatched,
        categories=list(hmrc.CATEGORY_NAMES),
        hint=f"{hmrc.MODEL_HINT} {hint}".strip() if hint else hmrc.MODEL_HINT,
    )
    if error:
        # Never fatal. The rules have already produced a real answer, and
        # throwing it away because a shared rate limit was busy would leave the
        # accountant with nothing rather than with most of their file.
        log.warning("job %s: model tail unavailable: %s", context.job_id, error)
        return {}, model, error

    return (
        {key: hmrc.decision_for_model_answer(category) for key, category in mapping.items()},
        model,
        None,
    )


def _official_guidance(context: JobContext, categories: set[str]) -> list[dict[str, Any]]:
    """
    Re-read the official guidance behind the tax-sensitive categories in a run.

    Off unless configured, and narrow when on: only the categories in
    `govuk.TAX_SENSITIVE` that this run actually used, never a page per
    transaction. What comes back is attached to the proposal as evidence and
    recorded in `hmrc_sources`, so the next run does not fetch it again.

    It cannot change a classification. A page that has moved raises a change
    report for a person; the rule that produced the category is unchanged until
    somebody changes it in code.
    """
    if not context.config.govuk.enabled:
        return []

    wanted = categories & set(govuk.TAX_SENSITIVE)
    if not wanted:
        return []

    checked_at = dt.datetime.now(dt.timezone.utc).isoformat()
    evidence: list[dict[str, Any]] = []

    try:
        with govuk.GovUKClient(context.config.govuk) as client:
            for source in client.check_topics(only=frozenset(wanted)):
                context.supabase.rpc(
                    "record_hmrc_source",
                    {
                        "p_content_path": source.content_path,
                        "p_url": source.url,
                        "p_title": source.title,
                        "p_summary": source.summary,
                        "p_public_updated_at": source.public_updated_at,
                        "p_body_hash": source.body_hash,
                        "p_categories": list(source.categories),
                    },
                )
                evidence.append(source.as_evidence(checked_at))
    except Exception as error:  # enrichment must never fail a customer run
        log.warning("job %s: official guidance unavailable: %s", context.job_id, error)

    return evidence


def handle_categorise_statement(context: JobContext) -> dict[str, Any]:
    """
    Upload to download, in one job.

    The question an accountant is asking is "is my file ready", and until now the
    product answered it in five parts: parse, profile, propose, approve, apply,
    export. Every seam between those was a place they had to know something --
    and one of them, the gap between approving a categorisation and applying it,
    is where a customer export came out with no category column in it at all.

    So this is one job, and it is finished when there is a validated file. What
    it does *not* do is skip the record. A proposal is still written with its
    full evidence, it is still approved before it is applied, and applying it
    still writes a new immutable version with a parent pointer. The approval is
    the agent own and is recorded as such -- `auto_approve_proposed_changes`
    writes a distinct audit action and leaves `decided_by` null, so nothing in
    the log can be mistaken for a decision a person made.

    The order is deliberate. The file is written, then *opened and checked*, and
    only then does the job succeed. "The model returned results" is not the same
    claim as "the accountant has a categorised file", and this is the only place
    the difference can be established.
    """
    version_id = context.job.get("dataset_version_id")
    if not version_id:
        raise JobError("this job has no dataset version attached")

    version = _load_version(context, version_id)

    context.heartbeat({"stage": "reading"})
    parquet_bytes = _load_parquet(context, version)
    _profile, table = _profile_from_parquet(
        parquet_bytes, _stored_interpretation(context, version)
    )

    rows = _rows_from_parquet(parquet_bytes)
    if not rows:
        raise JobError("there are no transactions in this file")

    # -- which column holds the merchant --------------------------------------
    context.heartbeat({"stage": "identifying"})
    requested = str(context.payload.get("column") or "").strip()
    column = requested or autopilot.choose_description_column(list(rows[0].keys()), rows)
    if not column:
        # Name what was actually found. The bare refusal read as a fault in the
        # product, and the two files it is said about need opposite responses
        # from the reader: one is a statement we failed to understand, the other
        # is a survey export that was never a statement at all. Listing the
        # columns is what lets them tell those apart at a glance, without
        # opening the file or filing a bug.
        visible = [name for name in rows[0] if not name.startswith("__")]
        shown = ", ".join(repr(name) for name in visible[:6])
        if len(visible) > 6:
            shown += f", and {len(visible) - 6} more"
        raise JobError(
            "We could not find a column of transaction descriptions in this file. "
            f"Its columns are: {shown}. "
            "If one of those is the merchant or payee, re-run the job naming it; "
            "otherwise this looks like a summary or a different kind of "
            "spreadsheet rather than a list of transactions."
        )
    if column not in rows[0]:
        raise JobError(f"there is no column called {column!r} in this file")

    # -- classify -------------------------------------------------------------
    counts: dict[str, int] = {}
    originals: dict[str, str] = {}
    for row in rows:
        text = normalize_text(row.get(column))
        if not text:
            continue
        key = text.lower()
        counts[key] = counts.get(key, 0) + 1
        originals.setdefault(key, text)

    if not counts:
        raise JobError(f"the {column!r} column is empty, so there is nothing to categorise")

    ordered = sorted(originals.values(), key=lambda text: -counts[text.lower()])

    context.heartbeat({"stage": "categorising", "values": len(ordered)})
    decisions, unmatched = hmrc.categorise_values(ordered)

    extra, model_used, model_error = _model_tail(
        context, column, unmatched, str(context.payload.get("hint") or "") or None
    )
    # Rules win on conflict. A rule is prose an accountant can read and argue
    # with; a model answer is not, and the one that can be checked is the one
    # that should stand.
    for key, decision in extra.items():
        decisions.setdefault(key, decision)

    # Everything still unplaced becomes an explicit "needs review" rather than a
    # blank. A gap that is visible gets looked at.
    for value in ordered:
        decisions.setdefault(normalize_text(value).lower(), hmrc.UNKNOWN)

    categories_used = {decision.category for decision in decisions.values()}
    sources = _official_guidance(context, categories_used)

    stats = hmrc.summarise(decisions.values())
    rows_flagged = sum(
        counts.get(key, 0) for key, decision in decisions.items() if decision.needs_review
    )

    # -- propose, then approve it as the agent --------------------------------
    context.heartbeat({"stage": "recording"})
    group_key = f"hmrc:{column}"
    proposal = _hmrc_proposal(
        column=column,
        group_key=group_key,
        decisions=decisions,
        originals=originals,
        counts=counts,
        rows_total=len(rows),
        rows_flagged=rows_flagged,
        stats=stats,
        model_used=model_used,
        model_error=model_error,
        sources=sources,
    )

    context.supabase.rpc(
        "append_proposed_changes",
        {
            "p_dataset_version_id": version_id,
            "p_job_id": context.job_id,
            "p_proposals": [proposal],
        },
    )
    context.supabase.rpc(
        "auto_approve_proposed_changes",
        {
            "p_dataset_version_id": version_id,
            "p_group_keys": [group_key],
            "p_note": (
                "Applied automatically by the HMRC categorisation agent. The classification "
                "adds columns beside the original data and changes no existing value; "
                f"{rows_flagged} row(s) are flagged for review."
            ),
        },
    )

    # -- apply into a new version ---------------------------------------------
    context.heartbeat({"stage": "applying"})
    result = apply_operations(table, [proposal["operation"]])

    new_parquet = to_parquet(result.columns, result.source_rows)
    parquet_object = context.supabase.upload(
        PARQUET_BUCKET,
        _parquet_path(
            context.job["org_id"], context.workspace_id, version["dataset_id"], context.job_id
        ),
        new_parquet,
        content_type="application/vnd.apache.parquet",
        upsert=True,
    )

    new_version = context.supabase.rpc(
        "record_dataset_version",
        {
            "p_dataset_id": version["dataset_id"],
            "p_kind": "cleaned",
            "p_parquet_path": parquet_object.path,
            "p_row_count": result.row_count,
            "p_column_hash": column_hash(result.columns),
            "p_parent_version_id": version_id,
            "p_produced_by_job": context.job_id,
            "p_created_by": context.requested_by(),
            "p_metadata": {
                "stage": "categorised",
                "taxonomy": hmrc.TAXONOMY,
                "source_column": column,
                "applied_groups": [group_key],
                "auto_applied": True,
                "rows_flagged": rows_flagged,
            },
        },
    )

    context.supabase.rpc(
        "mark_changes_applied",
        {"p_dataset_version_id": version_id, "p_group_keys": [group_key]},
    )

    # -- write the file the accountant opens ----------------------------------
    context.heartbeat({"stage": "preparing"})
    export_rows = _rows_from_parquet(new_parquet)

    dataset_rows = context.supabase.select(
        "datasets", columns="id,name", filters={"id": f"eq.{version['dataset_id']}"}, limit=1
    )
    dataset_name = dataset_rows[0]["name"] if dataset_rows else "Transactions"
    source_filename = _source_filename(context, version)

    workbook = report.rows_to_xlsx(export_rows, sheet_name=dataset_name)

    # -- and prove it is the right file before saying so ----------------------
    context.heartbeat({"stage": "validating"})
    try:
        check = autopilot.validate_export(
            workbook,
            expected_rows=result.row_count,
            source_column=column,
            source_values=[row.get(column) for row in export_rows],
        )
    except autopilot.ValidationError as error:
        # Deliberately not retryable: the same inputs produce the same file, and
        # three attempts only delay the message. The version stays -- it is
        # evidence of what happened -- but no download is offered.
        raise JobError(
            "We produced a file but it did not pass our own checks, so we have not offered "
            f"it for download. ({error})",
            retryable=False,
        ) from error

    period = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")
    export_object = context.supabase.upload(
        EXPORTS_BUCKET,
        (
            f"{context.job['org_id']}/{context.workspace_id}/{period}/"
            f"{version['dataset_id']}__v{new_version['version_no']}__categorised.xlsx"
        ),
        workbook,
        content_type=_EXPORT_CONTENT_TYPES["xlsx"],
        upsert=True,
    )

    return {
        # `export_path` and `bucket` are what /api/exports reads. Naming them the
        # same as export_dataset means the download route needs no special case
        # and no new trust in this job.
        "export_path": export_object.path,
        "bucket": EXPORTS_BUCKET,
        "format": "xlsx",
        "byte_size": export_object.size,
        "dataset_name": dataset_name,
        "source_filename": source_filename,
        "version_no": new_version["version_no"],
        "dataset_version_id": new_version["id"],
        "parent_version_id": version_id,
        "source_column": column,
        "taxonomy": hmrc.TAXONOMY,
        # The three numbers the result screen shows, computed from the file that
        # was actually written rather than from what we intended to write.
        "rows_total": check.rows,
        "rows_categorised": check.categorised,
        "rows_flagged": check.flagged,
        "categories": sorted(categories_used),
        "values_by_rule": stats["values_by_rule"],
        "values_by_model": stats["values_by_model"],
        "model_used": model_used,
        "official_sources": sources,
        "validated": True,
    }


def _hmrc_proposal(
    *,
    column: str,
    group_key: str,
    decisions: dict[str, hmrc.Decision],
    originals: dict[str, str],
    counts: dict[str, int],
    rows_total: int,
    rows_flagged: int,
    stats: dict[str, int],
    model_used: str | None,
    model_error: str | None,
    sources: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    The change, written down the way every other change in this product is.

    Medium confidence, never high: this is a judgement about somebody else books,
    and the tier is what keeps it out of any path that applies findings without a
    record. The operation carries the decisions verbatim, so what is applied is
    exactly what was proposed -- no re-derivation, and no second call to a model
    at apply time.
    """
    examples = [
        {
            "value": originals[key],
            "category": decision.category,
            "box": decision.box,
            "confidence": decision.confidence,
            "evidence": decision.evidence,
            "rows": counts.get(key, 0),
        }
        for key, decision in sorted(
            decisions.items(), key=lambda item: -counts.get(item[0], 0)
        )[:10]
    ]

    categories = sorted({decision.category for decision in decisions.values()})

    rationale = (
        f"{len(decisions)} distinct value(s) in {column!r} were sorted into "
        f"{len(categories)} HMRC categor{'y' if len(categories) == 1 else 'ies'} across "
        f"{rows_total} row(s). {stats['values_by_rule']} were matched by UK tax rules"
        + (f" and {stats['values_by_model']} by the model" if stats["values_by_model"] else "")
        + f". Adds {', '.join(hmrc.OUTPUT_COLUMNS)} beside the original data and changes "
        f"nothing that was already there."
    )
    if rows_flagged:
        rationale += (
            f" {rows_flagged} row(s) are flagged for review: the description does not "
            f"establish a business purpose, so no deduction is claimed for them."
        )
    if model_error:
        rationale += " Some values could not be sent to the model and were left for review."
    if sources:
        rationale += (
            f" Current GOV.UK guidance was checked for "
            f"{len(sources)} topic{'' if len(sources) == 1 else 's'}."
        )

    return {
        "group_key": group_key,
        "step_type": "assign_hmrc_categories",
        "column_name": column,
        "title": (
            f"HMRC categories for {rows_total} transactions "
            f"({len(categories)} categories, {rows_flagged} to review)"
        ),
        "rationale": rationale,
        "operation": {
            "op": "assign_hmrc_categories",
            "column": column,
            "targets": list(hmrc.OUTPUT_COLUMNS),
            "decisions": {key: decision.to_row() for key, decision in decisions.items()},
            "fallback": hmrc.UNKNOWN.to_row(),
        },
        "evidence": {
            "taxonomy": hmrc.TAXONOMY,
            "categories": categories,
            "boxes": hmrc.boxes_for(categories),
            "examples": examples,
            "quality": stats,
            "rows_flagged": rows_flagged,
            "model_used": model_used,
            "model_error": model_error,
            # Official guidance consulted for this run, if any. Title, URL and
            # date -- never an extract of the page.
            "official_sources": sources,
            # Why each value went where it went. This is what makes the column
            # auditable at all: eight examples are a sample, and the reviewer who
            # wants to check the other four hundred can.
            "reasoning": {
                key: {
                    "category": decision.category,
                    "box": decision.box,
                    "confidence": decision.confidence,
                    "evidence": decision.evidence,
                    "source": decision.source,
                    "coa": decision.coa,
                }
                for key, decision in decisions.items()
            },
        },
        "confidence": "medium",
        "affected_rows": rows_total,
    }


# -----------------------------------------------------------------------------
# hmrc_knowledge_check
# -----------------------------------------------------------------------------


def handle_hmrc_knowledge_check(context: JobContext) -> dict[str, Any]:
    """
    Re-read official guidance and report what moved. Nothing else.

    There is deliberately no code path from this job to a categorisation rule.
    It reads GOV.UK, records what it saw, and where a page it had seen before has
    changed it writes a change report for a person -- what changed, the source,
    the date, the categories that might be affected, and what to do about it.

    That restraint is the design, not a limitation of it. A government website is
    edited continuously, and a system that reclassified historical accounts
    because a paragraph moved would be unauditable: last month return would stop
    agreeing with itself and nobody could say why. The route from a detected
    change to a production rule runs through a person, a code change and a test,
    and it is documented in docs/HMRC_KNOWLEDGE_MONITOR.md.
    """
    if not context.config.govuk.enabled:
        raise JobError(
            "Checking official guidance is switched off on this agent. Set "
            "HERMES_GOVUK_ENABLED to turn it on."
        )

    context.heartbeat({"stage": "checking"})
    checked = 0
    changed: list[dict[str, Any]] = []

    with govuk.GovUKClient(context.config.govuk) as client:
        for source in client.check_topics():
            checked += 1
            outcome = context.supabase.rpc(
                "record_hmrc_source",
                {
                    "p_content_path": source.content_path,
                    "p_url": source.url,
                    "p_title": source.title,
                    "p_summary": source.summary,
                    "p_public_updated_at": source.public_updated_at,
                    "p_body_hash": source.body_hash,
                    "p_categories": list(source.categories),
                },
            )
            if isinstance(outcome, dict) and outcome.get("changed"):
                changed.append(
                    {
                        "title": source.title,
                        "url": source.url,
                        "published": source.public_updated_at,
                        "categories": list(source.categories),
                        "change_report_id": outcome.get("change_report_id"),
                    }
                )

    return {
        "sources_checked": checked,
        "changes_detected": len(changed),
        "reports": changed,
        # Said in the result so it is visible to anyone reading the job row: this
        # job never touches the rules.
        "rules_changed": 0,
        "note": (
            "Change reports are for human review. Categorisation rules are only ever "
            "changed in code, with a test, through review."
        ),
    }

HANDLERS: dict[str, Callable[[JobContext], dict[str, Any]]] = {
    "parse_workbook": handle_parse_workbook,
    "profile_dataset": handle_profile_dataset,
    "propose_cleaning": handle_propose_cleaning,
    "apply_cleaning": handle_apply_cleaning,
    "replay_recipe": handle_replay_recipe,
    "query_dataset": handle_query_dataset,
    "reconcile_sources": handle_reconcile_sources,
    "generate_report": handle_generate_report,
    "export_dataset": handle_export_dataset,
    "categorize_dataset": handle_categorize_dataset,
    "categorise_statement": handle_categorise_statement,
    "hmrc_knowledge_check": handle_hmrc_knowledge_check,
}


# Registered here rather than in the literal above only because `hermes.bridge`
# imports this module's helpers, so it cannot be imported before the table
# exists. The types both modules share live in `job_types.py`, which is what
# keeps this a one-line ordering detail rather than an import cycle.
from .bridge import handle_kanban_report  # noqa: E402

HANDLERS["kanban_report"] = handle_kanban_report


__all__ = ["HANDLERS", "JobContext", "JobDeferred", "JobError"]
