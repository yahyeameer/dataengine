"""
The bridge between a customer's job and the internal Kanban chain.

    agent_jobs -> worker claims -> cards created -> supervisor/analyst/reporter
              -> verifier -> worker validates -> agent_jobs -> dashboard

One function, `handle_kanban_report`, and it is a *resumable state machine*
rather than a procedure. Every claim of the job runs exactly one step and then
either finishes the job or hands it back with `defer_agent_job`. That shape is
not an optimisation; it is what makes the rest of the guarantees possible:

  * A chain is minutes long and a blocked card is hours long. A handler that
    looped until the board was done would hold the deployment's single worker
    for that whole time, so one customer's report would stop every other
    customer's parse.
  * A worker that dies mid-chain loses nothing. The next claim reads the same
    `kanban_runs` row and carries on from whatever phase it reached.
  * "Restart-safe" and "retry-safe" stop being separate problems. A restart is
    just another claim, and so is a retry.

## What is trusted, and by whom

Kanban holds no Supabase credentials, no `org_id` and no notion of a customer.
It is handed two things: a time-limited URL to one input object, and a
time-limited URL that writes to one path. Both are minted here, by the process
that already proved the job's tenancy by claiming its row.

Coming back the other way, nothing the board says is believed on its own word:

  * the correlation token on the returning metadata must equal the one this
    database issued for this job,
  * the artefact path must equal the path this worker chose -- not a path the
    board proposes,
  * the object must actually exist at that path and be readable, and
  * the verdict must be an explicit PASS.

A card in `done` is a statement about a *card*, not about a business result. The
verifier protocol makes FAIL block rather than complete precisely because a
completed card is how the board says "fine", and a failed check wearing that
badge is the defect this whole path is shaped to avoid.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import logging
import re
from typing import Any

from .job_types import JobContext, JobDeferred, JobError
from .kanban import (
    CardSpec,
    KanbanClient,
    KanbanError,
    KanbanTask,
    KanbanUnavailable,
    runner_for,
)

log = logging.getLogger("hermes.bridge")

EXPORTS_BUCKET = "exports"

# The order is the chain. Each card is the child of the one before it, so the
# board runs them one at a time -- which is also all `max_in_progress: 1` would
# allow, and stating it in the DAG means the ordering does not depend on that
# setting staying where it is.
ROLES = ("supervisor", "analyst", "reporter", "verifier")

TERMINAL_PHASES = frozenset({"completed", "failed", "cancelled", "timeout"})

# The prefix a verifier puts on a blocking reason when the *business* result
# failed, as opposed to the card being unable to proceed. Getting this
# distinction wrong in either direction is expensive: treat every block as a
# failure and a missing input becomes a lost job; treat every block as
# recoverable and a detected corruption waits politely for an operator who has
# no idea anything is wrong.
FAIL_PREFIX = "VERDICT=FAIL:"

_MARKER = re.compile(r"\[de:([0-9a-f]{16})\]")
_ROLE_IN_TITLE = re.compile(r"\[role:([a-z]+)\]")


# -----------------------------------------------------------------------------
# The handler
# -----------------------------------------------------------------------------


def handle_kanban_report(context: JobContext) -> dict[str, Any]:
    settings = context.config.kanban

    if not settings.enabled:
        # Reachable only if a worker announced the capability and the flag was
        # then turned off under it. Refuse loudly rather than half-running.
        raise JobError(
            "The multi-agent report path is not enabled on this agent host.",
            retryable=False,
        )

    client = KanbanClient(
        command=settings.command,
        board=settings.board,
        timeout_seconds=settings.timeout_seconds,
        runner=runner_for(settings),
    )

    run = _start_run(context)

    # A run that already reached a terminal phase means the job was re-claimed
    # after the chain was decided -- a lease that lapsed in the window between
    # `kanban_run_advance` and `finish_agent_job`. Replay the decision rather
    # than re-running the chain: the board has moved on, and asking it again
    # would either duplicate the work or read a card somebody has since tidied.
    if run["phase"] in TERMINAL_PHASES:
        return _replay_decision(run)

    if _deadline_exceeded(context, run):
        return _time_out(context, client, run, blocked_reason=run.get("blocked_reason") or "")

    if not run.get("root_task_id"):
        return _orchestrate(context, client, run)

    return _poll(context, client, run)


# -----------------------------------------------------------------------------
# Phase 1: create the chain, or adopt the one a previous attempt left behind
# -----------------------------------------------------------------------------


def _orchestrate(
    context: JobContext, client: KanbanClient, run: dict[str, Any]
) -> dict[str, Any]:
    """
    Create the chain -- and creating it twice is the same as creating it once.

    The first draft of this searched the board for its own correlation token
    before creating anything, to close the window where cards exist and the
    database has not heard about them. The CLI turns out to close it properly:
    `create --idempotency-key` returns the existing task's id if a non-archived
    task already carries that key, and does not overwrite it. Verified against
    the live board on 2026-08-31 -- a repeat create returned the same id and
    left the original body alone.

    So the recovery path and the happy path are the same code. A worker that
    died after creating two cards runs the same four creates on its next claim,
    gets the two that exist back unchanged, and creates the two that do not.
    """
    context.heartbeat({"stage": "orchestrating"})

    settings = context.config.kanban
    brief = _build_brief(context, run)
    specs = _card_specs(context, run, brief)

    try:
        created = client.create_chain(
            specs,
            tenant=run["kanban_tenant"],
            created_by=context.config.worker_id,
            max_runtime=settings.card_max_runtime,
        )
    except KanbanUnavailable as error:
        # Some cards may already exist. That is safe: the idempotency keys mean
        # the retry converges on them rather than duplicating them.
        raise JobDeferred(
            delay_seconds=settings.poll_seconds,
            progress={"stage": "orchestrating", "note": "the board is not answering"},
            reason=str(error),
        ) from error
    except KanbanError as error:
        return _fail(
            context, client, run,
            f"The internal board refused to create this job's tasks. {error}",
        )

    verifier = next((task for task in created if _role_of(task.title) == "verifier"), None)

    run = _one(
        context.supabase.rpc(
            "kanban_run_record_tasks",
            {
                "p_job_id": context.job_id,
                "p_worker_id": context.config.worker_id,
                "p_correlation_id": run["correlation_id"],
                "p_root_task_id": created[0].id,
                "p_verifier_task_id": verifier.id if verifier else None,
                "p_task_ids": [task.id for task in created],
            },
        )
    )

    log.info(
        "job %s: kanban chain %s dispatched on board %s",
        context.job_id, " -> ".join(task.id for task in created), settings.board,
    )

    raise JobDeferred(
        delay_seconds=settings.poll_seconds,
        progress=_progress(run, "orchestrating", tasks=len(created)),
        reason="chain dispatched",
    )


# -----------------------------------------------------------------------------
# Phase 2: watch it
# -----------------------------------------------------------------------------


def _poll(
    context: JobContext, client: KanbanClient, run: dict[str, Any]
) -> dict[str, Any]:
    settings = context.config.kanban
    task_ids = list(run.get("task_ids") or [])
    verifier_id = run.get("verifier_task_id")

    try:
        tasks = _read_tasks(client, run, task_ids)
    except KanbanUnavailable as error:
        # The board is briefly unreachable. That is not the customer's job
        # failing; it is a reason to look again shortly.
        raise JobDeferred(
            delay_seconds=settings.poll_seconds,
            progress=_progress(run, run["phase"], note="the board is not answering"),
            reason=str(error),
        ) from error
    except KanbanError as error:
        return _fail(context, client, run, f"Could not read the internal board. {error}")

    by_id = {task.id: task for task in tasks}
    verifier = by_id.get(verifier_id) if verifier_id else None

    # -- a card is blocked -----------------------------------------------------
    #
    # Checked before "the verifier is done", because a blocked card upstream is
    # why the verifier will never be done.
    blocked = [task for task in tasks if task.is_blocked]
    if blocked:
        return _handle_block(context, client, run, blocked[0])

    # -- a card was retired ----------------------------------------------------
    #
    # The board has no `failed` or `gave_up` status -- a card that trips the
    # failure breaker is blocked, and that is handled above. `archived` is the
    # one way a card in flight disappears, and it means a person retired it. The
    # chain cannot finish, and polling until the deadline would hide that.
    retired = [task for task in tasks if task.is_retired]
    if retired:
        return _fail(
            context, client, run,
            f"An internal step ({_role_of(retired[0].title) or retired[0].id}) was "
            f"retired before it produced a result.",
        )

    # -- the verifier finished -------------------------------------------------
    if verifier is not None and verifier.is_done:
        return _accept(context, client, run, verifier.id)

    if verifier is None and tasks and all(task.is_done for task in tasks):
        # Every card done and no verifier recorded. Refuse: a chain without a
        # verification is exactly the thing this path exists not to ship.
        return _fail(
            context, client, run,
            "The internal chain finished with no verification step. Nothing was accepted.",
        )

    # -- still working ---------------------------------------------------------
    phase = "verifying" if verifier is not None and verifier.is_active else "running"
    done = sum(1 for task in tasks if task.is_done)

    run = _advance(context, run, phase)
    raise JobDeferred(
        delay_seconds=settings.poll_seconds,
        progress=_progress(run, phase, tasks=len(tasks), done=done),
        reason=f"{done}/{len(tasks)} cards done",
    )


def _read_tasks(
    client: KanbanClient, run: dict[str, Any], task_ids: list[str]
) -> list[KanbanTask]:
    """
    The status of every card in this run, in one call.

    `--tenant` is a real filter on the board, so a job's namespace returns
    exactly its own cards even though the board is shared with operator work.
    That is also what makes the per-job isolation checkable rather than merely
    intended.

    Falling back to reading each recorded id keeps the bridge working if the
    listing is ever unavailable, at the cost of one call per card.
    """
    tasks = client.tasks_for_tenant(run["kanban_tenant"])
    if tasks:
        return _order_by_role(tasks)
    return [client.task(task_id) for task_id in task_ids]


# -----------------------------------------------------------------------------
# Outcomes
# -----------------------------------------------------------------------------


def _handle_block(
    context: JobContext, client: KanbanClient, run: dict[str, Any], task: KanbanTask
) -> dict[str, Any]:
    """
    A blocked card is two different events wearing one status.

    `VERDICT=FAIL:` means a check ran and the answer was no. That is a finished
    piece of work with a negative result, and the customer should be told now --
    re-running it against the same artefact produces the same sentence.

    Any other reason means the card cannot proceed: a missing input, an
    ambiguity a person has to settle. The job stays alive and keeps looking,
    because `hermes kanban unblock` is a real recovery and the run resumes
    cleanly from it -- measured on 2026-08-31, where a re-dispatched card
    measured the supplied file correctly with no carry-over from its first
    attempt.
    """
    try:
        reason = client.block_reason(task.id).strip()
    except KanbanError:
        reason = ""

    if reason.startswith(FAIL_PREFIX):
        detail = reason[len(FAIL_PREFIX):].strip() or "no detail was recorded"
        _advance(context, run, "failed", verdict="FAIL", error=reason)
        log.warning("job %s: verifier returned FAIL: %s", context.job_id, detail)
        raise JobError(
            f"The internal verification of this report failed: {detail} "
            f"Nothing was published.",
            retryable=False,
        )

    settings = context.config.kanban

    run = _advance(context, run, "blocked", blocked_reason=reason or "no reason recorded")
    raise JobDeferred(
        delay_seconds=settings.blocked_poll_seconds,
        progress=_progress(run, "blocked", note=reason[:200] or "waiting for input"),
        reason=f"card {task.id} is blocked",
    )


def _accept(
    context: JobContext, client: KanbanClient, run: dict[str, Any], verifier_id: str
) -> dict[str, Any]:
    """
    The verifier's card is `done`. That is where the checking starts, not ends.
    """
    context.heartbeat({"stage": "verifying"})

    try:
        metadata = client.latest_metadata(verifier_id)
    except KanbanError as error:
        return _fail(context, client, run, f"Could not read the verification result. {error}")

    verdict = str(metadata.get("verdict") or "").strip().upper()

    if verdict != "PASS":
        # `done` on its own is not a pass. This is the exact defect observed on
        # 2026-08-31: a verifier detected a corrupted figure, recorded
        # verdict=FAIL and then completed the card anyway. On the board it was
        # indistinguishable from a success. The worker refuses to make that
        # mistake a second time on the customer's behalf.
        _advance(
            context, run, "failed",
            verdict="FAIL" if verdict == "FAIL" else None,
            error=f"verifier completed with verdict {verdict or 'none'}",
        )
        if verdict == "FAIL":
            raise JobError(
                "The internal verification of this report failed. Nothing was published.",
                retryable=False,
            )
        raise JobError(
            "The internal verification finished without recording a verdict, so the "
            "report was not accepted.",
            retryable=False,
        )

    ownership = _check_ownership(context, run, metadata)
    if ownership:
        return _fail(context, client, run, ownership)

    artifact = metadata.get("artifact")
    if not isinstance(artifact, dict):
        return _fail(
            context, client, run,
            "The internal chain reported a pass but attached no artefact.",
        )

    expected = _artifact_path(context, run)
    claimed = str(artifact.get("path") or "")
    bucket = str(artifact.get("bucket") or EXPORTS_BUCKET)

    if claimed != expected or bucket != EXPORTS_BUCKET:
        # Rule 10, enforced by comparison rather than by trust. The path was
        # chosen here and handed out as a single signed URL; anything else
        # arriving in its place is either a bug or an attempt to have this
        # worker publish an object it never authorised.
        log.error(
            "job %s: artefact ownership mismatch -- expected %s/%s, got %s/%s",
            context.job_id, EXPORTS_BUCKET, expected, bucket, claimed,
        )
        return _fail(
            context, client, run,
            "The artefact returned by the internal chain does not belong to this job. "
            "It was rejected and nothing was published.",
        )

    try:
        body = context.supabase.download(
            EXPORTS_BUCKET, expected, context.config.max_download_bytes
        )
    except Exception as error:  # noqa: BLE001 - any failure here means no artefact
        log.warning("job %s: artefact %s unreadable: %s", context.job_id, expected, error)
        return _fail(
            context, client, run,
            "The internal chain reported a finished report, but the file it named is "
            "not in storage.",
        )

    if not body:
        return _fail(context, client, run, "The report the internal chain produced is empty.")

    digest = hashlib.sha256(body).hexdigest()
    claimed_digest = str(artifact.get("sha256") or "").strip().lower()
    if claimed_digest and claimed_digest != digest:
        return _fail(
            context, client, run,
            "The report in storage does not match what the internal chain verified.",
        )

    result = {
        "report_path": expected,
        "bucket": EXPORTS_BUCKET,
        "byte_size": len(body),
        "sha256": digest,
        "dataset_name": _dataset_name(context, run),
        "verdict": "PASS",
        "checks": metadata.get("checks"),
        "summary": metadata.get("summary") or metadata.get("headline"),
        "kanban": {
            "board": run["board"],
            "root_task_id": run.get("root_task_id"),
            "verifier_task_id": verifier_id,
            "task_ids": list(run.get("task_ids") or []),
            "polls": run.get("polls"),
        },
    }

    _advance(context, run, "completed", verdict="PASS", result=result)
    log.info("job %s: kanban chain verified PASS, %s bytes", context.job_id, len(body))
    return result


def _check_ownership(
    context: JobContext, run: dict[str, Any], metadata: dict[str, Any]
) -> str | None:
    """
    Does this result belong to this job? Returns a message if not.

    Two independent identifiers, because they fail differently. The correlation
    token catches a result from another run of the same shape; the job id
    catches a card body that was copied and edited. Neither is guessable from
    the board, and the board is never asked to prove anything about tenancy --
    it is only asked to echo back what it was given.
    """
    seen_correlation = str(metadata.get("correlation_id") or "")
    if seen_correlation != run["correlation_id"]:
        log.error(
            "job %s: correlation mismatch on the returned result (%s...)",
            context.job_id, seen_correlation[:8] or "absent",
        )
        return (
            "The result returned by the internal chain could not be matched to this "
            "request, so it was rejected."
        )

    seen_job = str(metadata.get("job_id") or "")
    if seen_job != str(context.job_id):
        log.error("job %s: result names job %s", context.job_id, seen_job or "nothing")
        return (
            "The result returned by the internal chain names a different job, so it "
            "was rejected."
        )

    return None


def _fail(
    context: JobContext, client: KanbanClient, run: dict[str, Any], message: str
) -> dict[str, Any]:
    """Record the failure on the run, stop the chain, and tell the customer."""
    _advance(context, run, "failed", error=message)
    _stop_chain(client, run, "the customer job this chain served has failed")
    raise JobError(message, retryable=False)


def _time_out(
    context: JobContext,
    client: KanbanClient,
    run: dict[str, Any],
    blocked_reason: str = "",
) -> dict[str, Any]:
    waited = _minutes_since(run["created_at"])
    _advance(context, run, "timeout", error=f"deadline exceeded after {waited} minutes")
    _stop_chain(client, run, "the customer job this chain served has timed out")

    if blocked_reason:
        raise JobError(
            f"This report needed something it did not have and nobody supplied it: "
            f"{blocked_reason[:200]} It was stopped after {waited} minutes.",
            retryable=False,
        )
    raise JobError(
        f"The internal analysis did not finish within {waited} minutes and was stopped.",
        retryable=False,
    )


def _stop_chain(client: KanbanClient, run: dict[str, Any], reason: str) -> None:
    """
    Best effort, and never fatal.

    A chain left running against a decided job spends the host's only core on a
    result nobody will read. But the job has already been decided by the time
    this runs, so a board that will not answer must not turn a clean failure
    into an exception.
    """
    for task_id in run.get("task_ids") or []:
        client.block(task_id, reason)


# -----------------------------------------------------------------------------
# The card bodies -- the contract Kanban actually receives
# -----------------------------------------------------------------------------


def _build_brief(context: JobContext, run: dict[str, Any]) -> dict[str, Any]:
    """
    Everything the chain is given, assembled once.

    Note what is *not* here: no Supabase URL, no key, no org id, no workspace
    id, no dataset id. The chain gets one link it may read, one link it may
    write, the shape of the data and the tokens it must echo back. Tenancy was
    settled before this function ran and is not a thing the board is asked to
    reason about.
    """
    version_id = context.job.get("dataset_version_id") or context.payload.get("dataset_version_id")
    if not version_id:
        raise JobError(
            "This report needs a dataset version to work from, and none was given.",
            retryable=False,
        )

    # Read directly rather than through jobs._load_version: `jobs` imports this
    # module to register the handler, so borrowing a helper back off it would be
    # a cycle -- and this select wants its own wording anyway, because "run the
    # parser first" is the wrong advice for a report the customer just asked for.
    rows = context.supabase.select(
        "dataset_versions",
        columns="id,dataset_id,version_no,kind,parquet_path,row_count",
        filters={"id": f"eq.{version_id}"},
        limit=1,
    )
    if not rows:
        raise JobError(
            "The dataset version this report was asked for no longer exists.",
            retryable=False,
        )
    version = rows[0]
    parquet_path = version.get("parquet_path")
    if not parquet_path:
        raise JobError(
            "That dataset version has not been written to storage yet, so there is "
            "nothing to analyse.",
            retryable=False,
        )

    settings = context.config.kanban
    input_url = context.supabase.create_signed_download_url(
        "parquet", str(parquet_path), settings.input_url_ttl_seconds
    )
    artifact_path = _artifact_path(context, run)
    upload_url = context.supabase.create_signed_upload_url(EXPORTS_BUCKET, artifact_path)

    return {
        "job_id": str(context.job_id),
        "correlation_id": run["correlation_id"],
        "dataset_name": _dataset_name(context, run, version=version),
        "version_no": version.get("version_no"),
        "row_count": version.get("row_count"),
        "question": str(context.payload.get("question") or "").strip(),
        "period": str(context.payload.get("period") or "").strip(),
        "input_url": input_url,
        "input_format": "parquet",
        "upload_url": upload_url,
        "artifact_path": artifact_path,
        "artifact_bucket": EXPORTS_BUCKET,
    }


_COMMON_RULES = """\
## Rules for every card in this chain

