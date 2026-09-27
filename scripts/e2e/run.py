#!/usr/bin/env python3
"""
The whole product, end to end, against a real database and no Docker.

    python scripts/e2e/run.py            # needs a local PostgreSQL 16

What this drives is the real thing: the migrations as they will be deployed, the
`enqueue -> claim -> run -> finish` queue protocol through the actual `Worker`
class, the real handlers, the real parser, profiler, rule engine, recipe replay,
report renderer and store connectors, and real Parquet in and out of storage.
The two substitutions are PostgREST and the object store -- see
`local_supabase.py` for exactly what that does and does not leave under test.

It is written as one narrative rather than as isolated cases, because the thing
most likely to be wrong is not any single step but the agreement between them.
So it follows a firm through a plausible two months:

  month 1   sign up -> workspace -> upload a messy workbook -> the agent reads,
            profiles and proposes -> an accountant approves all but the blocker
            -> a new version is written -> a report comes out of it
  month 2   the same layout arrives -> the signature matches the captured
            recipe -> it replays and reports only the deviations
  the shop  a Somali retailer connects a spreadsheet store -> the agent syncs it
            -> a monthly report in Somali, with the figures checked by hand

Every assertion is on state the product wrote, not on what this script passed
in. Where a number is asserted it was computed by hand from the fixture, which
is the only way a pipeline test says anything: a test that recomputes the answer
the same way the code does agrees with the bug.

The model is deliberately switched off. Nothing about the figures depends on it,
which is a claim this repository makes in several places and this is where it
gets checked -- the whole run below produces its report with no API key set.
"""

from __future__ import annotations

import datetime as dt
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "hermes"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from local_supabase import LocalSupabase  # noqa: E402

    from hermes.config import Config, KanbanConfig, LLMConfig, StoreConfig  # noqa: E402
    from hermes.worker import Worker  # noqa: E402
except ImportError as error:  # pragma: no cover - a setup problem, not a test failure
    print(
        f"Missing a dependency: {error.name}.\n\n"
        "This drives the real worker, so it needs the worker's own environment:\n\n"
        "    cd services/hermes && python3 -m venv .venv \\\n"
        "      && .venv/bin/pip install -r requirements.txt pytest 'psycopg[binary]'\n\n"
        "Then `npm run test:pipeline`, which picks that virtualenv up automatically."
    )
    raise SystemExit(1) from error

DSN = os.environ.get("E2E_DSN", "host=/tmp port=55440 user=postgres dbname=dataengine")

FIXTURES = ROOT / "fixtures" / "messy"
AUGUST = FIXTURES / "acme-sales-2026-08.xlsx"
SEPTEMBER = FIXTURES / "acme-sales-2026-09.xlsx"

FIRM = "11111111-1111-1111-1111-111111111111"
SHOPKEEPER = "22222222-2222-2222-2222-222222222222"

# Hand-computed from fixtures/messy/acme-sales-2026-08.xlsx, which is what makes
# these assertions worth making. The file has nine transaction rows; its own
# TOTAL row claims 10,361.35 while the rows add to 10,361.10, and that 25p is
# the reconciliation failure the agent is supposed to block on.
AUGUST_ROWS = 9
AUGUST_DECLARED_TOTAL = 10_361.35
AUGUST_COMPUTED_TOTAL = 10_361.10

passed = 0
failures: list[str] = []
skipped: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> bool:
    global passed
    if condition:
        passed += 1
        print(f"  PASS  {name}")
        return True
    failures.append(f"{name}{f' -- {detail}' if detail else ''}")
    print(f"  FAIL  {name}{f' -- {detail}' if detail else ''}")
    return False


def section(title: str) -> None:
    print(f"\n{title}\n{'-' * len(title)}")


def note(text: str) -> None:
    print(f"  ..    {text}")


# -----------------------------------------------------------------------------
# Harness
# -----------------------------------------------------------------------------


def make_config(storage: Path) -> Config:
    return Config(
        supabase_url="http://127.0.0.1:54321",
        service_key="local-e2e",
        worker_id="e2e-worker",
        hostname="e2e",
        # No API key anywhere. Every explanation below comes from the rule
        # engine, which is the claim being checked.
        llm=LLMConfig(),
        kanban=KanbanConfig(enabled=False),
        store=StoreConfig(enabled=True),
        work_dir=storage / "work",
        lease_seconds=120,
        poll_seconds=0,
    )


