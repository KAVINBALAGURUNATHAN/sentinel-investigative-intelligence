"""
CCC engine tests, scored against data/synthetic/ground_truth.json.

The decisive test is `test_legitimate_routine_is_not_flagged`: CASE_003 is
*more* statistically extreme than the anomalous CASE_002, so any system that
consults statistics alone flags the innocent subject harder than the suspect.
If that test fails, the false-positive guard is gone.
"""

from __future__ import annotations

import csv
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.analytics.baseline import assess_routine
from app.analytics.ccc_engine import analyse_case, decide, run_ccc
from app.analytics.fdr import benjamini_hochberg, significant_after_fdr
from app.analytics.permutation_test import TypedEvent, count_sequences, permutation_test
from app.services.entity_resolution import resolve_case
from app.services.normalizers import normalize_rows

DATA = Path(__file__).resolve().parents[2] / "data" / "synthetic"
PERMS = 300  # keeps the suite fast; conclusions are unchanged at 1000

UTC = timezone.utc


def rows(name: str) -> list[dict]:
    with (DATA / name).open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


@pytest.fixture(scope="module")
def ground_truth() -> dict:
    return json.loads((DATA / "ground_truth.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def resolved_events() -> list:
    events: list = []
    for kind in ("cdr", "ipdr", "bank", "social"):
        events += normalize_rows(kind, rows(f"{kind}.csv"))
    resolve_case(events, rows("entities.csv"))
    return events


def case_events(events: list, case_id: str) -> list:
    return [e for e in events if e.case_id == case_id]


def result_for(events: list, case_id: str, pattern="CALL_TRANSFER_SOCIAL"):
    found = [r for r in analyse_case(case_events(events, case_id),
                                     patterns=[pattern], permutations=PERMS)
             if r.stats.observed > 0]
    return found[0] if found else None


# ── Benjamini-Hochberg ────────────────────────────────────────────────────

def test_bh_matches_worked_example():
    q = benjamini_hochberg([0.01, 0.02, 0.03, 0.04, 0.05])
    assert [round(v, 4) for v in q] == [0.05, 0.05, 0.05, 0.05, 0.05]


def test_bh_is_monotone_and_preserves_order():
    p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.6, 0.9]
    q = benjamini_hochberg(p)
    ordered = [q[i] for i in sorted(range(len(p)), key=lambda i: p[i])]
    assert ordered == sorted(ordered), "q-values must not decrease with p"


def test_bh_never_reports_below_raw_p():
    p = [0.01, 0.2, 0.5]
    assert all(q >= raw for q, raw in zip(benjamini_hochberg(p), p))


def test_bh_clamps_to_one():
    assert all(q <= 1.0 for q in benjamini_hochberg([0.9, 0.95, 0.99]))


def test_bh_handles_empty_and_single():
    assert benjamini_hochberg([]) == []
    assert benjamini_hochberg([0.03]) == [0.03]


def test_bh_rejects_out_of_range():
    with pytest.raises(ValueError):
        benjamini_hochberg([0.5, 1.5])


def test_fdr_suppresses_an_isolated_weak_signal():
    """
    One borderline result among many nulls is what multiple testing produces by
    chance; BH must not report it. (BH is adaptive, not uniformly stricter —
    when most tests are strong it correctly keeps them.)
    """
    p = [0.04] + [0.6] * 20
    assert sum(1 for x in p if x <= 0.05) == 1, "naive thresholding finds one"
    assert sum(significant_after_fdr(p)) == 0, "FDR should suppress it"


def test_fdr_keeps_a_strong_signal_among_nulls():
    p = [0.0001] + [0.7] * 20
    assert significant_after_fdr(p)[0] is True


# ── sequence counting ─────────────────────────────────────────────────────

def _ev(minute: int, kind: str) -> TypedEvent:
    return TypedEvent(datetime(2026, 8, 15, 9, 0, tzinfo=UTC) + timedelta(minutes=minute), kind)


def test_counts_ordered_sequence_within_window():
    events = [_ev(0, "CALL"), _ev(5, "TRANSFER"), _ev(10, "SOCIAL_POST")]
    assert count_sequences(events, ["CALL", "TRANSFER", "SOCIAL_POST"], timedelta(minutes=30)) == 1


def test_sequence_outside_window_is_not_counted():
    events = [_ev(0, "CALL"), _ev(5, "TRANSFER"), _ev(400, "SOCIAL_POST")]
    assert count_sequences(events, ["CALL", "TRANSFER", "SOCIAL_POST"], timedelta(minutes=30)) == 0


def test_wrong_order_is_not_counted():
    events = [_ev(0, "TRANSFER"), _ev(5, "CALL"), _ev(10, "SOCIAL_POST")]
    assert count_sequences(events, ["CALL", "TRANSFER", "SOCIAL_POST"], timedelta(minutes=30)) == 0


def test_matches_do_not_overlap():
    """3 calls + 3 transfers is 3 occurrences, not 9 combinatorial ones."""
    events = [_ev(0, "CALL"), _ev(1, "CALL"), _ev(2, "CALL"),
              _ev(3, "TRANSFER"), _ev(4, "TRANSFER"), _ev(5, "TRANSFER")]
    assert count_sequences(events, ["CALL", "TRANSFER"], timedelta(minutes=30)) == 3


# ── permutation test ──────────────────────────────────────────────────────

def test_p_value_never_zero():
    """No finite resampling can justify p = 0."""
    events = []
    for day in range(20):
        events += [_ev(day * 1440, "CALL"), _ev(day * 1440 + 2, "TRANSFER")]
    result = permutation_test(events, ["CALL", "TRANSFER"], timedelta(minutes=30),
                              permutations=200)
    assert result.p_value > 0
    assert result.p_value >= 1 / 201


def test_is_deterministic_for_same_seed():
    events = [_ev(i * 60, "CALL" if i % 2 else "TRANSFER") for i in range(30)]
    a = permutation_test(events, ["CALL", "TRANSFER"], timedelta(minutes=90), permutations=100)
    b = permutation_test(events, ["CALL", "TRANSFER"], timedelta(minutes=90), permutations=100)
    assert a.p_value == b.p_value and a.expected == b.expected


def test_random_activity_is_not_significant():
    """Negative control: interleaved routine activity must not be flagged."""
    events = [_ev(i * 37, ["CALL", "TRANSFER", "SOCIAL_POST"][i % 3]) for i in range(60)]
    result = permutation_test(events, ["CALL", "TRANSFER", "SOCIAL_POST"],
                              timedelta(minutes=30), permutations=PERMS)
    assert result.p_value > 0.05


# ── baseline / routine ────────────────────────────────────────────────────

def test_short_burst_is_not_established_routine():
    base = datetime(2026, 8, 15, tzinfo=UTC)
    times = [base + timedelta(hours=4 * i) for i in range(18)]
    assert assess_routine(times).established is False


def test_long_regular_history_is_established_routine():
    base = datetime(2026, 8, 1, tzinfo=UTC)
    times = [base + timedelta(days=i) for i in range(30)]
    assert assess_routine(times).established is True


def test_clustered_days_are_not_routine():
    """Many occurrences over a long span, but on only a few days."""
    base = datetime(2026, 8, 1, tzinfo=UTC)
    times = ([base + timedelta(minutes=10 * i) for i in range(15)] +
             [base + timedelta(days=20, minutes=10 * i) for i in range(15)])
    assert assess_routine(times).established is False


def test_routine_assessment_always_explains_itself():
    assert assess_routine([]).explanation
    base = datetime(2026, 8, 1, tzinfo=UTC)
    assert assess_routine([base + timedelta(days=i) for i in range(30)]).explanation


# ── ground truth: the discrimination that matters ─────────────────────────

def test_cross_domain_anomaly_is_flagged(resolved_events, ground_truth):
    result = result_for(resolved_events, "CASE_002")
    assert result is not None, "CASE_002 pattern not detected at all"
    assert ground_truth["CASE_002"]["expected_alert"] is True
    assert result.decision == "REVIEW"
    assert result.stats.observed == ground_truth["CASE_002"]["expected_occurrences"]
    assert result.stats.lift > 2.0


def test_legitimate_routine_is_not_flagged(resolved_events, ground_truth):
    """
    The false-positive control. CASE_003 is statistically MORE extreme than
    CASE_002; only the subject baseline prevents an innocent subject being
    escalated.
    """
    result = result_for(resolved_events, "CASE_003")
    assert result is not None
    assert ground_truth["CASE_003"]["expected_alert"] is False
    assert result.decision == "NO_ACTION"
    assert result.routine.established is True
    assert result.exculpatory, "a suppressed alert must carry its explanation"


def test_legitimate_case_is_statistically_stronger_than_anomaly(resolved_events):
    """Documents why statistics alone is insufficient."""
    anomaly = result_for(resolved_events, "CASE_002")
    routine = result_for(resolved_events, "CASE_003")
    assert routine.stats.lift >= anomaly.stats.lift
    assert routine.decision == "NO_ACTION" and anomaly.decision == "REVIEW"


def test_normal_behaviour_raises_no_review(resolved_events, ground_truth):
    assert ground_truth["CASE_001"]["expected_alert"] is False
    results = analyse_case(case_events(resolved_events, "CASE_001"), permutations=PERMS)
    assert all(r.decision != "REVIEW" for r in results)


def test_quarantined_records_never_enter_statistics(resolved_events):
    corrupted = case_events(resolved_events, "CASE_006")
    assert any(e.quarantined for e in corrupted)
    for result in analyse_case(corrupted, permutations=50):
        assert result.decision in {"INSUFFICIENT_DATA", "NO_ACTION", "MONITOR"}


# ── output contract ───────────────────────────────────────────────────────

def test_result_dict_carries_full_spec_shape(resolved_events):
    payload = result_for(resolved_events, "CASE_002").as_dict()
    for key in ("pattern", "observed", "expected", "lift", "permutations",
                "p_value", "fdr_adjusted", "decision"):
        assert key in payload, f"missing {key}"
    assert payload["fdr_adjusted"] is not None


def test_output_language_is_non_accusatory(resolved_events):
    """Decision support must never assert guilt."""
    banned = ("criminal", "guilty", "offender", "perpetrator", "proves")
    payload = result_for(resolved_events, "CASE_002").as_dict()
    text = " ".join([payload["interpretation"], *payload["rationale"],
                     *payload["exculpatory_context"]]).lower()
    for word in banned:
        assert word not in text, f"accusatory language: {word!r}"
    assert payload["decision"] in {"REVIEW", "MONITOR", "NO_ACTION", "INSUFFICIENT_DATA"}


def test_interpretation_is_readable_without_statistics_training(resolved_events):
    text = result_for(resolved_events, "CASE_002").interpretation()
    assert len(text) > 80 and "p=" not in text


def test_insufficient_data_makes_no_claim():
    events = [_ev(0, "CALL"), _ev(5, "TRANSFER"), _ev(10, "SOCIAL_POST")]

    class Fake:
        quarantined = False
        attributes: dict = {}

        def __init__(self, e):
            self.timestamp, self.event_type = e.timestamp, e.event_type
            self.actor = type("I", (), {"value": "E-1"})()

    results = decide([run_ccc([Fake(e) for e in events], "E-1",
                              "CALL_TRANSFER_SOCIAL", permutations=50)])
    assert results[0].decision == "INSUFFICIENT_DATA"


def test_unknown_pattern_is_rejected():
    with pytest.raises(ValueError, match="Unknown pattern"):
        run_ccc([], "E-1", "TELEPATHY")