- The payload in this card body is the only source of truth. Do not go looking
  for context on disk; `/opt/data` holds a checkout of an abandoned predecessor
  of this project that shares its whole vocabulary, and it describes a contract
  that does not exist.
- You have no database access and need none. There is one URL you may read and
  one you may write. Do not attempt to reach Supabase, and do not ask for
  credentials -- there are none to give.
- Hand off with `kanban_complete(summary=..., metadata=...)`. The payload lives
  on the **run**, not the task row, which is where the next card will read it.
- If you cannot proceed, call `kanban_block` with a precise reason. Do not
  invent figures to get past a missing input; a blocked card with a real reason
  is a correct outcome and somebody can fix it in a minute.
- Echo `job_id` and `correlation_id` unchanged in every handoff. They are how
  the result gets back to the customer who asked for it.

    job_id:         {job_id}
    correlation_id: {correlation_id}
"""

_SUPERVISOR_BODY = """\
You are the supervisor for one customer report. Nothing has been analysed yet.

## The request

    dataset:   {dataset_name} (version {version_no}, {row_count} rows)
    period:    {period_text}
    question:  {question_text}

## What to do

Do not analyse anything and do not open the data. Write the acceptance criteria
the analyst and the reporter will be held to, and the verifier will check
against: the specific figures this report must contain, and what would make each
one wrong.

