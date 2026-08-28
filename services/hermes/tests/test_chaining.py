"""
The chaining rules, and the loop they used to produce.

The pipeline is meant to run

    parse -> profile -> propose -> (a person approves) -> apply -> profile -> stop

and it did not. apply_cleaning chains to profile_dataset so the new version gets
measured, and profile_dataset chained onward to propose_cleaning unconditionally
-- so every apply handed back a fresh queue against the version just cleaned to
the reviewer's approval, and some items recurred verbatim because they cannot be
satisfied by applying them.

Nothing caught it, because the handlers had no tests: the tools are pure and
were tested, the handlers talk to Supabase and were not. These use a fake client
that records the RPCs, which is enough to assert what the pipeline *decides*
without a database.

The assertions are about the shape of the chain, not about parsing or profiling
-- those belong to test_tools.py.
"""

from __future__ import annotations

import io
from typing import Any

import polars as pl
import pytest

from hermes.config import Config, LLMConfig
from hermes.jobs import HANDLERS, JobContext, handle_apply_cleaning, handle_profile_dataset
from hermes.tools.clean import ADVISORY_OPERATIONS, OPERATIONS, Table
from hermes.tools.propose import KNOWN_OPERATIONS


def _parquet() -> bytes:
    frame = pl.DataFrame(
        {
            "__source_row": [1, 2, 3],
            "vendor": ["ACME Ltd", "Globex", "ACME Ltd"],
            "amount": [100.0, 250.5, 100.0],
        }
    )
    buffer = io.BytesIO()
    frame.write_parquet(buffer)
    return buffer.getvalue()


class FakeSupabase:
    """Records every RPC so a test can assert what the handler decided to queue."""

    def __init__(self, proposed: list[dict[str, Any]] | None = None):
        self.rpc_calls: list[tuple[str, dict[str, Any]]] = []
        self.proposed = proposed or []
        self.parquet = _parquet()

    def select(self, table: str, **kwargs: Any) -> list[dict[str, Any]]:
        if table == "dataset_versions":
            return [
                {
                    "id": "version-1",
                    "dataset_id": "dataset-1",
                    "version_no": 1,
                    "kind": "cleaned",
                    "parquet_path": "org/ws/2026-08/dataset-1__job.parquet",
                    "row_count": 3,
                    "parent_version_id": None,
                    "produced_by_run_id": None,
                }
            ]
        if table == "proposed_changes":
            filters = kwargs.get("filters") or {}
            wanted = filters.get("status", "").removeprefix("eq.")
            if wanted == "approved":
                return self.proposed
            return []
        if table == "datasets":
            return [{"id": "dataset-1", "name": "Ledger"}]
        return []

    def download(self, bucket: str, path: str, max_bytes: int) -> bytes:
        return self.parquet

    def upload(self, bucket: str, path: str, data: bytes, **kwargs: Any) -> Any:
        class Stored:
            pass

        stored = Stored()
        stored.bucket, stored.path, stored.size = bucket, path, len(data)
        return stored

    def rpc(self, function: str, params: dict[str, Any] | None = None) -> Any:
        self.rpc_calls.append((function, params or {}))
        if function == "record_dataset_version":
            return {"id": "version-2", "version_no": 2}
        if function == "match_recipe":
            return []
        # The recipe capture path reads ids back off its own writes.
        if function in {"capture_recipe", "ensure_mapping_table", "start_recipe_run"}:
            return {"id": f"{function}-1", "version_no": 1}
        return None

    # -- helpers for assertions ------------------------------------------------

    def enqueued(self) -> list[dict[str, Any]]:
        return [params for name, params in self.rpc_calls if name == "enqueue_agent_job_internal"]

    def called(self, name: str) -> bool:
        return any(call == name for call, _ in self.rpc_calls)


