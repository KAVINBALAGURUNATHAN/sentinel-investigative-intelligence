"""
Entity attention score — how much of this case's analysis points at one subject.

WHAT THIS IS NOT: a probability that someone did something wrong. There is no
training data here, no outcome to calibrate against, and no way to validate such
a number on synthetic records. Presenting one would be dishonest.

What it IS: a ranking aid. When a case holds six subjects and three findings,
an investigator needs to know where to start. The score adds up the analysis
that already exists — findings raised against the subject, corroboration across
independent sources, and structural position — and every point traces to a named
indicator that is shown alongside it.

Design rules, deliberately restrictive:

  - No indicator fires without evidence already stored. Nothing is invented.
  - Every contribution is named and returned, so the score can be argued with.
  - It is capped, and the label is "attention", never "risk of offending".
  - A subject with no findings scores zero. Absence of analysis is not suspicion.

The weights are judgement, not measurement, and are stated as such in the
output. They order a worklist; they do not quantify guilt.
"""

from __future__ import annotations

from typing import Any

# Points per indicator. Chosen so that one strong statistical finding alone
# cannot reach the top band — corroboration has to come from somewhere else too.
WEIGHTS = {
    "finding_high": 30,
    "finding_medium": 15,
    "lift_extreme": 15,      # lift >= 10 against the subject's own baseline
    "lift_strong": 8,        # lift >= 3
    "cross_domain_link": 10,  # per counterparty seen in more than one source
    "structural_bridge": 20,
    "multi_source_activity": 5,  # per source beyond the first
}

BANDS = ((60, "HIGH"), (30, "MEDIUM"), (0, "LOW"))


def _band(score: int) -> str:
    for threshold, label in BANDS:
        if score >= threshold:
            return label
    return "LOW"


def score_entity(
    entity_id: str,
    *,
    alerts: list[dict[str, Any]],
    related: list[dict[str, Any]],
    activity: dict[str, int],
    structural: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """
    Score one subject from analysis that already exists.

    alerts      findings stored against this entity
    related     counterparties, each with the relationship types linking them
    activity    event counts by type, from the event store
    structural  NetworkX findings naming this entity
    """
    indicators: list[dict[str, Any]] = []
    total = 0

    own_alerts = [a for a in alerts if a.get("entity_id") == entity_id]
    for alert in own_alerts:
        severity = str(alert.get("severity", "")).upper()
        if severity == "HIGH":
            points = WEIGHTS["finding_high"]
        elif severity == "MEDIUM":
            points = WEIGHTS["finding_medium"]
        else:
            continue
        total += points
        indicators.append({
            "indicator": "FINDING",
            "points": points,
            "detail": f"{severity.title()}-priority finding: {alert.get('pattern')}",
            "evidence": alert.get("alert_id"),
        })

        lift = alert.get("lift")
        if lift is not None:
            if lift >= 10:
                total += WEIGHTS["lift_extreme"]
                indicators.append({
                    "indicator": "STATISTICAL_DEPARTURE", "points": WEIGHTS["lift_extreme"],
                    "detail": f"Occurs {lift:.1f}× more often than this subject's own baseline",
                    "evidence": alert.get("alert_id")})
            elif lift >= 3:
                total += WEIGHTS["lift_strong"]
                indicators.append({
                    "indicator": "STATISTICAL_DEPARTURE", "points": WEIGHTS["lift_strong"],
                    "detail": f"Occurs {lift:.1f}× more often than expected",
                    "evidence": alert.get("alert_id")})

    for link in related:
        if link.get("cross_domain"):
            total += WEIGHTS["cross_domain_link"]
            indicators.append({
                "indicator": "CROSS_SOURCE_LINK",
                "points": WEIGHTS["cross_domain_link"],
                "detail": (f"Linked to {link['entity']} in "
                           f"{len(link['relationships'])} independent sources "
                           f"({', '.join(link['relationships'])})"),
                "evidence": None})

    for finding in (structural or []):
        if finding.get("entity") == entity_id and finding.get("decision") == "REVIEW":
            total += WEIGHTS["structural_bridge"]
            indicators.append({
                "indicator": "STRUCTURAL_POSITION",
                "points": WEIGHTS["structural_bridge"],
                "detail": "Connects groups that would otherwise have no contact",
                "evidence": None})

    sources = len({t for t in activity if activity[t]})
    if sources > 1:
        points = WEIGHTS["multi_source_activity"] * (sources - 1)
        total += points
        indicators.append({
            "indicator": "MULTI_SOURCE_ACTIVITY", "points": points,
            "detail": f"Active across {sources} kinds of record",
            "evidence": None})

    score = max(0, min(100, total))
    return {
        "entity_id": entity_id,
        "score": score,
        "band": _band(score),
        "indicators": sorted(indicators, key=lambda i: -i["points"]),
        "basis": (
            "Sum of the analysis already recorded against this subject. Weights "
            "order a worklist; they are judgement, not a calibrated measurement, "
            "and this score is not a probability of wrongdoing."
        ),
        "no_findings": not own_alerts,
    }