Three to six criteria. Each one has to be checkable by re-deriving a number, not
by reading prose.

`kanban_complete(summary=..., metadata={{"job_id":"{job_id}",
"correlation_id":"{correlation_id}", "criteria":[...]}})`

""" + _COMMON_RULES

_ANALYST_BODY = """\
You are the analyst. The supervisor's criteria are on its run -- call
`kanban_show` and read the parent handoff before anything else.

## The data

One file, one link, valid for this run only:

    {input_url}

It is Parquet: {row_count} rows, dataset "{dataset_name}", version {version_no}.
Download it and measure it with code -- write and run a script. Do not estimate
from a sample and do not re-derive by hand.

## What to produce

Every figure the supervisor's criteria name, with the method used for each one,
so the verifier can re-derive them independently.

`kanban_complete(summary=..., metadata={{"job_id":"{job_id}",
"correlation_id":"{correlation_id}", "figures":{{...}}, "method":{{...}},
"row_count":<measured>}})`

If the link does not resolve or the file is not what this card says it is, block
with that as the reason. Do not substitute anything.

""" + _COMMON_RULES

_REPORTER_BODY = """\
You are the reporter. Read the analyst's handoff on its **run**, not its task
row.

Write the report as Markdown. Every figure comes from the analyst's handoff --
you do not recompute and you do not add figures nobody measured. Say plainly
where each number came from.

