"""
Pipeline-integrity regression tests.

These cover the seams where data can go missing without anything reporting a
failure: the wrong ingestion endpoint, a graph that was never projected, and a
normaliser that invents an event type. Each one is a silent-loss bug, so each
gets a test that fails loudly.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

DATA = Path(__file__).resolve().parents[2] / "data" / "synthetic"

SOURCES = ("cdr", "ipdr", "bank", "social")


@pytest.fixture(scope="module")
def client(tmp_path_factory) -> TestClient:
    os.environ["SENTINEL_DB_PATH"] = str(tmp_path_factory.mktemp("store") / "pipe.db")
    from app.main import app
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def ingested(client: TestClient) -> TestClient:
    with (DATA / "entities.csv").open("rb") as f:
        client.post("/api/v1/ingest/entities/register",
                    files={"file": ("entities.csv", f, "text/csv")})
    for source in SOURCES:
        with (DATA / f"{source}.csv").open("rb") as f:
            assert client.post(
                f"/api/v1/ingest/{source}",
                files={"file": (f"{source}.csv", f, "text/csv")}).status_code == 200
    return client


# -- Problem 1: the two pipelines must not be confusable --------------------

@pytest.mark.parametrize("source", SOURCES)
def test_multidomain_csv_is_refused_by_the_legacy_endpoint(client, source):
    """
    The legacy path never writes to the event store. Accepting CDR here would
    leave the records absent from timeline, CCC and evidence with no error.
    """
    with (DATA / f"{source}.csv").open("rb") as f:
        response = client.post("/api/v1/ingest",
                               files={"file": (f"{source}.csv", f, "text/csv")})
    assert response.status_code == 400
    assert "/api/v1/ingest/" in response.json()["detail"]


def test_refusal_survives_a_misleading_filename(client):
    """A CSV renamed to .json is still a CSV; the header row settles it."""
    body = (DATA / "cdr.csv").read_bytes()
    response = client.post(
        "/api/v1/ingest", files={"file": ("messages.json", body, "application/json")})
    assert response.status_code == 400
    assert "caller_msisdn" in response.json()["detail"]


def test_legacy_whatsapp_ingestion_still_works(client):
    """Isolating the pipelines must not disable the one being isolated."""
    path = DATA / "whatsapp_conversation_40_messages.json"
    with path.open("rb") as f:
        response = client.post("/api/v1/ingest",
                               files={"file": (path.name, f, "application/json")})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] > 0
    assert len(body["sha256_hash"]) == 64


# -- Problem 2: ingestion must project, and survive Neo4j being down --------

def test_ingestion_reports_graph_projection(client):
    """
    Ingestion returns a projection status for every affected case, whether or
    not Neo4j is reachable. "No graph projected" must never be a silent state.
    """
    with (DATA / "cdr.csv").open("rb") as f:
        response = client.post("/api/v1/ingest/cdr",
                               files={"file": ("cdr.csv", f, "text/csv")})
    assert response.status_code == 200
    body = response.json()
    assert "GRAPH_PROJECTION" in body["stages"]
    assert body["graph_projection"], "projection status must be reported"
    for projection in body["graph_projection"]:
        assert projection["status"] in {"OK", "EMPTY", "SKIPPED", "UNAVAILABLE"}
        assert projection["case_id"]


def test_events_survive_an_unreachable_graph(client):
    """
    Neo4j is optional infrastructure for ingestion. Whatever the projection
    says, the evidence must be in SQLite and visible on the timeline.
    """
    with (DATA / "bank.csv").open("rb") as f:
        body = client.post("/api/v1/ingest/bank",
                           files={"file": ("bank.csv", f, "text/csv")}).json()
    case = body["cases"][0]
    timeline = client.get(f"/api/v1/cases/{case}/timeline?limit=5000").json()
    assert timeline["count"] > 0


def test_rebuild_endpoint_remains_available_for_recovery(ingested):
    """A projection that failed at ingest must be retryable, and repeatable."""
    first = ingested.post("/api/v1/cases/CASE_002/graph/build")
    assert first.status_code == 200
    second = ingested.post("/api/v1/cases/CASE_002/graph/build")
    assert second.status_code == 200
    # Idempotent: the same case projected twice reports the same shape.
    assert first.json()["status"] == second.json()["status"]
    if first.json()["status"] == "OK":
        for key in ("person_nodes", "identifier_nodes",
                    "ownership_edges", "activity_edges"):
            assert first.json()[key] == second.json()[key], key


# -- Problem 7: no invented event types ------------------------------------

def test_unmapped_social_activity_is_quarantined_not_defaulted():
    """
    SOCIAL_POST is a type the CCC engine matches sequences against. Defaulting
    an unrecognised activity to it would manufacture pattern occurrences from
    rows whose meaning is unknown.
    """
    from app.services.normalizers import normalize_social

    event = normalize_social({
        "post_id": "P-1", "case_id": "CASE_TEST", "handle": "@x",
        "timestamp": "2026-08-15T09:00:00+00:00",
        "activity_type": "REACTED",   # not in _SOCIAL_TYPES
    }, row_no=1)
    assert event.flags.event_type_unmapped is True
    assert event.quarantined is True


def test_mapped_social_activity_is_not_quarantined_for_its_type():
    from app.services.normalizers import normalize_social

    event = normalize_social({
        "post_id": "P-2", "case_id": "CASE_TEST", "handle": "@x",
        "timestamp": "2026-08-15T09:00:00+00:00",
        "activity_type": "POST",
    }, row_no=1)
    assert event.flags.event_type_unmapped is False
    assert event.event_type.value == "SOCIAL_POST"


def test_the_synthetic_social_dataset_maps_cleanly():
    """Tightening the mapping must not quarantine the benchmark data."""
    from app.services.normalizers import normalize_csv_bytes

    events = normalize_csv_bytes("social", (DATA / "social.csv").read_bytes())
    assert events
    assert not [e for e in events if e.flags.event_type_unmapped]


# -- Problem 4: global register must not leak into unrelated cases ----------

def test_identifiers_are_scoped_to_cases_that_observed_them(ingested):
    """
    The shared register exists so resolution can consult it. An identifier a
    case never observed must not appear in that case's entity list.
    """
    checked = 0
    for case in ingested.get("/api/v1/cases").json()["cases"]:
        cid = case["case_id"]
        registry = ingested.get(f"/api/v1/cases/{cid}/entities")
        if registry.status_code != 200:
            continue
        identifiers = {e["id"] for e in registry.json()["entities"]
                       if e["kind"] == "IDENTIFIER"}
        if not identifiers:
            continue

        # Everything this case actually observed: the parties to its events and
        # the identifying values its records carry.
        events = ingested.get(f"/api/v1/cases/{cid}/timeline?limit=5000").json()
        observed: set[str] = set()
        for event in events["events"]:
            observed.update(str(v) for v in (event["actor"], event["target"]) if v)
            observed.update(str(v) for v in (event.get("attributes") or {}).values()
                            if isinstance(v, (str, int)))

        unobserved = identifiers - observed
        assert not unobserved, (
            f"{cid} lists identifiers it never observed: {sorted(unobserved)} -- "
            f"a global register must not populate an unrelated case")
        checked += 1

    assert checked >= 2, "need at least two populated cases to be meaningful"


# -- Problem 13: ingestion must be idempotent ------------------------------

def test_reingesting_the_same_file_does_not_duplicate_events(client):
    """
    A double upload must not double the data.

    Duplicated events inflate a subject's observed occurrence count, and the
    CCC engine compares that count against a permutation baseline -- so an
    accidental re-upload could manufacture a significant finding from nothing
    but the duplication.
    """
    def ingest():
        with (DATA / "cdr.csv").open("rb") as f:
            return client.post("/api/v1/ingest/cdr",
                               files={"file": ("cdr.csv", f, "text/csv")}).json()

    first = ingest()
    before = {
        c["case_id"]: (c["events"], c["quarantined"], c["total_records"])
        for c in client.get("/api/v1/cases").json()["cases"]
    }

    second = ingest()
    after = {
        c["case_id"]: (c["events"], c["quarantined"], c["total_records"])
        for c in client.get("/api/v1/cases").json()["cases"]
    }

    assert first["total"] == second["total"]
    assert before == after, "re-ingesting the same file changed the stored counts"


def test_reingestion_keeps_one_row_per_event(client):
    """The stored record is keyed by (case_id, event_id), not by batch."""
    from app.services import event_store as store

    with store.connect() as conn:
        duplicated = conn.execute(
            "SELECT case_id, event_id, COUNT(*) AS n FROM events "
            "GROUP BY case_id, event_id HAVING n > 1").fetchall()
    assert not duplicated, f"duplicate stored events: {[dict(r) for r in duplicated]}"


def test_observed_counts_are_stable_across_a_reingest(client):
    """
    The number the statistics rest on must not move because a file was
    uploaded twice.
    """
    before = client.get(
        "/api/v1/cases/CASE_002/patterns?permutations=200").json()
    with (DATA / "cdr.csv").open("rb") as f:
        client.post("/api/v1/ingest/cdr",
                    files={"file": ("cdr.csv", f, "text/csv")})
    after = client.get(
        "/api/v1/cases/CASE_002/patterns?permutations=200").json()

    assert (before["diagnostics"]["events_analysed"]
            == after["diagnostics"]["events_analysed"])
    observed_before = {r["pattern"]: r["observed"] for r in before["results"]}
    observed_after = {r["pattern"]: r["observed"] for r in after["results"]}
    assert observed_before == observed_after
