"""
The customer -> Kanban bridge, driven end to end without a board.

Two fakes stand in for the two things the bridge talks to:

  * `FakeBoard` speaks the `hermes kanban` CLI over an argument list. It records
    every command, so a test can assert not only what came back but what was
    *asked* -- that four cards were created and not eight, that each is the
    child of the one before it, that nothing ever asks for decomposition.
  * `FakeSupabase` implements the three bridge RPCs with the same guards the SQL
    has: one run per job, a correlation id minted once, a terminal phase that
    cannot be rewritten.

`_drive` is the worker loop, compressed: claim, run, defer, repeat. Every test
that exercises more than one step goes through it, because the interesting
failures in this design are all failures *across* steps -- a restart between
creating a card and writing down its id, a second claim of a job that already
has a chain.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
from typing import Any

import pytest

from hermes.bridge import handle_kanban_report
from hermes.config import Config, KanbanConfig, LLMConfig
from hermes.jobs import JobContext, JobDeferred, JobError

JOB_ID = "11111111-1111-1111-1111-111111111111"
ORG_ID = "22222222-2222-2222-2222-222222222222"
WORKSPACE_ID = "33333333-3333-3333-3333-333333333333"
DATASET_ID = "44444444-4444-4444-4444-444444444444"
VERSION_ID = "55555555-5555-5555-5555-555555555555"

SERVICE_KEY = "service-role-key-that-must-never-leave-the-worker"

REPORT = b"# Period report\n\nRevenue: 1,204.00\n"
REPORT_SHA = hashlib.sha256(REPORT).hexdigest()


def _stamp(offset_seconds: int) -> str:
    """
    Run timestamps, relative to the clock the bridge actually reads.

    Fixed dates were the obvious choice and the wrong one: a deadline written as
    a literal is in the past by the afternoon of the day it was written, and the
    suite then fails on its own with a message about a chain that timed out.
    """
    moment = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=offset_seconds)
    return moment.isoformat()


# -----------------------------------------------------------------------------
# The board
# -----------------------------------------------------------------------------


class FakeBoard:
    """A `hermes kanban` CLI that keeps its cards in a dict."""

    def __init__(self) -> None:
        self.tasks: dict[str, dict[str, Any]] = {}
        self.runs: dict[str, list[dict[str, Any]]] = {}
        self.events: dict[str, list[dict[str, Any]]] = {}
        self.commands: list[list[str]] = []
        self.created_order: list[str] = []
        self.parents: dict[str, str | None] = {}
        self.tenants: list[str] = []
        self.max_runtimes: list[str] = []
        self.by_key: dict[str, str] = {}
        # Set to make every call fail the way an agent container mid-restart
        # fails, which the bridge must treat as "look again" and not as "the
        # customer's job is over".
        self.unavailable = False
        self.next_id = 0

    # -- the transport the KanbanClient is given -----------------------------

    def runner(self, argv, timeout: int):  # noqa: ANN001 - matches the client's seam
        argv = list(argv)
        self.commands.append(argv)

        if self.unavailable:
            return 1, "", "Error: no such container: hermes-agent-1"

        # [hermes, kanban, --board, <board>, <verb>, ...]
        verb = argv[4]
        rest = argv[5:]

        handler = {
            "create": self._create,
            "list": self._list,
            "show": self._show,
            "runs": self._runs,
            "block": self._block,
        }.get(verb)

        if handler is None:
            return 2, "", f"Error: no such command '{verb}'"
        return handler(rest)

    # -- verbs ---------------------------------------------------------------

    def _create(self, args: list[str]) -> tuple[int, str, str]:
        # `title` is positional on the real CLI, and getting that wrong was a
        # parse error rather than a card. The fake insists on it for the same
        # reason: a test that accepted --title would have gone on passing while
        # production could not create a single task.
        if not args or args[0].startswith("--"):
            return 2, "", "Error: the following arguments are required: title"

        title = args[0]
        flags = _flags(args[1:])

        # --idempotency-key returns the existing task rather than duplicating
        # it. Verified on the live board: the id came back unchanged and the
        # original body was *not* overwritten.
        key = flags.get("--idempotency-key")
        if key and key in self.by_key:
            return 0, json.dumps(self.tasks[self.by_key[key]]), ""

        self.next_id += 1
        task_id = f"t_{self.next_id:08x}"
        self.tasks[task_id] = {
            "id": task_id,
            "title": title,
            "body": flags.get("--body", ""),
            "status": "todo",
            "assignee": flags.get("--assignee"),
            "tenant": flags.get("--tenant", ""),
            "created_by": flags.get("--created-by", "user"),
            "result": None,
        }
        if key:
            self.by_key[key] = task_id
        self.parents[task_id] = flags.get("--parent")
        self.tenants.append(flags.get("--tenant", ""))
        self.max_runtimes.append(flags.get("--max-runtime", ""))
        self.created_order.append(task_id)
        self.runs[task_id] = []
        self.events[task_id] = []
        # The live CLI returns the task object itself, not {"task": {...}}.
        return 0, json.dumps(self.tasks[task_id]), ""

    def _list(self, args: list[str]) -> tuple[int, str, str]:
        flags = _flags(args)
        tenant = flags.get("--tenant")
        rows = [
            dict(task)
            for task in self.tasks.values()
            if tenant is None or task.get("tenant") == tenant
        ]
        if "--json" in args:
            # The live CLI returns a bare array, not an object.
            return 0, json.dumps(rows), ""
        return 0, "\n".join(f"{row['id']}  {row['status']}  {row['title']}" for row in rows), ""

    def _show(self, args: list[str]) -> tuple[int, str, str]:
        task_id = args[0]
        if task_id not in self.tasks:
            return 1, "", f"Error: no task {task_id}"
        return 0, json.dumps(
            {"task": self.tasks[task_id], "events": self.events[task_id]}
        ), ""

    def _runs(self, args: list[str]) -> tuple[int, str, str]:
        task_id = args[0]
        if task_id not in self.tasks:
            return 1, "", f"Error: no task {task_id}"
        return 0, json.dumps(self.runs[task_id]), ""

    def _block(self, args: list[str]) -> tuple[int, str, str]:
        task_id = args[0]
        if task_id not in self.tasks:
            return 1, "", f"Error: no task {task_id}"
        if self.tasks[task_id]["status"] == "blocked":
            # What the live CLI answers for an already-blocked card. Not worth
            # raising: the card is in the state we wanted.
            return 1, "", f"cannot block {task_id}"
        # `block <task_id> <reason...> --kind <kind>`: the reason is positional.
        reason = args[1] if len(args) > 1 and not args[1].startswith("--") else ""
        self.block(task_id, reason)
        return 0, f"Blocked {task_id}: {reason}", ""

    # -- what a dispatcher would do ------------------------------------------

    def complete(self, task_id: str, metadata: dict[str, Any], summary: str = "done") -> None:
        self.tasks[task_id]["status"] = "done"
        self.runs[task_id].append({"summary": summary, "metadata": metadata})

    def block(self, task_id: str, reason: str) -> None:
        self.tasks[task_id]["status"] = "blocked"
        # The payload shape the live board writes.
        self.events[task_id].append({
            "kind": "blocked",
            "payload": {"reason": reason, "kind": "needs_input",
                        "recurrences": 1, "source_status": "ready"},
        })

    def start(self, task_id: str) -> None:
        self.tasks[task_id]["status"] = "running"

    def unblock(self, task_id: str) -> None:
        self.tasks[task_id]["status"] = "ready"

    def role(self, role: str) -> str:
        for task_id, task in self.tasks.items():
            if f"[role:{role}]" in task["title"]:
                return task_id
        raise AssertionError(f"no {role} card on the board")

    def run_the_chain(self, correlation: str, *, artifact_path: str) -> None:
        """Every card completes, and the verifier passes. The happy path."""
        for role in ("supervisor", "analyst", "reporter"):
            self.complete(self.role(role), {"job_id": JOB_ID, "correlation_id": correlation})
        self.complete(
            self.role("verifier"),
            {
                "verdict": "PASS",
                "job_id": JOB_ID,
                "correlation_id": correlation,
                "artifact": {
                    "bucket": "exports",
                    "path": artifact_path,
                    "sha256": REPORT_SHA,
                    "bytes": len(REPORT),
                },
                "checks": {"revenue": "ok"},
            },
        )


def _flags(args: list[str]) -> dict[str, str]:
    flags: dict[str, str] = {}
    index = 0
    while index < len(args):
        token = args[index]
        if token.startswith("--"):
            if index + 1 < len(args) and not args[index + 1].startswith("--"):
                flags[token] = args[index + 1]
                index += 2
                continue
            flags[token] = ""
        index += 1
    return flags


# -----------------------------------------------------------------------------
# The database
# -----------------------------------------------------------------------------


class FakeSupabase:
    """
    The bridge's RPCs, with the guards the SQL has.

    Only the guards, though -- the point is to test the bridge's behaviour
    against a database that refuses the things the real one refuses, not to
    reimplement Postgres.
    """

    def __init__(self, version: dict[str, Any] | None = None) -> None:
        self.run: dict[str, Any] | None = None
        self.claimed_by = "worker-1"
        self.job_status = "running"
        self.rpc_calls: list[tuple[str, dict[str, Any]]] = []
        self.storage: dict[tuple[str, str], bytes] = {}
        self.signed_downloads: list[tuple[str, str]] = []
        self.signed_uploads: list[tuple[str, str]] = []
        self.correlation_seed = 0
        self._version = version if version is not None else {
            "id": VERSION_ID,
            "dataset_id": DATASET_ID,
            "version_no": 3,
            "kind": "cleaned",
            "parquet_path": f"{ORG_ID}/{WORKSPACE_ID}/2026-08/{DATASET_ID}__v3.parquet",
            "row_count": 1204,
        }

    # -- tables ---------------------------------------------------------------

    def select(self, table: str, **kwargs: Any) -> list[dict[str, Any]]:
        if table == "dataset_versions":
            return [self._version] if self._version else []
        if table == "datasets":
            return [{"id": DATASET_ID, "name": "Sales ledger"}]
        return []

    # -- storage --------------------------------------------------------------

    def create_signed_download_url(self, bucket: str, path: str, expires_in: int) -> str:
        self.signed_downloads.append((bucket, path))
        return f"https://example.supabase.co/storage/v1/object/sign/{bucket}/{path}?token=read"

    def create_signed_upload_url(self, bucket: str, path: str) -> str:
        self.signed_uploads.append((bucket, path))
        return f"https://example.supabase.co/storage/v1/object/upload/sign/{bucket}/{path}?token=write"

    def download(self, bucket: str, path: str, max_bytes: int) -> bytes:
        try:
            return self.storage[(bucket, path)]
        except KeyError as error:
            raise RuntimeError(f"{bucket}/{path} not found") from error

    # -- rpc ------------------------------------------------------------------

    def rpc(self, function: str, params: dict[str, Any] | None = None) -> Any:
        params = params or {}
        self.rpc_calls.append((function, params))
        return getattr(self, f"_rpc_{function}")(params)

    def _authorise(self, params: dict[str, Any]) -> None:
        if self.job_status != "running" or params["p_worker_id"] != self.claimed_by:
            raise PermissionError(
                f"job {params['p_job_id']} is not running under {params['p_worker_id']}"
            )

    def _rpc_kanban_run_start(self, params: dict[str, Any]) -> Any:
        self._authorise(params)
        if self.run is None:
            self.correlation_seed += 1
            self.run = {
                "id": "run-1",
                "job_id": params["p_job_id"],
                "org_id": ORG_ID,
                "workspace_id": WORKSPACE_ID,
                "correlation_id": f"{self.correlation_seed:064x}",
                "board": params["p_board"],
                "kanban_tenant": f"job-{params['p_job_id']}",
                "root_task_id": None,
                "verifier_task_id": None,
                "task_ids": [],
                "phase": "claimed",
                "verdict": None,
                "blocked_reason": None,
                "error": None,
                "result": None,
                "polls": 0,
                "created_at": _stamp(-60),
                "deadline_at": _stamp(3600),
                "finished_at": None,
            }
        return [dict(self.run)]

    def _rpc_kanban_run_record_tasks(self, params: dict[str, Any]) -> Any:
        self._authorise(params)
        assert self.run is not None
        if params["p_correlation_id"] != self.run["correlation_id"]:
            raise PermissionError("correlation mismatch")
        if self.run["root_task_id"] is not None:
            if self.run["root_task_id"] != params["p_root_task_id"]:
                raise RuntimeError("refusing to repoint a run at a different root task")
            return [dict(self.run)]
        self.run["root_task_id"] = params["p_root_task_id"]
        self.run["verifier_task_id"] = params["p_verifier_task_id"]
        self.run["task_ids"] = list(params["p_task_ids"] or [])
        if self.run["phase"] == "claimed":
            self.run["phase"] = "orchestrating"
        return [dict(self.run)]

    def _rpc_kanban_run_advance(self, params: dict[str, Any]) -> Any:
        self._authorise(params)
        assert self.run is not None
        if params["p_correlation_id"] != self.run["correlation_id"]:
            raise PermissionError("correlation mismatch")
        if self.run["phase"] in {"completed", "failed", "cancelled", "timeout"}:
            return [dict(self.run)]
        phase = params["p_phase"]
        if phase == "completed" and params.get("p_verdict") != "PASS":
            raise RuntimeError("kanban_runs_verdict_ck: completed requires verdict PASS")
        self.run["phase"] = phase
        self.run["verdict"] = params.get("p_verdict") or self.run["verdict"]
        self.run["blocked_reason"] = params.get("p_blocked_reason") if phase == "blocked" else None
        self.run["error"] = params.get("p_error") or self.run["error"]
        self.run["result"] = params.get("p_result") or self.run["result"]
        self.run["polls"] += 1
        if phase in {"completed", "failed", "cancelled", "timeout"}:
            self.run["finished_at"] = _stamp(0)
        return [dict(self.run)]

    def _rpc_defer_agent_job(self, params: dict[str, Any]) -> Any:
        return [{"id": params["p_job_id"], "status": "queued"}]


# -----------------------------------------------------------------------------
# Wiring
# -----------------------------------------------------------------------------


def _config(board: str = "dataengine", **kanban: Any) -> Config:
    return Config(
        supabase_url="https://example.supabase.co",
        service_key=SERVICE_KEY,
        worker_id="worker-1",
        hostname="test",
        llm=LLMConfig(),
        kanban=KanbanConfig(enabled=True, board=board, **kanban),
    )


def _context(
    supabase: FakeSupabase,
    board: FakeBoard,
    config: Config | None = None,
    payload: dict[str, Any] | None = None,
    dataset_version_id: str | None = VERSION_ID,
    monkeypatch: Any = None,
) -> JobContext:
    config = config or _config()

    # The client the bridge builds is internal to the handler, so the transport
    # is injected by patching the default runner. That keeps the seam in one
    # place instead of threading a client through the handler's signature for
    # the tests' benefit.
    import hermes.kanban as kanban_module

    if monkeypatch is not None:
        monkeypatch.setattr(kanban_module, "_subprocess_runner", board.runner)

    return JobContext(
        config=config,
        supabase=supabase,
        llm=None,
        job={
            "id": JOB_ID,
            "org_id": ORG_ID,
            "workspace_id": WORKSPACE_ID,
            "dataset_id": DATASET_ID,
            "dataset_version_id": dataset_version_id,
            "kind": "kanban_report",
            "payload": payload or {"period": "2026-08"},
            "requested_by": None,
        },
        heartbeat=lambda progress: None,
    )


def _drive(context: JobContext, limit: int = 12) -> tuple[dict[str, Any] | None, list[JobDeferred]]:
    """
    The worker loop, minus the queue.

    Each pass is one claim: run the handler, and if it defers, come back. The
    bridge is a state machine precisely so that this is all the worker has to
    do, and testing through it means a test cannot accidentally exercise a path
    the real loop would never take.
    """
    deferrals: list[JobDeferred] = []
    for _ in range(limit):
        try:
            return handle_kanban_report(context), deferrals
        except JobDeferred as deferred:
            deferrals.append(deferred)
    raise AssertionError(f"still deferring after {limit} passes")


def _artifact_path() -> str:
    return f"{ORG_ID}/{WORKSPACE_ID}/2026-08/{JOB_ID}__kanban-report.md"


# =============================================================================
# The happy path
# =============================================================================


def test_the_happy_path_produces_a_verified_report(monkeypatch):
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    # Pass one: the chain is created and the job yields.
    with pytest.raises(JobDeferred) as first:
        handle_kanban_report(context)

    assert first.value.progress["stage"] == "orchestrating"
    assert len(board.tasks) == 4
    assert [task["title"].split("] ")[1].split(" ")[0] for task in board.tasks.values()] == [
        "1/4", "2/4", "3/4", "4/4",
    ]

    # Pass two: nothing has happened on the board yet, so it yields again.
    board.start(board.role("supervisor"))
    with pytest.raises(JobDeferred) as second:
        handle_kanban_report(context)
    assert second.value.progress["stage"] == "running"

    # The chain runs and the verifier passes.
    correlation = supabase.run["correlation_id"]
    supabase.storage[("exports", _artifact_path())] = REPORT
    board.run_the_chain(correlation, artifact_path=_artifact_path())

    result = handle_kanban_report(context)

    assert result["report_path"] == _artifact_path()
    assert result["bucket"] == "exports"
    assert result["verdict"] == "PASS"
    assert result["sha256"] == REPORT_SHA
    assert result["dataset_name"] == "Sales ledger"
    assert supabase.run["phase"] == "completed"
    assert supabase.run["verdict"] == "PASS"


def test_the_chain_is_serial_four_cards_and_no_decomposition(monkeypatch):
    """
    `max_in_progress: 1` and `auto_decompose: false` are host settings this
    bridge must not quietly work around.

    Four cards, each the child of the one before it, so the DAG itself
    serialises the work rather than relying on the dispatcher's budget. And no
    command this module builds mentions decomposition, concurrency or a budget
    -- asserted over every argument list rather than by reading the code.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    created = board.created_order
    assert len(created) == 4
    assert board.parents[created[0]] is None
    for child, parent in zip(created[1:], created):
        assert board.parents[child] == parent, "the chain must be linear"

    flat = " ".join(token for command in board.commands for token in command)
    for forbidden in ("decompose", "max_in_progress", "--parallel", "--concurrency"):
        assert forbidden not in flat


