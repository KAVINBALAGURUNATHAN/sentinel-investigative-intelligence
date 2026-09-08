"""
Regression tests for the reported defect list.

One test per defect, each written to fail against the code as it was. Where a
defect had a downstream consequence for evidence — a score that ranks the wrong
subject, a figure that moves with a tuning knob, an id that stops pointing at
the finding it named — the test asserts that consequence rather than the
mechanism, so a future refactor cannot quietly reintroduce it.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

DATA = Path(__file__).resolve().parents[2] / "data" / "synthetic"
UTC = timezone.utc


# ── BUG-01: structural bridge credited twice ──────────────────────────────

def test_structural_bridge_is_credited_once_not_twice():
    """
    The bridge finding is stored both as an alert row and in the NetworkX
    output. Scoring both gave 30 + 20 = 50 -- enough on its own to clear the
    HIGH band, from the weakest kind of lead in the system.
    """
    from app.analytics.entity_risk import WEIGHTS, score_entity

    alert = {"entity_id": "E-1", "pattern": "STRUCTURAL_BRIDGE",
             "severity": "HIGH", "alert_id": "ALERT-X"}
    structural = [{"entity": "E-1", "decision": "REVIEW"}]

    scored = score_entity("E-1", alerts=[alert], related=[], activity={},
                          structural=structural)

    assert scored["score"] == WEIGHTS["structural_bridge"]
    assert scored["band"] == "LOW"
    positions = [i for i in scored["indicators"]
                 if i["indicator"] == "STRUCTURAL_POSITION"]
    assert len(positions) == 1


def test_structural_bridge_still_counts_when_only_the_alert_is_available():
    """The dashboard calls score_entity without the NetworkX list."""
    from app.analytics.entity_risk import WEIGHTS, score_entity

    scored = score_entity(
        "E-1",
        alerts=[{"entity_id": "E-1", "pattern": "STRUCTURAL_BRIDGE",
                 "severity": "HIGH", "alert_id": "ALERT-X"}],
        related=[], activity={}, structural=None)
    assert scored["score"] == WEIGHTS["structural_bridge"]


def test_a_statistical_finding_is_unaffected():
    """Only STRUCTURAL_BRIDGE alerts change; CCC findings score as before."""
    from app.analytics.entity_risk import WEIGHTS, score_entity

    scored = score_entity(
        "E-1",
        alerts=[{"entity_id": "E-1", "pattern": "CALL_TRANSFER_SOCIAL",
                 "severity": "HIGH", "lift": 17.0, "alert_id": "A"}],
        related=[], activity={}, structural=[])
    assert scored["score"] == WEIGHTS["finding_high"] + WEIGHTS["lift_extreme"]


# ── BUG-02: lift must not scale with the permutation count ────────────────

def _events(pairs):
    from app.analytics.permutation_test import TypedEvent
    base = datetime(2026, 8, 15, 9, 0, tzinfo=UTC)
    return [TypedEvent(base + timedelta(minutes=m), t) for m, t in pairs]


def test_lift_does_not_move_with_the_permutation_count():
    """
    A figure printed beside a p-value must be a property of the data. The old
    zero-expected fallback (observed x permutations) reported 3,600 at N=200
    and 18,000 at N=1000 for identical input.
    """
    from app.analytics.permutation_test import permutation_test

    # A sequence the label-shuffled null essentially never reproduces.
    events = _events([(0, "CALL"), (1, "TRANSFER"), (2, "SOCIAL_POST")]
                     + [(10 + i, "CALL") for i in range(30)])
    seq = ["CALL", "TRANSFER", "SOCIAL_POST"]

    small = permutation_test(events, seq, timedelta(minutes=30), permutations=200)
    large = permutation_test(events, seq, timedelta(minutes=30), permutations=1000)

    if small.expected == 0 and large.expected == 0:
        assert small.lift == large.lift
        assert small.lift_undefined and large.lift_undefined
    else:  # pragma: no cover - depends on the drawn null
        pytest.skip("null produced the sequence; the zero-expected path is untested here")


def test_an_undefined_lift_is_labelled_as_such():
    from app.analytics.permutation_test import LIFT_CEILING, permutation_test

    events = _events([(0, "CALL"), (1, "TRANSFER")]
                     + [(20 + i, "CALL") for i in range(40)])
    result = permutation_test(events, ["CALL", "TRANSFER"],
                              timedelta(minutes=5), permutations=200)
    if result.expected == 0 and result.observed > 0:
        assert result.lift == LIFT_CEILING
        assert result.as_dict()["lift_undefined"] is True


def test_a_defined_lift_is_a_plain_ratio():
    from app.analytics.permutation_test import permutation_test

    events = _events([(i * 3, t) for i, t in
                      enumerate(["CALL", "TRANSFER"] * 12)])
    result = permutation_test(events, ["CALL", "TRANSFER"],
                              timedelta(minutes=10), permutations=200)
    if result.expected > 0:
        assert result.lift == pytest.approx(result.observed / result.expected)
        assert result.lift_undefined is False


# ── BUG-03: tied timestamps must not make the count depend on row order ───

def test_tied_timestamps_give_the_same_count_whatever_the_row_order():
    """
    Records sharing a timestamp have no observable order. The count must be a
    property of the data, not of the order the store happened to return.
    """
    from app.analytics.permutation_test import TypedEvent, count_sequences

    t = datetime(2026, 8, 15, 9, 0, tzinfo=UTC)
    events = [
        TypedEvent(t, "CALL"),
        TypedEvent(t, "TRANSFER"),          # identical instant
        TypedEvent(t + timedelta(minutes=5), "SOCIAL_POST"),
    ]
    seq = ["CALL", "TRANSFER", "SOCIAL_POST"]
    window = timedelta(minutes=30)

    first = count_sequences(events, seq, window)
    reversed_order = count_sequences(list(reversed(events)), seq, window)
    rotated = count_sequences(events[1:] + events[:1], seq, window)

    assert first == reversed_order == rotated


def test_the_p_value_is_reproducible_whatever_the_row_order():
    from app.analytics.permutation_test import permutation_test

    events = _events([(0, "CALL"), (0, "TRANSFER"), (5, "SOCIAL_POST"),
                      (60, "CALL"), (60, "TRANSFER"), (65, "SOCIAL_POST"),
                      (120, "CALL"), (180, "SOCIAL_POST")])
    seq = ["CALL", "TRANSFER", "SOCIAL_POST"]

    forward = permutation_test(events, seq, timedelta(minutes=30), permutations=200)
    backward = permutation_test(list(reversed(events)), seq,
                                timedelta(minutes=30), permutations=200)

    assert forward.observed == backward.observed
    assert forward.p_value == backward.p_value
    assert forward.expected == backward.expected


# ── BUG-07: alert ids must survive a re-analysis ──────────────────────────

def test_alert_ids_are_stable_across_reanalysis():
    """
    Ids were a counter over whatever the analysis returned that run, so
    re-running renumbered them and a written-down id came to name a different
    finding. Nothing warns; the reference just becomes wrong.
    """
    from app.services.event_store import _alert_id

    first = _alert_id("CASE_002", "E-104", "CALL_TRANSFER_SOCIAL")
    again = _alert_id("CASE_002", "E-104", "CALL_TRANSFER_SOCIAL")
    assert first == again

    # A different finding must not collide with it.
    assert first != _alert_id("CASE_002", "E-104", "CALL_SOCIAL")
    assert first != _alert_id("CASE_002", "E-105", "CALL_TRANSFER_SOCIAL")
    assert first != _alert_id("CASE_003", "E-104", "CALL_TRANSFER_SOCIAL")


def test_the_alert_id_does_not_leak_the_subject():
    from app.services.event_store import _alert_id

    aid = _alert_id("CASE_002", "+919876543210", "CALL_TRANSFER_SOCIAL")
    assert "9876543210" not in aid


# ── BUG-13: an explicit type beats a guess about the string's shape ───────

def test_an_at_prefixed_upi_is_masked_as_a_upi():
    """
    The '@' heuristic ran before the declared type, so a UPI beginning with '@'
    took the social-handle branch -- which keeps the sigil and two more
    characters than the UPI rule intends.
    """
    from app.models.event import IdentifierType, mask

    masked = mask("@9876543210@okaxis", IdentifierType.UPI)
    assert masked.endswith("@okaxis")
    assert "9876543" not in masked


def test_a_declared_handle_is_still_masked_as_a_handle():
    from app.models.event import IdentifierType, mask

    assert mask("@alice_r", IdentifierType.SOCIAL_HANDLE).startswith("@al")


def test_untyped_values_still_fall_back_to_shape():
    from app.models.event import mask

    assert mask("@alice_r").startswith("@al")
    assert mask("9876543210@ybl").endswith("@ybl")
    # Untyped and no identifier shape: the generic rule keeps the last four.
    assert mask("203.0.113.44") == "********3.44"


def test_a_declared_ip_is_masked_by_octet():
    from app.models.event import IdentifierType, mask

    assert mask("203.0.113.44", IdentifierType.IP) == "203.0.*.*"


# ── BUG-10: NOT REPRODUCIBLE, deliberately untested ──────────────────────
#
# The report was said to crash with UnicodeEncodeError because ReportLab's
# built-in Helvetica is Latin-1 and the report is full of arrows, em dashes and
# the multiplication sign in lift figures.
#
# It does not. Against the installed ReportLab, Paragraphs containing U+2192,
# U+2014 and Devanagari all build, and every synthetic case exports a valid PDF
# (CASE_002 6.4 kB, CASE_003 6.8 kB, CASE_004 9.2 kB) with no sanitising layer
# in place. No fix was made, because there is nothing here to fix; a
# transliteration pass would have silently rewritten report text to work around
# a defect that does not exist.
#
# What remains true is that this depends on the ReportLab version. If a future
# upgrade reintroduces strict Latin-1 encoding, the export is the thing that
# breaks, and it breaks at write time after the whole report is assembled --
# so this test pins the behaviour rather than assuming it.

def test_every_synthetic_case_exports_a_pdf(client):
    """Guards the export path against a regression in font handling."""
    built = 0
    for case in ("CASE_002", "CASE_003", "CASE_004"):
        response = client.get(f"/api/v1/cases/{case}/report")
        if response.status_code == 404:
            continue
        assert response.status_code == 200, response.text
        assert response.content.startswith(b"%PDF")
        built += 1
    assert built, "no case produced a report; the export path was not exercised"


# ── BUG-11: a gap alert without a pair must not take the dashboard down ───

def test_a_null_pair_key_is_skipped_not_fatal():
    """`alert.get("pair_key", "")` returns None for a present-but-null key."""
    from app.agents.module_11_context import _metadata_matches_pair

    assert _metadata_matches_pair({"sender_id": "A"}, None) is False
    assert _metadata_matches_pair({"sender_id": "A"}, "") is False


# ── BUG-06 / BUG-05: search scope and ownership edges ─────────────────────

@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from fastapi.testclient import TestClient
    os.environ["SENTINEL_DB_PATH"] = str(tmp_path_factory.mktemp("defects") / "d.db")
    from app.main import app
    with TestClient(app) as c:
        with (DATA / "entities.csv").open("rb") as f:
            c.post("/api/v1/ingest/entities/register",
                   files={"file": ("entities.csv", f, "text/csv")})
        for source in ("cdr", "ipdr", "bank", "social"):
            with (DATA / f"{source}.csv").open("rb") as f:
                c.post(f"/api/v1/ingest/{source}",
                       files={"file": (f"{source}.csv", f, "text/csv")})
        yield c


def test_search_scoped_to_one_case_returns_only_that_case(client):
    """The case list was the one result class that ignored the scope."""
    unscoped = client.get("/api/v1/search?q=CASE").json()["results"]
    assert len(unscoped["cases"]) > 1, "need several cases for this to mean anything"

    scoped = client.get("/api/v1/search?q=CASE&case_id=CASE_002").json()["results"]
    assert [c["case_id"] for c in scoped["cases"]] == ["CASE_002"]


def test_search_scope_applies_to_every_result_class(client):
    scoped = client.get("/api/v1/search?q=E-1&case_id=CASE_002").json()["results"]
    for group in scoped.values():
        for hit in group:
            if "case_id" in hit:
                assert hit["case_id"] in ("CASE_002", "ALL")


def test_an_ownership_edge_answers_as_resolution_without_the_type_hint(client):
    """
    Clicking an ownership edge on the graph omits the relationship parameter.
    Answering "0 events, kind OBSERVATION" reads as missing evidence for a link
    that can never have events.
    """
    with __import__("app.services.event_store", fromlist=["x"]).connect() as conn:
        row = conn.execute(
            "SELECT entity_id, identifier_value FROM entity_identifiers "
            "WHERE case_id = 'CASE_002' LIMIT 1").fetchone()
    assert row, "need a resolved identifier for this case"

    body = client.get(
        f"/api/v1/cases/CASE_002/relationship"
        f"?source={row['entity_id']}&target={row['identifier_value']}").json()

    assert body["kind"] == "RESOLUTION"
    assert body["count"] == 0
    assert "not an observed event" in body["note"]


def test_an_activity_edge_is_still_reported_as_an_observation(client):
    timeline = client.get("/api/v1/cases/CASE_002/timeline?limit=50").json()
    event = next(e for e in timeline["events"] if e.get("actor") and e.get("target"))

    body = client.get(
        f"/api/v1/cases/CASE_002/relationship"
        f"?source={event['actor']}&target={event['target']}").json()
    assert body["kind"] == "OBSERVATION"
    assert body["count"] > 0


# ── CDR call_type: two vocabularies, read separately ──────────────────────

def test_a_direction_code_is_not_read_as_a_modality():
    from app.models.event import EventType
    from app.services.normalizers import normalize_cdr

    row = {"record_id": "C-1", "case_id": "CASE_X", "caller_msisdn": "1",
           "callee_msisdn": "2", "start_time": "2026-08-15T09:00:00+00:00",
           "duration_sec": "60", "call_type": "OUT"}
    event = normalize_cdr(row, row_no=1)
    assert event.event_type is EventType.CALL
    assert event.attributes["direction"] == "OUTGOING"
    assert event.flags.event_type_unmapped is False
    assert event.quarantined is False


def test_an_sms_modality_is_still_typed_as_sms():
    from app.models.event import EventType
    from app.services.normalizers import normalize_cdr

    row = {"record_id": "C-2", "case_id": "CASE_X", "caller_msisdn": "1",
           "callee_msisdn": "2", "start_time": "2026-08-15T09:00:00+00:00",
           "duration_sec": "0", "call_type": "SMS"}
    assert normalize_cdr(row, row_no=1).event_type is EventType.SMS


def test_an_unrecognised_call_type_is_quarantined_not_guessed():
    from app.services.normalizers import normalize_cdr

    row = {"record_id": "C-3", "case_id": "CASE_X", "caller_msisdn": "1",
           "callee_msisdn": "2", "start_time": "2026-08-15T09:00:00+00:00",
           "duration_sec": "60", "call_type": "WHOKNOWS"}
    event = normalize_cdr(row, row_no=1)
    assert event.flags.event_type_unmapped is True
    assert event.quarantined is True


def test_the_synthetic_cdr_dataset_still_maps_cleanly():
    """Reading the column properly must not quarantine the benchmark data."""
    from app.services.normalizers import normalize_csv_bytes

    events = normalize_csv_bytes("cdr", (DATA / "cdr.csv").read_bytes())
    assert events
    assert not [e for e in events if e.flags.event_type_unmapped]