## Publishing it

Upload the finished Markdown to this URL, which writes to exactly one path and
nowhere else:

    PUT {upload_url}
        Content-Type: text/markdown

Then record what you wrote, including the SHA-256 of the exact bytes you sent:

`kanban_complete(summary=..., metadata={{"job_id":"{job_id}",
"correlation_id":"{correlation_id}",
"artifact":{{"bucket":"{artifact_bucket}","path":"{artifact_path}",
"sha256":"<hex>","bytes":<n>}}, "figures":{{...}}}})`

The path is fixed. Do not change it, and do not report a different one -- the
worker compares what you report against what it issued and rejects anything
else, so a "corrected" path loses the report entirely.

""" + _COMMON_RULES

_VERIFIER_BODY = """\
You are the verifier for this chain. Call `kanban_show` first and read every
parent handoff -- they are on the parents' **runs**, not their task rows.

## What to check

1. Every criterion the supervisor set.
2. Every figure the reporter published, re-derived by you from the source at
   {input_url} -- not by comparing two downstream copies of the same number,
   which cannot detect a shared error.
3. That the reporter published to exactly {artifact_path} and recorded a
   SHA-256 and a byte count for what it sent.

   You cannot re-download it: the exports bucket is private and you hold no
   credentials for it. Do not report that as a failure and do not invent a way
   around it -- the worker re-reads those bytes from storage with its own
   credentials and rejects the result if the digest disagrees. Check that the
   path matches this card exactly and that the reporter's upload succeeded;
   the bytes are somebody else's job.