def test_the_argv_contract_matches_the_live_cli(monkeypatch):
    """
    The exact shape of every command, pinned.

    Three assumptions in the first draft were wrong against the real CLI, and
    none of them would have failed loudly: `--title` is a parse error rather
    than a card, `--workspace` selects a directory kind rather than a namespace,
    and `block --reason` is not a flag. This test is what makes the next Hermes
    upgrade break a test instead of a customer's report.

    Verified against `hermes kanban` on srv1927440, 2026-08-31.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    creates = [command for command in board.commands if command[4] == "create"]
    assert len(creates) == 4

    for command in creates:
        # [hermes, kanban, --board, <board>, create, <title>, ...]
        assert not command[5].startswith("--"), "title is positional"
        assert "--title" not in command
        # A namespace, not a working directory. --workspace would have been
        # read as scratch|worktree|dir:<path> and quietly ignored.
        assert "--workspace" not in command
        assert "--tenant" in command
        assert "--idempotency-key" in command
        assert "--max-runtime" in command
        assert "--created-by" in command
        assert command[-1] == "--json"

    tenant = creates[0][creates[0].index("--tenant") + 1]
    assert tenant == f"job-{JOB_ID}"
    assert board.tenants == [tenant] * 4

    keys = [command[command.index("--idempotency-key") + 1] for command in creates]
    assert len(set(keys)) == 4, "one key per card"
    correlation = supabase.run["correlation_id"]
    assert keys == [f"{correlation}:{role}" for role in
                    ("supervisor", "analyst", "reporter", "verifier")]

    # Every card is the child of the one before it, by id.
    assert "--parent" not in creates[0]
    for command, previous in zip(creates[1:], board.created_order):
        assert command[command.index("--parent") + 1] == previous


def test_stopping_a_card_uses_a_typed_block(monkeypatch):
    """
    A bare block does not hold a card.

    Measured on the live board: a card parked with `--initial-status blocked`
    carried a `promoted` event within the minute and came back as `ready`. With
    the dispatcher running in the gateway, a `ready` card with an assignee is a
    card about to be spawned -- so the stop path has to leave a live diagnostic,
    which is what `--kind needs_input` does.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    supabase.run["deadline_at"] = _stamp(-30)
    with pytest.raises(JobError):
        handle_kanban_report(context)

    blocks = [command for command in board.commands if command[4] == "block"]
    assert len(blocks) == 4
    for command in blocks:
        assert not command[6].startswith("--"), "the reason is positional"
        assert "--reason" not in command
        assert command[-2:] == ["--kind", "needs_input"]


