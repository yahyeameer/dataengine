"""
The Kanban control channel.

Everything the worker knows about the board goes through this module, and it is
deliberately small and deterministic: build an argument list, run it, parse
JSON. No model is asked to create a card, because a card is a control-plane
object -- the whole point of the bridge is that a customer request cannot cause
an arbitrary task to exist, and "the supervisor usually creates the right cards"
would put that guarantee in a prompt.

    worker  --(argv, no shell)-->  hermes kanban --board dataengine ...

## Where the CLI is

The worker runs in its own container; `kanban.db` lives inside the agent's. So
the command prefix is configuration, not code:

    HERMES_KANBAN_COMMAND="docker exec -u hermes hermes-agent-bwlq-hermes-agent-1 \\
                           /opt/hermes/.venv/bin/hermes"

On a host where the worker runs beside the CLI (the systemd deployment) it is
simply `hermes`. The prefix is split with shlex and executed as an argument
list -- never through a shell -- so a board name or a title can never become a
command.

## Verified against the live CLI, 2026-08-31

Every argument list below was run against `hermes kanban` on `srv1927440`
(`hermes-agent-bwlq-hermes-agent-1`, `/opt/hermes/.venv/bin/hermes`). Three
things the first draft of this module got wrong, recorded because each would
have failed differently and none would have failed obviously:

- **`title` is positional.** `create --title X` is a parse error, not a card.
- **`--workspace` is not a namespace.** It selects the *kind* of working
  directory -- `scratch | worktree | worktree:<path> | dir:<path>` -- and
  defaults to `scratch`. The per-job namespace is **`--tenant`**, which
  `list --tenant` then filters on, so one call reads exactly one job's cards.
  Scratch is left as the default deliberately: it gives every card its own
  directory, which is stronger isolation than a shared per-job one, and the
  chain hands off through run metadata and signed URLs rather than through a
  filesystem.
- **`block` takes its reason positionally**, and needs `--kind`. A bare block
  leaves no diagnostic and the dispatcher's promote pass moves the card back to
  `ready` -- measured: a card created with `--initial-status blocked` carried a
  `promoted` event within the minute. `--kind needs_input` is what actually
  holds a card for a human.

And one the CLI does better than the design did:

- **`--idempotency-key`.** "If a non-archived task with this key exists, its id
  is returned instead of creating a duplicate." Verified: re-running a create
  with the same key returned the same id and did *not* overwrite the body. That
  makes duplicate creation impossible at the source rather than merely
  detectable afterwards, so it is the primary defence and the tenant listing is
  the backstop.

`python -m hermes.kanban --probe` re-runs the read half of this contract against
a live board. Run it after any Hermes upgrade; a renamed flag is a five-second
finding there and a mystery three minutes into a chain.
"""

from __future__ import annotations

import json
import logging
import re
import shlex
import subprocess
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Sequence

log = logging.getLogger("hermes.kanban")

# Task ids are `t_` plus eight hex characters. Used to recognise ids in the
# plain-text `list` output when `--json` is unavailable, and -- more importantly
# -- to refuse anything that does not look like one before it is passed back
# into an argument list or written to the database.
TASK_ID = re.compile(r"^t_[0-9a-f]{8,}$")

# The board's whole status vocabulary, read off `list --status` on the live CLI:
#   archived blocked done ready review running scheduled todo triage
#
# There is no `failed`, no `cancelled` and no `gave_up`. A card that trips the
# consecutive-failure breaker is *blocked*, and a card re-blocked with the same
# kind after an unblock is routed to *triage* to break unblock loops. Both of
# those need a person, which is why triage sits with blocked rather than with
# the working states.
DONE_STATUSES = frozenset({"done"})
BLOCKED_STATUSES = frozenset({"blocked", "triage"})
WORKING_STATUSES = frozenset({"todo", "ready", "running", "review", "scheduled"})
# The subset where a worker is actually on the card.
ACTIVE_STATUSES = frozenset({"running", "review"})
# Retired by hand. Not a failure of the card, but for a chain in flight it means
# the work is gone, and treating it as "still working" would poll until the
# deadline for a card nobody intends to run.
RETIRED_STATUSES = frozenset({"archived"})

