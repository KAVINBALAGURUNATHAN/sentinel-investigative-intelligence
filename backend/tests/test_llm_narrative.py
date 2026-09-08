"""
Tests for the LLM narrative layer.

The model itself is not under test -- it is a remote service whose output
varies. What is under test is the boundary around it: that the brief contains
only stored facts, that fabricated output is rejected rather than published,
and that every response says where its words came from.

These run without network access and without a key. The one test that needs a
live model is skipped unless one is configured.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.services import case_narrative as narr

CASE = {"case_id": "CASE_T", "events": 82, "quarantined": 0, "total_records": 82,
        "entities": 1, "first_event": "2026-08-15T09:00:00+00:00",
        "last_event": "2026-08-19T18:00:00+00:00"}

PATTERNS = {
    "diagnostics": {"events_analysed": 82, "subjects": ["E-104"],
                    "patterns_checked": 4, "window_minutes": 30},
    "results": [
        {"subject": "E-104", "pattern": "CALL_TRANSFER_SOCIAL",
         "sequence": ["CALL", "TRANSFER", "SOCIAL_POST"], "observed": 18,
         "expected": 1.16, "lift": 15.52, "lift_undefined": False,
         "p_value": 0.000999, "fdr_adjusted": 0.000999, "decision": "REVIEW"},
        {"subject": "E-104", "pattern": "CALL_SESSION_TRANSFER",
         "sequence": ["CALL", "DATA_SESSION", "TRANSFER"], "observed": 1,
         "expected": 1.12, "lift": 0.89, "lift_undefined": False,
         "p_value": 0.68, "fdr_adjusted": 0.68, "decision": "INSUFFICIENT_DATA"},
    ],
}


@pytest.fixture
def brief():
    return narr.build_brief(case=CASE, patterns=PATTERNS,
                            network_findings=[], entity_count=11)


# ── The brief carries only stored facts ───────────────────────────────────

def test_the_brief_separates_escalated_from_tested_but_not_escalated(brief):
    """
    Handing the model only positives would let it infer that nothing else was
    examined, and write "no other patterns were checked" about ones that were.
    """
    stats = brief["statistical_analysis"]
    assert [f["pattern"] for f in stats["escalated_findings"]] == ["CALL_TRANSFER_SOCIAL"]
    assert [f["pattern"] for f in stats["tested_but_not_escalated"]] == ["CALL_SESSION_TRANSFER"]


def test_the_brief_states_the_method_and_its_limits(brief):
    assert "permutation" in brief["method_note"].lower()
    assert "not evidence of an offence" in brief["method_note"]


def test_an_undefined_lift_is_not_passed_as_a_number():
    """A ceiling sentinel must not reach the model as though it were measured."""
    undefined = narr.build_brief(
        case=CASE,
        patterns={"diagnostics": PATTERNS["diagnostics"],
                  "results": [{**PATTERNS["results"][0], "lift": 999.0,
                               "lift_undefined": True}]},
        network_findings=[], entity_count=11)
    finding = undefined["statistical_analysis"]["escalated_findings"][0]
    assert finding["lift"] is None
    assert "not defined" in finding["lift_note"]


# ── Verification rejects fabrication ──────────────────────────────────────

def test_truthful_text_passes(brief):
    ok, problems = narr.verify(
        "E-104 shows the sequence observed 18 times against 1.16 expected, "
        "lift 15.52.", brief)
    assert ok, problems


@pytest.mark.parametrize("text,expect", [
    ("E-104 shows the sequence observed 40 times.", "40"),
    ("Transfers totalling 250000 rupees were identified.", "250000"),
    ("The pattern occurred roughly 20 times.", "20"),
])
def test_a_figure_not_in_the_brief_is_rejected(brief, text, expect):
    """
    The core guarantee. A fabricated number in a case summary is a fabricated
    fact about a person, and it reads exactly like a real one.
    """
    ok, problems = narr.verify(text, brief)
    assert not ok
    assert any(expect in p for p in problems)


def test_a_subject_not_in_the_brief_is_rejected(brief):
    ok, problems = narr.verify("E-999 made 18 transfers.", brief)
    assert not ok
    assert any("E-999" in p for p in problems)


@pytest.mark.parametrize("phrase", [
    "E-104 is guilty of the offence.",
    "The data proves coordinated activity.",
    "This clearly shows a pattern of laundering.",
    "E-104 is the perpetrator.",
])
def test_language_asserting_criminality_is_rejected(brief, phrase):
    """
    A statistical pattern means "requires investigation". No generated sentence
    may promote it to a finding of guilt.
    """
    ok, problems = narr.verify(phrase, brief)
    assert not ok
    assert any("criminality" in p for p in problems)


def test_small_structural_numbers_do_not_trip_the_check(brief):
    """Rejecting good text over the word 'two' would make the check useless."""
    ok, problems = narr.verify(
        "Two of the three tested patterns involved E-104.", brief)
    assert ok, problems


# ── The deterministic fallback ────────────────────────────────────────────

def test_the_template_summary_is_built_from_the_brief(brief):
    out = narr.template_narrative(brief)
    assert "82" in out["headline"]
    assert any("18" in s for s in out["observed"])
    assert out["next"]


def test_the_template_summary_passes_its_own_verification(brief):
    """
    The fallback must satisfy the same rules the model's output must satisfy.
    If it did not, the check would be a standard only the model is held to.
    """
    out = narr.template_narrative(brief)
    prose = " ".join([out["headline"], *out["observed"], *out["next"],
                      *out["caveats"]])
    ok, problems = narr.verify(prose, brief)
    assert ok, problems


def test_a_fully_quarantined_case_is_described_honestly():
    empty = narr.build_brief(
        case={"case_id": "CASE_Q", "events": 0, "quarantined": 5,
              "total_records": 5, "entities": 0, "first_event": None,
              "last_event": None},
        patterns={"diagnostics": {"events_analysed": 0, "subjects": [],
                                  "patterns_checked": 0, "window_minutes": 30,
                                  "reasons": ["NO_SUBJECT"]},
                  "results": []},
        network_findings=[], entity_count=0)
    out = narr.template_narrative(empty)
    assert any("quarantine" in s.lower() for s in out["observed"])
    assert any("No pattern met" in s for s in out["observed"])


def test_no_model_configured_returns_a_labelled_template(brief, monkeypatch):
    """Absent a model, the response must say so rather than returning nothing."""
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    out = narr.narrate(brief)
    assert out["mode"] == "TEMPLATE"
    assert "No language model is configured" in out["reason"]
    assert out["headline"]


def test_a_failed_model_call_falls_back_and_says_why(brief, monkeypatch):
    from app.services import llm

    monkeypatch.setenv("GROQ_API_KEY", "test-key-not-used")
    monkeypatch.setattr(llm, "complete", lambda **kw: llm.LLMResult(
        ok=False, mode="UNAVAILABLE", reason="The model returned no content."))
    out = narr.narrate(brief)
    assert out["mode"] == "TEMPLATE"
    assert out["reason"] == "The model returned no content."


def test_unparseable_model_output_is_discarded(brief, monkeypatch):
    from app.services import llm

    monkeypatch.setenv("GROQ_API_KEY", "test-key-not-used")
    monkeypatch.setattr(llm, "complete", lambda **kw: llm.LLMResult(
        ok=True, mode="LIVE", text="Sorry, I cannot help with that."))
    out = narr.narrate(brief)
    assert out["mode"] == "TEMPLATE"
    assert out["verified"] is False


def test_fabricated_model_output_is_discarded_not_published(brief, monkeypatch):
    """
    End to end: a model that invents a figure must not reach the investigator,
    and the response must explain why the text was replaced.
    """
    from app.services import llm

    monkeypatch.setenv("GROQ_API_KEY", "test-key-not-used")
    monkeypatch.setattr(llm, "complete", lambda **kw: llm.LLMResult(
        ok=True, mode="LIVE",
        text='{"headline": "E-104 made 40 transfers totalling 250000 rupees",'
             ' "observed": [], "next": [], "caveats": []}'))
    out = narr.narrate(brief)
    assert out["mode"] == "TEMPLATE"
    assert out["verified"] is False
    assert any("40" in p for p in out["verification_problems"])
    assert "40 transfers" not in out["headline"]


# ── Config surface must not leak the key ──────────────────────────────────

def test_the_config_surface_never_exposes_the_key(monkeypatch):
    from app.services import llm

    monkeypatch.setenv("GROQ_API_KEY", "gsk_supersecretvalue123")
    cfg = llm.config()
    assert cfg["configured"] is True
    serialised = repr(cfg)
    assert "gsk_" not in serialised
    assert "supersecret" not in serialised


def test_the_analytics_package_contains_no_llm_call():
    """
    The boundary, asserted. Statistics must stay reproducible and auditable;
    a model anywhere in that path would make them neither.
    """
    analytics = Path(__file__).resolve().parents[1] / "app" / "analytics"
    for path in analytics.glob("*.py"):
        body = path.read_text(encoding="utf-8").lower()
        for banned in ("import openai", "chat.completions"):
            assert banned not in body, f"{path.name} reaches for an LLM"


# ── Live call, only when a model is actually configured ───────────────────

@pytest.mark.skipif(not os.environ.get("GROQ_API_KEY"),
                    reason="No GROQ_API_KEY configured")
def test_a_live_narrative_is_verified_before_it_is_returned(brief):
    out = narr.narrate(brief)
    assert out["mode"] in {"LIVE", "TEMPLATE"}
    if out["mode"] == "LIVE":
        assert out["verified"] is True
        prose = " ".join([out["headline"], *out["observed"], *out["next"]])
        ok, problems = narr.verify(prose, brief)
        assert ok, problems