## PROTOCOL -- how to report

**PASS** -- every check agrees:

    kanban_complete(
      summary="...",
      metadata={{"verdict":"PASS",
                "job_id":"{job_id}",
                "correlation_id":"{correlation_id}",
                "artifact":{{"bucket":"{artifact_bucket}","path":"{artifact_path}",
                           "sha256":"<hex>","bytes":<n>}},
                "checks":{{...}},
                "discrepancies":[]}}
    )

The `job_id`, `correlation_id` and `artifact` fields are not optional. A PASS
without them is rejected by the worker and the customer gets nothing, because
there is no other way to prove this result belongs to the request that started
it.

**FAIL** -- anything disagrees. Two calls, in this order:

    kanban_comment(body='{{"verdict":"FAIL","checks":{{...}},"discrepancies":[...]}}')

    kanban_block(
      reason="VERDICT=FAIL: <one line naming the figure and the two values>",
      kind="needs_input"
    )

The comment first, because `kanban_block` takes only `task_id`, `reason` and
`kind` -- it has no `metadata` parameter, so a block silently drops structured
detail. The `VERDICT=FAIL:` prefix on the reason is the only machine-readable
carrier of the verdict, and the worker matches on it exactly.

**Do not call `kanban_complete` for a FAIL.** A completed card is `done`, and a
`done` card is how the board says this went fine. A FAIL that completes is a
failed verification wearing a success badge.

