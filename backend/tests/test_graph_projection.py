"""
Neo4j projection tests (workflow step 6).

The payload builders are pure functions, so the graph model is verified
without a database. The two tests that need a live Neo4j skip cleanly when it
is unreachable — CI and offline development must not depend on a hosted
instance being awake.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.models.event import Domain, EventType, Identifier, IdentifierType, UnifiedEvent
from app.services.graph_projection import (
    ACTIVITY_RELATIONSHIPS,
    IDENTIFIER_NODES,
    build_activity_payload,
    build_ownership_payload,
    fetch_case_graph,
    project_case,
)

BASE = datetime(2026, 8, 15, 9, 0, tzinfo=timezone.utc)


def event(event_type: EventType, actor: tuple[str, IdentifierType],
          target: tuple[str, IdentifierType] | None = None, *,
          minutes: int = 0, amount: str | None = None,
          duration: int | None = None, quarantined: bool = False) -> UnifiedEvent:
    e = UnifiedEvent(
        event_id=f"E{minutes}-{event_type.value}",
        case_id="CASE_T",
        domain=Domain.CDR,
        event_type=event_type,
        timestamp=BASE + timedelta(minutes=minutes),
        actor=Identifier(type=actor[1], value=actor[0]),
        target=Identifier(type=target[1], value=target[0]) if target else None,
        amount=Decimal(amount) if amount else None,
        duration_seconds=duration,
        source_file="test.csv",
    )
    if quarantined:
        e.flags.timestamp_missing = True
    return e


PHONE_A = ("9999900101", IdentifierType.PHONE)
PHONE_B = ("9999900102", IdentifierType.PHONE)
ACCT_A = ("ICIC0001100101", IdentifierType.BANK_ACCOUNT)
ACCT_B = ("HDFC0002200102", IdentifierType.BANK_ACCOUNT)


# ── ownership layer ───────────────────────────────────────────────────────

def test_identifier_types_map_to_distinct_node_labels():
    """A phone must not be stored as the same kind of node as a bank account."""
    rows = build_ownership_payload([
        {"entity_id": "E-101", "identifier_type": "PHONE",
         "identifier_value": "9999900101", "confidence": 1.0},
        {"entity_id": "E-101", "identifier_type": "BANK_ACCOUNT",
         "identifier_value": "ICIC0001100101", "confidence": 1.0},
        {"entity_id": "E-101", "identifier_type": "IMEI",
         "identifier_value": "356938035643101", "confidence": 0.9},
    ])
    labels = {r["value"]: r["label"] for r in rows}
    assert labels["9999900101"] == "Phone"
    assert labels["ICIC0001100101"] == "BankAccount"
    assert labels["356938035643101"] == "Device"


def test_owned_identifiers_use_owns_and_used_ones_use_uses():
    rows = {r["identifier_type"]: r["relationship"] for r in build_ownership_payload([
        {"entity_id": "E-1", "identifier_type": t, "identifier_value": f"v{t}",
         "confidence": 1.0}
        for t in ("PHONE", "BANK_ACCOUNT", "IMEI", "IP", "SOCIAL_HANDLE")
    ])}
    assert rows["PHONE"] == "OWNS"
    assert rows["BANK_ACCOUNT"] == "OWNS"
    assert rows["SOCIAL_HANDLE"] == "OWNS"
    assert rows["IMEI"] == "USES"
    assert rows["IP"] == "USES"


def test_resolution_confidence_and_basis_are_carried_onto_the_edge():
    """An investigator must be able to see WHY a link was asserted."""
    row = build_ownership_payload([
        {"entity_id": "E-101", "identifier_type": "PHONE",
         "identifier_value": "9999900901", "confidence": 0.82,
         "origin": "INFERRED", "basis": "shared IMEI"},
    ])[0]
    assert row["confidence"] == 0.82
    assert row["origin"] == "INFERRED"
    assert row["basis"] == "shared IMEI"


def test_rows_without_an_entity_or_value_are_skipped():
    assert build_ownership_payload([
        {"entity_id": "", "identifier_type": "PHONE", "identifier_value": "999"},
        {"entity_id": "E-1", "identifier_type": "PHONE", "identifier_value": ""},
    ]) == []


# ── activity layer ────────────────────────────────────────────────────────

def test_repeated_events_collapse_to_one_weighted_edge():
    events = [event(EventType.CALL, PHONE_A, PHONE_B, minutes=i, duration=60)
              for i in range(18)]
    edges = build_activity_payload(events)
    assert len(edges) == 1
    assert edges[0]["count"] == 18
    assert edges[0]["relationship"] == "CALLED"
    assert edges[0]["total_duration"] == 18 * 60


def test_transfers_accumulate_amounts():
    events = [event(EventType.TRANSFER, ACCT_A, ACCT_B, minutes=i, amount="50000.00")
              for i in range(3)]
    edge = build_activity_payload(events)[0]
    assert edge["relationship"] == "TRANSFERRED"
    assert edge["total_amount"] == pytest.approx(150000.0)


def test_edge_records_first_and_last_seen():
    events = [event(EventType.CALL, PHONE_A, PHONE_B, minutes=m) for m in (0, 90, 45)]
    edge = build_activity_payload(events)[0]
    assert edge["first_seen"] < edge["last_seen"]


def test_call_and_transfer_between_same_pair_stay_separate_edges():
    """Different relationship types must remain distinguishable in the UI."""
    edges = build_activity_payload([
        event(EventType.CALL, PHONE_A, PHONE_B),
        event(EventType.TRANSFER, ACCT_A, ACCT_B, amount="100"),
    ])
    assert {e["relationship"] for e in edges} == {"CALLED", "TRANSFERRED"}


def test_quarantined_records_create_no_edges():
    """An unparsed row must never look like an observation."""
    assert build_activity_payload([
        event(EventType.CALL, PHONE_A, PHONE_B, quarantined=True)]) == []


def test_events_without_a_target_create_no_edge():
    assert build_activity_payload([event(EventType.SOCIAL_POST, PHONE_A)]) == []


def test_every_event_type_has_a_relationship_name():
    """A new event type must not silently vanish from the graph."""
    missing = {t.value for t in EventType} - set(ACTIVITY_RELATIONSHIPS)
    assert not missing, f"event types with no graph relationship: {missing}"


def test_every_identifier_type_has_a_node_label():
    missing = {t.value for t in IdentifierType} - set(IDENTIFIER_NODES)
    assert not missing, f"identifier types with no node label: {missing}"


# ── graceful degradation ──────────────────────────────────────────────────

def test_empty_case_reports_empty_not_failure():
    result = project_case("CASE_EMPTY", [], [])
    assert result["status"] == "EMPTY"
    assert result["activity_edges"] == 0


def test_unavailable_neo4j_never_reports_fabricated_counts(monkeypatch):
    """If the graph write fails, the response must not claim nodes were written."""
    import app.services.graph_projection as projection

    def boom(*_args, **_kwargs):
        raise RuntimeError("Neo4j is temporarily unavailable")

    monkeypatch.setattr(projection, "run_write", boom)
    result = projection.project_case(
        "CASE_T",
        [event(EventType.CALL, PHONE_A, PHONE_B)],
        [{"entity_id": "E-101", "identifier_type": "PHONE",
          "identifier_value": "9999900101", "confidence": 1.0}])
    assert result["status"] == "UNAVAILABLE"
    assert result["person_nodes"] == 0
    assert result["ownership_edges"] == 0
    assert "reason" in result


def test_unavailable_read_returns_empty_graph(monkeypatch):
    import app.services.graph_projection as projection

    def boom(*_args, **_kwargs):
        raise RuntimeError("unreachable")

    monkeypatch.setattr(projection, "run_query_for_case", boom)
    result = projection.fetch_case_graph("CASE_T")
    assert result["status"] == "UNAVAILABLE"
    assert result["nodes"] == [] and result["edges"] == []


# ── live Neo4j (skipped when unreachable) ─────────────────────────────────

def _neo4j_available() -> bool:
    """
    True only against a REAL Neo4j.

    tests/conftest.py replaces the whole `neo4j` module with a MagicMock so the
    suite runs offline. That mock answers every query without raising, so a
    naive probe reports success and the assertions below then fail against a
    database that was never there. Detect the mock explicitly and skip.
    """
    import sys
    from unittest.mock import MagicMock

    if isinstance(sys.modules.get("neo4j"), MagicMock):
        return False
    try:
        from app.services.graph_db import run_query

        run_query("RETURN 1 AS ok")
        return True
    except Exception:
        return False


live = pytest.mark.skipif(
    not _neo4j_available(),
    reason="Neo4j mocked by conftest or not reachable; verified separately "
           "against the live instance via the API")


@live
def test_projection_round_trips_through_neo4j():
    case = "CASE_PYTEST_TMP"
    from app.services.graph_projection import clear_case

    clear_case(case)
    result = project_case(
        case,
        [event(EventType.CALL, PHONE_A, PHONE_B, duration=60),
         event(EventType.TRANSFER, ACCT_A, ACCT_B, amount="50000")],
        [{"entity_id": "E-101", "identifier_type": "PHONE",
          "identifier_value": PHONE_A[0], "confidence": 1.0},
         {"entity_id": "E-102", "identifier_type": "PHONE",
          "identifier_value": PHONE_B[0], "confidence": 1.0}])
    assert result["status"] == "OK"

    graph = fetch_case_graph(case)
    assert graph["status"] == "OK"
    assert {"CALLED", "TRANSFERRED", "OWNS"} <= {e["relationship"] for e in graph["edges"]}
    clear_case(case)


@live
def test_reprojection_is_idempotent():
    """Re-running a build must update, not duplicate."""
    case = "CASE_PYTEST_IDEM"
    from app.services.graph_projection import clear_case

    clear_case(case)
    events = [event(EventType.CALL, PHONE_A, PHONE_B)]
    identifiers = [{"entity_id": "E-101", "identifier_type": "PHONE",
                    "identifier_value": PHONE_A[0], "confidence": 1.0}]
    project_case(case, events, identifiers)
    first = len(fetch_case_graph(case)["nodes"])
    project_case(case, events, identifiers)
    assert len(fetch_case_graph(case)["nodes"]) == first
    clear_case(case)