def test_kanban_is_never_handed_a_supabase_credential(monkeypatch):
    """
    Rule four, asserted against what actually crosses the wire.

    The board receives two signed URLs and nothing else. Not the service key,
    not the org id, not the workspace id -- a card that knew a workspace id
    would be one step from being asked to act on it.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    bodies = "\n".join(task["body"] for task in board.tasks.values())
    assert SERVICE_KEY not in bodies
    # The words a credential would arrive under. The bodies do mention Supabase --
    # they tell the card not to go looking for it -- so the assertion is about what
    # could be *used*, not about the name appearing.
    for credential in ("service_role", "apikey", "Authorization", "Bearer", "SUPABASE_"):
        assert credential not in bodies

    # The org and workspace ids do appear, and refusing to let them would be
    # theatre: the storage layout has always keyed objects by tenant, so they
    # are components of the input link and of the one path the card may write.
    #
    # What matters is that they only ever appear *as* path components. An opaque
    # segment of a URL grants no authority; a `workspace_id:` field invites a
    # card to reason about tenancy, which is the thing this bridge exists to
    # keep on the worker's side of the wall. So: always followed by a slash,
    # never named.
    for identifier in (ORG_ID, WORKSPACE_ID):
        for match in re.finditer(re.escape(identifier), bodies):
            assert bodies[match.end():match.end() + 1] == "/", (
                f"{identifier} appears outside a storage path"
            )
    assert "workspace_id" not in bodies and "org_id" not in bodies
    # The one input link, scoped to one object, and one write link.
    assert supabase.signed_downloads == [("parquet", supabase._version["parquet_path"])]
    assert supabase.signed_uploads == [("exports", _artifact_path())]


def test_no_customer_data_reaches_a_card_title(monkeypatch):
    """
    Titles are the one thing every board listing prints, and the board is shared
    with operator work. The dataset's name belongs in the body, next to the
    signed URL that already carries the data.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    for task in board.tasks.values():
        assert "Sales ledger" not in task["title"]
        assert re.match(r"^\[de:[0-9a-f]{16}\]\[role:[a-z]+\] \d/4 [a-z]+$", task["title"])


