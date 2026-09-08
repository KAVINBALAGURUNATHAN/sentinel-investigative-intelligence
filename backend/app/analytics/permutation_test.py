"""
Permutation test for cross-domain event sequences.

The question: a subject's CALL was followed by a TRANSFER and then SOCIAL
activity, 18 times inside 30-minute windows. Is that more than you would
expect from this subject's own level of activity?

THE NULL MODEL (this is the whole design decision)
--------------------------------------------------
We keep the subject's real timestamps exactly as observed and shuffle only the
*event-type labels* across them.

That choice matters. The naive alternative — scattering timestamps at random
across the observation period — destroys the subject's daily rhythm, so any
person whose activity clusters in the evening looks "anomalous" against a
uniform null. Nearly everyone clusters. That null manufactures suspects.

By permuting labels over the observed times, the null keeps:
  - the exact times of day the subject is active
  - the exact bursts and quiet periods
  - the count of each event type
and varies only which kind of event happened when. So the test answers the
narrow, defensible question: given that this person was active at these
moments, is the *ordering* of call/transfer/social into this sequence more
frequent than chance?

Deterministic: seeded, so an identical input reproduces an identical p-value.
That is a requirement for evidence, not a convenience.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Sequence


@dataclass(frozen=True)
class TypedEvent:
    """Minimal projection of a UnifiedEvent for sequence testing."""

    timestamp: datetime
    event_type: str


# Reported in place of a lift that has no finite value, because the null never
# produced the sequence at all. It is a display bound, not a measurement -- see
# the note where it is assigned in permutation_test().
LIFT_CEILING = 999.0


@dataclass
class PermutationResult:
    observed: int
    expected: float
    lift: float
    p_value: float
    permutations: int
    null_min: int = 0
    null_max: int = 0
    lift_undefined: bool = False
    null_distribution: list[int] = field(default_factory=list, repr=False)

    def as_dict(self) -> dict:
        return {
            "observed": self.observed,
            "expected": round(self.expected, 4),
            "lift": round(self.lift, 2),
            "lift_undefined": self.lift_undefined,
            "p_value": round(self.p_value, 6),
            "permutations": self.permutations,
            "null_min": self.null_min,
            "null_max": self.null_max,
        }


def count_sequences(
    events: Sequence[TypedEvent],
    sequence: Sequence[str],
    window: timedelta,
) -> int:
    """
    Count non-overlapping occurrences of an ordered `sequence` where the whole
    chain completes within `window` of its first event.

    Non-overlapping (each event is consumed by at most one match) prevents a
    single dense burst from being counted combinatorially — 3 calls and 3
    transfers must not report 9 occurrences.

    TIED TIMESTAMPS. Records sharing a timestamp have no observable order, and
    a plain sort left them in whatever order the caller supplied — so the same
    case could report a different count depending on the row order the store
    happened to return, and an evidence figure must not do that. Ties are
    broken on event_type, which is deterministic, independent of input order,
    and applied identically to the observed data and to every permutation, so
    the null it is compared against is built the same way.
    """
    if not sequence or not events:
        return 0

    ordered = sorted(events, key=lambda e: (e.timestamp, e.event_type))
    used = [False] * len(ordered)
    count = 0

    for start in range(len(ordered)):
        if used[start] or ordered[start].event_type != sequence[0]:
            continue
        deadline = ordered[start].timestamp + window
        matched = [start]
        step = 1
        for j in range(start + 1, len(ordered)):
            if step >= len(sequence):
                break
            if used[j] or ordered[j].timestamp > deadline:
                if ordered[j].timestamp > deadline:
                    break
                continue
            if ordered[j].event_type == sequence[step]:
                matched.append(j)
                step += 1
        if step == len(sequence):
            for idx in matched:
                used[idx] = True
            count += 1
    return count


def permutation_test(
    events: Sequence[TypedEvent],
    sequence: Sequence[str],
    window: timedelta,
    *,
    permutations: int = 1000,
    seed: int = 20260815,
) -> PermutationResult:
    """
    Empirical p-value for the observed sequence count.

    p = (1 + #{null >= observed}) / (1 + permutations)

    The add-one smoothing is deliberate: it prevents reporting p = 0, which no
    finite resampling can justify. With 1000 permutations the floor is ~0.001.
    """
    observed = count_sequences(events, sequence, window)

    # Canonical order, so a seeded shuffle reproduces the same null whatever
    # order the caller supplied. Pairing is irrelevant here -- the labels are
    # about to be permuted across the timestamps -- but the *seeded* pairing
    # is not, and a p-value that moves with row order is not reproducible.
    timestamps = sorted(e.timestamp for e in events)
    labels = sorted(e.event_type for e in events)
    rng = random.Random(seed)

    null_counts: list[int] = []
    for _ in range(permutations):
        shuffled = labels[:]
        rng.shuffle(shuffled)
        permuted = [TypedEvent(t, lab) for t, lab in zip(timestamps, shuffled)]
        null_counts.append(count_sequences(permuted, sequence, window))

    at_least_observed = sum(1 for c in null_counts if c >= observed)
    p_value = (1 + at_least_observed) / (1 + permutations)
    expected = sum(null_counts) / len(null_counts) if null_counts else 0.0

    # An expected of 0 makes lift undefined -- there is no denominator.
    #
    # The previous fallback (observed x permutations) stood in the smallest
    # expectation the resampling could resolve, but that quantity is 1/N, so
    # the reported lift moved with the permutation count: the same data scored
    # 3,600 at N=200 and 18,000 at N=1000. A number that changes when an
    # unrelated tuning knob changes is not a measurement, and it was being
    # printed next to figures that are.
    #
    # So it is reported as undefined, at a fixed ceiling, with a flag saying
    # so. The p-value is unaffected -- it already carries the strength of this
    # case correctly, at its 1/(N+1) floor.
    lift_undefined = False
    if expected > 0:
        lift = observed / expected
    elif observed > 0:
        lift = LIFT_CEILING
        lift_undefined = True
    else:
        lift = 0.0

    return PermutationResult(
        observed=observed,
        expected=expected,
        lift=lift,
        lift_undefined=lift_undefined,
        p_value=p_value,
        permutations=permutations,
        null_min=min(null_counts) if null_counts else 0,
        null_max=max(null_counts) if null_counts else 0,
        null_distribution=null_counts,
    )
