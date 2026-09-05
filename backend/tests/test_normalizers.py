"""
Multi-domain normalisation tests, scored against data/synthetic/ground_truth.json.

The quarantine counts asserted here are the labels the System Validation page
reports as "Synthetic benchmark results", so these tests and that page must
never disagree.
"""

from __future__ import annotations

import csv
import json
from decimal import Decimal
from pathlib import Path

import pytest

from app.models.event import Domain, EventType, IdentifierType, mask
from app.services.normalizers import (
    ingestion_summary,
    normalize_csv_bytes,
    normalize_rows,
)

DATA = Path(__file__).resolve().parents[2] / "data" / "synthetic"


def load(name: str) -> list[dict]:
    with (DATA / name).open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


@pytest.fixture(scope="module")
def ground_truth() -> dict:
    return json.loads((DATA / "ground_truth.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def events() -> dict[str, list]:
    return {kind: normalize_rows(kind, load(f"{kind}.csv"))
            for kind in ("cdr", "ipdr", "bank", "social")}


# ── totality: nothing is ever dropped ─────────────────────────────────────

@pytest.mark.parametrize("kind", ["cdr", "ipdr", "bank", "social"])
def test_every_row_yields_exactly_one_event(kind, events):
    assert len(events[kind]) == len(load(f"{kind}.csv"))


@pytest.mark.parametrize("kind", ["cdr", "ipdr", "bank", "social"])
def test_validated_plus_quarantined_reconciles(kind, events):
    s = ingestion_summary(events[kind])
    assert s["validated"] + s["quarantined"] == s["total"]


# ── ground-truth quarantine labels ────────────────────────────────────────

def _quarantined_for(case: str, events: dict[str, list]) -> list:
    return [e for evs in events.values() for e in evs
            if e.case_id == case and e.quarantined]


def test_case_006_corrupted_input_quarantine_count(events, ground_truth):
    expected = ground_truth["CASE_006"]["expected_quarantine"]
    assert len(_quarantined_for("CASE_006", events)) == expected


def test_case_007_missing_data_quarantine_count(events, ground_truth):
    expected = ground_truth["CASE_007"]["expected_quarantine"]
    assert len(_quarantined_for("CASE_007", events)) == expected


def test_clean_cases_have_no_quarantine(events, ground_truth):
    for case in ("CASE_001", "CASE_002", "CASE_003", "CASE_004", "CASE_005"):
        assert len(_quarantined_for(case, events)) == 0, f"{case} should be clean"


def test_quarantine_reasons_are_specific(events):
    """A quarantined record must say why — 'invalid' alone is not evidence."""
    for event in _quarantined_for("CASE_006", events) + _quarantined_for("CASE_007", events):
        assert event.flags.reasons(), f"{event.event_id} quarantined with no reason"


# ── per-domain field mapping ──────────────────────────────────────────────

def test_cdr_maps_duration_and_cell_site(events):
    call = next(e for e in events["cdr"]
                if e.case_id == "CASE_001" and not e.quarantined)
    assert call.domain is Domain.CDR
    assert call.event_type is EventType.CALL
    assert call.duration_seconds and call.duration_seconds > 0
    assert call.actor.type is IdentifierType.PHONE
    assert call.attributes["cell_id"] and call.attributes["imei"]


def test_bank_amount_is_decimal_not_float(events):
    txn = next(e for e in events["bank"]
               if e.case_id == "CASE_002" and not e.quarantined)
    assert isinstance(txn.amount, Decimal)
    assert txn.amount > 0 and txn.currency == "INR"


def test_bad_amounts_are_quarantined_never_zeroed(events):
    bad = [e for e in events["bank"] if e.case_id == "CASE_006"]
    assert len(bad) == 2
    for event in bad:
        assert event.quarantined and event.flags.value_invalid
        assert event.amount is None  # must not reach scoring as 0


def test_ipdr_target_is_an_ip_and_not_required(events):
    session = next(e for e in events["ipdr"]
                   if e.case_id == "CASE_001" and not e.quarantined)
    assert session.event_type is EventType.DATA_SESSION
    assert session.target.type is IdentifierType.IP
    assert session.bytes_up is not None and session.bytes_down is not None
    assert not session.flags.target_missing


def test_social_post_has_no_counterparty_and_is_still_valid(events):
    post = next(e for e in events["social"]
                if e.event_type is EventType.SOCIAL_POST and not e.quarantined)
    assert post.target is None
    assert not post.flags.target_missing  # single-actor event, not a defect


def test_timestamps_are_utc(events):
    for evs in events.values():
        for event in evs:
            if event.timestamp is not None:
                assert event.timestamp.utcoffset().total_seconds() == 0


# ── specific corruption modes ─────────────────────────────────────────────

def test_unparseable_timestamp_flags_invalid_not_missing(events):
    event = next(e for e in events["cdr"] if e.case_id == "CASE_006"
                 and e.flags.timestamp_invalid)
    assert not event.flags.timestamp_missing
    assert event.timestamp is None


def test_negative_duration_is_invalid(events):
    assert any(e.flags.value_invalid and e.duration_seconds is None
               for e in events["cdr"] if e.case_id == "CASE_006")


def test_replacement_character_is_detected(events):
    assert any(e.flags.content_suspect
               for e in events["cdr"] if e.case_id == "CASE_006")


def test_absent_timestamp_flags_missing_not_invalid(events):
    event = next(e for e in events["cdr"] if e.case_id == "CASE_007"
                 and e.flags.timestamp_missing)
    assert not event.flags.timestamp_invalid


# ── entity-resolution evidence (CASE_005) ─────────────────────────────────

def test_case_005_second_msisdn_shares_imei_and_ip(events, ground_truth):
    """Resolution is not implemented yet; the linking evidence must exist."""
    a, b, _ = ground_truth["CASE_005"]["expected_entity_links"][0]
    cdr = [e for e in events["cdr"] if e.case_id == "CASE_005"]
    imeis = {e.actor.value: e.attributes["imei"] for e in cdr if e.actor}
    assert imeis.get(a) and imeis.get(a) == imeis.get(b), "shared IMEI is the link"

    ipdr = [e for e in events["ipdr"] if e.case_id == "CASE_005"]
    ips = {e.actor.value: e.attributes["public_ip"] for e in ipdr if e.actor}
    assert ips.get(a) == ips.get(b), "shared public IP corroborates"


# ── masking ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("value,itype,expected", [
    ("9999900101", IdentifierType.PHONE, "******0101"),
    ("203.0.113.11", IdentifierType.IP, "203.0.*.*"),
    ("subjecta@upi", IdentifierType.UPI, "su******@upi"),
    ("@subject_a", IdentifierType.SOCIAL_HANDLE, "@su*******"),
])
def test_masking_keeps_recognisable_tail_only(value, itype, expected):
    assert mask(value, itype) == expected


def test_masking_never_returns_full_value(events):
    for event in events["cdr"][:20]:
        if event.actor:
            assert event.actor.masked != event.actor.value


# ── upload path ───────────────────────────────────────────────────────────

def test_csv_bytes_path_matches_dict_path(events):
    raw = (DATA / "cdr.csv").read_bytes()
    assert len(normalize_csv_bytes("cdr", raw)) == len(events["cdr"])


def test_undecodable_bytes_do_not_raise():
    raw = b"record_id,case_id,caller_msisdn,callee_msisdn,start_time\n1,C,\xff\xfe,222,2026-08-15T09:00:00\n"
    result = normalize_csv_bytes("cdr", raw)
    assert len(result) == 1 and result[0].quarantined


def test_unknown_source_is_rejected_loudly():
    with pytest.raises(ValueError, match="Unknown source"):
        normalize_rows("telegram", [])


def test_summary_counts_discovered_structure(events):
    summary = ingestion_summary(events["cdr"])
    assert summary["identifiers_discovered"] > 0
    assert summary["relationships_discovered"] > 0
