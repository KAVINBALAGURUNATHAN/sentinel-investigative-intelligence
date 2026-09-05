"""
Subject-specific baseline — "does this person normally do this?"

A permutation test answers whether a sequence is more frequent than chance
*within an observation period*. It cannot tell you whether the behaviour is
this subject's long-standing routine, because a routine repeated every day is
still non-random. Both a fraud ring and a payroll clerk produce a highly
non-random CALL -> TRANSFER -> SOCIAL sequence.

This module supplies the second, independent question: has the subject been
doing this consistently for long enough, and regularly enough, that an
established routine is a plausible innocent explanation?

IMPORTANT — what this is and is not:
  This is EXCULPATORY CONTEXT, not proof of innocence. A long-running pattern
  can be long-running crime. The output is an alternative explanation an
  investigator must weigh, and it is recorded in the audit trail either way.
  It lowers priority; it never closes a lead on its own.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import datetime
from typing import Sequence

# A pattern must persist across at least this many days before "established
# routine" is offered as an explanation. Below this, a burst and a habit are
# indistinguishable.
MIN_ESTABLISHED_DAYS = 14

# Coefficient of variation of the gaps between occurrences. Low means metronomic
# (payroll, scheduled settlement); high means bursty.
MAX_ROUTINE_CV = 0.75


@dataclass
class RoutineAssessment:
    established: bool
    span_days: float
    active_days: int
    occurrences: int
    per_day: float
    interval_cv: float | None
    explanation: str

    def as_dict(self) -> dict:
        return {
            "established_routine": self.established,
            "span_days": round(self.span_days, 2),
            "active_days": self.active_days,
            "occurrences": self.occurrences,
            "occurrences_per_day": round(self.per_day, 3),
            "interval_cv": (None if self.interval_cv is None
                            else round(self.interval_cv, 3)),
            "explanation": self.explanation,
        }


def assess_routine(
    occurrence_times: Sequence[datetime],
    *,
    min_days: int = MIN_ESTABLISHED_DAYS,
    max_cv: float = MAX_ROUTINE_CV,
) -> RoutineAssessment:
    """
    Decide whether repeated occurrences look like an established routine.

    Requires three things together: a long enough span, presence on many
    distinct days (not all crammed into two), and reasonably regular spacing.
    """
    times = sorted(occurrence_times)
    count = len(times)

    if count == 0:
        return RoutineAssessment(False, 0.0, 0, 0, 0.0, None,
                                 "No occurrences of this pattern for the subject.")

    span_days = (times[-1] - times[0]).total_seconds() / 86400.0
    active_days = len({t.date() for t in times})
    per_day = count / span_days if span_days > 0 else float(count)

    interval_cv: float | None = None
    if count >= 3:
        gaps = [(b - a).total_seconds() for a, b in zip(times, times[1:])]
        mean_gap = statistics.fmean(gaps)
        if mean_gap > 0:
            interval_cv = statistics.pstdev(gaps) / mean_gap

    if span_days < min_days:
        return RoutineAssessment(
            False, span_days, active_days, count, per_day, interval_cv,
            f"Pattern observed over {span_days:.1f} days, short of the "
            f"{min_days}-day history needed to call it established. A recent "
            f"burst and a habit cannot be told apart on this much data.")

    if active_days < min_days / 2:
        return RoutineAssessment(
            False, span_days, active_days, count, per_day, interval_cv,
            f"Occurrences fall on only {active_days} distinct days across "
            f"{span_days:.1f} days — clustered rather than habitual.")

    if interval_cv is not None and interval_cv > max_cv:
        return RoutineAssessment(
            False, span_days, active_days, count, per_day, interval_cv,
            f"Spacing is irregular (variation {interval_cv:.2f} exceeds "
            f"{max_cv}); consistent with bursts rather than a routine.")

    return RoutineAssessment(
        True, span_days, active_days, count, per_day, interval_cv,
        f"Pattern has recurred on {active_days} days across {span_days:.1f} "
        f"days at {per_day:.2f}/day with regular spacing. Consistent with an "
        f"established routine — treat as a possible legitimate explanation and "
        f"verify before escalating.")


def active_hours(event_times: Sequence[datetime]) -> dict:
    """
    The subject's usual hours of activity, for the entity profile and for
    judging whether an event fell outside their normal window.
    """
    if not event_times:
        return {"hours": [], "busiest_hour": None, "sample_size": 0}
    histogram: dict[int, int] = {}
    for t in event_times:
        histogram[t.hour] = histogram.get(t.hour, 0) + 1
    busiest = max(histogram.items(), key=lambda kv: kv[1])[0]
    return {
        "hours": sorted(histogram.items()),
        "busiest_hour": busiest,
        "sample_size": len(event_times),
    }