# =============================================================================
# Idempotency: restarts, duplicate claims, duplicate invocations
# =============================================================================


def test_a_second_invocation_does_not_create_a_second_chain(monkeypatch):
    """
    The bridge invoked twice for one job -- a retried call, a duplicated
    dispatch -- must converge on the chain that already exists.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)
    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    assert len(board.tasks) == 4
    assert supabase.run["task_ids"] == board.created_order


def test_a_crash_between_creating_the_cards_and_recording_them_is_harmless(monkeypatch):
    """
    The worst window in the design, reproduced exactly.

    The cards exist on the board and the database knows nothing about them. A
    worker that started again from scratch would spend four more Opus turns on
    a one-core box and produce a second artefact nobody asked for.

    It does start again from scratch -- and that is now safe, because every
    create carries an idempotency key derived from the run's correlation token.
    The board returns the ids it already has. The recovery path and the happy
    path are the same four commands.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    # Creation succeeds; recording it does not.
    original = supabase._rpc_kanban_run_record_tasks

    def explode(params):
        raise ConnectionError("connection reset by peer")

    supabase._rpc_kanban_run_record_tasks = explode
    with pytest.raises(ConnectionError):
        handle_kanban_report(context)

    assert len(board.tasks) == 4
    assert supabase.run["root_task_id"] is None, "the crash is only interesting if nothing was written"

    # The worker restarts and claims the job again.
    supabase._rpc_kanban_run_record_tasks = original
    first_ids = list(board.created_order)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    assert board.created_order == first_ids, "no second chain"
    assert len(board.tasks) == 4
    assert supabase.run["task_ids"] == first_ids


