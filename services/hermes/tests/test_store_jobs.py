"""
The two store handlers, against a fake Supabase.

The tools are pure and tested elsewhere. What is only testable here is what the
handlers *decide*: whether a job may read the connection its payload names,
whether a re-sync adds to the ledger or replaces it, whether a correction wins
over the stale row it corrects, and whether a report waits for the sync it was
scheduled alongside instead of reporting on yesterday's data.

Every one of those is a decision no unit test of `retail.py` can reach, and the
first is the one that matters most: the job row is the authority on tenancy and
the payload is not.
"""

from __future__ import annotations

import datetime as dt
import io
import json
from typing import Any

import polars as pl
import pytest

from hermes.config import Config, LLMConfig, StoreConfig
from hermes.connectors import ledger
from hermes.connectors.ledger import FxRates, LedgerEntry
from hermes.jobs import (
    JobDeferred,
    JobError,
    handle_store_financials,
    handle_sync_store,
    handle_test_store_connection,
)

USD = FxRates(base="USD", rates={"SOS": __import__("decimal").Decimal("570")})

CONNECTION = {
    "id": "conn-1",
    "org_id": "org-1",
    "workspace_id": "ws-1",
    "dataset_id": "dataset-1",
    "name": "Suuqa Hodan",
    "source": "excel",
    "status": "active",
    "config": {},
    "base_currency": "USD",
    "secondary_currency": "SOS",
    "secondary_rate": "570",
    "rate_as_of": "2026-08-01",
    "language": "so",
    "week_start": 5,
    "balances": {},
    "created_by": None,
    "secret": None,
}


def entry(day: str, kind: str, amount: str, ref: str, **kwargs) -> LedgerEntry:
    from decimal import Decimal

    return LedgerEntry(
        occurred_on=dt.date.fromisoformat(day),
        kind=kind,
        category=kwargs.pop("category", "sales" if kind == "revenue" else "rent"),
        amount=Decimal(amount),
        currency="USD",
        source_ref=ref,
        **kwargs,
    )


def ledger_parquet(entries: list[LedgerEntry]) -> bytes:
    columns = ledger.to_columns(entries, USD)
    frame = pl.DataFrame(
        {"__source_row": list(range(1, len(entries) + 1)), **columns},
        strict=False,
        infer_schema_length=None,
    )
    buffer = io.BytesIO()
    frame.write_parquet(buffer)
    return buffer.getvalue()


def workbook(rows: list[list]) -> bytes:
    from openpyxl import Workbook

    book = Workbook()
    sheet = book.active
    sheet.append(["Suuqa Hodan — iibka"])
    sheet.append([])
    for row in rows:
        sheet.append(row)
    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


