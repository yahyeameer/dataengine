"""
The worker's side of branding: resolving it, fetching a logo, recording what
was produced.

`test_branding.py` covers the rules; this covers the wiring around them —
which table is read, which bucket is reached for, and what ends up on the report
row. All of it against a stub client, because the interesting failures here are
about *which calls are made* rather than about what a database would answer.
"""

from __future__ import annotations

import io

import pytest

from hermes import jobs
from hermes.tools import branding, documents


def _png(width: int = 240, height: int = 80) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGBA", (width, height), (24, 80, 200, 255)).save(buffer, format="PNG")
    return buffer.getvalue()


class _Supabase:
    def __init__(self, rows: dict[str, list[dict]], blob: bytes | None = None) -> None:
        self.rows = rows
        self.blob = blob
        self.downloads: list[tuple[str, str]] = []
        self.uploads: list[tuple[str, str, int, str]] = []
        self.rpcs: list[tuple[str, dict]] = []

    def select(self, table: str, **_kwargs: object) -> list[dict]:
        return self.rows.get(table, [])

    def download(self, bucket: str, path: str, max_bytes: int) -> bytes:
        self.downloads.append((bucket, path))
        if self.blob is None:
            raise RuntimeError("no such object")
        return self.blob

    def upload(self, bucket: str, path: str, data: bytes, content_type: str = "", upsert: bool = False):
        self.uploads.append((bucket, path, len(data), content_type))
        return type("Stored", (), {"bucket": bucket, "path": path, "size": len(data)})()

    def rpc(self, name: str, params: dict | None = None):
        self.rpcs.append((name, params or {}))
        if name == "record_report_artifact":
            return {"id": "artifact-1"}
        return {}


class _Context:
    def __init__(self, supabase: _Supabase, payload: dict | None = None) -> None:
        self.supabase = supabase
        self.job = {
            "id": "job-1",
            "org_id": "org-1",
            "workspace_id": "ws-1",
            "payload": payload or {},
        }
        self.workspace_id = "ws-1"
        self.beats: list[dict] = []

    @property
    def job_id(self) -> str:
        return self.job["id"]

    @property
    def payload(self) -> dict:
        return self.job["payload"]

    def requested_by(self) -> str | None:
        return "user-1"

    def heartbeat(self, progress: dict) -> None:
        self.beats.append(progress)


# ---------------------------------------------------------------------------
# Logo resolution (section 11)
# ---------------------------------------------------------------------------


def test_a_stored_logo_is_fetched_from_the_branding_bucket():
    supabase = _Supabase(
        {
            "organization_branding": [
                {
                    "organization_id": "org-1",
                    "business_name": "Energy Gain",
                    "logo_storage_path": "organizations/org-1/branding/logo",
                }
            ]
        },
        blob=_png(),
    )
    brand, resolved = jobs._brand_for(_Context(supabase), None)

    assert supabase.downloads == [("branding", "organizations/org-1/branding/logo")]
    assert brand.logo is not None
    assert resolved.logo_source == "organization_logo"


def test_a_logo_that_will_not_download_costs_the_logo_and_not_the_report():
    supabase = _Supabase(
        {
            "organization_branding": [
                {
                    "organization_id": "org-1",
                    "business_name": "Energy Gain",
                    "logo_storage_path": "organizations/org-1/branding/logo",
                }
            ],
        },
        blob=None,
    )
    brand, resolved = jobs._brand_for(_Context(supabase), None)

    assert brand.name == "Energy Gain"
    assert brand.logo is None
    assert resolved.logo_source == "none"


def test_a_logo_url_pointing_into_a_private_network_is_never_fetched(monkeypatch):
    # The SSRF boundary, at the place that would actually open the socket.
    monkeypatch.setattr(
        branding.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("169.254.169.254", 443))],
    )

    def explode(*_args, **_kwargs):  # pragma: no cover - reaching this is the bug
        raise AssertionError("the server must not make this request")

    monkeypatch.setattr("httpx.Client", explode)

    supabase = _Supabase(
        {
            "organization_branding": [
                {
                    "organization_id": "org-1",
                    "business_name": "Energy Gain",
                    "logo_url": "https://metadata.example/logo.png",
                }
            ]
        }
    )
    brand, _resolved = jobs._brand_for(_Context(supabase), None)
    assert brand.logo is None


