"""
Benjamini-Hochberg false discovery rate correction.

Why this exists: an investigation tests many subjects against many patterns.
At alpha=0.05, testing 100 innocent subjects yields ~5 "significant" results by
chance alone. Reporting those as leads would send officers to real doors on
statistical noise. BH controls the expected proportion of false leads among
those reported.

Implemented from the definition rather than pulled from SciPy: this is ~30
lines, it must be auditable line by line, and the dependency is not worth it.
"""

from __future__ import annotations


def benjamini_hochberg(p_values: list[float]) -> list[float]:
    """
    Return FDR-adjusted p-values (q-values), in the input order.

    Step-up procedure: sort ascending, scale each by n/rank, then enforce
    monotonicity from the largest downward so a q-value is never smaller than
    one ranked below it. Results are clamped to 1.0.
    """
    n = len(p_values)
    if n == 0:
        return []
    for p in p_values:
        if not 0.0 <= p <= 1.0:
            raise ValueError(f"p-value out of range: {p}")

    order = sorted(range(n), key=lambda i: p_values[i])
    adjusted = [0.0] * n
    previous = 1.0
    # Walk from the largest p-value down, carrying the running minimum.
    for rank in range(n, 0, -1):
        idx = order[rank - 1]
        value = min(previous, p_values[idx] * n / rank)
        adjusted[idx] = min(1.0, value)
        previous = adjusted[idx]
    return adjusted


def significant_after_fdr(p_values: list[float], alpha: float = 0.05) -> list[bool]:
    """Which tests survive FDR control at `alpha`."""
    return [q <= alpha for q in benjamini_hochberg(p_values)]