class FakeSupabase:
    """Records every RPC so a test can assert what the handler decided."""

    def __init__(
        self,
        *,
        connection: dict[str, Any] | None = None,
        versions: list[dict[str, Any]] | None = None,
        parquet: bytes | None = None,
        raw: bytes | None = None,
        sync_runs: list[dict[str, Any]] | None = None,
        jobs: list[dict[str, Any]] | None = None,
    ):
        self.rpc_calls: list[tuple[str, dict[str, Any]]] = []
        self.uploads: list[tuple[str, str, bytes]] = []
        self.connection = dict(connection or CONNECTION)
        self.versions = versions or []
        self.parquet = parquet
        self.raw = raw
        self.sync_runs = sync_runs or []
        self.jobs = jobs or []

    def select(self, table: str, **kwargs: Any) -> list[dict[str, Any]]:
        if table == "dataset_versions":
            return list(self.versions)
        if table == "store_sync_runs":
            return list(self.sync_runs)
        if table == "agent_jobs":
            return list(self.jobs)
        if table == "raw_uploads":
            return [
                {
                    "id": "upload-1",
                    "storage_path": "org-1/ws-1/2026-08/upload-1__sales.xlsx",
                    "original_filename": "sales.xlsx",
                    "created_at": "2026-08-01T00:00:00Z",
                }
            ]
        if table == "workspaces":
            return [{"id": "ws-1", "name": "Hodan"}]
        if table == "organizations":
            return [{"id": "org-1", "name": "Hodan Traders"}]
        return []

    def download(self, bucket: str, path: str, max_bytes: int) -> bytes:
        if bucket == "raw":
            assert self.raw is not None, "the test did not supply a workbook"
            return self.raw
        assert self.parquet is not None, "the test did not supply a stored ledger"
        return self.parquet

    def upload(self, bucket: str, path: str, data: bytes, **kwargs: Any) -> Any:
        self.uploads.append((bucket, path, data))

        class Stored:
            pass

        stored = Stored()
        stored.bucket, stored.path, stored.size = bucket, path, len(data)
        return stored

    def rpc(self, function: str, params: dict[str, Any] | None = None) -> Any:
        self.rpc_calls.append((function, params or {}))
        if function == "store_connection_credentials":
            return dict(self.connection)
        if function == "start_store_sync":
            return {"id": "run-1"}
        if function == "record_dataset_version":
            return {"id": "version-2", "version_no": 2}
        if function == "enqueue_agent_job_internal":
            return {"id": "job-2"}
        return None

    def called(self, name: str) -> list[dict[str, Any]]:
        return [params for call, params in self.rpc_calls if call == name]

    def stored_ledger(self) -> list[LedgerEntry]:
        bucket, _path, data = next(u for u in self.uploads if u[0] == "parquet")
        assert bucket == "parquet"
        return ledger.from_columns(pl.read_parquet(io.BytesIO(data)).to_dict(as_series=False))


def context(supabase: FakeSupabase, payload: dict[str, Any], **job: Any):
    from hermes.jobs import JobContext

    config = Config(
        supabase_url="https://example.supabase.co",
        service_key="test",
        worker_id="test",
        hostname="test",
        llm=LLMConfig(),
        store=StoreConfig(enabled=True),
    )
    return JobContext(
        config=config,
        supabase=supabase,
        llm=None,
        job={
            "id": "job-1",
            "workspace_id": "ws-1",
            "org_id": "org-1",
            "payload": payload,
            "requested_by": None,
            **job,
        },
        heartbeat=lambda progress: None,
    )


# -----------------------------------------------------------------------------
# Tenancy
# -----------------------------------------------------------------------------


class TestTenancy:
    def test_a_job_cannot_read_a_connection_from_another_workspace(self):
        """
        The load-bearing check in the whole feature.

        `enqueue_agent_job` validated the *job row's* workspace against the
        caller's membership. It did not validate the payload, and
        `store_connection_credentials` runs as the service role, which sees
        every tenant — so without this the payload would decide whose
        credentials the worker fetches.
        """
        supabase = FakeSupabase(connection={**CONNECTION, "workspace_id": "ws-someone-else"})
        with pytest.raises(JobError) as error:
            handle_sync_store(context(supabase, {"connection_id": "conn-1"}))
        assert "does not belong to this workspace" in str(error.value)

    def test_no_sync_run_is_opened_for_a_refused_connection(self):
        supabase = FakeSupabase(connection={**CONNECTION, "workspace_id": "other"})
        with pytest.raises(JobError):
            handle_sync_store(context(supabase, {"connection_id": "conn-1"}))
        assert supabase.called("start_store_sync") == []

    def test_a_job_with_no_connection_says_so(self):
        with pytest.raises(JobError) as error:
            handle_sync_store(context(FakeSupabase(), {}))
        assert "which store connection" in str(error.value)

    def test_a_report_cannot_name_a_version_from_another_ledger(self):
        supabase = FakeSupabase(
            versions=[{"id": "version-9", "dataset_id": "someone-elses-dataset", "version_no": 1,
                       "parquet_path": "p", "row_count": 1}]
        )
        with pytest.raises(JobError) as error:
            handle_store_financials(
                context(
                    supabase,
                    {"connection_id": "conn-1", "dataset_version_id": "version-9"},
                )
            )
        assert "does not belong to this store connection" in str(error.value)


# -----------------------------------------------------------------------------
# Syncing
# -----------------------------------------------------------------------------


