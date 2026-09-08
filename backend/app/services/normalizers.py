"""
SENTINEL — domain normalisers: CDR / IPDR / bank / social → UnifiedEvent.

One function per source format. Each is total: every input row produces exactly
one event, and unusable rows come back flagged for quarantine rather than
raising or being silently skipped. Row counts in == events out, always. That
property is what makes the ingestion figures on the Data Ingestion page
reconcile, and what keeps the evidence chain complete.

Adding a new source means adding a normaliser here; nothing downstream changes.
"""

from __future__ import annotations

import csv
import io
from typing import Any, Callable, Iterable

from app.models.event import (
    Domain,
    EventFlags,
    EventType,
    Identifier,
    IdentifierType,
    UnifiedEvent,
    clean,
    is_suspect,
    parse_decimal,
    parse_int,
    parse_timestamp,
)


def _ident(itype: IdentifierType, value: Any) -> Identifier | None:
    v = clean(value)
    return Identifier(type=itype, value=v) if v else None


def _base_flags(actor: Identifier | None, target: Identifier | None,
                *, target_required: bool, missing: bool, invalid: bool,
                suspect: bool = False) -> EventFlags:
    return EventFlags(
        timestamp_missing=missing,
        timestamp_invalid=invalid,
        actor_missing=actor is None,
        target_missing=target_required and target is None,
        content_suspect=suspect,
    )


# A CDR's call_type column carries one of two different vocabularies depending
# on the operator, and the previous code assumed only the first.
#
#   modality   VOICE / SMS / MMS -- what kind of communication it was
#   direction  IN / OUT / MO / MT -- which way it went
#
# The rule was `SMS if call_type == "SMS" else CALL`. Against the synthetic
# dataset, where every one of the 121 rows reads "OUT", that branch is dead:
# each row falls through to CALL. It gets the right answer for voice records by
# accident, and would silently mistype an entire SMS feed from any operator
# using the direction vocabulary -- while a genuinely unrecognised code would
# also become CALL, with nothing recorded to say so.
#
# The two vocabularies are now read separately: a modality sets the event type,
# a direction sets the event type to CALL (a CDR row measured in seconds is a
# call) and is preserved as an attribute rather than discarded. A value in
# neither vocabulary is flagged, which quarantines the row -- the same rule
# already applied to unmapped social activity, and for the same reason: the CCC
# engine matches sequences on event type, so guessing one manufactures pattern
# occurrences out of records whose meaning is unknown.
_CDR_MODALITY = {
    "SMS": EventType.SMS, "TEXT": EventType.SMS, "MMS": EventType.SMS,
    "VOICE": EventType.CALL, "CALL": EventType.CALL, "DATA": EventType.DATA_SESSION,
}
_CDR_DIRECTION = {
    "IN": "INCOMING", "OUT": "OUTGOING",
    "INCOMING": "INCOMING", "OUTGOING": "OUTGOING",
    "MO": "OUTGOING",   # mobile-originated
    "MT": "INCOMING",   # mobile-terminated
}


def _classify_cdr(call_type: str) -> tuple[EventType, str | None, bool]:
    """Return (event_type, direction, unmapped) for a CDR call_type value."""
    if not call_type:
        # The source did not say. A CDR row is a voice record by default, and
        # saying nothing is not the same as saying something unrecognised.
        return EventType.CALL, None, False
    if call_type in _CDR_MODALITY:
        return _CDR_MODALITY[call_type], None, False
    if call_type in _CDR_DIRECTION:
        return EventType.CALL, _CDR_DIRECTION[call_type], False
    return EventType.CALL, None, True