def test_a_crash_halfway_through_creation_finishes_the_chain(monkeypatch):
    """
    A partial DAG is not a reason to start again either. Two cards exist; the
    next attempt creates the two that are missing and hangs them off the last
    one that made it.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    real_create = board._create
    calls = {"n": 0}

    def flaky_create(args):
        calls["n"] += 1
        if calls["n"] > 2:
            return 1, "", "Error: cannot connect to the board"
        return real_create(args)

    board._create = flaky_create
    with pytest.raises(JobDeferred):
        handle_kanban_report(context)
    assert len(board.tasks) == 2

    board._create = real_create
    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    assert len(board.tasks) == 4
    created = board.created_order
    assert board.parents[created[2]] == created[1], "the second half hangs off the first"
    roles = [task["title"] for task in board.tasks.values()]
    assert sum("[role:verifier]" in title for title in roles) == 1


def test_a_worker_that_lost_its_lease_cannot_touch_the_run(monkeypatch):
    """
    Duplicate claims, settled where they have to be: in the database.

    `claim_agent_job` cannot hand one job to two workers, but a lease can lapse
    and be taken over. The loser must not be able to advance the run it no
    longer owns, and it finds out on its very next call rather than after
    writing a result.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    supabase.claimed_by = "worker-2"  # somebody else took it

    with pytest.raises(PermissionError):
        handle_kanban_report(context)


def test_a_decided_run_replays_its_result_instead_of_running_again(monkeypatch):
    """
    A lease that lapses in the window between recording the outcome and
    reporting it means the job is claimed again after the chain is over.
    Re-reading the board then would be wrong -- cards get archived -- so the
    decision is replayed from the run row.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)
    correlation = supabase.run["correlation_id"]
    supabase.storage[("exports", _artifact_path())] = REPORT
    board.run_the_chain(correlation, artifact_path=_artifact_path())
    first = handle_kanban_report(context)

    commands_before = len(board.commands)
    again = handle_kanban_report(context)

    assert again == first
    assert len(board.commands) == commands_before, "a decided run does not touch the board"


# =============================================================================
# Missing input, blocking and recovery
# =============================================================================


def test_a_job_with_no_dataset_version_fails_before_touching_the_board(monkeypatch):
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, dataset_version_id=None, monkeypatch=monkeypatch)

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert not error.value.retryable
    assert "dataset version" in str(error.value)
    assert board.tasks == {}, "nothing was created for a job that cannot run"


def test_a_version_with_no_parquet_fails_readably(monkeypatch):
    supabase = FakeSupabase(version={"id": VERSION_ID, "dataset_id": DATASET_ID,
                                     "version_no": 1, "parquet_path": None, "row_count": 0})
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert not error.value.retryable
    assert "storage" in str(error.value)
    assert board.tasks == {}


def test_a_blocked_card_keeps_the_job_alive_and_unblocking_recovers_it(monkeypatch):
    """
    Missing input, blocked, fixed, resumed -- the recovery the runbook
    documents, driven through the bridge.

    The job must not fail here. A card blocked for a missing file is fixable in
    a minute with `hermes kanban unblock`, and a bridge that gave up on it would
    turn a one-minute fix into a re-run of the whole chain.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    analyst = board.role("analyst")
    board.complete(board.role("supervisor"), {"job_id": JOB_ID})
    board.block(analyst, "the input link returned 404; nothing was measured")

    with pytest.raises(JobDeferred) as blocked:
        handle_kanban_report(context)

    assert blocked.value.progress["stage"] == "blocked"
    assert "404" in blocked.value.progress["kanban"]["note"]
    assert blocked.value.delay_seconds == context.config.kanban.blocked_poll_seconds
    assert supabase.run["phase"] == "blocked"

    # An operator supplies the input and unblocks the card.
    board.unblock(analyst)
    with pytest.raises(JobDeferred) as resumed:
        handle_kanban_report(context)
    assert resumed.value.progress["stage"] == "running"

    correlation = supabase.run["correlation_id"]
    supabase.storage[("exports", _artifact_path())] = REPORT
    board.run_the_chain(correlation, artifact_path=_artifact_path())

    result = handle_kanban_report(context)
    assert result["verdict"] == "PASS"
    assert supabase.run["phase"] == "completed"


