"""
End-to-end tests for the multi-domain API.

Exercises the real flow over HTTP: upload CSV → hash → normalise → resolve
entities → store → analyse → alert → evidence with provenance.

Each test module run uses a throwaway SQLite file, so these never touch a
developer's local store.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

DATA = Path(__file__).resolve().parents[2] / "data" / "synthetic"


@pytest.fixture(scope="module")
def client(tmp_path_factory) -> TestClient:
    os.environ["SENTINEL_DB_PATH"] = str(tmp_path_factory.mktemp("store") / "test.db")
    from app.main import app  # imported after the env var is set
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def ingested(client: TestClient) -> TestClient:
    """Load the entity register first, then every domain."""
    with (DATA / "entities.csv").open("rb") as f:
        assert client.post("/api/v1/ingest/entities/register",
                           files={"file": ("entities.csv", f, "text/csv")}).status_code == 200
    for source in ("cdr", "ipdr", "bank", "social"):
        with (DATA / f"{source}.csv").open("rb") as f:
            response = client.post(f"/api/v1/ingest/{source}",
                                   files={"file": (f"{source}.csv", f, "text/csv")})
        assert response.status_code == 200, response.text
    return client


# ── ingestion ─────────────────────────────────────────────────────────────

def test_ingest_reports_hash_and_reconciling_counts(ingested):
    response = ingested.get("/api/v1/ingestion/batches")
    batches = response.json()["batches"]
    assert batches, "no ingestion batches recorded"
    for batch in batches:
        assert len(batch["sha256"]) == 64
        assert batch["validated"] + batch["quarantined"] == batch["total"]


def test_unknown_source_is_rejected(client):
    response = client.post("/api/v1/ingest/telegram",
                           files={"file": ("x.csv", b"a,b\n1,2\n", "text/csv")})
    assert response.status_code == 400
    assert "Unknown source" in response.json()["detail"]


def test_empty_upload_is_rejected(client):
    response = client.post("/api/v1/ingest/cdr",
                           files={"file": ("empty.csv", b"", "text/csv")})
    assert response.status_code == 400


def test_quarantined_records_are_stored_not_dropped(ingested):
    """CASE_006 is corrupted; its records must still be retrievable."""
    case = ingested.get("/api/v1/cases/CASE_006").json()
    assert case["quarantined"] > 0
    assert case["events"] >= case["quarantined"]


# ── cases and timeline ────────────────────────────────────────────────────

def test_cases_list_reports_data_sources(ingested):
    cases = {c["case_id"]: c for c in ingested.get("/api/v1/cases").json()["cases"]}
    assert "CASE_002" in cases
    assert set(cases["CASE_002"]["data_sources"]) >= {"cdr", "bank", "social"}


def test_case_metadata_starts_unrecorded_and_invents_nothing(ingested):
    """Before anyone fills it in, the fields are empty — never fabricated."""
    meta = ingested.get("/api/v1/cases/CASE_002").json()["case_metadata"]
    assert meta["recorded"] is False
    assert meta["investigator"] is None
    assert meta["name"] is None
    assert meta["authority_reference"] is None
    assert meta["status"] == "OPEN"


def test_case_metadata_round_trips(ingested):
    saved = ingested.put("/api/v1/cases/CASE_002/metadata", json={
        "name": "Operation Test",
        "status": "UNDER REVIEW",
        "investigator": "Inspector on duty",
        "authority_reference": "FIR 123/2026",
    }).json()
    assert saved["recorded"] is True
    assert saved["created_at"] and saved["updated_at"]

    fetched = ingested.get("/api/v1/cases/CASE_002").json()["case_metadata"]
    assert fetched["name"] == "Operation Test"
    assert fetched["status"] == "UNDER REVIEW"
    assert fetched["authority_reference"] == "FIR 123/2026"


def test_partial_update_preserves_other_fields(ingested):
    ingested.put("/api/v1/cases/CASE_004/metadata",
                 json={"name": "Network case", "investigator": "Officer A"})
    ingested.put("/api/v1/cases/CASE_004/metadata", json={"status": "CLOSED"})
    meta = ingested.get("/api/v1/cases/CASE_004/metadata").json()
    assert meta["status"] == "CLOSED"
    assert meta["name"] == "Network case"
    assert meta["investigator"] == "Officer A"


def test_invalid_status_is_rejected(ingested):
    response = ingested.put("/api/v1/cases/CASE_002/metadata",
                            json={"status": "GUILTY"})
    assert response.status_code == 422


def test_metadata_for_unknown_case_is_404(ingested):
    assert ingested.put("/api/v1/cases/NOPE/metadata",
                        json={"name": "x"}).status_code == 404


def test_missing_case_returns_404(ingested):
    assert ingested.get("/api/v1/cases/CASE_NOPE").status_code == 404


def test_timeline_is_chronological_and_filterable(ingested):
    body = ingested.get("/api/v1/cases/CASE_002/timeline?limit=100").json()
    stamps = [e["timestamp"] for e in body["events"] if e["timestamp"]]
    assert stamps == sorted(stamps)

    filtered = ingested.get(
        "/api/v1/cases/CASE_002/timeline?event_types=TRANSFER").json()
    assert filtered["count"] > 0
    assert {e["event_type"] for e in filtered["events"]} == {"TRANSFER"}


def test_timeline_excludes_quarantined_by_default(ingested):
    body = ingested.get("/api/v1/cases/CASE_006/timeline").json()
    assert all(e["quarantined"] is False for e in body["events"])


def test_synthetic_mode_shows_identifiers_in_full(ingested):
    """
    Benchmark data carries no real person's number, and an investigator
    demonstrating resolution has to be able to read the values.
    """
    body = ingested.get("/api/v1/cases/CASE_002/timeline?limit=20").json()
    shown = [e["actor"] for e in body["events"] if e["actor"]]
    assert shown, "no identifiers returned at all"
    assert not any("*" in value for value in shown), "masked under SYNTHETIC mode"


def test_sensitive_mode_masks_identifiers_everywhere(ingested, monkeypatch):
    """
    The protection must still work. Flipping one setting masks every response
    path, which is what a deployment against real records relies on.
    """
    monkeypatch.setenv("SENTINEL_DATA_MODE", "SENSITIVE")

    body = ingested.get("/api/v1/cases/CASE_002/timeline?limit=20").json()
    for event in body["events"]:
        if event["actor"]:
            assert "*" in event["actor"], "raw identifier leaked in SENSITIVE mode"

    profile = ingested.get("/api/v1/entities/E-104?case_id=CASE_002").json()
    for identifier in profile["identifiers"]:
        assert "*" in identifier["value"], "raw identifier leaked in SENSITIVE mode"

    registry = ingested.get("/api/v1/cases/CASE_002/entities").json()
    for row in registry["entities"]:
        if row["kind"] == "IDENTIFIER":
            assert "*" in row["id"], "raw identifier leaked in SENSITIVE mode"


def test_unknown_data_mode_fails_safe_to_masked(monkeypatch):
    """An unrecognised setting must not be read as permission to show values."""
    from app import config

    monkeypatch.setenv("SENTINEL_DATA_MODE", "probably-fine")
    assert config.data_mode() == config.SENSITIVE
    assert config.identifiers_visible() is False


# ── entity resolution ─────────────────────────────────────────────────────

def test_entities_resolve_across_domains(ingested):
    """The whole point: one entity owning phone, account and handle."""
    profile = ingested.get("/api/v1/entities/E-104?case_id=CASE_002").json()
    assert profile["activity"], "entity has no resolved activity"
    assert {"CALL", "TRANSFER"} <= set(profile["activity"])


def test_entity_identifiers_are_readable_in_synthetic_mode(ingested):
    profile = ingested.get("/api/v1/entities/E-104?case_id=CASE_002").json()
    assert profile["identifiers"]
    for identifier in profile["identifiers"]:
        assert "*" not in identifier["value"], "masked under SYNTHETIC mode"


def test_every_identifier_type_is_shown_in_full(ingested):
    """No type may quietly remain masked while the others are readable."""
    registry = ingested.get("/api/v1/cases/CASE_002/entities").json()
    by_type = {}
    for row in registry["entities"]:
        if row["kind"] == "IDENTIFIER":
            by_type.setdefault(row["type"], []).append(row["id"])
    assert by_type, "no identifiers resolved"
    for itype, values in by_type.items():
        for value in values:
            assert "*" not in value, f"{itype} still masked"


def test_display_policy_is_stated(ingested):
    policy = ingested.get("/api/v1/system/display-policy").json()
    assert policy["data_mode"] == "SYNTHETIC"
    assert policy["identifiers_visible"] is True
    assert policy["explanation"]


def test_unknown_entity_returns_404(ingested):
    assert ingested.get("/api/v1/entities/E-999?case_id=CASE_002").status_code == 404


def test_network_edges_are_typed(ingested):
    graph = ingested.get("/api/v1/cases/CASE_002/network").json()
    assert graph["nodes"] and graph["edges"]
    assert all("event_type" in e for e in graph["edges"])


# ── CCC analysis ──────────────────────────────────────────────────────────

def test_patterns_flag_the_anomaly(ingested):
    body = ingested.get(
        "/api/v1/cases/CASE_002/patterns?permutations=200").json()
    target = [r for r in body["results"] if r["pattern"] == "CALL_TRANSFER_SOCIAL"]
    assert target and target[0]["decision"] == "REVIEW"
    assert target[0]["lift"] > 2 and target[0]["fdr_adjusted"] is not None


def test_patterns_clear_the_legitimate_routine(ingested):
    body = ingested.get(
        "/api/v1/cases/CASE_003/patterns?permutations=200").json()
    target = [r for r in body["results"] if r["pattern"] == "CALL_TRANSFER_SOCIAL"]
    assert target and target[0]["decision"] == "NO_ACTION"
    assert target[0]["exculpatory_context"]


def test_analysis_carries_a_disclaimer(ingested):
    body = ingested.get("/api/v1/cases/CASE_001/patterns?permutations=100").json()
    assert "not evidence of wrongdoing" in body["disclaimer"]


def test_alerts_are_created_and_ranked(ingested):
    ingested.get("/api/v1/cases/CASE_002/patterns?permutations=200")
    alerts = ingested.get("/api/v1/alerts?case_id=CASE_002").json()["alerts"]
    assert alerts
    assert alerts[0]["severity"] in {"HIGH", "MEDIUM"}
    assert alerts[0]["detail"]["interpretation"]


def test_alert_carries_statistics_and_explanation(ingested):
    ingested.get("/api/v1/cases/CASE_002/patterns?permutations=200")
    alert = ingested.get("/api/v1/alerts?case_id=CASE_002").json()["alerts"][0]
    for field in ("observed", "expected", "lift", "p_value", "fdr_adjusted"):
        assert alert[field] is not None
    assert alert["detail"]["rationale"]


# ── evidence provenance ───────────────────────────────────────────────────

def test_evidence_traces_back_to_source_hash(ingested):
    event = ingested.get(
        "/api/v1/cases/CASE_002/timeline?limit=1").json()["events"][0]
    record = ingested.get(f"/api/v1/evidence/{event['event_id']}").json()
    provenance = record["provenance"]
    assert len(provenance["sha256"]) == 64
    assert provenance["source_file"] and provenance["source_row"]
    assert provenance["chain_status"] == "VERIFIED"


def test_missing_evidence_returns_404(ingested):
    assert ingested.get("/api/v1/evidence/NOPE-1").status_code == 404


# ── validation benchmark ──────────────────────────────────────────────────

def test_benchmark_scores_against_ground_truth(ingested):
    body = ingested.get("/api/v1/validation/benchmark?permutations=200").json()
    assert body["label"] == "Synthetic benchmark results"
    assert "Not an estimate" in body["disclaimer"]
    assert body["summary"]["tests"] >= 5
    by_case = {t["case_id"]: t for t in body["tests"]}
    assert by_case["CASE_002"]["expected"] == "ALERT"
    assert by_case["CASE_003"]["expected"] == "CLEAR"


def test_benchmark_reports_no_false_positive_on_routine(ingested):
    """The regression that matters: the legitimate case must stay CLEAR."""
    body = ingested.get("/api/v1/validation/benchmark?permutations=200").json()
    routine = next(t for t in body["tests"] if t["case_id"] == "CASE_003")
    assert routine["actual"] == "CLEAR", "legitimate routine was flagged"


# ── existing pipeline must be unaffected ──────────────────────────────────

def test_original_endpoints_still_registered(client):
    paths = set(client.get("/openapi.json").json()["paths"])
    for path in ("/api/v1/ingest", "/api/v1/run/{case_id}",
                 "/api/v1/dashboard/{case_id}", "/api/v1/ledger/{case_id}",
                 "/api/v1/export/court-pack/{case_id}", "/health"):
        assert path in paths, f"{path} disappeared"


def test_new_routes_do_not_shadow_the_original_ingest(client):
    """POST /ingest and POST /ingest/{source} must coexist."""
    paths = set(client.get("/openapi.json").json()["paths"])
    assert "/api/v1/ingest" in paths and "/api/v1/ingest/{source}" in paths


def test_health_still_ok(client):
    assert client.get("/health").json()["status"] == "ok"