class TestSync:
    def test_a_first_sync_writes_the_ledger_as_a_dataset_version(self):
        supabase = FakeSupabase(
            raw=workbook(
                [
                    ["Taariikh", "Sharaxaad", "Qiimaha"],
                    ["2026-08-01", "Iibka maanta", 300],
                    ["2026-08-01", "Kirada dukaanka", -150],
                ]
            )
        )
        result = handle_sync_store(context(supabase, {"connection_id": "conn-1"}))

        assert result["entries"] == 2
        recorded = supabase.called("record_dataset_version")[0]
        assert recorded["p_dataset_id"] == "dataset-1"
        # 'raw', not 'cleaned': nothing here has been cleaned or approved.
        assert recorded["p_kind"] == "raw"
        assert recorded["p_row_count"] == 2

        stored = supabase.stored_ledger()
        assert {e.category for e in stored} == {"sales", "rent"}

    def test_a_second_sync_adds_to_the_ledger_rather_than_replacing_it(self):
        """
        Each version is a complete snapshot, so a monthly report is one read of
        the latest version rather than a hunt across several.
        """
        supabase = FakeSupabase(
            versions=[{"id": "version-1", "dataset_id": "dataset-1", "version_no": 1,
                       "parquet_path": "p", "row_count": 1}],
            parquet=ledger_parquet([entry("2026-07-15", "revenue", "500", "row:9:revenue")]),
            raw=workbook([["Date", "Amount"], ["2026-08-01", 300]]),
        )
        result = handle_sync_store(context(supabase, {"connection_id": "conn-1"}))

        assert result["entries"] == 2
        stored = supabase.stored_ledger()
        assert sorted(e.occurred_on.isoformat() for e in stored) == ["2026-07-15", "2026-08-01"]

    def test_a_corrected_row_replaces_the_stale_one_rather_than_being_dropped(self):
        """
        The overlap window exists to catch edits to already-synced periods. Read
        in the wrong order, every correction it finds is discarded as a
        duplicate of the row it was meant to correct.
        """
        supabase = FakeSupabase(
            versions=[{"id": "version-1", "dataset_id": "dataset-1", "version_no": 1,
                       "parquet_path": "p", "row_count": 1}],
            # The stored ledger has row 3 at $300; the sheet now says $250.
            # Row 4 of the sheet: a title row, a blank, the header, then data.
            parquet=ledger_parquet([entry("2026-08-01", "revenue", "300", "row:4:revenue")]),
            raw=workbook([["Date", "Amount"], ["2026-08-01", 250]]),
        )
        result = handle_sync_store(context(supabase, {"connection_id": "conn-1"}))

        stored = supabase.stored_ledger()
        assert len(stored) == 1
        assert stored[0].amount == __import__("decimal").Decimal("250")
        assert result["summary"]["replaced"] == 1

    def test_the_window_reaches_back_past_the_last_successful_sync(self):
        supabase = FakeSupabase(
            sync_runs=[{"window_end": "2026-08-20", "finished_at": "2026-08-20T10:00:00Z"}],
            raw=workbook([["Date", "Amount"], ["2026-08-01", 10]]),
        )
        handle_sync_store(context(supabase, {"connection_id": "conn-1"}))
        started = supabase.called("start_store_sync")[0]
        # Seven days of overlap by default, because these systems all let
        # somebody edit last week's invoice.
        assert started["p_window_start"] == "2026-08-13"

    def test_a_window_with_no_transactions_succeeds_and_changes_nothing(self):
        supabase = FakeSupabase(
            raw=workbook(
                [
                    ["Date", "Description", "Amount"],
                    ["2026-08-01", "opening balance", None],
                    ["2026-08-02", "stock count", None],
                ]
            )
        )
        result = handle_sync_store(context(supabase, {"connection_id": "conn-1"}))
        assert result["entries"] == 0
        assert supabase.called("record_dataset_version") == []
        assert supabase.called("finish_store_sync")[0]["p_status"] == "succeeded"

    def test_a_sheet_with_no_table_in_it_reads_as_a_sentence_not_a_crash(self):
        """
        A shop's sheet with headers and no rows yet is ordinary. Reaching the
        worker's catch-all would tell them "the agent hit an unexpected error".
        """
        supabase = FakeSupabase(raw=workbook([["Date", "Amount"]]))
        with pytest.raises(JobError) as error:
            handle_sync_store(context(supabase, {"connection_id": "conn-1"}))
        assert "could not be read as a store ledger" in str(error.value)

    def test_a_failed_sync_closes_its_run_so_the_failure_is_visible(self):
        """
        "Last week is missing" and "last Tuesday's sync failed" look identical
        from the dashboard unless the failed run leaves a row.
        """
        supabase = FakeSupabase(connection={**CONNECTION, "source": "mystery"})
        with pytest.raises(JobError):
            handle_sync_store(context(supabase, {"connection_id": "conn-1"}))

        finished = supabase.called("finish_store_sync")
        assert finished and finished[0]["p_status"] == "failed"
        assert "mystery" in finished[0]["p_error"]

    def test_a_sync_can_chain_its_own_report_but_only_when_asked(self):
        supabase = FakeSupabase(raw=workbook([["Date", "Amount"], ["2026-08-01", 10]]))
        handle_sync_store(context(supabase, {"connection_id": "conn-1"}))
        assert supabase.called("enqueue_agent_job_internal") == []

        supabase = FakeSupabase(raw=workbook([["Date", "Amount"], ["2026-08-01", 10]]))
        result = handle_sync_store(
            context(supabase, {"connection_id": "conn-1", "then_report": True})
        )
        queued = supabase.called("enqueue_agent_job_internal")[0]
        assert queued["p_kind"] == "store_financials"
        assert result["report_job_id"] == "job-2"

    def test_a_connection_needing_credentials_says_which_ones(self):
        supabase = FakeSupabase(connection={**CONNECTION, "source": "odoo", "secret": None})
        with pytest.raises(JobError) as error:
            handle_sync_store(context(supabase, {"connection_id": "conn-1"}))
        assert "no stored credentials" in str(error.value)


