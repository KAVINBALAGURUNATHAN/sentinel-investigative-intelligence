"""
SENTINEL — unified multi-domain event model.

ARCHITECTURE.md §3.1 identified `RawMessage` as the chokepoint: it models a
two-party *text message*, which CDR, IPDR, banking and social records do not
fit (no numeric amount, no duration, no single-actor events, no typed
identifiers).

`UnifiedEvent` generalises it. Every domain record normalises into this one
shape so that downstream analysis — timeline, graph, baseline, CCC — reads a
single type regardless of source.

Design rules carried over from the existing ingestion model, deliberately:
  - Invalid records are QUARANTINED, never dropped.
  - Validation never raises; it records flags on the event.
  - Timestamps are normalised to UTC on parse.

`RawMessage` is untouched and still powers the existing WhatsApp pipeline.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field

# Replacement char, C0 control bytes, or runs of '?' indicate transport damage.
_SUSPECT_CHARS = set("�") | {chr(c) for c in range(0x00, 0x09)} | {
    chr(c) for c in (0x0b, 0x0c)} | {chr(c) for c in range(0x0e, 0x20)}


class EventType(str, Enum):
    """What happened. Kept coarse: the domain payload carries the detail."""

    CALL = "CALL"
    SMS = "SMS"
    DATA_SESSION = "DATA_SESSION"
    TRANSFER = "TRANSFER"
    SOCIAL_POST = "SOCIAL_POST"
    SOCIAL_CONNECTION = "SOCIAL_CONNECTION"
    LOGIN = "LOGIN"
    MESSAGE = "MESSAGE"  # bridges the existing RawMessage pipeline


class IdentifierType(str, Enum):
    """The kind of thing an identifier names, not the person behind it."""

    PHONE = "PHONE"
    IMEI = "IMEI"
    IMSI = "IMSI"
    BANK_ACCOUNT = "BANK_ACCOUNT"
    UPI = "UPI"
    SOCIAL_HANDLE = "SOCIAL_HANDLE"
    IP = "IP"
    DEVICE = "DEVICE"
    ENTITY = "ENTITY"  # a resolved person


class Domain(str, Enum):
    CDR = "CDR"
    IPDR = "IPDR"
    BANK = "BANK"
    SOCIAL = "SOCIAL"
    MESSAGING = "MESSAGING"


def mask(value: str, itype: "IdentifierType | str | None" = None) -> str:
    """
    Mask an identifier for display. Investigators see enough to recognise a
    value they already know, not enough for a screenshot to leak it.

    Unmasking is an authorisation decision and is deliberately not done here.
    """
    if not value:
        return ""
    v = str(value)
    # Handles are checked first: a leading '@' would otherwise be read as the
    # UPI separator and leak the whole handle as the "host" part.
    if itype == IdentifierType.SOCIAL_HANDLE or v.startswith("@"):
        body = v.lstrip("@")
        return "@" + (body[:2] + "*" * max(len(body) - 2, 1) if len(body) > 2 else body)
    if itype == IdentifierType.UPI or "@" in v:
        user, _, host = v.partition("@")
        keep = user[:2] if len(user) > 2 else user[:1]
        return f"{keep}{'*' * max(len(user) - len(keep), 1)}@{host}" if host else v
    if itype == IdentifierType.IP:
        parts = v.split(".")
        return ".".join(parts[:2] + ["*", "*"]) if len(parts) == 4 else v
    if len(v) <= 4:
        return "*" * len(v)
    return "*" * (len(v) - 4) + v[-4:]


class Identifier(BaseModel):
    """A typed identifier. Not a person — resolution to an entity is separate."""

    type: IdentifierType
    value: str

    @property
    def masked(self) -> str:
        return mask(self.value, self.type)

    def key(self) -> str:
        return f"{self.type.value}:{self.value}"


class EventFlags(BaseModel):
    """Quality flags computed at normalisation. Any true flag → quarantine."""

    timestamp_missing: bool = False
    timestamp_invalid: bool = False
    actor_missing: bool = False
    target_missing: bool = False
    value_invalid: bool = False
    content_suspect: bool = False

    @property
    def quarantined(self) -> bool:
        return any(self.model_dump().values())

    def reasons(self) -> list[str]:
        return [k for k, v in self.model_dump().items() if v]


class UnifiedEvent(BaseModel):
    """
    One observation from any domain.

    `actor` acts; `target` is acted upon and may be absent (a social post has
    no counterparty). Domain-specific fields that do not generalise live in
    `attributes` rather than widening this model per source.
    """

    event_id: str
    case_id: str
    domain: Domain
    event_type: EventType

    timestamp: Optional[datetime] = None
    end_timestamp: Optional[datetime] = None

    actor: Optional[Identifier] = None
    target: Optional[Identifier] = None

    # Numeric payloads. Money is Decimal: float rounding on evidential
    # amounts is not acceptable.
    amount: Optional[Decimal] = None
    currency: Optional[str] = None
    duration_seconds: Optional[int] = None
    bytes_up: Optional[int] = None
    bytes_down: Optional[int] = None

    content: Optional[str] = None
    attributes: dict[str, Any] = Field(default_factory=dict)

    source_file: str
    source_row: Optional[int] = None
    flags: EventFlags = Field(default_factory=EventFlags)

    @property
    def quarantined(self) -> bool:
        return self.flags.quarantined

    def participants(self) -> list[Identifier]:
        return [i for i in (self.actor, self.target) if i is not None]


# ── parsing helpers ───────────────────────────────────────────────────────
# These never raise. A bad value produces (None, flag) so the record can be
# quarantined with a reason instead of aborting a whole file.

def parse_timestamp(raw: Any) -> tuple[Optional[datetime], bool, bool]:
    """Returns (value, missing, invalid). Naive input is treated as UTC."""
    if raw is None or str(raw).strip() == "":
        return None, True, False
    text = str(raw).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None, False, True
    return (dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None
            else dt.astimezone(timezone.utc)), False, False


def parse_int(raw: Any, *, allow_negative: bool = False) -> tuple[Optional[int], bool]:
    """Returns (value, invalid). Empty is not invalid — it is simply absent."""
    if raw is None or str(raw).strip() == "":
        return None, False
    try:
        value = int(float(str(raw).strip()))
    except (ValueError, TypeError):
        return None, True
    if value < 0 and not allow_negative:
        return None, True
    return value, False


def parse_decimal(raw: Any, *, allow_negative: bool = False) -> tuple[Optional[Decimal], bool]:
    if raw is None or str(raw).strip() == "":
        return None, False
    try:
        value = Decimal(str(raw).strip())
    except (InvalidOperation, ValueError):
        return None, True
    if value < 0 and not allow_negative:
        return None, True
    return value, False


def is_suspect(text: Any) -> bool:
    """Transport damage: replacement chars, control bytes, or '??' runs."""
    if text is None:
        return False
    s = str(text)
    return bool(set(s) & _SUSPECT_CHARS) or "??" in s


def clean(raw: Any) -> str:
    return "" if raw is None else str(raw).strip()