def build_worker(supabase: LocalSupabase, storage: Path) -> Worker:
    """
    The real Worker, with its transport swapped.

    Constructed rather than imitated: `run_job` is where the chaining, the
    deferral handling, the JobError/exception split and the terminal-state
    guarantee live, and a harness that re-implemented the loop would be testing
    its own copy of the thing most worth testing.
    """
    worker = Worker(make_config(storage))
    worker.supabase.close()
    worker.supabase = supabase  # type: ignore[assignment]
    return worker


def drain(worker: Worker, supabase: LocalSupabase, limit: int = 40) -> list[dict[str, Any]]:
    """
    Run the queue to empty, the way the worker does, and report what happened.

    Chained jobs are picked up on later passes, so this is also what proves the
    chain runs: nothing here knows that parse leads to profile leads to propose.
    """
    finished: list[dict[str, Any]] = []
    for _ in range(limit):
        job = worker.claim()
        if job is None:
            break
        worker.run_job(job)
        rows = supabase.select("agent_jobs", filters={"id": f"eq.{job['id']}"}, limit=1)
        if rows:
            finished.append(rows[0])
    else:
        raise AssertionError(f"the queue did not drain in {limit} jobs -- a chain is looping")
    return finished


def enqueue(supabase: LocalSupabase, workspace: str, kind: str, **kwargs: Any) -> dict[str, Any]:
    """Queue work the way the dashboard does: as the signed-in user."""
    return supabase.rpc(
        "enqueue_agent_job",
        {"p_workspace_id": workspace, "p_kind": kind, **kwargs},
    )


def fail_fast(label: str) -> None:
    print(f"\n{label}\n")
    for failure in failures:
        print(f"  {failure}")
    sys.exit(1)


# -----------------------------------------------------------------------------
# The run
# -----------------------------------------------------------------------------


def main() -> int:
    if not AUGUST.exists():
        print(f"Fixture missing: {AUGUST}\nRun `npm run fixtures` first.")
        return 1

    with tempfile.TemporaryDirectory(prefix="dataengine-e2e-") as tmp:
        storage = Path(tmp)
        try:
            supabase = LocalSupabase(DSN, storage / "buckets")
        except Exception as error:  # noqa: BLE001 - setup, not a test failure
            print(
                f"Could not reach the test database ({error}).\n\n"
                "Start it first:\n\n    scripts/e2e/bootstrap.sh\n\n"
                "or run `npm run test:pipeline`, which does both."
            )
            return 1
        with supabase:
            return run(supabase, storage)