def _context(supabase: FakeSupabase, payload: dict[str, Any]) -> JobContext:
    config = Config(
        supabase_url="https://example.supabase.co",
        service_key="test",
        worker_id="test",
        hostname="test",
        llm=LLMConfig(),
    )
    return JobContext(
        config=config,
        supabase=supabase,
        llm=None,
        job={
            "id": "job-1",
            "workspace_id": "ws-1",
            "org_id": "org-1",
            "dataset_version_id": "version-1",
            "payload": payload,
            "requested_by": None,
        },
        heartbeat=lambda progress: None,
    )


# -----------------------------------------------------------------------------
# The chain
# -----------------------------------------------------------------------------


def test_profile_after_a_parse_proposes():
    """The first profile is what fills the review queue. It must keep doing so."""
    supabase = FakeSupabase()
    handle_profile_dataset(_context(supabase, {}))

    kinds = [job["p_kind"] for job in supabase.enqueued()]
    assert kinds == ["propose_cleaning"]


def test_profile_after_an_apply_does_not_propose():
    """
    The loop, asserted directly.

    A profile asked not to propose must queue nothing at all -- not a
    propose_cleaning with a flag, not a deferred one. Nothing.
    """
    supabase = FakeSupabase()
    handle_profile_dataset(_context(supabase, {"propose": False}))

    assert supabase.enqueued() == []
    assert supabase.called("record_dataset_profile"), "the profile itself must still be recorded"


def test_apply_chains_a_profile_that_will_not_propose():
    """
    The other half of the same rule.

    apply_cleaning is entitled to queue a profile -- section 5.3's invariants
    need the output measured. It is not entitled to queue one that proposes,
    because that is the loop.
    """
    supabase = FakeSupabase(
        proposed=[
            {
                "id": "c1",
                "group_key": "whitespace:vendor",
                "step_type": "normalize_whitespace",
                "operation": {"op": "normalize_whitespace", "column": "vendor"},
                "confidence": "high",
                "affected_rows": 2,
            }
        ]
    )
    handle_apply_cleaning(_context(supabase, {}))

    queued = supabase.enqueued()
    assert [job["p_kind"] for job in queued] == ["profile_dataset"]
    assert queued[0]["p_payload"] == {"propose": False}


def test_the_full_lifecycle_terminates():
    """
    Walk the chain the way the worker does and show it stops.

    parse's link is asserted by test_tools; this picks up at the profile and
    follows every job the handlers queue until none are left. The point is the
    loop's absence: the sequence has to end.
    """
    seen: list[str] = []
    payload: dict[str, Any] = {}
    supabase = FakeSupabase(
        proposed=[
            {
                "id": "c1",
                "group_key": "whitespace:vendor",
                "step_type": "normalize_whitespace",
                "operation": {"op": "normalize_whitespace", "column": "vendor"},
                "confidence": "high",
                "affected_rows": 2,
            }
        ]
    )

    # profile (post-parse) -> propose
    handle_profile_dataset(_context(supabase, payload))
    seen.append("profile")
    assert [job["p_kind"] for job in supabase.enqueued()] == ["propose_cleaning"]

    # ... a person approves, then apply -> profile(propose=False)
    supabase.rpc_calls.clear()
    handle_apply_cleaning(_context(supabase, {}))
    seen.append("apply")
    chained = supabase.enqueued()
    assert [job["p_kind"] for job in chained] == ["profile_dataset"]

    # that profile queues nothing, so the pipeline is over
    supabase.rpc_calls.clear()
    handle_profile_dataset(_context(supabase, chained[0]["p_payload"]))
    seen.append("profile")
    assert supabase.enqueued() == [], "the post-apply profile must end the chain"

    assert seen == ["profile", "apply", "profile"]


# -----------------------------------------------------------------------------
# Advisory findings
# -----------------------------------------------------------------------------


