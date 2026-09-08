"""
SENTINEL — POST /api/v1/ingest  (LEGACY messaging pipeline)

WHICH ENDPOINT TO USE

  POST /api/v1/ingest/{source}   multi-domain: cdr | ipdr | bank | social
                                 CSV in, SQLite event store out, then entity
                                 resolution and automatic Neo4j projection.
                                 Everything downstream -- Timeline, CCC,
                                 NetworkX, Evidence Explorer -- reads that
                                 store, so this is the only path that makes
                                 data visible to the investigation.

  POST /api/v1/ingest            legacy WhatsApp/RawMessage pipeline. JSON in,
                                 loaded straight to Neo4j. It does NOT write to
                                 the SQLite event store, so its records are
                                 invisible to the timeline, the CCC engine and
                                 the evidence API by design.

The two are kept apart deliberately. Sending CDR/IPDR/banking/social data here
would hash and count it, load a message-shaped graph, and leave it absent from
every analytical view -- silently. The guard below refuses that instead, and
names the endpoint that should have been used.

SHA-256 hashes the raw file before parsing, validates every record
independently, quarantines bad ones, then loads the clean graph into Neo4j.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from fastapi import APIRouter, UploadFile, File, HTTPException

from app.models.raw_message import RawMessage, IngestResponse
from app.services.graph_db import batch_load_graph

router = APIRouter(prefix="/api/v1", tags=["ingestion"])

# Map synthetic filenames to their demo case_id partition
_FILENAME_TO_CASE: dict[str, str] = {
    "whatsapp_conversation_40_messages.json": "case-dataset1",
    "whatsapp_synthetic_35_messages.json":    "case-dataset2",
    "corrupted_whatsapp_30_messages.json":    "case-dataset3",
    "network_test_45_messages.json":          "case-dataset4",
}


def _resolve_case_id(filename: str) -> str:
    """Return the canonical case_id for this file, falling back to the stem."""
    return _FILENAME_TO_CASE.get(filename, filename.split(".")[0])


# Sources that belong to the multi-domain pipeline. Named here so this endpoint
# can refuse them by name rather than failing later with a parse error that
# reads like a corrupt file.
_MULTIDOMAIN_SOURCES = ("cdr", "ipdr", "bank", "social")

# Column names that only ever appear in a multi-domain CSV. Any one of them in a
# header row identifies the file, whatever it happens to be called.
# Taken from the real dataset headers in data/synthetic/, not from memory.
_MULTIDOMAIN_COLUMNS = {
    "caller_msisdn", "callee_msisdn", "duration_sec", "imsi",      # CDR
    "subscriber_msisdn", "public_ip", "bytes_up", "bytes_down",    # IPDR
    "payer_account", "payee_account", "payer_upi", "amount_inr",   # BANKING
    "post_id", "handle", "target_handle", "activity_type",         # SOCIAL
}


def _reject_if_multidomain(filename: str, raw_bytes: bytes) -> None:
    """
    Refuse multi-source data on the legacy messaging endpoint.

    Data accepted here is loaded straight to Neo4j and never reaches the SQLite
    event store, so it would be absent from the timeline, the CCC engine and the
    evidence API without anything reporting a failure. Refusing loudly, and
    naming the right endpoint, is the only honest outcome.
    """
    name = (filename or "").lower()
    stem = name.rsplit("/", 1)[-1].split(".")[0]
    reason = None

    if name.endswith(".csv"):
        reason = "a CSV file"
    elif any(stem == src or stem.startswith(src + "_") or stem.endswith("_" + src)
             for src in _MULTIDOMAIN_SOURCES):
        reason = f"named for a multi-domain source ({stem})"
    else:
        # Look at the first line: a header row naming multi-domain columns is
        # decisive even when the filename says nothing.
        head = raw_bytes[:2048].decode("utf-8", errors="replace").lstrip()
        if head and not head.startswith(("[", "{")):
            columns = {c.strip().strip('"').lower() for c in head.splitlines()[0].split(",")}
            overlap = columns & _MULTIDOMAIN_COLUMNS
            if overlap:
                reason = f"a delimited file with multi-domain columns ({', '.join(sorted(overlap))})"

    if reason:
        raise HTTPException(
            status_code=400,
            detail=(
                f"This endpoint is the legacy WhatsApp/RawMessage pipeline and "
                f"accepts a JSON array of messages. The upload appears to be "
                f"{reason}. Multi-source records must be ingested through "
                f"POST /api/v1/ingest/{{source}} with source one of "
                f"{', '.join(_MULTIDOMAIN_SOURCES)} -- that path writes to the "
                f"event store, so the records reach the timeline, pattern "
                f"analysis, network graph and evidence trail. Ingesting them "
                f"here would load a message-shaped graph and leave them "
                f"invisible to every analytical view."
            ),
        )


def _record_message_id(record: Any, index: int) -> str:
    """Return a stable quarantine id without assuming the record is a dict."""
    if isinstance(record, dict) and record.get("message_id"):
        return str(record["message_id"])
    return f"<missing-message-id-{index + 1}>"


def _build_edges(messages: list[RawMessage]) -> list[dict[str, Any]]:
    """Convert validated messages into edge dicts for Neo4j batch load."""
    edges = []
    for msg in messages:
        if not msg.flags.is_quarantined and msg.sender_id and msg.receiver_id:
            edges.append(
                {
                    "sender_id": msg.sender_id,
                    "receiver_id": msg.receiver_id,
                    "message_id": msg.message_id,
                    "platform": msg.platform,
                    "timestamp_iso": (
                        msg.timestamp.isoformat() if msg.timestamp else None
                    ),
                }
            )
    return edges


@router.post("/ingest", response_model=IngestResponse)
async def ingest_file(file: UploadFile = File(...)) -> IngestResponse:
    """
    Accept a JSON file upload, SHA-256 hash it, parse each record independently.
    Returns counts of total / validated / quarantined records and the file hash.
    """
    raw_bytes = await file.read()

    # ── Chain-of-custody: hash before any parsing ──────────────────────────
    sha256_hash = hashlib.sha256(raw_bytes).hexdigest()

    # ── Pipeline guard ─────────────────────────────────────────────────────
    # Hashed first, so a refused upload is still identifiable in the logs.
    _reject_if_multidomain(file.filename or "", raw_bytes)

    # ── Parse outer JSON ───────────────────────────────────────────────────
    try:
        raw_records: list[dict] = json.loads(raw_bytes)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {exc}") from exc

    if not isinstance(raw_records, list):
        raise HTTPException(status_code=400, detail="Expected a JSON array at top level.")

    # ── Validate each record independently ────────────────────────────────
    validated: list[RawMessage] = []
    quarantined_ids: list[str] = []

    for index, record in enumerate(raw_records):
        try:
            msg = RawMessage.model_validate(record)
            validated.append(msg)
            if msg.flags.is_quarantined:
                quarantined_ids.append(msg.message_id)
        except Exception:
            # Even if Pydantic itself raises (e.g. missing message_id),
            # capture the raw record id if possible and quarantine.
            raw_id = _record_message_id(record, index)
            quarantined_ids.append(raw_id)

    # ── Load graph ─────────────────────────────────────────────────────────
    case_id = _resolve_case_id(file.filename or "")
    try:
        edges = _build_edges(validated)
        if edges:
            batch_load_graph(edges, case_id=case_id)
    except Exception as exc:
        # Graph load failure must not lose the ingestion result — log and continue
        print(f"[WARN] Neo4j load failed: {exc}")

    return IngestResponse(
        filename=file.filename or "upload",
        sha256_hash=sha256_hash,
        total=len(raw_records),
        validated=len(validated),
        quarantined=len(quarantined_ids),
        quarantined_ids=quarantined_ids,
    )
