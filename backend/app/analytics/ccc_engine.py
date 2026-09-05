"""
CCC engine — Cross-domain Corroboration & Context.

Pipeline for one (subject, pattern) test:

  1. find occurrences of an ordered cross-domain sequence for the subject
  2. build the null by permuting event-type labels over the subject's own
     observed timestamps          (permutation_test.py)
  3. empirical p-value and lift    (permutation_test.py)
  4. assess whether the pattern is an established routine   (baseline.py)
  5. across all tests in a run, apply Benjamini-Hochberg     (fdr.py)
  6. return a decision with the evidence needed to explain it

Two independent questions are asked, deliberately:

  STATISTICAL   Is this sequence more frequent than chance, given when this
                subject was active?
  CONTEXTUAL    Has the subject been doing it long and regularly enough that a
                routine is a plausible innocent explanation?

Only "statistically unusual AND not an established routine" reaches REVIEW.
A payroll clerk transferring money after a call every day scores as strongly
non-random as a fraud ring; the second question is what separates them, and
skipping it is how a system becomes a false-positive machine.

LANGUAGE: decisions are REVIEW / MONITOR / NO_ACTION / INSUFFICIENT_DATA.
Nothing here concludes guilt. Output is decision support for an investigator.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Iterable, Sequence

from app.analytics.baseline import RoutineAssessment, assess_routine
from app.analytics.fdr import benjamini_hochberg
from app.analytics.permutation_test import (
    PermutationResult,
    TypedEvent,
    count_sequences,
    permutation_test,
)

DEFAULT_WINDOW_MINUTES = 30
DEFAULT_PERMUTATIONS = 1000
ALPHA = 0.05
MIN_LIFT = 2.0
MIN_OCCURRENCES = 3  # below this, resampling cannot support a claim


# Cross-domain sequences of investigative interest. Each is a hypothesis to
# test, never a finding in itself.
PATTERNS: dict[str, list[str]] = {
    "CALL_TRANSFER_SOCIAL": ["CALL", "TRANSFER", "SOCIAL_POST"],
    "CALL_TRANSFER": ["CALL", "TRANSFER"],
    "TRANSFER_SOCIAL": ["TRANSFER", "SOCIAL_POST"],
    "CALL_SESSION_TRANSFER": ["CALL", "DATA_SESSION", "TRANSFER"],
}


@dataclass
class CCCResult:
    """One (subject, pattern) test, with everything needed to explain it."""

    subject: str
    pattern: str
    sequence: list[str]
    window_minutes: int
    stats: PermutationResult
    routine: RoutineAssessment
    fdr_adjusted: float | None = None
    decision: str = "PENDING"
    rationale: list[str] = field(default_factory=list)
    exculpatory: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        """Shape consumed by the CCC panel and the alert detail view."""
        return {
            "subject": self.subject,
            "pattern": self.pattern,
            "sequence": self.sequence,
            "window_minutes": self.window_minutes,
            "observed": self.stats.observed,
            "expected": round(self.stats.expected, 2),
            "lift": round(self.stats.lift, 2),
            "permutations": self.stats.permutations,
            "p_value": round(self.stats.p_value, 6),
            "fdr_adjusted": (None if self.fdr_adjusted is None
                             else round(self.fdr_adjusted, 6)),
            "decision": self.decision,
            "rationale": self.rationale,
            "exculpatory_context": self.exculpatory,
            "baseline": self.routine.as_dict(),
            "null_range": [self.stats.null_min, self.stats.null_max],
            "interpretation": self.interpretation(),
        }

    def interpretation(self) -> str:
        """Plain-language reading for an investigator who is not a statistician."""
        if self.decision == "INSUFFICIENT_DATA":
            return (f"Only {self.stats.observed} occurrence(s) of "
                    f"{self.pattern.replace('_', ' → ')}. Too few to test "
                    f"reliably; no statistical claim is made.")
        times = "time" if self.stats.observed == 1 else "times"
        base = (
            f"The sequence {self.pattern.replace('_', ' → ')} completed within "
            f"{self.window_minutes} minutes {self.stats.observed} {times}. "
            f"Rearranging this subject's own activity at random produced it "
            f"about {self.stats.expected:.1f} times on average "
            f"({self.stats.lift:.1f}× fewer), and reached the observed count in "
            f"roughly {self.stats.p_value * 100:.1f}% of {self.stats.permutations} "
            f"random rearrangements."
        )
        if self.decision == "NO_ACTION":
            return base + (" However, the behaviour is long-standing and regular "
                           "for this subject, so an established routine is a "
                           "plausible explanation. Verify before escalating.")
        if self.decision == "REVIEW":
            return base + (" The pattern is not explained by an established "
                           "routine and warrants review of the supporting "
                           "evidence. This is not a finding of wrongdoing.")
        return base + " Retained for monitoring; no action indicated yet."


def subject_of(event: Any) -> str | None:
    """
    The subject an event belongs to: the resolved entity where identity
    resolution has run, otherwise the raw actor identifier.

    Without resolution a person is a different actor in every domain — a phone
    number in CDR, an account in banking — and no cross-domain sequence can
    ever match. See services/entity_resolution.py.
    """
    attrs = getattr(event, "attributes", None) or {}
    entity = attrs.get("actor_entity")
    if entity:
        return str(entity)
    actor = getattr(event, "actor", None)
    return actor.value if actor is not None else None


def _subject_events(
    events: Iterable[Any],
    subject_key: str,
) -> list[TypedEvent]:
    """Project a subject's UnifiedEvents onto (timestamp, type) pairs.

    Quarantined records are excluded: a record we could not parse must never
    contribute to a statistical claim.
    """
    projected: list[TypedEvent] = []
    for event in events:
        if getattr(event, "quarantined", False) or event.timestamp is None:
            continue
        if subject_of(event) != subject_key:
            continue
        etype = event.event_type
        projected.append(
            TypedEvent(event.timestamp, etype.value if hasattr(etype, "value") else str(etype))
        )
    return projected


def _occurrence_times(
    events: Sequence[TypedEvent],
    sequence: Sequence[str],
    window: timedelta,
) -> list[datetime]:
    """Start times of each non-overlapping match, for the routine assessment."""
    ordered = sorted(events, key=lambda e: e.timestamp)
    used = [False] * len(ordered)
    starts: list[datetime] = []
    for start in range(len(ordered)):
        if used[start] or ordered[start].event_type != sequence[0]:
            continue
        deadline = ordered[start].timestamp + window
        matched, step = [start], 1
        for j in range(start + 1, len(ordered)):
            if step >= len(sequence) or ordered[j].timestamp > deadline:
                break
            if not used[j] and ordered[j].event_type == sequence[step]:
                matched.append(j)
                step += 1
        if step == len(sequence):
            for idx in matched:
                used[idx] = True
            starts.append(ordered[start].timestamp)
    return starts


def run_ccc(
    events: Iterable[Any],
    subject_key: str,
    pattern: str,
    *,
    window_minutes: int = DEFAULT_WINDOW_MINUTES,
    permutations: int = DEFAULT_PERMUTATIONS,
    seed: int = 20260815,
) -> CCCResult:
    """Run one (subject, pattern) test. Decision is provisional until FDR."""
    if pattern not in PATTERNS:
        raise ValueError(f"Unknown pattern '{pattern}'. "
                         f"Known: {', '.join(sorted(PATTERNS))}")
    sequence = PATTERNS[pattern]
    window = timedelta(minutes=window_minutes)
    subject_events = _subject_events(events, subject_key)

    stats = permutation_test(subject_events, sequence, window,
                             permutations=permutations, seed=seed)
    routine = assess_routine(_occurrence_times(subject_events, sequence, window))

    return CCCResult(
        subject=subject_key,
        pattern=pattern,
        sequence=list(sequence),
        window_minutes=window_minutes,
        stats=stats,
        routine=routine,
    )


def decide(results: Sequence[CCCResult], *, alpha: float = ALPHA,
           min_lift: float = MIN_LIFT) -> list[CCCResult]:
    """
    Apply FDR across a whole run, then settle each decision.

    FDR must be applied over the family of tests actually performed, which is
    why decisions are finalised here and not inside `run_ccc`.
    """
    if not results:
        return []

    q_values = benjamini_hochberg([r.stats.p_value for r in results])
    for result, q in zip(results, q_values):
        result.fdr_adjusted = q
        stats, routine = result.stats, result.routine
        result.rationale, result.exculpatory = [], []

        if stats.observed < MIN_OCCURRENCES:
            result.decision = "INSUFFICIENT_DATA"
            result.rationale.append(
                f"Only {stats.observed} occurrence(s); minimum for testing is "
                f"{MIN_OCCURRENCES}.")
            continue

        significant = q <= alpha
        strong = stats.lift >= min_lift

        if significant:
            result.rationale.append(
                f"Occurs {stats.lift:.1f}× more often than random rearrangement "
                f"of the subject's own activity (p={stats.p_value:.4f}, "
                f"FDR-adjusted q={q:.4f}).")
        else:
            result.rationale.append(
                f"Not statistically distinguishable from chance after FDR "
                f"correction (q={q:.4f} > {alpha}).")
        if significant and not strong:
            result.rationale.append(
                f"Effect size is small (lift {stats.lift:.1f}× below the "
                f"{min_lift}× threshold).")

        if routine.established:
            result.exculpatory.append(routine.explanation)
        else:
            result.rationale.append(routine.explanation)

        if significant and strong and not routine.established:
            result.decision = "REVIEW"
        elif significant and strong and routine.established:
            result.decision = "NO_ACTION"
            result.exculpatory.append(
                "Statistically unusual, but consistent with this subject's "
                "established behaviour. Retained in the audit trail.")
        elif significant:
            result.decision = "MONITOR"
        else:
            result.decision = "NO_ACTION"

    return list(results)


def analyse_case(
    events: Sequence[Any],
    *,
    patterns: Sequence[str] | None = None,
    window_minutes: int = DEFAULT_WINDOW_MINUTES,
    permutations: int = DEFAULT_PERMUTATIONS,
    seed: int = 20260815,
) -> list[CCCResult]:
    """
    Test every subject in a case against every pattern, then FDR-correct
    together — the family of tests is the whole run, not one subject.
    """
    subjects = sorted({
        s for s in (
            subject_of(e) for e in events
            if not getattr(e, "quarantined", False)
        ) if s
    })
    selected = list(patterns) if patterns else list(PATTERNS)

    results = [
        run_ccc(events, subject, pattern, window_minutes=window_minutes,
                permutations=permutations, seed=seed)
        for subject in subjects
        for pattern in selected
    ]
    # Untestable tests must not consume FDR budget and dilute real signals.
    testable = [r for r in results if r.stats.observed >= MIN_OCCURRENCES]
    untestable = [r for r in results if r.stats.observed < MIN_OCCURRENCES]
    decide(testable)
    decide(untestable)
    return sorted(results,
                  key=lambda r: (r.decision != "REVIEW", -r.stats.lift))