# -----------------------------------------------------------------------------
# Reporting
# -----------------------------------------------------------------------------


AUGUST = [
    entry("2026-07-05", "revenue", "4000", "a"),
    entry("2026-07-06", "cogs", "2400", "b", category="purchases"),
    entry("2026-08-05", "revenue", "4200", "c"),
    entry("2026-08-06", "cogs", "2900", "d", category="purchases"),
    entry("2026-08-01", "expense", "400", "e", category="rent"),
]


class TestReport:
    def _supabase(self, entries=AUGUST):
        return FakeSupabase(
            versions=[{"id": "version-3", "dataset_id": "dataset-1", "version_no": 3,
                       "parquet_path": "p", "row_count": len(entries)}],
            parquet=ledger_parquet(entries),
        )

    def test_a_monthly_report_covers_the_last_complete_month(self):
        supabase = self._supabase()
        result = handle_store_financials(
            context(
                supabase,
                {"connection_id": "conn-1", "cadence": "monthly",
                 "from": "2026-07-01", "to": "2026-08-31"},
            )
        )
        figures = result["figures"]["period"]
        assert figures["revenue"] == 4200.0
        assert figures["cogs"] == 2900.0
        assert figures["net_profit"] == 900.0

    def test_the_report_is_written_in_the_connection_language(self):
        result = handle_store_financials(
            context(
                self._supabase(),
                {"connection_id": "conn-1", "from": "2026-07-01", "to": "2026-08-31"},
            )
        )
        # The connection says Somali, and nothing on the payload overrides it.
        assert result["language"] == "so"
        assert "Faa'iidada saafiga ah" in result["markdown"]

    def test_a_payload_language_overrides_the_connection(self):
        result = handle_store_financials(
            context(
                self._supabase(),
                {"connection_id": "conn-1", "language": "en",
                 "from": "2026-07-01", "to": "2026-08-31"},
            )
        )
        assert "Net profit" in result["markdown"]

    def test_the_document_lands_in_the_exports_bucket_under_the_tenant_path(self):
        supabase = self._supabase()
        result = handle_store_financials(
            context(supabase, {"connection_id": "conn-1", "from": "2026-07-01", "to": "2026-08-31"})
        )
        bucket, path, _data = supabase.uploads[-1]
        assert bucket == "exports"
        # The storage policy reads the tenant out of the first two segments.
        assert path.startswith("org-1/ws-1/")
        assert result["report_path"] == path

    def test_a_pdf_is_produced_when_one_is_asked_for(self):
        supabase = self._supabase()
        result = handle_store_financials(
            context(
                supabase,
                {"connection_id": "conn-1", "format": "pdf",
                 "from": "2026-07-01", "to": "2026-08-31"},
            )
        )
        assert result["format"] == "pdf"
        assert supabase.uploads[-1][2][:4] == b"%PDF"

    def test_a_store_that_has_never_synced_is_told_to_sync(self):
        with pytest.raises(JobError) as error:
            handle_store_financials(context(FakeSupabase(), {"connection_id": "conn-1"}))
        assert "has not been synced yet" in str(error.value)

    def test_an_unknown_reporting_period_is_refused(self):
        with pytest.raises(JobError) as error:
            handle_store_financials(
                context(FakeSupabase(), {"connection_id": "conn-1", "cadence": "fortnightly"})
            )
        assert "not a reporting period" in str(error.value)

    def test_the_report_waits_for_the_sync_it_was_scheduled_beside(self):
        """
        The schedule enqueues both jobs at once rather than chaining them, so a
        failed sync cannot silently produce no report at all. The report waits —
        and waiting is a deferral, so the worker serves somebody else meanwhile.
        """
        supabase = self._supabase()
        supabase.jobs = [{"id": "job-0", "status": "running", "error": None}]
        with pytest.raises(JobDeferred) as deferred:
            handle_store_financials(
                context(supabase, {"connection_id": "conn-1", "after_job_id": "job-0"})
            )
        assert deferred.value.delay_seconds == 30

    def test_a_report_whose_sync_failed_says_so_instead_of_reporting_stale_figures(self):
        supabase = self._supabase()
        supabase.jobs = [
            {"id": "job-0", "status": "failed", "error": "QuickBooks refused the credentials"}
        ]
        with pytest.raises(JobError) as error:
            handle_store_financials(
                context(supabase, {"connection_id": "conn-1", "after_job_id": "job-0"})
            )
        assert "QuickBooks refused the credentials" in str(error.value)

    def test_a_finished_sync_does_not_hold_the_report_up(self):
        supabase = self._supabase()
        supabase.jobs = [{"id": "job-0", "status": "succeeded", "error": None}]
        result = handle_store_financials(
            context(
                supabase,
                {"connection_id": "conn-1", "after_job_id": "job-0",
                 "from": "2026-07-01", "to": "2026-08-31"},
            )
        )
        assert result["figures"]["has_data"] is True

    def test_zakat_is_computed_when_the_connection_carries_the_balances(self):
        supabase = self._supabase()
        supabase.connection = {
            **CONNECTION,
            "balances": {"inventory_value": 10000, "cash": 2000, "receivables": 0},
        }
        result = handle_store_financials(
            context(supabase, {"connection_id": "conn-1", "from": "2026-07-01", "to": "2026-08-31"})
        )
        assert result["zakat"]["computed"] is True
        assert result["zakat"]["amount"] == 300.0

    def test_zakat_is_refused_rather_than_guessed_from_profit(self):
        result = handle_store_financials(
            context(
                self._supabase(),
                {"connection_id": "conn-1", "from": "2026-07-01", "to": "2026-08-31"},
            )
        )
        assert result["zakat"]["computed"] is False