**Do not call `kanban_request_changes`.** It resets this card to `ready` and the
dispatcher re-runs it against the same unchanged artefact until the recurrence
limit trips.

Detecting a discrepancy is a **correct outcome**. Report it precisely and block.

""" + _COMMON_RULES


def _card_specs(
    context: JobContext, run: dict[str, Any], brief: dict[str, Any]
) -> list[CardSpec]:
    settings = context.config.kanban
    marker = _marker(run["correlation_id"])

    fields = dict(brief)
    fields["period_text"] = brief["period"] or "not specified"
    fields["question_text"] = brief["question"] or "a standard period report"

    bodies = {
        "supervisor": _SUPERVISOR_BODY,
        "analyst": _ANALYST_BODY,
        "reporter": _REPORTER_BODY,
        "verifier": _VERIFIER_BODY,
    }
    profiles = {
        "supervisor": settings.supervisor_profile,
        "analyst": settings.analyst_profile,
        "reporter": settings.reporter_profile,
        "verifier": settings.verifier_profile,
    }

    specs: list[CardSpec] = []
    for index, role in enumerate(ROLES, start=1):
        specs.append(
            CardSpec(
                key=role,
                # Stable for the life of the run and unique to it, so creating
                # this card twice is creating it once. The correlation token is
                # already the thing that identifies the run; pairing it with the
                # role identifies the card.
                idempotency_key=f"{run['correlation_id']}:{role}",
                # No customer data in a title. The board is shared with operator
                # work and titles are the one thing every listing prints, so the
                # dataset's name stays in the body where the signed URL already
                # is.
                title=f"{marker}[role:{role}] {index}/{len(ROLES)} {role}",
                body=bodies[role].format(**fields),
                assignee=profiles[role],
            )
        )
    return specs


# -----------------------------------------------------------------------------
# Small helpers
# -----------------------------------------------------------------------------


def _start_run(context: JobContext) -> dict[str, Any]:
    settings = context.config.kanban
    run = context.supabase.rpc(
        "kanban_run_start",
        {
            "p_job_id": context.job_id,
            "p_worker_id": context.config.worker_id,
            "p_board": settings.board,
            "p_deadline_seconds": settings.deadline_seconds,
        },
    )
    run = _one(run)
    if not run:
        raise JobError("Could not open an internal run for this job.", retryable=True)
    return run


def _advance(
    context: JobContext,
    run: dict[str, Any],
    phase: str,
    verdict: str | None = None,
    blocked_reason: str | None = None,
    error: str | None = None,
    result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    updated = context.supabase.rpc(
        "kanban_run_advance",
        {
            "p_job_id": context.job_id,
            "p_worker_id": context.config.worker_id,
            "p_correlation_id": run["correlation_id"],
            "p_phase": phase,
            "p_verdict": verdict,
            "p_blocked_reason": blocked_reason,
            "p_error": error,
            "p_result": result,
        },
    )
    return _one(updated) or run


def _replay_decision(run: dict[str, Any]) -> dict[str, Any]:
    if run["phase"] == "completed" and isinstance(run.get("result"), dict):
        return run["result"]
    raise JobError(
        run.get("error")
        or "The internal analysis for this job has already finished without a result.",
        retryable=False,
    )


def _progress(
    run: dict[str, Any],
    phase: str,
    tasks: int | None = None,
    done: int | None = None,
    note: str = "",
) -> dict[str, Any]:
    # `stage` is what the dashboard renders verbatim, so the bridge's phase name
    # is chosen to read correctly to an accountant as well as to an operator.
    progress: dict[str, Any] = {"stage": phase, "kanban": {"phase": phase}}
    if tasks is not None:
        progress["kanban"]["tasks"] = tasks
    if done is not None:
        progress["kanban"]["done"] = done
    if note:
        progress["kanban"]["note"] = note[:300]
    if run.get("root_task_id"):
        progress["kanban"]["root_task_id"] = run["root_task_id"]
    return progress


def _marker(correlation_id: str) -> str:
    """
    The half of the correlation token that travels in a card title.

    Sixteen hex characters -- 64 bits -- is far more than enough to be unique on
    a board that holds tens of cards, and keeping the other half out of the
    titles means a screenshot of the board does not carry the whole token.
    """
    return f"[de:{correlation_id[:16]}]"


def _role_of(title: str) -> str:
    match = _ROLE_IN_TITLE.search(title or "")
    return match.group(1) if match else ""


def _order_by_role(tasks: list[KanbanTask]) -> list[KanbanTask]:
    """
    The chain in its declared order, ignoring anything that is not part of it.

    A partial chain -- created two cards, then the connection dropped -- comes
    back as a prefix, which is what lets `_orchestrate` continue from where it
    stopped instead of starting again.
    """
    by_role = {}
    for task in tasks:
        role = _role_of(task.title)
        if role in ROLES and role not in by_role:
            by_role[role] = task

    ordered: list[KanbanTask] = []
    for role in ROLES:
        if role not in by_role:
            break
        ordered.append(by_role[role])
    return ordered


def _artifact_path(context: JobContext, run: dict[str, Any]) -> str:
    """
    Where the report will live, decided here and never anywhere else.

    Derived only from values that cannot change between one claim and the next.
    The period comes from the *run's* creation time rather than from now(), so a
    chain that starts on the 31st and finishes on the 1st does not go looking
    for its artefact in a folder nobody wrote to.
    """
    created = _parse_time(run["created_at"])
    period = created.strftime("%Y-%m")
    return (
        f"{run['org_id']}/{run['workspace_id']}/{period}/"
        f"{context.job_id}__kanban-report.md"
    )


def _dataset_name(
    context: JobContext, run: dict[str, Any], version: dict[str, Any] | None = None
) -> str:
    dataset_id = context.job.get("dataset_id") or (version or {}).get("dataset_id")
    if not dataset_id:
        return "Report"
    rows = context.supabase.select(
        "datasets", columns="id,name", filters={"id": f"eq.{dataset_id}"}, limit=1
    )
    return rows[0]["name"] if rows else "Report"


def _deadline_exceeded(context: JobContext, run: dict[str, Any]) -> bool:
    """
    Two clocks, and which one applies depends on what the run is waiting for.

    A working chain gets the short one: ten minutes is a healthy four-card run,
    so an hour means something is wrong and leaving it to spend the host's only
    core all afternoon helps nobody.

    A *blocked* run is waiting for a person, and people are not an hour. It gets
    a working day, measured from the same start, so that a card blocked at 17:00
    for a missing file is still recoverable the next morning instead of having
    quietly failed overnight.
    """
    settings = context.config.kanban
    if run.get("phase") == "blocked":
        limit = _parse_time(run["created_at"]) + dt.timedelta(
            seconds=settings.blocked_deadline_seconds
        )
        return _now() > limit
    return _now() > _parse_time(run["deadline_at"])


def _minutes_since(stamp: str) -> int:
    return max(int((_now() - _parse_time(stamp)).total_seconds() // 60), 0)


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _parse_time(value: Any) -> dt.datetime:
    if isinstance(value, dt.datetime):
        return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)
    text = str(value or "").replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return _now()
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)


def _one(value: Any) -> dict[str, Any]:
    """PostgREST returns a one-row set for a function returning a composite."""
    if isinstance(value, list):
        return value[0] if value else {}
    return value if isinstance(value, dict) else {}


__all__ = ["handle_kanban_report"]
