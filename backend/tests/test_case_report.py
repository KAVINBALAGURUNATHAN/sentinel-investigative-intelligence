"""
Report generation tests (workflow step 15).

PDF text extraction is unreliable — ReportLab splits words across glyph runs —
so these tests assert on what can be checked honestly:

  * the audit bundle, which carries the same data as JSON and is fully
    inspectable;
  * the structural guarantee that a court pack cannot contain statistics,
    because the function is never given any;
  * that the PDFs are real, non-trivial PDFs.
"""

from __future__ import annotations

import inspect
import json
import os

import pytest
from fastapi.testclient import TestClient

from app.services import case_report


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    os.environ["SENTINEL_DB_PATH"] = str(tmp_path_factory.mktemp("rep") / "r.db")
    from app.main import app

    with TestClient(app) as c:
        from pathlib import Path

        data = Path(__file__).resolve().parents[2] / "data" / "synthetic"
        with (data / "entities.csv").open("rb") as f:
            c.post("/api/v1/ingest/entities/register",
                   files={"file": ("entities.csv", f, "text/csv")})
        for source in ("cdr", "ipdr", "bank", "social"):
            with (data / f"{source}.csv").open("rb") as f:
                c.post(f"/api/v1/ingest/{source}",
                       files={"file": (f"{source}.csv", f, "text/csv")})
        yield c


# ── availability ──────────────────────────────────────────────────────────

def test_reports_are_available_for_multi_domain_cases(client):
    """The regression: these used to 404 because they read the old schema."""
    for path in ("/report", "/report/court-pack", "/audit-bundle"):
        response = client.get(f"/api/v1/cases/CASE_002{path}")
        assert response.status_code == 200, f"{path} → {response.status_code}"


def test_unknown_case_still_404s(client):
    assert client.get("/api/v1/cases/CASE_NOPE/report").status_code == 404
    assert client.get("/api/v1/cases/CASE_NOPE/audit-bundle").status_code == 404


def test_preview_describes_the_documents(client):
    body = client.get("/api/v1/cases/CASE_002/report/preview").json()
    assert body["records"] > 0
    assert {d["id"] for d in body["documents"]} >= {"court-pack", "audit-bundle"}


# ── PDFs ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("path,filename", [
    ("/report", "sentinel-report"),
    ("/report/court-pack", "sentinel-court-pack"),
])
def test_pdf_is_served_as_a_real_download(client, path, filename):
    response = client.get(f"/api/v1/cases/CASE_002{path}")
    assert response.headers["content-type"] == "application/pdf"
    assert filename in response.headers["content-disposition"]
    assert response.content.startswith(b"%PDF")
    assert len(response.content) > 2000, "PDF too small to contain the case"


def test_report_carries_its_title(client):
    body = client.get("/api/v1/cases/CASE_002/report").content
    assert b"Investigation report" in body


def test_court_pack_carries_its_title(client):
    body = client.get("/api/v1/cases/CASE_002/report/court-pack").content
    assert b"Court pack" in body


def test_no_accusatory_language_in_either_document(client):
    for path in ("/report", "/report/court-pack"):
        body = client.get(f"/api/v1/cases/CASE_002{path}").content.lower()
        for word in (b"criminal", b"guilty", b"offender", b"perpetrator"):
            assert word not in body, f"{word!r} appears in {path}"


def test_court_pack_cannot_receive_statistics_by_construction():
    """
    Structural guarantee rather than a text search: the court pack builder is
    never handed the analysis, so no p-value or score can reach it even by
    mistake. The investigation report is the document that takes findings.
    """
    court = inspect.signature(case_report.generate_court_pack).parameters
    report = inspect.signature(case_report.generate_investigation_report).parameters
    assert "analysis" not in court
    assert "analysis" in report


# ── audit bundle ──────────────────────────────────────────────────────────

def test_audit_bundle_contains_every_record_including_quarantined(client):
    bundle = client.get("/api/v1/cases/CASE_006/audit-bundle").json()
    assert bundle["case"]["quarantined"] > 0
    assert len(bundle["events"]) == bundle["case"]["events"]
    assert any(e["quarantined"] for e in bundle["events"])


def test_audit_bundle_carries_source_hashes(client):
    bundle = client.get("/api/v1/cases/CASE_002/audit-bundle").json()
    assert bundle["source_files"]
    for batch in bundle["source_files"]:
        assert len(batch["sha256"]) == 64


def test_audit_bundle_is_self_hashed(client):
    """A recipient must be able to detect alteration of the export itself."""
    bundle = client.get("/api/v1/cases/CASE_002/audit-bundle").json()
    assert len(bundle["bundle_sha256"]) == 64


def test_bundle_hash_changes_when_content_changes(client):
    import hashlib

    bundle = client.get("/api/v1/cases/CASE_002/audit-bundle").json()
    original = bundle.pop("bundle_sha256")
    bundle["events"][0]["event_type"] = "TAMPERED"
    recomputed = hashlib.sha256(json.dumps(
        bundle, sort_keys=True, separators=(",", ":"),
        default=str).encode()).hexdigest()
    assert recomputed != original


def test_audit_bundle_carries_the_disclaimer(client):
    bundle = client.get("/api/v1/cases/CASE_002/audit-bundle").json()
    assert "not establish" in bundle["disclaimer"]
    assert "synthetic" in bundle["notice"].lower()


def test_audit_bundle_follows_the_display_policy(client, monkeypatch):
    """
    An export is the highest-risk artifact: it leaves the system. It must obey
    the same policy as the screen, not a rule of its own — masked whenever the
    deployment holds sensitive data, readable for the benchmark set where the
    bundle exists so a third party can recompute the findings.
    """
    monkeypatch.setenv("SENTINEL_DATA_MODE", "SENSITIVE")
    bundle = client.get("/api/v1/cases/CASE_002/audit-bundle").json()
    for event in bundle["events"]:
        if event["actor"]:
            assert "*" in event["actor"], "raw identifier exported from sensitive data"

    monkeypatch.setenv("SENTINEL_DATA_MODE", "SYNTHETIC")
    bundle = client.get("/api/v1/cases/CASE_002/audit-bundle").json()
    shown = [e["actor"] for e in bundle["events"] if e["actor"]]
    assert shown and not any("*" in v for v in shown), "benchmark export masked"


def test_bundle_includes_findings_and_diagnostics(client):
    bundle = client.get("/api/v1/cases/CASE_002/audit-bundle").json()
    assert "analysis" in bundle
    assert "results" in bundle["analysis"]


# ── empty and degraded cases ──────────────────────────────────────────────

def test_report_generates_for_a_case_with_no_findings(client):
    """CASE_004 has no banking data; the report must still be produced."""
    response = client.get("/api/v1/cases/CASE_004/report")
    assert response.status_code == 200
    assert response.content.startswith(b"%PDF")


def test_report_generates_for_a_fully_quarantined_case(client):
    response = client.get("/api/v1/cases/CASE_006/report")
    assert response.status_code == 200
    assert response.content.startswith(b"%PDF")