# -----------------------------------------------------------------------------
# Setting a store up
# -----------------------------------------------------------------------------


ODOO_CONNECTION = {
    **CONNECTION,
    "source": "odoo",
    "config": {},
    "language": "so",
    "secret": None,
}


class FakeOdooClient:
    """Records what it was constructed with, so the test can assert on it."""

    last: dict[str, Any] = {}

    def __init__(self, **kwargs: Any):
        FakeOdooClient.last = kwargs

    def close(self) -> None:
        pass


class FakeQuickBooksClient:
    last: dict[str, Any] = {}

    def __init__(self, **kwargs: Any):
        FakeQuickBooksClient.last = kwargs
        self.rotated_refresh_token = None

    def close(self) -> None:
        pass


class TestConnectionSetup:
    """
    What a shop owner sees between "here is what my accountant sent me" and a
    working connection. Before this job existed they found out whether the
    four boxes they filled in were right at the first sync -- which is to say,
    when they were already waiting for a report.
    """

    def _supabase(self, connection: dict[str, Any]) -> FakeSupabase:
        return FakeSupabase(connection=connection)

    def test_a_complete_paste_connects_and_names_the_company(self, monkeypatch):
        from hermes import jobs

        monkeypatch.setattr(jobs.odoo_connector, "OdooClient", FakeOdooClient)
        monkeypatch.setattr(
            jobs.odoo_connector,
            "verify",
            lambda client: {"company_name": "Suuqa Hodan", "accounts": 84,
                            "income_accounts": 6, "expense_accounts": 21},
        )

        supabase = self._supabase({
            **ODOO_CONNECTION,
            "secret": "URL=https://hodan.odoo.com\nDB=hodan_live\n"
                      "User=api@hodan.so\nAPI_KEY=k-99887766",
        })
        result = handle_test_store_connection(context(supabase, {"connection_id": "conn-1"}))

        assert result["ok"] is True
        # The company name is the point: "connected" is a claim the owner
        # cannot check, and credentials that open the wrong company file would
        # otherwise be found at month end.
        assert "Suuqa Hodan" in result["message"]
        assert "Suuqa Hodan" in result["message_so"]
        assert result["evidence"]["accounts"] == 84

    def test_the_settings_in_the_file_are_kept_so_nobody_types_them_twice(self, monkeypatch):
        from hermes import jobs

        monkeypatch.setattr(jobs.odoo_connector, "OdooClient", FakeOdooClient)
        monkeypatch.setattr(jobs.odoo_connector, "verify", lambda client: {"company_name": "X"})

        supabase = self._supabase({
            **ODOO_CONNECTION,
            "secret": "URL=https://hodan.odoo.com\nDB=hodan_live\nUser=api@hodan.so\nKEY=k",
        })
        handle_test_store_connection(context(supabase, {"connection_id": "conn-1"}))

        setup = supabase.called("apply_store_connection_setup")[0]
        assert setup["p_base_url"] == "https://hodan.odoo.com"
        assert setup["p_database"] == "hodan_live"
        assert setup["p_username"] == "api@hodan.so"

    def test_only_the_secret_half_is_written_back_to_the_vault(self, monkeypatch):
        from hermes import jobs

        monkeypatch.setattr(jobs.odoo_connector, "OdooClient", FakeOdooClient)
        monkeypatch.setattr(jobs.odoo_connector, "verify", lambda client: {"company_name": "X"})

        supabase = self._supabase({
            **ODOO_CONNECTION,
            "secret": "URL=https://hodan.odoo.com\nDB=b\nUser=c\nKEY=the-key",
        })
        handle_test_store_connection(context(supabase, {"connection_id": "conn-1"}))

        stored = json.loads(supabase.called("rotate_store_connection_secret")[0]["p_secret"])
        assert stored == {"api_key": "the-key"}

    def test_an_incomplete_paste_names_what_is_missing_in_both_languages(self):
        supabase = self._supabase({**ODOO_CONNECTION, "secret": "just-a-key-on-its-own"})
        result = handle_test_store_connection(context(supabase, {"connection_id": "conn-1"}))

        assert result["ok"] is False
        assert set(result["missing"]) == {"base_url", "database", "username"}
        assert "Odoo address" in result["message"]
        assert "Cinwaanka Odoo" in result["message_so"]
        # And it says who to ask, which is the half the owner actually needs.
        assert result["next_step_so"]
        # Nothing was dialled and nothing was saved.
        assert supabase.called("rotate_store_connection_secret") == []

    def test_an_unreadable_paste_says_so_rather_than_failing_the_job(self):
        supabase = self._supabase({**ODOO_CONNECTION, "secret": "Dear Yahye,\n\nBest wishes"})
        result = handle_test_store_connection(context(supabase, {"connection_id": "conn-1"}))
        assert result["ok"] is False
        assert result["missing"]

    def test_a_refusal_from_the_shop_system_is_relayed_as_a_sentence(self, monkeypatch):
        from hermes import jobs

        def refuse(client):
            raise jobs.odoo_connector.OdooError(
                "Odoo rejected the username or API key for database 'hodan_live'."
            )

        monkeypatch.setattr(jobs.odoo_connector, "OdooClient", FakeOdooClient)
        monkeypatch.setattr(jobs.odoo_connector, "verify", refuse)

        supabase = self._supabase({
            **ODOO_CONNECTION,
            "secret": "URL=https://a.odoo.com\nDB=hodan_live\nUser=c\nKEY=wrong",
        })
        result = handle_test_store_connection(context(supabase, {"connection_id": "conn-1"}))

        assert result["ok"] is False
        assert "rejected the username" in result["message"]
        assert result["message_so"] != result["message"]
        # A credential that does not work is not written back as canonical.
        assert supabase.called("rotate_store_connection_secret") == []

    def test_a_test_that_spends_a_quickbooks_token_saves_its_replacement(self, monkeypatch):
        """
        Intuit replaces the refresh token on every use, including this one. Not
        writing the replacement back would mean a test that reports "connected"
        and invalidates the credential it just proved.
        """
        from hermes import jobs

        def verify(client):
            client.rotated_refresh_token = "RT-NEW"
            return {"company_name": "Hodan Electronics"}

        monkeypatch.setattr(jobs.quickbooks_connector, "QuickBooksClient", FakeQuickBooksClient)
        monkeypatch.setattr(jobs.quickbooks_connector, "verify", verify)

        supabase = self._supabase({
            **CONNECTION,
            "source": "quickbooks",
            "language": "en",
            "config": {"realm_id": "9130350000"},
            "secret": json.dumps({
                "clientId": "A", "clientSecret": "B",
                "refreshToken": "RT-OLD", "realmId": "9130350000",
            }),
        })
        result = handle_test_store_connection(context(supabase, {"connection_id": "conn-1"}))

        assert result["ok"] is True
        stored = json.loads(supabase.called("rotate_store_connection_secret")[0]["p_secret"])
        assert stored["refresh_token"] == "RT-NEW"

    def test_a_spreadsheet_store_is_told_it_needs_nothing(self):
        supabase = self._supabase({**CONNECTION, "source": "excel", "language": "so"})
        result = handle_test_store_connection(context(supabase, {"connection_id": "conn-1"}))
        assert result["ok"] is True
        assert result["missing"] == []
        assert "Excel" in result["message_so"]

    def test_the_verdict_a_browser_receives_carries_no_credential(self, monkeypatch):
        """
        The whole result is returned to the dashboard and stored on the job row,
        so it has to be safe verbatim rather than safe once somebody remembers
        to strip it.
        """
        from hermes import jobs

        monkeypatch.setattr(jobs.odoo_connector, "OdooClient", FakeOdooClient)
        monkeypatch.setattr(jobs.odoo_connector, "verify", lambda client: {"company_name": "X"})

        secret = "kx-0099-do-not-leak-this"
        supabase = self._supabase({
            **ODOO_CONNECTION,
            "secret": f"URL=https://a.odoo.com\nDB=b\nUser=c\nKEY={secret}",
        })
        result = handle_test_store_connection(context(supabase, {"connection_id": "conn-1"}))

        assert secret not in json.dumps(result)
        # And it is still informative: it names the key it read the value from.
        assert result["understood"]["api_key"] == "KEY"
        assert result["masked"]["api_key"].startswith("kx-0")

    def test_a_connection_from_another_workspace_is_refused_before_anything_is_read(self):
        supabase = self._supabase({**ODOO_CONNECTION, "workspace_id": "ws-elsewhere"})
        with pytest.raises(JobError) as error:
            handle_test_store_connection(context(supabase, {"connection_id": "conn-1"}))
        assert "does not belong to this workspace" in str(error.value)