def test_advisories_alone_write_no_new_version():
    """
    review_key_conflicts and its siblings change nothing.

    Applying a set of only these used to write a version byte-identical to its
    parent and report a successful cleaning. It must acknowledge them instead --
    and leave the lineage alone.
    """
    supabase = FakeSupabase(
        proposed=[
            {
                "id": "c1",
                "group_key": "duplicates:key_conflict",
                "step_type": "review_key_conflicts",
                "operation": {"op": "review_key_conflicts", "column": "vendor"},
                "confidence": "medium",
                "affected_rows": 132,
            }
        ]
    )
    result = handle_apply_cleaning(_context(supabase, {}))

    assert not supabase.called("record_dataset_version"), "no version may be written"
    assert supabase.enqueued() == [], "and nothing may be queued off the back of it"
    assert supabase.called("mark_changes_applied"), "but the decision is still recorded"
    assert result["new_dataset_version_id"] is None
    assert result["rows_changed"] == 0
    assert result["acknowledged"] == ["duplicates:key_conflict"]


def test_advisories_alongside_real_changes_still_apply():
    """A review item must not veto the changes it was approved with."""
    supabase = FakeSupabase(
        proposed=[
            {
                "id": "c1",
                "group_key": "duplicates:key_conflict",
                "step_type": "review_key_conflicts",
                "operation": {"op": "review_key_conflicts", "column": "vendor"},
                "confidence": "medium",
                "affected_rows": 132,
            },
            {
                "id": "c2",
                "group_key": "whitespace:vendor",
                "step_type": "normalize_whitespace",
                "operation": {"op": "normalize_whitespace", "column": "vendor"},
                "confidence": "high",
                "affected_rows": 2,
            },
        ]
    )
    handle_apply_cleaning(_context(supabase, {}))

    assert supabase.called("record_dataset_version")


def test_every_advisory_operation_is_a_noop():
    """
    The registry and the advisory set must agree.

    Derived rather than hand-listed for exactly this reason -- the worker's
    capability tuple drifted from its handler table the same way, silently, and
    two features stopped working.
    """
    for name in ADVISORY_OPERATIONS:
        assert name in OPERATIONS, f"{name} is advisory but not in the operation registry"

    # Called through the registry rather than through apply_operations, so the
    # assertion is about the operation itself and not about the applier's
    # bookkeeping around it.
    original = ["  ACME  ", "Globex"]
    for name in ADVISORY_OPERATIONS:
        table = Table({"vendor": list(original)}, [1, 2])
        result = OPERATIONS[name](table, {"column": "vendor", "__op": name})
        assert result.rows_changed == 0, f"{name} reported changing rows"
        assert result.rows_removed == 0, f"{name} reported removing rows"
        assert table.columns["vendor"] == original, f"{name} altered values"


def test_advisory_operations_are_proposable():
    """An advisory the proposer cannot emit is dead code; one it emits and the applier does not know is a crash."""
    assert ADVISORY_OPERATIONS <= KNOWN_OPERATIONS


def _worker(capabilities: tuple[str, ...] = ()):
    from hermes.worker import Worker

    return Worker(
        Config(
            supabase_url="https://example.supabase.co",
            service_key="test",
            worker_id="test",
            hostname="test",
            capabilities=capabilities,
            llm=LLMConfig(),
        )
    )


def test_worker_announces_every_kind_it_can_run():
    """
    Guards the bug class that hid replay_recipe and export_dataset for weeks.

    The capability list is sent to claim_agent_job as p_kinds, so a kind the
    worker fails to announce is one the database filters out of every claim:
    the job enqueues, reports queued, and waits forever with nothing anywhere
    to say why. Asserting on a constructed worker rather than on the constant
    means the resolution itself is under test.
    """
    worker = _worker()
    try:
        assert set(worker.capabilities) == set(HANDLERS)
        for required in ("parse_workbook", "apply_cleaning", "replay_recipe", "export_dataset"):
            assert required in worker.capabilities, f"{required} would never be claimed"
    finally:
        worker.close()


def test_a_worker_cannot_announce_a_kind_it_cannot_run():
    """
    The opposite failure, which is worse.

    Announcing an unrunnable kind means claiming those jobs and failing every
    one, so it is refused at startup rather than at three in the morning.
    """
    from hermes.config import ConfigError

    with pytest.raises(ConfigError, match="no handler"):
        _worker(("parse_workbook", "make_the_tea"))