def test_a_board_that_is_not_answering_defers_rather_than_failing(monkeypatch):
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    board.unavailable = True
    with pytest.raises(JobDeferred) as deferred:
        handle_kanban_report(context)

    assert "board" in deferred.value.progress["note"]
    assert board.tasks == {}

    board.unavailable = False
    with pytest.raises(JobDeferred):
        handle_kanban_report(context)
    assert len(board.tasks) == 4


# =============================================================================
# Verification
# =============================================================================


def test_verifier_pass_is_accepted(monkeypatch):
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)
    supabase.storage[("exports", _artifact_path())] = REPORT
    board.run_the_chain(supabase.run["correlation_id"], artifact_path=_artifact_path())

    result, _ = _drive(context)
    assert result["verdict"] == "PASS"
    assert result["checks"] == {"revenue": "ok"}


def test_verifier_fail_blocks_the_card_and_fails_the_job(monkeypatch):
    """
    The protocol's FAIL path: a block whose reason carries the verdict.

    The job fails, non-retryably, with the verifier's own sentence in it. Not
    deferred -- re-running the same artefact produces the same answer -- and
    certainly not succeeded.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    for role in ("supervisor", "analyst", "reporter"):
        board.complete(board.role(role), {"job_id": JOB_ID})
    board.block(
        board.role("verifier"),
        "VERDICT=FAIL: revenue reported as 1204.00 but the source sums to 1198.50",
    )

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert not error.value.retryable
    assert "1198.50" in str(error.value)
    assert "Nothing was published" in str(error.value)
    assert supabase.run["phase"] == "failed"
    assert supabase.run["verdict"] == "FAIL"


def test_a_done_card_carrying_a_fail_verdict_is_not_a_success(monkeypatch):
    """
    The defect observed on 2026-08-31, and the reason the worker reads the
    verdict rather than the status.

    A verifier detected a real corruption, wrote verdict=FAIL into its metadata
    and then called `kanban_complete` anyway. The card went to `done`. On the
    board it was indistinguishable from a pass. The worker must not repeat that
    reading on the customer's behalf.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    correlation = supabase.run["correlation_id"]
    supabase.storage[("exports", _artifact_path())] = REPORT
    for role in ("supervisor", "analyst", "reporter"):
        board.complete(board.role(role), {"job_id": JOB_ID, "correlation_id": correlation})
    board.complete(
        board.role("verifier"),
        {
            "verdict": "FAIL",
            "job_id": JOB_ID,
            "correlation_id": correlation,
            "artifact": {"bucket": "exports", "path": _artifact_path()},
        },
    )

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert not error.value.retryable
    assert supabase.run["phase"] == "failed"
    assert supabase.run["verdict"] == "FAIL"


def test_a_pass_with_no_verdict_recorded_is_refused(monkeypatch):
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)
    board.complete(board.role("verifier"), {"job_id": JOB_ID, "correlation_id":
                                            supabase.run["correlation_id"]})

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert "without recording a verdict" in str(error.value)
    assert supabase.run["phase"] == "failed"


def test_a_chain_with_no_verification_step_is_refused(monkeypatch):
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    # The verifier card is gone -- archived by hand, say -- and every other card
    # is done. A chain that finished without being checked is not a result.
    supabase.run["verifier_task_id"] = None
    verifier_id = board.role("verifier")
    del board.tasks[verifier_id]
    for role in ("supervisor", "analyst", "reporter"):
        board.complete(board.role(role), {"job_id": JOB_ID})

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert "no verification step" in str(error.value)


# =============================================================================
# Ownership of what comes back
# =============================================================================


def _pass_with(monkeypatch, metadata_patch: dict[str, Any], store: bool = True):
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    correlation = supabase.run["correlation_id"]
    if store:
        supabase.storage[("exports", _artifact_path())] = REPORT
    for role in ("supervisor", "analyst", "reporter"):
        board.complete(board.role(role), {"job_id": JOB_ID, "correlation_id": correlation})

    metadata = {
        "verdict": "PASS",
        "job_id": JOB_ID,
        "correlation_id": correlation,
        "artifact": {
            "bucket": "exports",
            "path": _artifact_path(),
            "sha256": REPORT_SHA,
            "bytes": len(REPORT),
        },
    }
    metadata.update(metadata_patch)
    board.complete(board.role("verifier"), metadata)
    return supabase, board, context


def test_a_result_with_the_wrong_correlation_token_is_rejected(monkeypatch):
    supabase, _, context = _pass_with(monkeypatch, {"correlation_id": "0" * 64})

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert "could not be matched to this request" in str(error.value)
    assert supabase.run["phase"] == "failed"


def test_a_result_naming_another_job_is_rejected(monkeypatch):
    supabase, _, context = _pass_with(
        monkeypatch, {"job_id": "99999999-9999-9999-9999-999999999999"}
    )

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert "different job" in str(error.value)
    assert supabase.run["phase"] == "failed"


def test_an_artefact_at_a_path_we_did_not_issue_is_rejected(monkeypatch):
    """
    The worker compares the returned path against the one it chose. It never
    reads a path the board proposes, which is what stops a chain publishing
    into somebody else's folder by naming it.
    """
    other = f"{ORG_ID}/00000000-0000-0000-0000-000000000000/2026-08/stolen.md"
    supabase, board, context = _pass_with(
        monkeypatch, {"artifact": {"bucket": "exports", "path": other, "sha256": REPORT_SHA}}
    )
    supabase.storage[("exports", other)] = REPORT

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert "does not belong to this job" in str(error.value)
    assert supabase.run["phase"] == "failed"


def test_a_pass_with_no_artefact_is_rejected(monkeypatch):
    supabase, _, context = _pass_with(monkeypatch, {"artifact": None})

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert "attached no artefact" in str(error.value)