# The typed block that actually holds a card.
#
# A block with no kind leaves no live diagnostic, and the dispatcher's promote
# pass returns the card to `ready` on its next sweep -- observed on a card
# created with `--initial-status blocked`, which carried a `promoted` event
# within the minute. `dependency` is worse than useless here: it waits in `todo`
# and auto-promotes when parents finish, with no human involved.
BLOCK_KIND = "needs_input"


class KanbanError(RuntimeError):
    """The board answered, and the answer was not usable."""


class KanbanUnavailable(KanbanError):
    """
    The board could not be reached at all.

    Separate from KanbanError because it is the retryable one: a restarting
    agent container, a `docker exec` against a container mid-deploy. The bridge
    defers on this rather than failing the customer's job.
    """


@dataclass(frozen=True)
class KanbanTask:
    id: str
    title: str
    status: str

    @property
    def is_done(self) -> bool:
        return self.status in DONE_STATUSES

    @property
    def is_blocked(self) -> bool:
        return self.status in BLOCKED_STATUSES

    @property
    def is_retired(self) -> bool:
        return self.status in RETIRED_STATUSES

    @property
    def is_working(self) -> bool:
        return self.status in WORKING_STATUSES

    @property
    def is_active(self) -> bool:
        """
        A worker is on this card *now*, as opposed to it merely being runnable.

        The distinction matters for one thing only, and it is a thing the
        customer reads: the job says "verifying" when the verifier is actually
        running, not from the moment the verifier card exists. `todo` and
        `ready` are queue positions, not work.
        """
        return self.status in ACTIVE_STATUSES


@dataclass
class CardSpec:
    """One card to create, and who it is for."""

    key: str
    title: str
    body: str
    assignee: str | None = None
    # Stable across every attempt at this run, which is what makes creation
    # idempotent at the board rather than only recoverable afterwards.
    idempotency_key: str = ""