def normalize_cdr(row: dict[str, Any], *, row_no: int | None = None) -> UnifiedEvent:
    """Call Detail Record → CALL or SMS event."""
    ts, missing, invalid = parse_timestamp(row.get("start_time"))
    duration, dur_bad = parse_int(row.get("duration_sec"))

    caller_raw, callee_raw = row.get("caller_msisdn"), row.get("callee_msisdn")
    suspect = is_suspect(caller_raw) or is_suspect(callee_raw)
    actor = _ident(IdentifierType.PHONE, caller_raw)
    target = _ident(IdentifierType.PHONE, callee_raw)

    call_type = clean(row.get("call_type")).upper()
    event_type, direction, type_unmapped = _classify_cdr(call_type)

    flags = _base_flags(actor, target, target_required=True,
                        missing=missing, invalid=invalid, suspect=suspect)
    flags.value_invalid = dur_bad
    flags.event_type_unmapped = type_unmapped

    return UnifiedEvent(
        event_id=clean(row.get("record_id")) or f"CDR-ROW-{row_no}",
        case_id=clean(row.get("case_id")) or "UNASSIGNED",
        domain=Domain.CDR,
        event_type=event_type,
        timestamp=ts,
        actor=actor,
        target=target,
        duration_seconds=duration,
        attributes={
            "call_type": call_type,
            "direction": direction,
            "imei": clean(row.get("imei")),
            "imsi": clean(row.get("imsi")),
            "cell_id": clean(row.get("cell_id")),
            "lac": clean(row.get("lac")),
        },
        source_file=clean(row.get("source_file")) or "cdr.csv",
        source_row=row_no,
        flags=flags,
    )


def normalize_ipdr(row: dict[str, Any], *, row_no: int | None = None) -> UnifiedEvent:
    """Internet Protocol Detail Record → DATA_SESSION event.

    The counterparty is a destination address, not a person, so `target` is a
    typed IP identifier and is not required for the record to be usable.
    """
    ts, missing, invalid = parse_timestamp(row.get("start_time"))
    end_ts, _, end_invalid = parse_timestamp(row.get("end_time"))
    up, up_bad = parse_int(row.get("bytes_up"))
    down, down_bad = parse_int(row.get("bytes_down"))
    port, port_bad = parse_int(row.get("dest_port"))

    actor = _ident(IdentifierType.PHONE, row.get("subscriber_msisdn"))
    target = _ident(IdentifierType.IP, row.get("dest_ip"))

    flags = _base_flags(actor, target, target_required=False,
                        missing=missing, invalid=invalid or end_invalid)
    flags.value_invalid = up_bad or down_bad or port_bad

    return UnifiedEvent(
        event_id=clean(row.get("record_id")) or f"IPDR-ROW-{row_no}",
        case_id=clean(row.get("case_id")) or "UNASSIGNED",
        domain=Domain.IPDR,
        event_type=EventType.DATA_SESSION,
        timestamp=ts,
        end_timestamp=end_ts,
        actor=actor,
        target=target,
        bytes_up=up,
        bytes_down=down,
        attributes={
            "private_ip": clean(row.get("private_ip")),
            "public_ip": clean(row.get("public_ip")),
            "dest_port": port,
            "imei": clean(row.get("imei")),
            "access_type": clean(row.get("access_type")),
        },
        source_file=clean(row.get("source_file")) or "ipdr.csv",
        source_row=row_no,
        flags=flags,
    )


def normalize_bank(row: dict[str, Any], *, row_no: int | None = None) -> UnifiedEvent:
    """Banking transaction → TRANSFER event.

    The amount is the analytic signal here, so a non-numeric or negative
    amount quarantines the record: a transfer whose value cannot be trusted
    must not silently reach a risk calculation as zero.
    """
    ts, missing, invalid = parse_timestamp(row.get("timestamp"))
    amount, amount_bad = parse_decimal(row.get("amount_inr"))

    actor = (_ident(IdentifierType.BANK_ACCOUNT, row.get("payer_account"))
             or _ident(IdentifierType.UPI, row.get("payer_upi")))
    target = (_ident(IdentifierType.BANK_ACCOUNT, row.get("payee_account"))
              or _ident(IdentifierType.UPI, row.get("payee_upi")))

    flags = _base_flags(actor, target, target_required=True,
                        missing=missing, invalid=invalid)
    flags.value_invalid = amount_bad or amount is None

    return UnifiedEvent(
        event_id=clean(row.get("txn_id")) or f"TXN-ROW-{row_no}",
        case_id=clean(row.get("case_id")) or "UNASSIGNED",
        domain=Domain.BANK,
        event_type=EventType.TRANSFER,
        timestamp=ts,
        actor=actor,
        target=target,
        amount=amount,
        currency="INR",
        attributes={
            "txn_type": clean(row.get("txn_type")),
            "channel": clean(row.get("channel")),
            "ifsc": clean(row.get("ifsc")),
            "payer_upi": clean(row.get("payer_upi")),
            "payee_upi": clean(row.get("payee_upi")),
        },
        source_file=clean(row.get("source_file")) or "bank.csv",
        source_row=row_no,
        flags=flags,
    )


