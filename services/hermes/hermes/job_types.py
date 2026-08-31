"""
The three types a job handler works with, in a module of their own.

Split out of `jobs.py` for one reason: `hermes.bridge` is a handler that needs
them, and `jobs.py` needs the bridge to register its handler. Sharing the types
through a leaf module makes that a straight line instead of a cycle that happens
to work when the modules are imported in one order and fails in the other.

`jobs.py` re-exports all three, so `from .jobs import JobContext` -- which most
of the codebase says -- keeps meaning what it meant.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .config import Config
from .llm.router import LLMRouter
from .supabase import SupabaseClient


class JobError(RuntimeError):
    """
    A failure whose message is safe and useful to show the accountant.

    Distinct from an unexpected exception: "Legacy .xls files are not supported"
    belongs on screen, whereas a KeyError does not. The worker shows the first
    verbatim and replaces the second with a generic message plus a log line.

    `retryable` defaults to False because a JobError describes a *conclusion*,
    not an accident -- the file really is an .xls, the blocking issue really is
    unresolved, and running it twice more produces the same sentence three
    times while the accountant waits to read it once. Failures worth retrying
    are the ones that raise something else.
    """

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class JobDeferred(Exception):
    """
    Not finished, not failed -- waiting on something slow, and yielding.

    Raised by a handler whose work is happening somewhere else and will take
    longer than a worker should sit still for. The worker hands the job back to
    the queue with `defer_agent_job`, which returns the attempt it consumed and
    makes the row unclaimable until `delay_seconds` have passed.

    Distinct from returning a result (the job is done) and from JobError (the
    job is over and the accountant needs a sentence). A deferral says nothing to
    the customer beyond the progress line it carries, because from their side
    nothing has happened yet -- the work is still running.
    """

    def __init__(
        self,
        delay_seconds: int,
        progress: dict[str, Any] | None = None,
        reason: str = "",
    ):
        super().__init__(reason or f"deferred for {delay_seconds}s")
        self.delay_seconds = max(int(delay_seconds), 1)
        self.progress = progress or {}
        self.reason = reason


@dataclass
class JobContext:
    config: Config
    supabase: SupabaseClient
    llm: LLMRouter
    job: dict[str, Any]
    # Extends the lease and reports progress. Called by anything slow enough to
    # risk the lease expiring underneath it.
    heartbeat: Callable[[dict[str, Any]], None]

    @property
    def job_id(self) -> str:
        return self.job["id"]

    @property
    def workspace_id(self) -> str:
        return self.job["workspace_id"]

    @property
    def payload(self) -> dict[str, Any]:
        return self.job.get("payload") or {}

    def requested_by(self) -> str | None:
        return self.job.get("requested_by")