def test_a_pass_whose_file_is_not_in_storage_is_rejected(monkeypatch):
    supabase, _, context = _pass_with(monkeypatch, {}, store=False)

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert "not in storage" in str(error.value)
    assert supabase.run["phase"] == "failed"


def test_a_file_that_does_not_match_what_was_verified_is_rejected(monkeypatch):
    """
    A partial result: the reporter uploaded, something truncated it, and the
    verifier checked the bytes it had. The digest is what catches the
    difference.
    """
    supabase, _, context = _pass_with(monkeypatch, {})
    supabase.storage[("exports", _artifact_path())] = b"# Period report\n\n(truncated"

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert "does not match what the internal chain verified" in str(error.value)


def test_an_empty_report_is_rejected(monkeypatch):
    supabase, _, context = _pass_with(monkeypatch, {"artifact": {
        "bucket": "exports", "path": _artifact_path()}})
    supabase.storage[("exports", _artifact_path())] = b""

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert "empty" in str(error.value)


# =============================================================================
# Cards that die, and clocks that run out
# =============================================================================


def test_a_retired_card_fails_the_job(monkeypatch):
    """
    There is no `gave_up` status on this board.

    The first draft of the bridge watched for one, along with `failed` and
    `cancelled`. `list --status` on the live CLI enumerates the whole
    vocabulary and it has none of them: a card that trips the consecutive-
    failure breaker goes to `blocked`, and a card re-blocked with the same kind
    after an unblock goes to `triage`. Both are handled as blocks.

    `archived` is the one way a card in flight actually disappears -- a person
    retired it. The chain cannot finish, and polling until the deadline would
    hide that behind a spinner.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    board.tasks[board.role("analyst")]["status"] = "archived"

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert "analyst" in str(error.value)
    assert "retired" in str(error.value)
    assert not error.value.retryable
    assert supabase.run["phase"] == "failed"


def test_a_card_in_triage_is_treated_as_needing_a_person(monkeypatch):
    """
    `triage` is where a card lands when the same block recurs after an unblock,
    which the dispatcher does to break unblock loops. It needs a person exactly
    as `blocked` does, and treating it as "still working" would poll a stalled
    chain until its deadline.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    analyst = board.role("analyst")
    board.block(analyst, "the ledger for August has not been uploaded")
    board.tasks[analyst]["status"] = "triage"

    with pytest.raises(JobDeferred) as deferred:
        handle_kanban_report(context)

    assert deferred.value.progress["stage"] == "blocked"
    assert supabase.run["phase"] == "blocked"


def test_a_run_past_its_deadline_is_stopped(monkeypatch):
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    supabase.run["deadline_at"] = _stamp(-30)  # in the past

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert "did not finish" in str(error.value)
    assert not error.value.retryable
    assert supabase.run["phase"] == "timeout"

    # And the chain was stopped rather than left spending the host's only core.
    blocked = [command for command in board.commands if command[4] == "block"]
    assert len(blocked) == 4


def test_a_blocked_run_gets_the_longer_clock(monkeypatch):
    """
    A card blocked at five o'clock for a missing file must still be recoverable
    the next morning. The short deadline is for a chain that is working; a
    blocked one is waiting for a person and gets a working day.
    """
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    board.block(board.role("analyst"), "the ledger for August has not been uploaded")
    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    assert supabase.run["phase"] == "blocked"
    supabase.run["deadline_at"] = _stamp(-30)  # the short clock has passed

    with pytest.raises(JobDeferred) as still_waiting:
        handle_kanban_report(context)
    assert still_waiting.value.progress["stage"] == "blocked"


def test_a_blocked_run_does_eventually_give_up(monkeypatch):
    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(
        supabase, board,
        config=_config(blocked_deadline_seconds=60),
        monkeypatch=monkeypatch,
    )

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)
    board.block(board.role("analyst"), "the ledger for August has not been uploaded")
    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    supabase.run["created_at"] = _stamp(-86_400)

    with pytest.raises(JobError) as error:
        handle_kanban_report(context)

    assert "did not have" in str(error.value)
    assert "ledger for August" in str(error.value)
    assert supabase.run["phase"] == "timeout"


# =============================================================================
# The worker's half of the deferral
# =============================================================================


def test_the_worker_defers_instead_of_finishing(monkeypatch):
    """
    A JobDeferred must reach `defer_agent_job` and never `finish_agent_job`. The
    difference is whether the customer's job comes back or is marked failed.
    """
    from hermes.worker import Worker

    supabase = FakeSupabase()
    config = _config()
    worker = Worker(config)
    worker.supabase = supabase

    monkeypatch.setitem(
        __import__("hermes.jobs", fromlist=["HANDLERS"]).HANDLERS,
        "kanban_report",
        lambda context: (_ for _ in ()).throw(
            JobDeferred(delay_seconds=42, progress={"stage": "running"}, reason="watching")
        ),
    )

    try:
        worker.run_job({
            "id": JOB_ID, "kind": "kanban_report", "workspace_id": WORKSPACE_ID,
            "org_id": ORG_ID, "payload": {}, "attempts": 1,
        })
    finally:
        worker.llm.close()

    called = [name for name, _ in supabase.rpc_calls]
    assert "defer_agent_job" in called
    assert "finish_agent_job" not in called

    params = next(p for name, p in supabase.rpc_calls if name == "defer_agent_job")
    assert params["p_delay_seconds"] == 42
    assert params["p_progress"] == {"stage": "running"}
    assert worker._jobs_deferred == 1
    assert worker._jobs_failed == 0
    assert worker._jobs_done == 0


