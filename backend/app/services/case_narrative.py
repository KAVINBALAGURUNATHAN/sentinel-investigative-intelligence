"""
SENTINEL — LLM case narrative, grounded and checked.

THE PROBLEM THIS SOLVES

An investigator opening a case sees counts, a graph, a timeline and a table of
statistical results. Reading that into a coherent picture is work, and it is
work a language model is genuinely good at. So the model is used to write the
summary.

THE PROBLEM THAT CREATES

A language model will write "approximately 40 transfers" when the figure is 18,
and it will write it in the same confident register as everything else. In an
investigative tool that is not a cosmetic flaw: a fabricated number in a case
summary is a fabricated fact about a person.

HOW IT IS HANDLED — three layers, in order

  1. GROUNDING. The model never queries anything. It is handed a brief built
     entirely from stored records and computed statistics, and told that the
     brief is the only permissible source of fact.

  2. VERIFICATION. Every number and every entity identifier in the generated
     text is checked against the brief. A figure the brief does not contain
     means the text is rejected -- not edited, not published with a caveat.
     Rejected.

  3. LANGUAGE. The output is checked for words that assert criminality. A
     statistical pattern is not proof of an offence, and no generated sentence
     is allowed to imply that it is.

If any layer fails, a deterministic summary is returned instead, assembled from
the same brief by template, and the response says plainly that the text was not
model-generated and why. The investigator is never shown unverified prose and
told it came from the model.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from app.services import llm

log = logging.getLogger("sentinel.narrative")

# Words that assert an offence or a conclusion of guilt. A detected pattern
# means "requires investigation", never this.
PROHIBITED = (
    "criminal", "guilty", "guilt", "culprit", "perpetrator", "offender",
    "proves", "proven", "proof of", "confirms that", "confirmed that",
    "fraudster", "launder", "laundering", "conviction", "convicted",
    "beyond doubt", "clearly shows", "demonstrates that",
)

SYSTEM = (
    "You write case summaries for police investigators working with "
    "communications and financial records.\n\n"
    "ABSOLUTE RULES:\n"
    "1. The supplied brief is your ONLY source of fact. Do not add figures, "
    "dates, names, identifiers, locations or events that are not in it.\n"
    "2. Never state or imply that anyone committed an offence. A statistical "
    "pattern means 'requires investigation', not 'guilt'. Do not use the words "
    "criminal, guilty, proves, confirms, fraud or laundering.\n"
    "3. Quote figures exactly as given. Do not round, estimate, total or "
    "recompute them.\n"
    "4. If the brief shows no findings, say so plainly. Do not manufacture "
    "significance to fill the summary.\n"
    "5. Write for a professional reader: direct, specific, no filler, no "
    "restating the instructions.\n\n"
    "Return ONLY a JSON object with these keys:\n"
    '  "headline"  one sentence, max 25 words, what this case currently shows\n'
    '  "observed"  array of 2-4 strings: what the data shows, each citing a '
    "figure from the brief\n"
    '  "next"      array of 2-3 strings: what an investigator should check '
    "next, phrased as actions\n"
    '  "caveats"   array of 1-2 strings: the limits of what this analysis can '
    "support"
)


# ── The brief ─────────────────────────────────────────────────────────────

def build_brief(*, case: dict[str, Any], patterns: dict[str, Any],
                network_findings: list[dict[str, Any]],
                entity_count: int) -> dict[str, Any]:
    """
    Assemble the only facts the model is permitted to use.

    Everything here was read from the event store or computed by the analytics
    package. Nothing is derived inside this function beyond selecting fields,
    so the brief cannot introduce a figure the system did not already hold.
    """
    diagnostics = patterns.get("diagnostics") or {}
    results = patterns.get("results") or []

    findings = []
    for r in results:
        if r.get("decision") not in ("REVIEW", "MONITOR"):
            continue
        findings.append({
            "subject": r.get("subject"),
            "pattern": r.get("pattern"),
            "sequence": " then ".join(r.get("sequence") or []),
            "occurrences_observed": r.get("observed"),
            "expected_under_chance": r.get("expected"),
            "lift": None if r.get("lift_undefined") else r.get("lift"),
            "lift_note": ("not defined - the comparison baseline never produced "
                          "this sequence" if r.get("lift_undefined") else None),
            "p_value": r.get("p_value"),
            "fdr_adjusted_q": r.get("fdr_adjusted"),
            "decision": r.get("decision"),
        })

    # Results that were tested and deliberately NOT escalated. Included so the
    # model can say a case was examined and found unremarkable, rather than
    # being handed only positives and inferring that silence means nothing
    # was checked.
    not_escalated = [
        {"subject": r.get("subject"), "pattern": r.get("pattern"),
         "occurrences_observed": r.get("observed"), "decision": r.get("decision")}
        for r in results if r.get("decision") not in ("REVIEW", "MONITOR")
    ]

    return {
        "case_id": case.get("case_id"),
        "records": {
            "usable_events": case.get("events"),
            "quarantined_records": case.get("quarantined"),
            "total_ingested": case.get("total_records"),
            "distinct_subjects_with_activity": case.get("entities"),
            "resolved_entities": entity_count,
        },
        "period": {"first_event": case.get("first_event"),
                   "last_event": case.get("last_event")},
        "statistical_analysis": {
            "events_analysed": diagnostics.get("events_analysed"),
            "subjects_tested": diagnostics.get("subjects"),
            "patterns_checked": diagnostics.get("patterns_checked"),
            "window_minutes": diagnostics.get("window_minutes"),
            "escalated_findings": findings,
            "tested_but_not_escalated": not_escalated,
            "zero_match_reasons": diagnostics.get("reasons"),
        },
        "network_findings": [
            {"subject": f.get("entity"), "finding": f.get("finding"),
             "betweenness": f.get("betweenness"), "decision": f.get("decision")}
            for f in network_findings
            if f.get("decision") in ("REVIEW", "MONITOR")
        ],
        "method_note": (
            "Findings come from a permutation test against each subject's own "
            "activity baseline, with Benjamini-Hochberg false-discovery "
            "correction. A finding means the pattern is statistically unusual "
            "for that subject and is not their established routine. It is a "
            "lead to investigate, not evidence of an offence."
        ),
    }


# ── Verification ──────────────────────────────────────────────────────────

_NUM = re.compile(r"\d+(?:\.\d+)?")
_ENTITY = re.compile(r"\bE-\d+\b")


def _permitted_numbers(brief: dict[str, Any]) -> set[str]:
    """
    Every numeric token the brief contains, in the forms it may be written in.

    A figure the brief does not hold cannot be checked, and an unverifiable
    figure in a case summary is indistinguishable from an invented one.
    """
    allowed: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, (list, tuple)):
            for v in node:
                walk(v)
        elif isinstance(node, bool) or node is None:
            return
        elif isinstance(node, (int, float)):
            allowed.add(_fmt(node))
            if isinstance(node, float):
                allowed.add(_fmt(round(node)))
                allowed.add(f"{node:.1f}".rstrip("0").rstrip("."))
                allowed.add(f"{node:.2f}")
                allowed.add(f"{node:.4f}")
        elif isinstance(node, str):
            for m in _NUM.findall(node):
                allowed.add(m.rstrip("0").rstrip(".") if "." in m else m)
                allowed.add(m)
    walk(brief)

    # Ordinals the model uses to structure prose ("the first of three") are not
    # claims about the data. Figures this small cannot encode a meaningful
    # fabricated quantity, and excluding them avoids rejecting good text over
    # the word "two".
    allowed.update({"0", "1", "2", "3"})
    return allowed


def _fmt(value: Any) -> str:
    if isinstance(value, float) and value == int(value):
        return str(int(value))
    s = str(value)
    return s.rstrip("0").rstrip(".") if "." in s else s


def verify(text: str, brief: dict[str, Any]) -> tuple[bool, list[str]]:
    """
    Check generated prose against the brief. Returns (ok, problems).

    Two checks, both of which reject rather than repair. Silently correcting a
    model's number would hide that it invented one, and the next version of the
    model would inherit the same trust.
    """
    problems: list[str] = []

    allowed = _permitted_numbers(brief)
    for token in _NUM.findall(text):
        normalised = token.rstrip("0").rstrip(".") if "." in token else token
        if token not in allowed and normalised not in allowed:
            problems.append(f"figure '{token}' does not appear in the brief")

    brief_entities = set(_ENTITY.findall(json.dumps(brief)))
    for entity in set(_ENTITY.findall(text)):
        if entity not in brief_entities:
            problems.append(f"subject '{entity}' is not named in the brief")

    lowered = text.lower()
    for word in PROHIBITED:
        if word in lowered:
            problems.append(f"asserts criminality or certainty: '{word}'")

    return (not problems), problems


# ── Deterministic fallback ────────────────────────────────────────────────

def template_narrative(brief: dict[str, Any]) -> dict[str, Any]:
    """
    The summary when the model is unavailable or its output failed verification.

    Assembled from the brief by template. Less fluent, equally true -- and the
    response labels it, so nobody mistakes it for model output.
    """
    rec = brief["records"]
    stats = brief["statistical_analysis"]
    findings = stats["escalated_findings"]
    bridges = brief["network_findings"]

    observed = [
        f"{rec['usable_events']} usable events across "
        f"{rec['distinct_subjects_with_activity']} subjects with activity."
    ]
    if rec.get("quarantined_records"):
        observed.append(
            f"{rec['quarantined_records']} of {rec['total_ingested']} ingested "
            f"records failed validation and are held in quarantine, excluded "
            f"from analysis but retained for audit.")
    for f in findings:
        lift = (f"lift {f['lift']}" if f.get("lift") is not None
                else "lift not defined")
        observed.append(
            f"{f['subject']}: {f['sequence']} observed {f['occurrences_observed']} "
            f"times ({lift}, q={f['fdr_adjusted_q']}) — {f['decision']}.")
    for b in bridges:
        observed.append(
            f"{b['subject']} holds a structural bridge position "
            f"(betweenness {b['betweenness']}) — {b['decision']}.")
    if not findings and not bridges:
        reasons = stats.get("zero_match_reasons")
        observed.append(
            "No pattern met the escalation criteria."
            + (f" Reported reasons: {', '.join(reasons)}." if reasons else ""))

    nxt = []
    if findings:
        nxt.append(f"Review the underlying records for "
                   f"{', '.join(sorted({f['subject'] for f in findings}))} "
                   f"through the evidence trail.")
    if bridges:
        nxt.append("Corroborate each structural position against independent "
                   "sources before escalating it.")
    if rec.get("quarantined_records"):
        nxt.append("Inspect the quarantined records in Batch History and "
                   "re-ingest any that are recoverable.")
    if not nxt:
        nxt.append("No action indicated by the current analysis. Ingest "
                   "further sources if the case warrants it.")

    return {
        "headline": (
            f"Case {brief['case_id']}: {len(findings)} statistical "
            f"{'finding' if len(findings) == 1 else 'findings'} and "
            f"{len(bridges)} structural "
            f"{'finding' if len(bridges) == 1 else 'findings'} "
            f"across {rec['usable_events']} usable events."),
        "observed": observed[:5],
        "next": nxt[:3],
        "caveats": [
            "A statistical pattern indicates that activity is unusual for this "
            "subject. It is a lead requiring investigation, not evidence of an "
            "offence.",
            "Inferred identity links require investigator confirmation before "
            "they are relied upon.",
        ],
    }


# ── Entry point ───────────────────────────────────────────────────────────

def narrate(brief: dict[str, Any]) -> dict[str, Any]:
    """
    Generate a case narrative, verify it, and report honestly which path ran.

    The returned dict always carries `mode`, and for anything other than LIVE a
    `reason` the UI can show. There is no path that returns unlabelled text.
    """
    if not llm.available():
        return {**template_narrative(brief), "mode": "TEMPLATE",
                "reason": "No language model is configured.",
                "verified": None, "llm": llm.config()}

    result = llm.complete(
        system=SYSTEM,
        user=("Write the case summary. The brief below is your only source of "
              "fact.\n\nBRIEF:\n" + json.dumps(brief, indent=2, default=str)),
    )

    if not result.ok:
        log.warning("narrative fell back for %s: %s", brief.get("case_id"), result.reason)
        return {**template_narrative(brief), "mode": "TEMPLATE",
                "reason": result.reason, "verified": None,
                "llm": result.as_dict()}

    payload = _parse(result.text)
    if payload is None:
        return {**template_narrative(brief), "mode": "TEMPLATE",
                "reason": "The model response was not valid JSON in the "
                          "expected shape.",
                "verified": False, "llm": result.as_dict()}

    # Verify the prose only. Keys and structure are ours; the text is the model's.
    prose = " ".join(
        [str(payload.get("headline") or "")]
        + [str(s) for s in (payload.get("observed") or [])]
        + [str(s) for s in (payload.get("next") or [])]
        + [str(s) for s in (payload.get("caveats") or [])])

    ok, problems = verify(prose, brief)
    if not ok:
        log.warning("narrative verification failed for %s: %s",
                    brief.get("case_id"), problems)
        return {**template_narrative(brief), "mode": "TEMPLATE",
                "reason": "The generated summary did not pass grounding "
                          "verification and was discarded.",
                "verified": False, "verification_problems": problems,
                "llm": result.as_dict()}

    log.info("narrative generated for %s in %dms",
             brief.get("case_id"), result.latency_ms)
    return {
        "headline": str(payload.get("headline") or "").strip(),
        "observed": [str(s).strip() for s in (payload.get("observed") or [])][:4],
        "next": [str(s).strip() for s in (payload.get("next") or [])][:3],
        "caveats": [str(s).strip() for s in (payload.get("caveats") or [])][:2],
        "mode": "LIVE",
        "reason": None,
        "verified": True,
        "llm": result.as_dict(),
    }


def _parse(text: str) -> dict[str, Any] | None:
    """Pull the JSON object out of a response that may be fenced or prefaced."""
    try:
        start, end = text.index("{"), text.rindex("}") + 1
    except ValueError:
        return None
    try:
        data = json.loads(text[start:end])
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or "headline" not in data:
        return None
    return data