_SOCIAL_TYPES = {
    "POST": EventType.SOCIAL_POST,
    "COMMENT": EventType.SOCIAL_POST,
    "CONNECT": EventType.SOCIAL_CONNECTION,
    "LOGIN": EventType.LOGIN,
}


def normalize_social(row: dict[str, Any], *, row_no: int | None = None) -> UnifiedEvent:
    """Social activity → post / connection / login.

    Single-actor by nature: a post has no counterparty, so `target` is only
    required for explicit connection events.
    """
    ts, missing, invalid = parse_timestamp(row.get("timestamp"))
    activity = clean(row.get("activity_type")).upper()
    # Only what _SOCIAL_TYPES states explicitly. An unrecognised or absent
    # activity is quarantined rather than defaulted: SOCIAL_POST is one of the
    # event types the CCC engine matches sequences against, so defaulting to it
    # would fabricate pattern occurrences from rows whose meaning is unknown.
    event_type = _SOCIAL_TYPES.get(activity, EventType.SOCIAL_POST)
    unmapped = activity not in _SOCIAL_TYPES

    actor = _ident(IdentifierType.SOCIAL_HANDLE, row.get("handle"))
    target = _ident(IdentifierType.SOCIAL_HANDLE, row.get("target_handle"))
    content = clean(row.get("content"))

    flags = _base_flags(
        actor, target,
        target_required=(event_type == EventType.SOCIAL_CONNECTION),
        missing=missing, invalid=invalid, suspect=is_suspect(content),
    )
    flags.event_type_unmapped = unmapped

    return UnifiedEvent(
        event_id=clean(row.get("post_id")) or f"SOC-ROW-{row_no}",
        case_id=clean(row.get("case_id")) or "UNASSIGNED",
        domain=Domain.SOCIAL,
        event_type=event_type,
        timestamp=ts,
        actor=actor,
        target=target,
        content=content or None,
        attributes={
            "platform": clean(row.get("platform")),
            "activity_type": activity,
            "ip_address": clean(row.get("ip_address")),
        },
        source_file=clean(row.get("source_file")) or "social.csv",
        source_row=row_no,
        flags=flags,
    )


NORMALIZERS: dict[str, Callable[..., UnifiedEvent]] = {
    "cdr": normalize_cdr,
    "ipdr": normalize_ipdr,
    "bank": normalize_bank,
    "social": normalize_social,
}


def normalize_rows(kind: str, rows: Iterable[dict[str, Any]]) -> list[UnifiedEvent]:
    """Normalise an iterable of dict rows. Row order is preserved."""
    try:
        fn = NORMALIZERS[kind.lower()]
    except KeyError:
        raise ValueError(
            f"Unknown source '{kind}'. Known: {', '.join(sorted(NORMALIZERS))}"
        ) from None
    return [fn(row, row_no=i) for i, row in enumerate(rows, start=1)]


def normalize_csv_bytes(kind: str, raw: bytes) -> list[UnifiedEvent]:
    """Normalise a raw uploaded CSV. Undecodable bytes are replaced, not
    rejected, so damaged files still reach quarantine with a reason."""
    text = raw.decode("utf-8", errors="replace")
    return normalize_rows(kind, csv.DictReader(io.StringIO(text)))


def ingestion_summary(events: list[UnifiedEvent]) -> dict[str, Any]:
    """Counts for the Data Ingestion page. Validated + quarantined == total."""
    quarantined = [e for e in events if e.quarantined]
    reasons: dict[str, int] = {}
    for event in quarantined:
        for reason in event.flags.reasons():
            reasons[reason] = reasons.get(reason, 0) + 1

    identifiers = {
        i.key() for e in events if not e.quarantined for i in e.participants()
    }
    relationships = {
        (e.actor.key(), e.target.key(), e.event_type.value)
        for e in events
        if not e.quarantined and e.actor and e.target
    }
    return {
        "total": len(events),
        "validated": len(events) - len(quarantined),
        "quarantined": len(quarantined),
        "quarantine_reasons": reasons,
        "identifiers_discovered": len(identifiers),
        "relationships_discovered": len(relationships),
    }