@dataclass
class KanbanClient:
    """
    A thin, synchronous wrapper over the `hermes kanban` CLI.

    `runner` exists so the tests can drive the whole state machine without a
    board: it takes an argument list and returns (returncode, stdout, stderr).
    Nothing else in the bridge knows there is a subprocess involved.
    """

    command: Sequence[str]
    board: str
    timeout_seconds: int = 120
    runner: Callable[[Sequence[str], int], tuple[int, str, str]] | None = None
    _last_stderr: str = field(default="", init=False, repr=False)

    # -- plumbing ------------------------------------------------------------

    def _run(self, args: Sequence[str]) -> str:
        argv = [*self.command, "kanban", "--board", self.board, *args]
        runner = self.runner or _subprocess_runner

        try:
            code, out, err = runner(argv, self.timeout_seconds)
        except FileNotFoundError as error:
            raise KanbanUnavailable(
                f"the kanban command {self.command[0]!r} is not executable from the worker: {error}"
            ) from error
        except subprocess.TimeoutExpired as error:
            raise KanbanUnavailable(
                f"kanban {' '.join(args[:2])} timed out after {self.timeout_seconds}s"
            ) from error

        self._last_stderr = (err or "").strip()

        if code != 0:
            # The distinction is worth making precisely because the two have
            # different recoveries. A container that is not there yet comes
            # back; a rejected flag does not, and retrying it for an hour turns
            # a five-minute fix into a mystery.
            message = f"kanban {' '.join(args[:2])} exited {code}: {self._last_stderr[:400]}"
            if _looks_transient(self._last_stderr):
                raise KanbanUnavailable(message)
            raise KanbanError(message)

        return out

    def _run_json(self, args: Sequence[str]) -> Any:
        out = self._run(args)
        try:
            return json.loads(out)
        except json.JSONDecodeError as error:
            raise KanbanError(
                f"kanban {' '.join(args[:2])} did not return JSON: {out[:200]!r}"
            ) from error

    # -- argument lists ------------------------------------------------------
    #
    # Every CLI invocation the bridge makes is built here and nowhere else. See
    # the module docstring for what was verified and when.

    def _argv_create(
        self,
        spec: CardSpec,
        tenant: str,
        parent: str | None,
        created_by: str,
        max_runtime: str,
    ) -> list[str]:
        # `title` is positional. `--workspace` is deliberately absent: it selects
        # the working-directory kind, not a namespace, and its default (scratch)
        # gives each card its own directory.
        argv = ["create", spec.title, "--body", spec.body, "--tenant", tenant]
        if spec.idempotency_key:
            argv += ["--idempotency-key", spec.idempotency_key]
        if spec.assignee:
            argv += ["--assignee", spec.assignee]
        if parent:
            argv += ["--parent", parent]
        if max_runtime:
            # The dispatcher SIGTERMs a worker that exceeds this and re-queues
            # the card. A second ceiling under the run's deadline, enforced by
            # the side that can actually stop a running turn.
            argv += ["--max-runtime", max_runtime]
        argv += ["--created-by", created_by, "--json"]
        return argv

    def _argv_show(self, task_id: str) -> list[str]:
        return ["show", task_id, "--json"]

    def _argv_runs(self, task_id: str) -> list[str]:
        return ["runs", task_id, "--json"]

    def _argv_list(self, tenant: str | None = None) -> list[str]:
        argv = ["list"]
        if tenant:
            argv += ["--tenant", tenant]
        return argv + ["--json"]

    def _argv_list_plain(self) -> list[str]:
        return ["list"]

    def _argv_block(self, task_id: str, reason: str) -> list[str]:
        # Reason is positional, and the kind is what makes the block stick.
        return ["block", task_id, reason, "--kind", BLOCK_KIND]

    # -- reads ---------------------------------------------------------------

    def show(self, task_id: str) -> dict[str, Any]:
        _require_task_id(task_id)
        payload = self._run_json(self._argv_show(task_id))
        if not isinstance(payload, dict):
            raise KanbanError(
                f"kanban show {task_id} returned {type(payload).__name__}, not an object"
            )
        return payload

    def task(self, task_id: str) -> KanbanTask:
        payload = self.show(task_id)
        row = payload.get("task") if isinstance(payload.get("task"), dict) else payload
        return _task_from_row(row) or KanbanTask(id=task_id, title="", status="")

    def latest_run(self, task_id: str) -> dict[str, Any]:
        """
        The card's last run, which is where a handoff actually lives.

        `show` reports `result: null` for a card that completed perfectly -- the
        payload a card hands on is stored on the run, not the task row. Reading
        the wrong one is the single most common way to conclude a working chain
        is broken.

        The *last* run, not the first: a card that blocked, was unblocked and
        then passed is healthy, and judging it on its first attempt would report
        a fault that no longer exists.
        """
        _require_task_id(task_id)
        runs = self._run_json(self._argv_runs(task_id))
        if not isinstance(runs, list) or not runs:
            return {}
        last = runs[-1]
        return last if isinstance(last, dict) else {}

    def latest_metadata(self, task_id: str) -> dict[str, Any]:
        metadata = self.latest_run(task_id).get("metadata")
        return metadata if isinstance(metadata, dict) else {}

    def block_reason(self, task_id: str) -> str:
        """
        Why a card is blocked, read off its most recent `blocked` event.

        `kanban_block` takes only a task id, a reason and a kind -- it has no
        `metadata` parameter, so a blocked card's structured detail lives in a
        comment and this string is the only machine-readable carrier. That is
        why the verifier protocol makes the `VERDICT=FAIL:` prefix mandatory.

        The event shape is verified: the live board's blocked events carry
        `payload.reason`, `payload.kind`, `payload.recurrences` and
        `payload.source_status`.
        """
        payload = self.show(task_id)
        events = payload.get("events")
        if not isinstance(events, list):
            return ""
        blocked = [
            event
            for event in events
            if isinstance(event, dict) and event.get("kind") == "blocked"
        ]
        if not blocked:
            return ""
        detail = blocked[-1].get("payload")
        if isinstance(detail, dict):
            return str(detail.get("reason") or "")
        return ""

    def tasks_for_tenant(self, tenant: str) -> list[KanbanTask]:
        """
        Every card in one job's namespace, in one call.

        `--tenant` is a real filter on the board, verified against the live CLI,
        so this returns exactly this job's cards even on a board shared with
        operator work. It is both the poll and the recovery read: a worker that
        died between creating cards and writing down their ids finds them here.

        Falls back to scraping ids out of the plain listing if `--json` is ever
        withdrawn, because a recovery path that depends on an output format is
        not a recovery path.
        """
        try:
            payload = self._run_json(self._argv_list(tenant))
        except KanbanUnavailable:
            raise
        except KanbanError:
            log.info("kanban list --json unavailable; falling back to the plain listing")
            return self._tasks_for_tenant_plain(tenant)

        # The live CLI returns a bare array. A dict with `tasks` is accepted too
        # so a future shape change is a no-op here.
        rows = payload.get("tasks") if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            return self._tasks_for_tenant_plain(tenant)

        found = [_task_from_row(row) for row in rows if isinstance(row, dict)]
        return [task for task in found if task is not None]

    def _tasks_for_tenant_plain(self, tenant: str) -> list[KanbanTask]:
        out = self._run(self._argv_list_plain())
        ids = sorted({match for match in re.findall(r"t_[0-9a-f]{8,}", out)})
        found: list[KanbanTask] = []
        for task_id in ids:
            try:
                payload = self.show(task_id)
            except KanbanError:
                continue
            row = payload.get("task") if isinstance(payload.get("task"), dict) else payload
            if isinstance(row, dict) and str(row.get("tenant") or "") == tenant:
                task = _task_from_row(row)
                if task is not None:
                    found.append(task)
        return found

    # -- writes --------------------------------------------------------------

    def create_chain(
        self,
        specs: Sequence[CardSpec],
        tenant: str,
        parent: str | None = None,
        created_by: str = "hermes",
        max_runtime: str = "",
    ) -> list[KanbanTask]:
        """
        Create the cards in order, each one the child of the one before it.

        A chain rather than a fan-out, and explicit rather than decomposed:
        `auto_decompose` is off on this host and must stay off, so the DAG is
        exactly the cards named here and nothing else can appear on the board
        because a model thought it should.

        Every card carries an idempotency key, so running this twice returns the
        same four ids rather than creating four more. That is the property the
        whole bridge rests on: a worker that dies between creating a card and
        recording its id can simply create it again.

        `parent` is the card the first new one hangs from, which is how a
        half-created chain is finished rather than restarted.
        """
        created: list[KanbanTask] = []

        for spec in specs:
            payload = self._run_json(
                self._argv_create(spec, tenant, parent, created_by, max_runtime)
            )
            task = _task_from_row(payload) if isinstance(payload, dict) else None
            task_id = task.id if task else _task_id_from(payload)
            if not task_id:
                raise KanbanError(
                    f"kanban create for {spec.key!r} returned no usable task id: "
                    f"{str(payload)[:200]}"
                )
            created.append(
                KanbanTask(id=task_id, title=spec.title, status=task.status if task else "todo")
            )
            parent = task_id

        return created

    def block(self, task_id: str, reason: str) -> bool:
        """
        Stop a card, best effort.

        Used when a run passes its deadline or its job is cancelled: leaving a
        chain running against a job nobody is waiting on spends the host's
        single core on nothing. Blocking rather than deleting, because a blocked
        card is evidence and a deleted one is a gap -- and because
        `request_changes` would reset it to `ready` and have the dispatcher run
        it again, which is the opposite of stopping it.

        Returns whether it worked. A failure here is logged and never raised:
        the customer's job has already been decided by the time this is called,
        and a card that is already blocked answers `cannot block <id>`, which is
        the outcome we wanted anyway.
        """
        try:
            self._run(self._argv_block(task_id, reason))
            return True
        except KanbanError as error:
            log.warning("could not stop kanban task %s: %s", task_id, error)
            return False


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------