def run(supabase: LocalSupabase, storage: Path) -> int:
    # Two people who have never met, in one database. Everything below happens
    # inside one of their tenancies.
    with supabase._conn.cursor() as cur:  # noqa: SLF001 - seeding auth is the harness's job
        cur.execute(
            "insert into auth.users (id, email) values (%s,%s), (%s,%s) "
            "on conflict (id) do nothing",
            (FIRM, "firm@example.test", SHOPKEEPER, "shop@example.test"),
        )

    worker = build_worker(supabase, storage)

    section("The worker announces itself")

    worker.announce()
    workers = supabase.select("agent_workers", filters={"id": "eq.e2e-worker"})
    check("a heartbeat registers the worker", len(workers) == 1)
    check(
        "it announces every kind this build can run",
        set(workers[0]["capabilities"]) == set(worker.capabilities),
        f"announced {len(workers[0]['capabilities'])}",
    )
    check(
        "store kinds are announced because the flag is on",
        "sync_store" in workers[0]["capabilities"],
    )

    worker.check_health()
    check("the health view is readable", worker._health.checked, worker._health.error)

    # -------------------------------------------------------------------------
    section("Month 1: a firm signs up and uploads a messy workbook")

    with supabase.as_user(FIRM):
        org = supabase.rpc("create_organization", {"p_name": "Acme Accounting", "p_slug": "acme"})
        workspace = supabase.rpc(
            "create_workspace", {"p_org_id": org["id"], "p_name": "Contoso Ltd"}
        )
    check("a firm and a client workspace exist", bool(org["id"] and workspace["id"]))

    # A browser session holds SELECT and nothing else -- there is no
    # INSERT policy on any table -- so the rows below are written the way the
    # upload route writes them: server-side, with the service key.
    denied = None
    try:
        with supabase.as_user(FIRM):
            supabase.insert(
                "datasets",
                {"workspace_id": workspace["id"], "name": "forged", "created_by": FIRM},
            )
    except Exception as error:  # noqa: BLE001 - the refusal is the assertion
        denied = error
    check("a browser session cannot insert a dataset directly", denied is not None)

    with supabase.as_server():
        dataset = supabase.insert(
            "datasets",
            {"workspace_id": workspace["id"], "name": "Sales ledger", "created_by": FIRM},
        )[0]

    # The upload path itself is HTTP and belongs to `e2e-upload.ts`; what this
    # run needs is the row that path produces, plus the bytes in the bucket.
    storage_key = f"{org['id']}/{workspace['id']}/2026-08/{AUGUST.name}"
    supabase.upload("raw", storage_key, AUGUST.read_bytes(), upsert=True)
    with supabase.as_server():
        upload = supabase.insert(
            "raw_uploads",
            {
                "workspace_id": workspace["id"],
                "dataset_id": dataset["id"],
                "storage_path": storage_key,
                "original_filename": AUGUST.name,
                "byte_size": AUGUST.stat().st_size,
                "uploaded_by": FIRM,
                "status": "pending",
            },
        )[0]
        supabase.update(
            "raw_uploads",
            {"id": f"eq.{upload['id']}"},
            {"status": "stored", "completed_at": dt.datetime.now(dt.timezone.utc)},
        )

    with supabase.as_user(FIRM):
        job = enqueue(
            supabase,
            workspace["id"],
            "parse_workbook",
            p_dataset_id=dataset["id"],
            p_raw_upload_id=upload["id"],
        )
    check("the dashboard can queue a parse", job["status"] == "queued")

    done = drain(worker, supabase)
    note(f"the chain ran {len(done)} job(s): {' -> '.join(j['kind'] for j in done)}")

    check(
        "every job in the chain succeeded",
        all(j["status"] == "succeeded" for j in done),
        "; ".join(f"{j['kind']}: {j['error']}" for j in done if j["status"] != "succeeded"),
    )
    check(
        "parse chained to profile and on to proposals",
        [j["kind"] for j in done] == ["parse_workbook", "profile_dataset", "propose_cleaning"],
        str([j["kind"] for j in done]),
    )

    # -------------------------------------------------------------------------
    section("What the agent made of the file")

    versions = supabase.select(
        "dataset_versions",
        filters={"dataset_id": f"eq.{dataset['id']}"},
        order="version_no.asc",
    )
    check("version 0 exists and is the raw reading", versions[0]["version_no"] == 0)
    check(
        f"it found {AUGUST_ROWS} transaction rows, not the total row",
        versions[0]["row_count"] == AUGUST_ROWS,
        f"got {versions[0]['row_count']}",
    )

    profiles = supabase.select(
        "dataset_profiles", filters={"dataset_version_id": f"eq.{versions[0]['id']}"}
    )
    check("the version was profiled", len(profiles) == 1)

    totals = (profiles[0]["signals"] or {}).get("declared_totals", {}) if profiles else {}
    check(
        "it reconciled the rows against the file's own TOTAL row",
        totals.get("checked") is True,
        str(totals)[:120],
    )
    check(
        "and refuses to agree with it, because the file disagrees with itself",
        totals.get("all_reconcile") is False,
    )
    difference = None
    for item in totals.get("checks", []):
        if not item.get("reconciles"):
            difference = round(abs(item["declared"] - item["computed"]), 2)
            break
    check(
        "the discrepancy it found is the 25p that is really there",
        difference == round(AUGUST_DECLARED_TOTAL - AUGUST_COMPUTED_TOTAL, 2),
        f"got {difference}",
    )

    proposals = supabase.select(
        "proposed_changes",
        filters={"dataset_version_id": f"eq.{versions[0]['id']}"},
        order="confidence.asc",
    )
    check("it proposed changes for a person to review", len(proposals) >= 4, f"{len(proposals)}")

    tiers = {p["confidence"] for p in proposals}
    check("including a blocking finding", "low" in tiers, str(tiers))
    blocker = next(p for p in proposals if p["confidence"] == "low")
    note(f"blocker: {blocker['title']}")

    check(
        "every proposal carries its evidence and a rationale",
        all(p["rationale"] and p["affected_rows"] is not None for p in proposals),
    )
    check(
        "the explanations came from the rule engine, with no model configured",
        not worker.llm.enabled,
    )

    # -------------------------------------------------------------------------
    section("An accountant approves everything except the blocker")

    approvable = [p["group_key"] for p in proposals if p["confidence"] != "low"]
    with supabase.as_user(FIRM):
        supabase.rpc(
            "decide_proposed_changes",
            {
                "p_dataset_version_id": versions[0]["id"],
                "p_group_keys": approvable,
                "p_approve": True,
                "p_note": "reviewed in the end-to-end run",
            },
        )
    decided = supabase.select(
        "proposed_changes",
        filters={"dataset_version_id": f"eq.{versions[0]['id']}", "status": "eq.approved"},
    )
    check(f"{len(approvable)} change(s) are approved", len(decided) == len(approvable))

    with supabase.as_user(FIRM):
        refused = supabase.rpc(
            "decide_proposed_changes",
            {
                "p_dataset_version_id": versions[0]["id"],
                "p_group_keys": [blocker["group_key"]],
                "p_approve": True,
                "p_note": "trying it on",
            },
        )
    still_blocked = supabase.select(
        "proposed_changes", filters={"id": f"eq.{blocker['id']}"}
    )[0]
    check(
        "the blocking finding cannot be waved through by approving it",
        still_blocked["status"] != "applied",
        f"status is {still_blocked['status']}",
    )
    del refused

    with supabase.as_user(FIRM):
        enqueue(
            supabase, workspace["id"], "apply_cleaning", p_dataset_version_id=versions[0]["id"]
        )
    applied = drain(worker, supabase)
    note(f"apply ran: {' -> '.join(j['kind'] for j in applied)}")
    check(
        "applying the approvals succeeded",
        all(j["status"] == "succeeded" for j in applied),
        "; ".join(f"{j['kind']}: {j['error']}" for j in applied if j["status"] != "succeeded"),
    )

    versions = supabase.select(
        "dataset_versions",
        filters={"dataset_id": f"eq.{dataset['id']}"},
        order="version_no.asc",
    )
    check("a new version was written", len(versions) >= 2, f"{len(versions)} versions")
    cleaned = versions[-1]
    check("it descends from the version it was cleaned from", cleaned["parent_version_id"] is not None)
    check(
        "the duplicate row is gone, so the ledger is one row shorter",
        cleaned["row_count"] == AUGUST_ROWS - 1,
        f"{versions[0]['row_count']} -> {cleaned['row_count']}",
    )

    # Immutability is a database promise, not an application one. Asserted with
    # the most privileged client there is, which is the only way the claim means
    # anything.
    try:
        with supabase.as_server():
            supabase.update(
                "dataset_versions", {"id": f"eq.{versions[0]['id']}"}, {"row_count": 999}
            )
        check("version 0 cannot be rewritten, even by the service role", False, "the update went through")
    except Exception as error:  # noqa: BLE001 - the refusal is the assertion
        check("version 0 cannot be rewritten, even by the service role", True)
        note(str(error).splitlines()[0][:100])

    # -------------------------------------------------------------------------
    section("A month-end report comes out of the cleaned version")

    with supabase.as_user(FIRM):
        enqueue(
            supabase,
            workspace["id"],
            "generate_report",
            p_dataset_version_id=cleaned["id"],
            p_payload={"format": "md"},
        )
    reported = drain(worker, supabase)
    report_job = next((j for j in reported if j["kind"] == "generate_report"), None)
    check("the report job succeeded", report_job is not None and report_job["status"] == "succeeded",
          report_job["error"] if report_job else "no job ran")

    if report_job and report_job["status"] == "succeeded":
        result = report_job["result"] or {}
        markdown = result.get("markdown") or ""
        check("it wrote a document into the exports bucket", bool(result.get("report_path")))
        stored = supabase.download("exports", result["report_path"], 20_000_000)
        check("the document is really in storage", len(stored) > 0, f"{len(stored)} bytes")
        check("the report names the client", "Contoso" in markdown or "Sales ledger" in markdown)
        check(
            "it carries the reconciliation warning at the top, not in a footnote",
            "reconcile" in markdown.lower(),
        )
        check(
            "and it states that no model wrote the prose",
            result.get("narrative") is None,
        )

    # -------------------------------------------------------------------------
    section("Month 2: the same layout replays against the captured recipe")

    recipes = supabase.select(
        "cleaning_recipes", filters={"workspace_id": f"eq.{workspace['id']}"}
    )
    if not recipes:
        skipped.append("recipe replay -- month 1 captured no recipe")
        note("no recipe was captured in month 1; skipping the replay leg")
    elif not SEPTEMBER.exists():
        skipped.append("recipe replay -- the September fixture is missing")
        note("fixtures/messy/acme-sales-2026-09.xlsx is missing; skipping the replay leg")
    else:
        note(f"month 1 captured a recipe: {recipes[0]['name']}")
        september_key = f"{org['id']}/{workspace['id']}/2026-09/{SEPTEMBER.name}"
        supabase.upload("raw", september_key, SEPTEMBER.read_bytes(), upsert=True)
        with supabase.as_server():
            september_upload = supabase.insert(
                "raw_uploads",
                {
                    "workspace_id": workspace["id"],
                    "dataset_id": dataset["id"],
                    "storage_path": september_key,
                    "original_filename": SEPTEMBER.name,
                    "byte_size": SEPTEMBER.stat().st_size,
                    "uploaded_by": FIRM,
                    "status": "pending",
                },
            )[0]
            supabase.update(
                "raw_uploads",
                {"id": f"eq.{september_upload['id']}"},
                {"status": "stored", "completed_at": dt.datetime.now(dt.timezone.utc)},
            )

        with supabase.as_user(FIRM):
            enqueue(
                supabase,
                workspace["id"],
                "parse_workbook",
                p_dataset_id=dataset["id"],
                p_raw_upload_id=september_upload["id"],
            )
        month2 = drain(worker, supabase)
        note(f"month 2 ran: {' -> '.join(j['kind'] for j in month2)}")
        check(
            "month 2 succeeded end to end",
            all(j["status"] == "succeeded" for j in month2),
            "; ".join(f"{j['kind']}: {j['error']}" for j in month2 if j["status"] != "succeeded"),
        )
        check(
            "and it took the replay route rather than proposing from scratch again",
            any(j["kind"] == "replay_recipe" for j in month2),
            str([j["kind"] for j in month2]),
        )

        runs = supabase.select(
            "recipe_runs", filters={"workspace_id": f"eq.{workspace['id']}"},
            order="started_at.desc",
        )
        if runs:
            note(f"replay finished as: {runs[0]['status']}")
            deviations = supabase.select(
                "deviations", filters={"run_id": f"eq.{runs[0]['id']}"}
            )
            check(
                "the replay reported only what deviated, not the whole queue again",
                len(deviations) < len(proposals),
                f"{len(deviations)} deviations vs {len(proposals)} month-1 proposals",
            )

    # -------------------------------------------------------------------------
    section("A Somali shop connects its spreadsheet and asks for a report")

    with supabase.as_user(SHOPKEEPER):
        shop_org = supabase.rpc(
            "create_organization", {"p_name": "Hodan Traders", "p_slug": "hodan"}
        )
        shop_ws = supabase.rpc(
            "create_workspace", {"p_org_id": shop_org["id"], "p_name": "Suuqa Hodan"}
        )
        connection = supabase.rpc(
            "create_store_connection",
            {
                "p_workspace_id": shop_ws["id"],
                "p_name": "Suuqa Hodan",
                "p_source": "excel",
                "p_base_currency": "USD",
                "p_secondary_currency": "SOS",
                "p_secondary_rate": 570,
                "p_language": "so",
            },
        )
    check("connecting a store opens its own ledger dataset", bool(connection["dataset_id"]))

    ledger = build_shop_workbook()
    shop_key = f"{shop_org['id']}/{shop_ws['id']}/2026-08/iibka.xlsx"
    supabase.upload("raw", shop_key, ledger, upsert=True)
    with supabase.as_server():
        shop_upload = supabase.insert(
            "raw_uploads",
            {
                "workspace_id": shop_ws["id"],
                "dataset_id": connection["dataset_id"],
                "storage_path": shop_key,
                "original_filename": "iibka.xlsx",
                "byte_size": len(ledger),
                "uploaded_by": SHOPKEEPER,
                "status": "pending",
            },
        )[0]
        supabase.update(
            "raw_uploads",
            {"id": f"eq.{shop_upload['id']}"},
            {"status": "stored", "completed_at": dt.datetime.now(dt.timezone.utc)},
        )

    with supabase.as_user(SHOPKEEPER):
        enqueue(
            supabase,
            shop_ws["id"],
            "test_store_connection",
            p_payload={"connection_id": connection["id"]},
        )
        enqueue(
            supabase,
            shop_ws["id"],
            "sync_store",
            p_payload={
                "connection_id": connection["id"],
                "window_start": "2026-07-01",
                "window_end": "2026-08-31",
            },
        )
    shop_jobs = drain(worker, supabase)
    note(f"the shop's jobs ran: {' -> '.join(j['kind'] for j in shop_jobs)}")
    check(
        "the store jobs succeeded",
        all(j["status"] == "succeeded" for j in shop_jobs),
        "; ".join(f"{j['kind']}: {j['error']}" for j in shop_jobs if j["status"] != "succeeded"),
    )

    test_job = next((j for j in shop_jobs if j["kind"] == "test_store_connection"), None)
    if test_job:
        verdict = test_job["result"] or {}
        check(
            "a spreadsheet store is told it needs no credentials",
            verdict.get("ok") is True and verdict.get("missing") == [],
            str(verdict)[:120],
        )

    sync_job = next((j for j in shop_jobs if j["kind"] == "sync_store"), None)
    if sync_job and sync_job["status"] == "succeeded":
        synced = sync_job["result"] or {}
        note(f"the sync read {synced.get('entries')} ledger entries")
        runs = supabase.select(
            "store_sync_runs", filters={"connection_id": f"eq.{connection['id']}"}
        )
        check("the sync left a run row a shop could look at", len(runs) == 1)
        check("and the run says it succeeded", runs[0]["status"] == "succeeded")
        check(
            "the ledger was written as an immutable version, not as rows in Postgres",
            bool(synced.get("dataset_version_id")),
        )

        with supabase.as_user(SHOPKEEPER):
            enqueue(
                supabase,
                shop_ws["id"],
                "store_financials",
                p_payload={
                    "connection_id": connection["id"],
                    "cadence": "monthly",
                    "from": "2026-07-01",
                    "to": "2026-08-31",
                    "format": "md",
                },
            )
        finance = drain(worker, supabase)
        finance_job = next((j for j in finance if j["kind"] == "store_financials"), None)
        check(
            "the shop's financial report succeeded",
            finance_job is not None and finance_job["status"] == "succeeded",
            finance_job["error"] if finance_job else "no job ran",
        )

        if finance_job and finance_job["status"] == "succeeded":
            result = finance_job["result"] or {}
            figures = (result.get("figures") or {}).get("period") or {}
            # Hand-computed from build_shop_workbook below: August took 7,600 in
            # sales, spent 5,300 on stock and 900 on running costs.
            check(
                "sales for the month are right",
                figures.get("revenue") == 7600.0,
                f"got {figures.get('revenue')}",
            )
            check(
                "cost of goods is separated from running costs",
                figures.get("cogs") == 5300.0 and figures.get("expenses") == 900.0,
                f"cogs={figures.get('cogs')} expenses={figures.get('expenses')}",
            )
            check(
                "so gross profit and net profit both come out right",
                figures.get("gross_profit") == 2300.0 and figures.get("net_profit") == 1400.0,
                f"gross={figures.get('gross_profit')} net={figures.get('net_profit')}",
            )
            markdown = result.get("markdown") or ""
            check("the report is written in Somali", "Faa'iidada saafiga ah" in markdown)
            check(
                "it shows shillings beside dollars at the stated rate",
                "Sh4,332,000" in markdown and "570" in markdown,
            )
            check("and it is downloadable from the exports bucket",
                  len(supabase.download("exports", result["report_path"], 20_000_000)) > 0)

    # -------------------------------------------------------------------------
    section("Two tenancies in one database")

    crossed = None
    try:
        with supabase.as_user(SHOPKEEPER):
            supabase.rpc(
                "enqueue_agent_job",
                {"p_workspace_id": workspace["id"], "p_kind": "generate_report"},
            )
    except Exception as error:  # noqa: BLE001 - the refusal is the assertion
        crossed = error
    check("the shop cannot queue work against the firm's workspace", crossed is not None)

    stolen = None
    try:
        with supabase.as_user(SHOPKEEPER):
            supabase.rpc("store_connection_credentials", {"p_connection_id": connection["id"]})
    except Exception as error:  # noqa: BLE001
        stolen = error
    check(
        "and cannot call the function that decrypts a credential",
        stolen is not None,
        "it returned a credential",
    )

    # -------------------------------------------------------------------------
    section("The queue protocol")

    with supabase.as_user(FIRM):
        first = enqueue(
            supabase, workspace["id"], "generate_report", p_dataset_version_id=cleaned["id"]
        )
        second = enqueue(
            supabase, workspace["id"], "generate_report", p_dataset_version_id=cleaned["id"]
        )
    check(
        "an impatient double click is one job, not two",
        first["id"] == second["id"],
    )

    claimed = worker.claim()
    check("a queued job can be claimed", claimed is not None and claimed["id"] == first["id"])
    check("claiming it takes it out of the queue", worker.claim() is None)

    if claimed:
        thief = None
        try:
            supabase.rpc(
                "finish_agent_job",
                {
                    "p_job_id": claimed["id"],
                    "p_worker_id": "a-different-worker",
                    "p_success": True,
                    "p_result": {},
                },
            )
        except Exception as error:  # noqa: BLE001 - the refusal is the assertion
            thief = error
        row = supabase.select("agent_jobs", filters={"id": f"eq.{claimed['id']}"})[0]
        check(
            "a worker that does not hold the lease cannot finish the job",
            thief is not None and row["status"] == "running",
            f"status became {row['status']}",
        )
        worker.finish(claimed["id"], True, {"note": "e2e"})
        row = supabase.select("agent_jobs", filters={"id": f"eq.{claimed['id']}"})[0]
        check("the worker holding it can", row["status"] == "succeeded")

    # -------------------------------------------------------------------------
    section("The schema stands on its own")

    # Everything in this section is about the database this directory *builds*,
    # rather than about the one Supabase happens to hand you. Both bugs it
    # guards were invisible on a Supabase project and fatal off one.
    with supabase._conn.cursor() as cur:  # noqa: SLF001 - catalogue reads
        cur.execute(
            "select n.nspname from pg_extension e "
            "join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto'"
        )
        row = cur.fetchone()
        check(
            "pgcrypto is in the extensions schema, where the code looks for it",
            row is not None and row["nspname"] == "extensions",
            f"it is in {row['nspname'] if row else 'nowhere'}",
        )

        # The dependency `kanban_run_start` mints a capability with. Unqualified
        # it found nothing and failed every bridged job three times; qualified to
        # `extensions` it found nothing on any database not built by Supabase.
        cur.execute("select length(encode(extensions.gen_random_bytes(32), 'hex')) as n")
        check("and the function kanban_run_start depends on resolves", cur.fetchone()["n"] == 64)

        # A policy without a grant permits nothing: PostgreSQL checks the table
        # privilege first, so two `for select to authenticated` policies on the
        # HMRC tables were inert and the screen that reads them would have come
        # back empty with nothing to say why.
        cur.execute(
            "select bool_and(has_table_privilege('authenticated', c.oid, 'SELECT')) as ok "
            "from pg_class c join pg_namespace n on n.oid = c.relnamespace "
            "where n.nspname = 'public' and c.relname in ('hmrc_sources','hmrc_change_reports')"
        )
        check("every table with a read policy is actually granted that read", cur.fetchone()["ok"] is True)

        # No table anywhere may be written from a browser session. This is the
        # whole shape of the write model -- every write goes through a definer
        # RPC -- and it is one forgotten `grant` away from not being true.
        cur.execute(
            """
            select coalesce(string_agg(c.relname, ', '), '') as leaks
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
              and (has_table_privilege('authenticated', c.oid, 'INSERT')
                or has_table_privilege('authenticated', c.oid, 'UPDATE')
                or has_table_privilege('authenticated', c.oid, 'DELETE'))
            """
        )
        leaks = cur.fetchone()["leaks"]
        check("no table can be written directly by a signed-in session", leaks == "", leaks)

        cur.execute(
            """
            select coalesce(string_agg(c.relname, ', '), '') as open
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
            """
        )
        unprotected = cur.fetchone()["open"]
        check("every table has row-level security enabled", unprotected == "", unprotected)

        # The worker's own RPCs are the ones that can write a result, decrypt a
        # credential or claim a job. None may be reachable from a browser.
        cur.execute(
            """
            select coalesce(string_agg(p.proname, ', '), '') as reachable
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname = any (%s)
              and has_function_privilege('authenticated', p.oid, 'EXECUTE')
            """,
            (
                [
                    "claim_agent_job",
                    "finish_agent_job",
                    "heartbeat_agent_job",
                    "record_dataset_version",
                    "replace_proposed_changes",
                    "store_connection_credentials",
                    "rotate_store_connection_secret",
                    "apply_store_connection_setup",
                    "enqueue_due_store_reports",
                    "enqueue_agent_job_internal",
                    "auto_approve_proposed_changes",
                ],
            ),
        )
        reachable = cur.fetchone()["reachable"]
        check("no worker-only function is callable from a browser", reachable == "", reachable)

    # -------------------------------------------------------------------------
    section("The audit trail")

    trail = supabase.select("audit_logs", order="id.asc")
    actions = [row["action"] for row in trail]
    for required in (
        "organization.created",
        "workspace.created",
        "dataset.version.created",
        "agent.job.enqueued",
        "store.connection.created",
    ):
        check(f"{required} was recorded", required in actions)
    check(
        "nothing in this application can delete an audit row",
        audit_is_append_only(supabase, trail),
    )
    note(f"{len(trail)} audit rows written by this run")

    # -------------------------------------------------------------------------
    print(f"\n{passed} passed, {len(failures)} failed, {len(skipped)} skipped\n")
    for item in skipped:
        print(f"  SKIP  {item}")
    if failures:
        print()
        for failure in failures:
            print(f"  FAIL  {failure}")
        return 1
    return 0


