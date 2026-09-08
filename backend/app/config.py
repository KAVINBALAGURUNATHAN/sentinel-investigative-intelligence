"""
SENTINEL — deployment configuration.

Currently this holds one decision: whether identifier values may be shown in
full.

Why it is a setting rather than a constant. Masking exists so that a screenshot,
a shared screen or an exported page cannot leak a phone number or an account
number belonging to a real person. That protection matters for real case data
and is worthless friction for the synthetic benchmark set, where every value is
invented and an investigator demonstrating the tool needs to see that
identifiers resolve correctly.

    SYNTHETIC   identifiers shown in full. For the benchmark data in
                data/synthetic/, which contains no real personal information.
    SENSITIVE   identifiers masked in every response. Required for real data.

The default is SYNTHETIC because that is the only data this prototype ships
with and can ingest without someone deliberately supplying their own. Before
this system is pointed at real records, set SENTINEL_DATA_MODE=SENSITIVE — the
masking code path is fully retained and is exercised by tests, so the switch is
a single environment variable, not a rewrite.
"""

from __future__ import annotations

import os

SYNTHETIC = "SYNTHETIC"
SENSITIVE = "SENSITIVE"
VALID_MODES = (SYNTHETIC, SENSITIVE)


def data_mode() -> str:
    """Current data classification. Unknown values fail safe to SENSITIVE."""
    raw = os.environ.get("SENTINEL_DATA_MODE", SYNTHETIC).strip().upper()
    return raw if raw in VALID_MODES else SENSITIVE


def identifiers_visible() -> bool:
    """True when identifier values may be returned in full."""
    return data_mode() == SYNTHETIC


def display_policy() -> dict[str, object]:
    """Describe the policy so the interface can state it rather than imply it."""
    synthetic = identifiers_visible()
    return {
        "data_mode": data_mode(),
        "identifiers_visible": synthetic,
        "label": "Synthetic" if synthetic else "Sensitive",
        "explanation": (
            "Benchmark data. Identifiers are shown in full because no value in "
            "this dataset belongs to a real person."
            if synthetic else
            "Real or sensitive data. Identifiers are masked in every response; "
            "unmasking is an authorisation decision this prototype does not make."
        ),
    }
