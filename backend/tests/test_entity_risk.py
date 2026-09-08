"""
Attention score tests.

A score attached to a person is the most dangerous object in this application:
it is the one number an investigator might act on without reading anything else.
These tests fix the properties that keep it honest — it stays zero without
evidence, it always carries its reasons, and it never claims to measure guilt.
"""

from __future__ import annotations

from app.analytics.entity_risk import WEIGHTS, score_entity


def alert(entity="E-1", severity="HIGH", lift=None, pattern="CALL_TRANSFER"):
    return {"entity_id": entity, "severity": severity, "lift": lift,
            "pattern": pattern, "alert_id": f"ALERT-{entity}"}


def link(entity="E-2", relationships=("CALL",), cross=False):
    return {"entity": entity, "relationships": list(relationships),
            "cross_domain": cross, "events": 1}


# ── the score must not invent suspicion ───────────────────────────────────

def test_subject_with_no_analysis_scores_zero():
    """Absence of a finding is not evidence of anything."""
    result = score_entity("E-1", alerts=[], related=[], activity={})
    assert result["score"] == 0
    assert result["band"] == "LOW"
    assert result["indicators"] == []
    assert result["no_findings"] is True


def test_activity_alone_does_not_raise_the_band():
    """Being busy is not suspicious. Only corroborated analysis moves the score."""
    result = score_entity("E-1", alerts=[], related=[],
                          activity={"CALL": 500, "TRANSFER": 300})
    assert result["band"] == "LOW"


def test_another_subjects_finding_does_not_score_this_one():
    result = score_entity("E-1", alerts=[alert(entity="E-9")], related=[], activity={})
    assert result["score"] == 0


# ── every point is accounted for ──────────────────────────────────────────

def test_points_sum_to_the_score():
    """The number must equal the reasons given for it, or it cannot be argued with."""
    result = score_entity(
        "E-1",
        alerts=[alert(lift=17.3), alert(severity="MEDIUM", lift=4.0)],
        related=[link(cross=True), link(entity="E-3")],
        activity={"CALL": 10, "TRANSFER": 4},
        structural=[{"entity": "E-1", "decision": "REVIEW"}])
    assert sum(i["points"] for i in result["indicators"]) >= result["score"]
    assert result["score"] == min(100, sum(i["points"] for i in result["indicators"]))


def test_every_indicator_names_itself():
    result = score_entity("E-1", alerts=[alert(lift=12)], related=[], activity={})
    assert result["indicators"]
    for indicator in result["indicators"]:
        assert indicator["indicator"]
        assert indicator["detail"]
        assert indicator["points"] > 0


def test_findings_are_traceable_to_their_alert():
    result = score_entity("E-1", alerts=[alert(lift=12)], related=[], activity={})
    finding = next(i for i in result["indicators"] if i["indicator"] == "FINDING")
    assert finding["evidence"] == "ALERT-E-1"


# ── the weighting behaves as documented ───────────────────────────────────

def test_one_finding_alone_cannot_reach_the_top_band():
    """Corroboration has to come from somewhere else before a subject reads HIGH."""
    result = score_entity("E-1", alerts=[alert(severity="HIGH")], related=[], activity={})
    assert result["score"] < 60
    assert result["band"] != "HIGH"


def test_stronger_departure_scores_above_weaker_one():
    weak = score_entity("E-1", alerts=[alert(lift=3.5)], related=[], activity={})
    strong = score_entity("E-1", alerts=[alert(lift=17.0)], related=[], activity={})
    assert strong["score"] > weak["score"]


def test_cross_source_links_count_but_single_source_ones_do_not():
    single = score_entity("E-1", alerts=[], related=[link()], activity={})
    crossed = score_entity("E-1", alerts=[], related=[link(cross=True)], activity={})
    assert single["score"] == 0
    assert crossed["score"] == WEIGHTS["cross_domain_link"]


def test_score_is_capped():
    result = score_entity(
        "E-1",
        alerts=[alert(lift=50) for _ in range(9)],
        related=[link(entity=f"E-{n}", cross=True) for n in range(9)],
        activity={"CALL": 1, "TRANSFER": 1, "SOCIAL_POST": 1, "DATA_SESSION": 1},
        structural=[{"entity": "E-1", "decision": "REVIEW"}])
    assert result["score"] == 100


def test_monitor_only_structural_finding_does_not_score():
    """Only a finding that asks for review contributes."""
    result = score_entity("E-1", alerts=[], related=[], activity={},
                          structural=[{"entity": "E-1", "decision": "MONITOR"}])
    assert result["score"] == 0


# ── language ──────────────────────────────────────────────────────────────

def test_basis_disclaims_measurement_of_wrongdoing():
    result = score_entity("E-1", alerts=[alert()], related=[], activity={})
    basis = result["basis"].lower()
    assert "not a probability" in basis
    assert "judgement" in basis


def test_no_accusatory_language_anywhere_in_the_output():
    result = score_entity(
        "E-1", alerts=[alert(lift=20)], related=[link(cross=True)],
        activity={"CALL": 3}, structural=[{"entity": "E-1", "decision": "REVIEW"}])
    text = " ".join(
        [result["basis"], result["band"]]
        + [i["detail"] for i in result["indicators"]]).lower()
    for word in ("criminal", "guilty", "offender", "perpetrator", "fraud", "proves"):
        assert word not in text