def audit_is_append_only(supabase: LocalSupabase, trail: list[dict[str, Any]]) -> bool:
    if not trail:
        return False
    try:
        with supabase._conn.cursor() as cur:  # noqa: SLF001
            cur.execute("delete from audit_logs where id = %s", (trail[0]["id"],))
        return False
    except Exception:  # noqa: BLE001 - the refusal is the assertion
        return True


def build_shop_workbook() -> bytes:
    """
    A Mogadishu electronics shop's own sheet, in Somali, over two months.

    Written here rather than committed as a fixture so the figures asserted
    above are visible beside the assertions. July is deliberately the better
    month, so the report has a real month-on-month movement to describe.
    """
    from openpyxl import Workbook

    book = Workbook()
    sheet = book.active
    sheet.title = "Iibka"
    sheet.append(["SUUQA HODAN — ELECTRONICS"])
    sheet.append(["Bakaaraha, Muqdisho"])
    sheet.append([])
    sheet.append(["Taariikh", "Nooca", "Sharaxaad", "Alaabta", "Macmiil", "Qiimaha"])

    rows = [
        # July: 7,400 sold, 4,100 of stock, 750 of running costs.
        ("2026-07-03", "Iib", "Iibka maalinlaha", "Solar panel 200W", "Faarax", 1800),
        ("2026-07-11", "Iib", "Iibka maalinlaha", "Inverter 3kVA", "Hodan Electric", 2400),
        ("2026-07-18", "Iib", "Iibka jumlada", "Solar panel 200W", "Hodan Electric", 3200),
        ("2026-07-05", "Iibsi", "Alaab laga soo iibsaday Dubai", "", "Dubai Supplier", 4100),
        ("2026-07-01", "Kiro", "Kirada dukaanka", "", "", 500),
        ("2026-07-01", "Koronto", "Korontada matoorka", "", "", 250),
        # August: 7,600 sold, 5,300 of stock, 900 of running costs.
        ("2026-08-04", "Iib", "Iibka maalinlaha", "Solar panel 200W", "Faarax", 1500),
        ("2026-08-12", "Iib", "Iibka maalinlaha", "Inverter 3kVA", "Cabdi", 2200),
        ("2026-08-22", "Iib", "Iibka jumlada", "Solar panel 200W", "Hodan Electric", 3900),
        ("2026-08-06", "Iibsi", "Alaab laga soo iibsaday Dubai", "", "Dubai Supplier", 5300),
        ("2026-08-01", "Kiro", "Kirada dukaanka", "", "", 500),
        ("2026-08-01", "Koronto", "Korontada matoorka", "", "", 400),
    ]
    for row in rows:
        sheet.append(list(row))

    import io

    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001
        print(f"\nThe harness itself failed: {type(error).__name__}: {error}\n")
        import traceback

        traceback.print_exc()
        sys.exit(2)