def test_the_sweep_stops_the_cards_of_a_cancelled_job(monkeypatch):
    """
    The hazard deferral introduces, and its cleanup.

    A bridged job is `queued` between polls, and `cancel_agent_job` accepts a
    queued job -- so a customer can cancel one while four agents are working on
    it. The database marks the run cancelled immediately; stopping the cards
    needs the CLI, so it happens here, on an idle pass.
    """
    from hermes.worker import Worker

    supabase = FakeSupabase()
    board = FakeBoard()
    context = _context(supabase, board, monkeypatch=monkeypatch)

    with pytest.raises(JobDeferred):
        handle_kanban_report(context)

    cancelled = dict(supabase.run)
    cancelled["phase"] = "cancelled"

    supabase._rpc_next_cancelled_kanban_run = lambda params: [cancelled]

    worker = Worker(_config())
    worker.supabase = supabase
    try:
        worker.sweep_cancelled_kanban_runs()
    finally:
        worker.llm.close()

    blocked = [command for command in board.commands if command[4] == "block"]
    assert len(blocked) == 4
    assert all(task["status"] == "blocked" for task in board.tasks.values())


def test_the_sweep_does_nothing_when_the_bridge_is_off(monkeypatch):
    from hermes.config import KanbanConfig
    from hermes.worker import Worker

    supabase = FakeSupabase()
    config = Config(
        supabase_url="https://example.supabase.co",
        service_key=SERVICE_KEY,
        worker_id="worker-1",
        hostname="test",
        llm=LLMConfig(),
        kanban=KanbanConfig(enabled=False),
    )
    worker = Worker(config)
    worker.supabase = supabase
    try:
        worker.sweep_cancelled_kanban_runs()
    finally:
        worker.llm.close()

    assert supabase.rpc_calls == []


# =============================================================================
# The docker-exec transport
# =============================================================================


class FakeHttp:
    """Just enough of httpx.Client to drive DockerExecRunner."""

    def __init__(self, frames: bytes, exit_code: int | None = 0, create_status: int = 201):
        self.frames = frames
        self.exit_code = exit_code
        self.create_status = create_status
        self.posts: list[tuple[str, dict[str, Any]]] = []

    def post(self, url, json=None, timeout=None):  # noqa: A002 - mirrors httpx
        self.posts.append((url, json or {}))
        if url.endswith("/exec"):
            return _Response(self.create_status, {"Id": "exec-1"})
        return _Response(200, content=self.frames)

    def get(self, url, timeout=None):
        return _Response(200, {"ExitCode": self.exit_code})


class _Response:
    def __init__(self, status_code, payload=None, content=b""):
        self.status_code = status_code
        self._payload = payload
        self.content = content
        self.text = "" if payload is None else json.dumps(payload)

    def json(self):
        return self._payload


def _frame(stream: int, payload: bytes) -> bytes:
    return bytes([stream, 0, 0, 0]) + len(payload).to_bytes(4, "big") + payload


def test_docker_exec_demultiplexes_stdout_from_stderr():
    """
    Without a TTY the daemon interleaves both streams on one connection behind
    8-byte frame headers. Concatenating the raw body splices those headers into
    the JSON the CLI printed, and the resulting parse error names the JSON
    rather than the framing — which is a long way to walk to find a header.
    """
    from hermes.kanban import DockerExecRunner

    body = (
        _frame(1, b'[{"id":"t_0000abcd",')
        + _frame(2, b"warning: board is busy\n")
        + _frame(1, b'"status":"done"}]')
    )
    http = FakeHttp(body)
    runner = DockerExecRunner("http://proxy:2375", "agent-1", user="hermes", client=http)

    code, out, err = runner(["hermes", "kanban", "list", "--json"], 30)

    assert code == 0
    assert json.loads(out) == [{"id": "t_0000abcd", "status": "done"}]
    assert err.strip() == "warning: board is busy"


def test_docker_exec_never_attaches_stdin():
    """
    Every `docker exec` in this repo's scripts carries `< /dev/null`, because a
    CLI waiting on a stdin that never closes is a hang rather than an error.
    This is the API-level equivalent, and it is worth pinning.
    """
    from hermes.kanban import DockerExecRunner

    http = FakeHttp(_frame(1, b"[]"))
    runner = DockerExecRunner("http://proxy:2375", "agent-1", user="hermes", client=http)
    runner(["hermes", "kanban", "list"], 30)

    create_url, create_body = http.posts[0]
    assert create_url.endswith("/containers/agent-1/exec")
    assert create_body["AttachStdin"] is False
    assert create_body["Tty"] is False
    assert create_body["User"] == "hermes"
    assert create_body["Cmd"] == ["hermes", "kanban", "list"]


def test_a_missing_container_is_retryable_not_fatal():
    """
    A container that is not there yet — mid-deploy, mid-restart — is a reason to
    look again, not a reason to fail a customer's report.
    """
    from hermes.kanban import DockerExecRunner, KanbanUnavailable

    http = FakeHttp(b"", create_status=404)
    runner = DockerExecRunner("http://proxy:2375", "agent-1", client=http)

    with pytest.raises(KanbanUnavailable):
        runner(["hermes", "kanban", "list"], 30)


def test_an_unframed_body_is_returned_rather_than_dropped():
    from hermes.kanban import _demultiplex

    assert _demultiplex(b"plain output") == ("plain output", "")
    assert _demultiplex(b"") == ("", "")


def test_the_transport_is_chosen_from_configuration():
    from hermes.config import KanbanConfig
    from hermes.kanban import DockerExecRunner, KanbanError, runner_for

    # No docker host: run it here. That is the systemd deployment, and a
    # developer with the CLI on their path.
    assert runner_for(KanbanConfig()) is None

    chosen = runner_for(
        KanbanConfig(docker_host="http://proxy:2375", container="agent-1")
    )
    assert isinstance(chosen, DockerExecRunner)
    assert chosen.container == "agent-1"

    # Half-configured is refused loudly rather than silently running the CLI in
    # the worker's own container, where it does not exist.
    with pytest.raises(KanbanError):
        runner_for(KanbanConfig(docker_host="http://proxy:2375"))
