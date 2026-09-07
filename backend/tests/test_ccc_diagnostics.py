"""
Diagnostics tests.

"No pattern occurrences" is truthful but useless on its own: it does not say
whether the detector failed, the window was too tight, or the case simply has
no banking records. These tests pin the explanation to the case's own numbers.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.analytics.ccc_engine import PATTERNS, diagnose_case
from app.models.event import Domain, EventType, Identifier, IdentifierType, UnifiedEvent

BASE = datetime(2026, 8, 15, 9, 0, tzinfo=timezone.utc)


def ev(kind: EventType, minutes: float, actor: str = "E-1",
       target: str = "E-2", quarantined: bool = False,
       dated: bool = True) -> UnifiedEvent:
    event = UnifiedEvent(
        event_id=f"{kind.value}-{minutes}-{actor}",
        case_id="CASE_T",
        domain=Domain.CDR,
        event_type=kind,
        timestamp=BASE + timedelta(minutes=minutes) if dated else None,
        actor=Identifier(type=IdentifierType.PHONE, value=f"phone-{actor}"),
        target=Identifier(type=IdentifierType.PHONE, value=f"phone-{target}"),
        source_file="t.csv",
        attributes={"actor_entity": actor, "target_entity": target},
    )
    if quarantined:
        event.flags.content_suspect = True
    return event


def sequence_run(offset: float = 0, actor: str = "E-1") -> list[UnifiedEvent]:
    """One clean CALL → TRANSFER → SOCIAL_POST inside half an hour."""
    return [ev(EventType.CALL, offset, actor),
            ev(EventType.TRANSFER, offset + 6, actor),
            ev(EventType.SOCIAL_POST, offset + 21, actor)]


# ── inventory ─────────────────────────────────────────────────────────────

def test_reports_the_numbers_needed_to_trust_an_empty_result():
    events = sequence_run() + [ev(EventType.CALL, 500, quarantined=True)]
    d = diagnose_case(events)
    assert d["events_total"] == 4
    assert d["events_analysed"] == 3
    assert d["events_quarantined_excluded"] == 1
    assert d["subjects"] == ["E-1"]
    assert d["window_minutes"] == 30
    assert d["patterns_checked"] == len(PATTERNS)


def test_counts_canonical_event_types():
    d = diagnose_case(sequence_run())
    assert d["canonical_event_types"] == {"CALL": 1, "SOCIAL_POST": 1, "TRANSFER": 1}


def test_reports_time_span():
    d = diagnose_case(sequence_run())
    assert d["earliest_timestamp"] < d["latest_timestamp"]


def test_undated_events_are_counted_separately():
    d = diagnose_case(sequence_run() + [ev(EventType.CALL, 0, dated=False)])
    assert d["events_without_timestamp"] == 1


# ── matches ───────────────────────────────────────────────────────────────

def test_matching_sequence_is_counted_with_no_rejection():
    d = diagnose_case(sequence_run(0) + sequence_run(600))
    check = next(c for c in d["checks"] if c["pattern"] == "CALL_TRANSFER_SOCIAL")
    assert check["occurrences"] == 2
    assert "rejection" not in check
    assert check["by_subject"] == {"E-1": 2}


# ── rejection reasons ─────────────────────────────────────────────────────

def test_missing_event_type_is_named():
    """The commonest real cause: the case has no banking records at all."""
    events = [ev(EventType.CALL, 0), ev(EventType.CALL, 10)]
    check = next(c for c in diagnose_case(events)["checks"]
                 if c["pattern"] == "CALL_TRANSFER")
    assert check["rejection"]["reason"] == "MISSING_EVENT_TYPE"
    assert "TRANSFER" in check["rejection"]["missing_event_types"]


def test_window_rejection_reports_the_actual_gap():
    """Actionable: it must say how much wider the window would need to be."""
    events = [ev(EventType.CALL, 0), ev(EventType.TRANSFER, 240)]
    check = next(c for c in diagnose_case(events, window_minutes=30)["checks"]
                 if c["pattern"] == "CALL_TRANSFER")
    rejection = check["rejection"]
    assert rejection["reason"] == "OUTSIDE_TIME_WINDOW"
    assert rejection["closest_span_minutes"] == 240
    assert "240" in rejection["detail"]


def test_widening_the_window_turns_a_rejection_into_a_match():
    events = [ev(EventType.CALL, 0), ev(EventType.TRANSFER, 240)]
    tight = next(c for c in diagnose_case(events, window_minutes=30)["checks"]
                 if c["pattern"] == "CALL_TRANSFER")
    wide = next(c for c in diagnose_case(events, window_minutes=300)["checks"]
                if c["pattern"] == "CALL_TRANSFER")
    assert tight["occurrences"] == 0 and wide["occurrences"] == 1


def test_wrong_order_is_distinguished_from_missing_data():
    """TRANSFER before CALL is not a CALL→TRANSFER sequence."""
    events = [ev(EventType.TRANSFER, 0), ev(EventType.CALL, 5)]
    check = next(c for c in diagnose_case(events)["checks"]
                 if c["pattern"] == "CALL_TRANSFER")
    assert check["rejection"]["reason"] == "WRONG_ORDER"


def test_unresolved_events_still_have_a_subject_via_the_identifier():
    """
    subject_of falls back to the raw actor identifier when resolution has not
    run, so analysis degrades to per-identifier rather than failing. Pinned
    because it is the difference between "no subject" and "no cross-domain
    match": unresolved, a person is a phone in CDR and an account in banking.
    """
    events = [ev(EventType.CALL, 0), ev(EventType.TRANSFER, 5)]
    for event in events:
        event.attributes = {}
    d = diagnose_case(events)
    assert d["subjects"] == ["phone-E-1"]
    check = next(c for c in d["checks"] if c["pattern"] == "CALL_TRANSFER")
    assert check["occurrences"] == 1


def test_no_subject_is_reported_rather_than_silence():
    """With no actor at all there is nobody to test, and it must say so."""
    events = [ev(EventType.CALL, 0)]
    for event in events:
        event.attributes = {}
        event.actor = None
    check = diagnose_case(events)["checks"][0]
    assert check["rejection"]["reason"] == "NO_SUBJECT"
    assert "entity resolution" in check["rejection"]["detail"]


# ── the accuracy trap ─────────────────────────────────────────────────────

def test_diagnosis_never_claims_the_case_lacks_data_another_subject_has():
    """
    Regression: probing only the first subject reported "this case contains no
    SOCIAL_POST events" when a different subject had three. The explanation must
    be attributed to a subject, and must say the data exists elsewhere.
    """
    events = ([ev(EventType.CALL, 0, "E-1"), ev(EventType.TRANSFER, 5, "E-1")]
              + [ev(EventType.SOCIAL_POST, 10, "E-2")])
    check = next(c for c in diagnose_case(events)["checks"]
                 if c["pattern"] == "CALL_TRANSFER_SOCIAL")
    detail = check["rejection"]["detail"]
    assert check["rejection"]["subject"] in {"E-1", "E-2"}
    assert detail.startswith(check["rejection"]["subject"])
    assert "belong to other subjects" in detail


def test_closest_subject_is_used_for_the_explanation():
    """A subject that merely missed the window explains more than one with no data."""
    events = ([ev(EventType.CALL, 0, "E-1"), ev(EventType.TRANSFER, 500, "E-1")]
              + [ev(EventType.CALL, 0, "E-2")])
    check = next(c for c in diagnose_case(events)["checks"]
                 if c["pattern"] == "CALL_TRANSFER")
    assert check["rejection"]["reason"] == "OUTSIDE_TIME_WINDOW"
    assert check["rejection"]["subject"] == "E-1"


def test_every_configured_pattern_is_reported():
    """A silently unchecked pattern is exactly the failure mode being guarded."""
    checks = {c["pattern"] for c in diagnose_case(sequence_run())["checks"]}
    assert checks == set(PATTERNS)


def test_each_check_declares_its_required_event_types():
    for check in diagnose_case(sequence_run())["checks"]:
        assert check["required_event_types"]
        assert set(check["required_event_types"]) == set(check["sequence"])