def _subprocess_runner(argv: Sequence[str], timeout: int) -> tuple[int, str, str]:
    # No shell, stdin closed. `docker exec` without a closed stdin has hung a
    # CLI call in this repo before -- `scripts/kanban-verdict-audit.sh` carries
    # `< /dev/null` on every invocation for the same reason.
    completed = subprocess.run(  # noqa: S603 - argv list, never a shell string
        list(argv),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    return completed.returncode, completed.stdout, completed.stderr


class DockerExecRunner:
    """
    Run the CLI inside another container, over the Docker exec API.

    The board lives in the agent's container and the worker lives in its own,
    with no shared filesystem. The obvious answer -- mount the Docker socket and
    shell out to `docker exec` -- gives this process root on the host, and this
    process already holds the Supabase service key. One compromise would then be
    the host *and* every tenant's data.

    So the socket is not mounted here. A `docker-socket-proxy` sits in front of
    it, allowing only the container and exec endpoints, and this class speaks
    that API directly rather than through a `docker` binary the image does not
    need to contain. What the worker can do becomes "exec in a container"
    instead of "anything the daemon can do": no creating privileged containers,
    no mounting the host filesystem, no reading other containers' images.

    That is still a real privilege, and it is worth saying plainly: exec into the
    agent container is enough to read that container's secrets. It is narrower
    than root on the host, not harmless.

    Stdin is never attached, which is the API-level equivalent of the
    `< /dev/null` that every `docker exec` in this repo's scripts carries -- a
    CLI waiting on a stdin that never closes is a hang, not an error.
    """

    def __init__(
        self,
        base_url: str,
        container: str,
        user: str = "",
        client: Any = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.container = container
        self.user = user
        self._client = client

    def _http(self) -> Any:
        if self._client is None:
            import httpx

            self._client = httpx.Client(timeout=httpx.Timeout(120.0, connect=10.0))
        return self._client

    def __call__(self, argv: Sequence[str], timeout: int) -> tuple[int, str, str]:
        import httpx

        client = self._http()
        payload: dict[str, Any] = {
            "AttachStdin": False,
            "AttachStdout": True,
            "AttachStderr": True,
            "Tty": False,
            "Cmd": list(argv),
        }
        if self.user:
            payload["User"] = self.user

        try:
            created = client.post(
                f"{self.base_url}/containers/{self.container}/exec",
                json=payload,
                timeout=timeout,
            )
            if created.status_code == 404:
                raise KanbanUnavailable(
                    f"no such container {self.container!r} behind the docker proxy"
                )
            if created.status_code >= 400:
                raise KanbanError(
                    f"docker exec create failed with {created.status_code}: "
                    f"{created.text[:200]}"
                )
            exec_id = (created.json() or {}).get("Id")
            if not exec_id:
                raise KanbanError("docker exec create returned no id")

            started = client.post(
                f"{self.base_url}/exec/{exec_id}/start",
                json={"Detach": False, "Tty": False},
                timeout=timeout,
            )
            if started.status_code >= 400:
                raise KanbanError(
                    f"docker exec start failed with {started.status_code}: "
                    f"{started.text[:200]}"
                )

            out, err = _demultiplex(started.content)

            inspected = client.get(f"{self.base_url}/exec/{exec_id}/json", timeout=timeout)
            code = (inspected.json() or {}).get("ExitCode")
            # A null ExitCode means the daemon still thinks it is running, which
            # after a non-detached start means we read the whole stream and the
            # bookkeeping has not caught up. Treat it as success only if the
            # command said nothing on stderr.
            if code is None:
                code = 0 if not err.strip() else 1

        except httpx.TimeoutException as error:
            raise KanbanUnavailable(
                f"the docker proxy did not answer within {timeout}s"
            ) from error
        except httpx.HTTPError as error:
            raise KanbanUnavailable(f"cannot reach the docker proxy: {error}") from error

        return int(code), out, err


def _demultiplex(body: bytes) -> tuple[str, str]:
    """
    Split Docker's multiplexed stream into stdout and stderr.

    Without a TTY the daemon interleaves both on one connection, framed as an
    8-byte header -- stream type, three zero bytes, then a big-endian length --
    followed by that many bytes. Concatenating the raw body instead would splice
    those headers into the JSON the CLI printed, and the parse error would name
    the JSON rather than the framing.
    """
    if not _is_framed(body):
        # An older daemon, or a TTY session, or a proxy that unwrapped it.
        # Returning the body verbatim is better than returning four bytes of it,
        # which is what reading a length out of ASCII produces.
        return body.decode("utf-8", "replace"), ""

    stdout: list[bytes] = []
    stderr: list[bytes] = []
    offset = 0

    while offset + 8 <= len(body):
        stream = body[offset]
        size = int.from_bytes(body[offset + 4:offset + 8], "big")
        offset += 8
        chunk = body[offset:offset + size]
        offset += size
        if stream == 2:
            stderr.append(chunk)
        else:
            stdout.append(chunk)

    return (
        b"".join(stdout).decode("utf-8", "replace"),
        b"".join(stderr).decode("utf-8", "replace"),
    )


def _is_framed(body: bytes) -> bool:
    """
    Does this actually look like Docker's frame format?

    Checking rather than assuming, because the failure of assuming is quiet: a
    plain `[]` is twelve bytes, which is long enough to be read as a header, and
    the length field then comes out of the ASCII. The result is a few bytes of
    the real output and no error anywhere.

    A real header is a known stream type followed by three zero bytes, and the
    frames tile the body exactly.
    """
    offset = 0
    while offset + 8 <= len(body):
        if body[offset] not in (0, 1, 2) or any(body[offset + 1:offset + 4]):
            return False
        offset += 8 + int.from_bytes(body[offset + 4:offset + 8], "big")
    return offset == len(body) and offset > 0


_TRANSIENT = (
    "is not running",
    "no such container",
    "cannot connect",
    "connection refused",
    "temporarily unavailable",
    "database is locked",
    "resource busy",
    "no such container",
)


def _looks_transient(stderr: str) -> bool:
    lowered = stderr.lower()
    return any(needle in lowered for needle in _TRANSIENT)


def _require_task_id(task_id: str) -> None:
    if not TASK_ID.match(task_id or ""):
        raise KanbanError(f"{task_id!r} is not a kanban task id")


def _task_from_row(row: Any) -> KanbanTask | None:
    if not isinstance(row, dict):
        return None
    task_id = str(row.get("id") or "")
    if not TASK_ID.match(task_id):
        return None
    return KanbanTask(
        id=task_id,
        title=str(row.get("title") or ""),
        status=str(row.get("status") or "").strip().lower(),
    )


def _task_id_from(payload: Any) -> str | None:
    """Pull a task id out of whatever shape `create --json` returns."""
    candidates: Iterable[Any]
    if isinstance(payload, dict):
        task = payload.get("task")
        candidates = (
            payload.get("id"),
            task.get("id") if isinstance(task, dict) else None,
            payload.get("task_id"),
        )
    elif isinstance(payload, str):
        candidates = (payload,)
    else:
        candidates = ()

    for candidate in candidates:
        if isinstance(candidate, str) and TASK_ID.match(candidate):
            return candidate
    return None


def split_command(raw: str) -> tuple[str, ...]:
    """
    Split HERMES_KANBAN_COMMAND into an argument list.

    posix=True even on Windows: the value describes a command run on the agent
    host, which is Linux, and a developer setting it on a laptop should get the
    same split the VPS will.
    """
    parts = tuple(shlex.split(raw, posix=True))
    return parts or ("hermes",)


# -----------------------------------------------------------------------------
# Operator probe
# -----------------------------------------------------------------------------


def _probe(client: KanbanClient) -> int:
    """
    Read-only check that each argument list this module builds is accepted.

    Creates nothing. The point is to find a renamed flag on the agent host, in a
    terminal, in ten seconds -- rather than in a customer's job three minutes
    into a chain that cannot be recorded.
    """
    checks: list[tuple[str, Callable[[], Any]]] = [
        ("list --json", lambda: client._run_json(client._argv_list())),
        ("list --tenant --json", lambda: client._run_json(client._argv_list("probe-none"))),
        ("list", lambda: client._run(client._argv_list_plain())),
        ("create --help", lambda: client._run(["create", "--help"])),
        ("show --help", lambda: client._run(["show", "--help"])),
        ("runs --help", lambda: client._run(["runs", "--help"])),
        ("block --help", lambda: client._run(["block", "--help"])),
    ]

    failures = 0
    for name, check in checks:
        try:
            check()
            print(f"ok       {name}")
        except KanbanError as error:
            failures += 1
            print(f"FAILED   {name}: {error}")

    # The flags this module depends on, checked by name against the CLI's own
    # help rather than by running a create. Verified present on 2026-08-31; this
    # is what catches a Hermes upgrade that renames one.
    try:
        help_text = client._run(["create", "--help"])
        for flag in ("--body", "--assignee", "--parent", "--tenant",
                     "--idempotency-key", "--max-runtime", "--created-by", "--json"):
            if flag not in help_text:
                failures += 1
                print(f"FAILED   create {flag} is gone")
        if "--title" in help_text:
            failures += 1
            print("FAILED   create now takes --title; the title is passed positionally")
    except KanbanError as error:
        failures += 1
        print(f"FAILED   create --help: {error}")

    print()
    if failures:
        print(
            f"{failures} check(s) failed. Correct the matching _argv_* builder in "
            f"hermes/kanban.py before enabling the bridge."
        )
        return 1
    print("every argument list this bridge builds is accepted by the CLI.")
    return 0


def runner_for(settings: Any) -> Callable[[Sequence[str], int], tuple[int, str, str]] | None:
    """
    The transport a KanbanConfig asks for.

    None means the default -- run it in this process's own container, which is
    right for the systemd deployment and for a developer with the CLI on their
    path. A docker host means go through the proxy.
    """
    if not getattr(settings, "docker_host", ""):
        return None
    if not getattr(settings, "container", ""):
        raise KanbanError(
            "HERMES_KANBAN_DOCKER_HOST is set but HERMES_KANBAN_CONTAINER is not, "
            "so there is nothing to exec into."
        )
    return DockerExecRunner(
        base_url=settings.docker_host,
        container=settings.container,
        user=getattr(settings, "container_user", ""),
    )


def main(argv: Sequence[str] | None = None) -> int:
    import argparse
    import os

    parser = argparse.ArgumentParser(prog="python -m hermes.kanban")
    parser.add_argument("--probe", action="store_true", help="check the CLI contract, read-only")
    parser.add_argument("--board", default=os.environ.get("HERMES_KANBAN_BOARD", "dataengine"))
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(name)s: %(message)s")

    # Built from the environment exactly the way the worker builds it, so a
    # green probe means the worker's transport works and not merely that some
    # transport does.
    from .config import load_config
    from .worker import load_local_env

    load_local_env()
    settings = load_config().kanban

    client = KanbanClient(
        command=settings.command,
        board=args.board or settings.board,
        timeout_seconds=settings.timeout_seconds,
        runner=runner_for(settings),
    )
    print(f"board:     {client.board}")
    print(f"command:   {' '.join(client.command)}")
    print(f"transport: {'docker exec via ' + settings.docker_host + ' -> ' + settings.container if settings.docker_host else 'local subprocess'}")
    print()

    if args.probe:
        return _probe(client)

    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