def test_no_branding_row_at_all_falls_through_to_the_organisation():
    supabase = _Supabase({"organizations": [{"id": "org-1", "name": "Acme Accounting"}]})
    brand, resolved = jobs._brand_for(_Context(supabase), None)

    assert brand.name == "Acme Accounting"
    assert resolved.name_source == "organization"
    assert supabase.downloads == []


# ---------------------------------------------------------------------------
# Which formats a job asks for
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload,expected",
    [
        ({}, ["md"]),
        ({"format": "pdf"}, ["pdf"]),
        ({"formats": ["pdf", "xlsx"]}, ["pdf", "xlsx"]),
        ({"formats": ["pdf", "pdf"]}, ["pdf"]),
        # A recipe's configuration wins over a single format, and rubbish in
        # either falls back to the default rather than failing a month-end.
        ({"formats": ["pptx"], "format": "pdf"}, ["md"]),
        ({"format": 42}, ["md"]),
    ],
)
def test_the_requested_formats_are_read_from_either_shape(payload, expected):
    assert jobs._requested_formats(payload) == expected


# ---------------------------------------------------------------------------
# Storing the result (sections 21 and 22)
# ---------------------------------------------------------------------------


def _document():
    import datetime as dt

    from hermes.tools.report import build_report_document

    return build_report_document(
        workspace_name="Kentex Cargo",
        dataset_name="Monthly Operations Report",
        version_no=4,
        kpis={"row_count": 10, "period": {"earliest": "2026-09-01", "latest": "2026-09-30"}},
        profile_signals={"exact_duplicates": {"duplicate_rows": 0}, "entity_variants": {"columns": []}},
        generated_at=dt.datetime(2026, 10, 2, 9, 0, tzinfo=dt.timezone.utc),
    )


def _store(context, formats, brand=None, resolved=None):
    return jobs._store_report(
        context,
        document=_document(),
        version={"id": "dv-1", "dataset_id": "ds-1", "version_no": 4},
        formats=formats,
        brand=brand or documents.Brand.for_client(name="Energy Gain", accent="#8a1538"),
        resolved=resolved or branding.resolve_branding(branding={"business_name": "Energy Gain"}),
    )


def test_a_report_row_records_everything_needed_to_explain_the_document():
    supabase = _Supabase({})
    context = _Context(supabase)

    stored = _store(context, ["pdf", "md"])

    assert stored["status"] == "succeeded"
    assert [entry["format"] for entry in stored["formats"]] == ["pdf", "md"]
    assert stored["report_artifact_id"] == "artifact-1"

    name, params = next(call for call in supabase.rpcs if call[0] == "record_report_artifact")
    assert params["p_dataset_version_id"] == "dv-1"
    assert params["p_period"] == "September 2026"
    # Section 19: the snapshot is what makes a historical report explainable
    # after the organisation renames itself.
    assert params["p_branding_snapshot"]["business_name"] == "Energy Gain"
    assert params["p_status"] == "succeeded"


def test_each_format_is_stored_under_the_organisation_and_workspace():
    supabase = _Supabase({})
    _store(_Context(supabase), ["pdf"])

    bucket, path, size, content_type = supabase.uploads[0]
    assert bucket == "exports"
    assert path.startswith("org-1/ws-1/")
    assert path.endswith("ds-1__v4__report.pdf")
    assert content_type == documents.CONTENT_TYPES["pdf"]
    assert size > 1000


def test_one_failing_format_is_recorded_as_partial_and_the_rest_are_kept(monkeypatch):
    def explode(*_args, **_kwargs):
        raise RuntimeError("the chart engine fell over")

    monkeypatch.setattr(documents, "render_xlsx", explode)

    supabase = _Supabase({})
    stored = _store(_Context(supabase), ["pdf", "xlsx"])

    assert stored["status"] == "partial"
    assert stored["primary"]["format"] == "pdf"
    assert [entry["ok"] for entry in stored["formats"]] == [True, False]
    # Only the format that worked reached the bucket.
    assert [path.rsplit(".", 1)[1] for _b, path, _s, _c in supabase.uploads] == ["pdf"]

    _name, params = next(call for call in supabase.rpcs if call[0] == "record_report_artifact")
    assert params["p_status"] == "partial"
    assert "chart engine" in params["p_error"]


def test_a_report_that_renders_in_no_format_at_all_is_recorded_as_failed(monkeypatch):
    monkeypatch.setattr(
        documents, "render_pdf", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("nope"))
    )
    supabase = _Supabase({})
    stored = _store(_Context(supabase), ["pdf"])

    assert stored["status"] == "failed"
    assert stored["primary"] is None
    assert supabase.uploads == []
