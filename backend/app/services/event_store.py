"""
SENTINEL — unified event store (SQLite).

ARCHITECTURE.md §3.4 recorded that there was nowhere to put tabular data:
Neo4j held everything, and CDR/IPDR/bank records are high-volume rows, not
relationships. This is that missing layer.

Division of responsibility, kept deliberately clean:
    SQLite    the event record of truth — rows, filtering, timelines, evidence
    Neo4j     relationships between resolved entities
    NetworkX  graph metrics computed over those relationships

Evidential properties, carried over from the existing ingestion design:
  - The raw upload is SHA-256 hashed BEFORE parsing, and the digest is stored
    on the batch. Every event points at its batch, so any record can be traced
    to the exact bytes it came from.
  - Quarantined records are STORED, not discarded. A dropped record is an
    unanswerable question later.
  - Nothing is ever updated in place; ingestion only appends.

SQLite is a deliberate choice for a prototype handling synthetic data: no
server to run, the database is one file, and it holds hundreds of thousands of
rows comfortably. Postgres is the migration if this ever meets real volume or
concurrent writers.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

from app.models.event import UnifiedEvent

DEFAULT_DB = Path(__file__).resolve().parents[2] / "sentinel_events.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS ingestion_batches (
    batch_id      TEXT PRIMARY KEY,
    case_id       TEXT NOT NULL,
    source        TEXT NOT NULL,
    filename      TEXT,
    sha256        TEXT NOT NULL,
    received_at   TEXT NOT NULL,
    total         INTEGER NOT NULL,
    validated     INTEGER NOT NULL,
    quarantined   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    row_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id         TEXT NOT NULL,
    case_id          TEXT NOT NULL,
    batch_id         TEXT NOT NULL REFERENCES ingestion_batches(batch_id),
    domain           TEXT NOT NULL,
    event_type       TEXT NOT NULL,
    timestamp        TEXT,
    end_timestamp    TEXT,
    actor_type       TEXT,
    actor_value      TEXT,
    target_type      TEXT,
    target_value     TEXT,
    actor_entity     TEXT,
    target_entity    TEXT,
    amount           TEXT,
    currency         TEXT,
    duration_seconds INTEGER,
    bytes_up         INTEGER,
    bytes_down       INTEGER,
    content          TEXT,
    attributes       TEXT NOT NULL DEFAULT '{}',
    source_file      TEXT,
    source_row       INTEGER,
    quarantined      INTEGER NOT NULL DEFAULT 0,
    flags            TEXT NOT NULL DEFAULT '{}',
    UNIQUE (event_id, case_id, batch_id)
);

CREATE INDEX IF NOT EXISTS idx_events_case      ON events(case_id);
CREATE INDEX IF NOT EXISTS idx_events_time      ON events(case_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_actor     ON events(case_id, actor_entity);
CREATE INDEX IF NOT EXISTS idx_events_type      ON events(case_id, event_type);
CREATE INDEX IF NOT EXISTS idx_events_quar      ON events(case_id, quarantined);

CREATE TABLE IF NOT EXISTS entity_identifiers (
    case_id         TEXT NOT NULL,
    entity_id       TEXT NOT NULL,
    identifier_type TEXT NOT NULL,
    identifier_value TEXT NOT NULL,
    confidence      REAL NOT NULL DEFAULT 1.0,
    origin          TEXT NOT NULL DEFAULT 'DECLARED',
    basis           TEXT,
    PRIMARY KEY (case_id, identifier_value, entity_id)
);

CREATE TABLE IF NOT EXISTS alerts (
    alert_id        TEXT PRIMARY KEY,
    case_id         TEXT NOT NULL,
    entity_id       TEXT,
    pattern         TEXT NOT NULL,
    decision        TEXT NOT NULL,
    severity        TEXT NOT NULL,
    observed        INTEGER,
    expected        REAL,
    lift            REAL,
    p_value         REAL,
    fdr_adjusted    REAL,
    evidence_count  INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'OPEN',
    detail          TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_alerts_case ON alerts(case_id, decision);

-- Facts about the INVESTIGATION rather than about the data: who owns the case,
-- what it is called, under what authority it was opened. None of this can be
-- derived from CDR or bank rows, so it is recorded here or it does not exist.
CREATE TABLE IF NOT EXISTS case_registry (
    case_id             TEXT PRIMARY KEY,
    name                TEXT,
    status              TEXT NOT NULL DEFAULT 'OPEN',
    investigator        TEXT,
    authority_reference TEXT,
    notes               TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
"""


def _db_path() -> Path:
    return Path(os.environ.get("SENTINEL_DB_PATH", str(DEFAULT_DB)))


@contextmanager
def connect(path: str | Path | None = None) -> Iterator[sqlite3.Connection]:
    """Open a connection with the schema guaranteed to exist."""
    target = Path(path) if path else _db_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(target))
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.executescript(SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


def sha256_bytes(raw: bytes) -> str:
    """Digest of the raw upload, taken before any parsing."""
    return hashlib.sha256(raw).hexdigest()


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def store_events(
    conn: sqlite3.Connection,
    events: Sequence[UnifiedEvent],
    *,
    case_id: str,
    source: str,
    filename: str | None,
    sha256: str,
) -> str:
    """
    Append one ingestion batch and all of its events, valid and quarantined
    alike. Returns the batch id.
    """
    batch_id = f"BATCH-{uuid.uuid4().hex[:12].upper()}"
    quarantined = sum(1 for e in events if e.quarantined)

    conn.execute(
        "INSERT INTO ingestion_batches (batch_id, case_id, source, filename, "
        "sha256, received_at, total, validated, quarantined) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (batch_id, case_id, source, filename, sha256,
         datetime.now(timezone.utc).isoformat(), len(events),
         len(events) - quarantined, quarantined),
    )

    conn.executemany(
        "INSERT OR IGNORE INTO events (event_id, case_id, batch_id, domain, "
        "event_type, timestamp, end_timestamp, actor_type, actor_value, "
        "target_type, target_value, actor_entity, target_entity, amount, "
        "currency, duration_seconds, bytes_up, bytes_down, content, attributes, "
        "source_file, source_row, quarantined, flags) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            (
                e.event_id, e.case_id or case_id, batch_id, e.domain.value,
                e.event_type.value, _iso(e.timestamp), _iso(e.end_timestamp),
                e.actor.type.value if e.actor else None,
                e.actor.value if e.actor else None,
                e.target.type.value if e.target else None,
                e.target.value if e.target else None,
                (e.attributes or {}).get("actor_entity"),
                (e.attributes or {}).get("target_entity"),
                str(e.amount) if e.amount is not None else None,
                e.currency, e.duration_seconds, e.bytes_up, e.bytes_down,
                e.content, json.dumps(e.attributes or {}),
                e.source_file, e.source_row,
                1 if e.quarantined else 0, json.dumps(e.flags.model_dump()),
            )
            for e in events
        ],
    )
    return batch_id


def store_entities(conn: sqlite3.Connection, case_id: str,
                   registry: Any, events: Sequence[UnifiedEvent] = ()) -> int:
    """
    Persist the identifier → entity map, declared and inferred.

    The registry maps identifier → entity but does not carry the identifier's
    TYPE. The events do, so the type is recovered from them; without this every
    identifier lands as UNKNOWN and the Neo4j projection cannot label a phone
    differently from a bank account.
    """
    # identifier value → type, taken from the records that observed it
    observed_types: dict[str, str] = {}
    for event in events:
        for side in (getattr(event, "actor", None), getattr(event, "target", None)):
            if side and side.value:
                observed_types.setdefault(
                    side.value, getattr(side.type, "value", str(side.type)))

    # never downgrade a type already established for this case
    known_types = {
        row["identifier_value"]: row["identifier_type"]
        for row in conn.execute(
            "SELECT identifier_value, identifier_type FROM entity_identifiers "
            "WHERE case_id IN (?, 'ALL') AND identifier_type != 'UNKNOWN'",
            (case_id,)).fetchall()
    }

    rows = []
    for identifier in registry._by_identifier:  # noqa: SLF001 - same package boundary
        entity = registry.resolve(identifier)
        itype = (known_types.get(identifier)
                 or observed_types.get(identifier)
                 or "UNKNOWN")
        rows.append((case_id, entity, itype, identifier,
                     registry.confidence_for(identifier), "DECLARED", None))
    inferred = {}
    for link in getattr(registry, "inferred_links", []):
        for ident in (link.identifier_a, link.identifier_b):
            inferred[ident] = "; ".join(link.basis)
    rows = [
        (c, e, t, v, conf, ("INFERRED" if v in inferred else o), inferred.get(v))
        for (c, e, t, v, conf, o, _) in rows
    ]
    conn.executemany(
        "INSERT OR REPLACE INTO entity_identifiers (case_id, entity_id, "
        "identifier_type, identifier_value, confidence, origin, basis) "
        "VALUES (?,?,?,?,?,?,?)", rows)
    return len(rows)


def _row_to_event_dict(row: sqlite3.Row, *, mask_identifiers: bool = True) -> dict[str, Any]:
    from app.models.event import mask  # local import avoids a cycle at import time

    actor = row["actor_value"]
    target = row["target_value"]
    return {
        "event_id": row["event_id"],
        "case_id": row["case_id"],
        "batch_id": row["batch_id"],
        "domain": row["domain"],
        "event_type": row["event_type"],
        "timestamp": row["timestamp"],
        "end_timestamp": row["end_timestamp"],
        "actor": mask(actor, row["actor_type"]) if (actor and mask_identifiers) else actor,
        "actor_entity": row["actor_entity"],
        "target": mask(target, row["target_type"]) if (target and mask_identifiers) else target,
        "target_entity": row["target_entity"],
        "amount": row["amount"],
        "currency": row["currency"],
        "duration_seconds": row["duration_seconds"],
        "bytes_up": row["bytes_up"],
        "bytes_down": row["bytes_down"],
        "content": row["content"],
        "attributes": json.loads(row["attributes"] or "{}"),
        "source_file": row["source_file"],
        "source_row": row["source_row"],
        "quarantined": bool(row["quarantined"]),
        "flags": json.loads(row["flags"] or "{}"),
    }


def list_cases(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT case_id, COUNT(*) AS events, "
        "  SUM(quarantined) AS quarantined, "
        "  COUNT(DISTINCT actor_entity) AS entities, "
        "  MIN(timestamp) AS first_event, MAX(timestamp) AS last_event "
        "FROM events GROUP BY case_id ORDER BY case_id"
    ).fetchall()
    cases = []
    for row in rows:
        alerts = conn.execute(
            "SELECT COUNT(*) FROM alerts WHERE case_id=? AND status='OPEN'",
            (row["case_id"],)).fetchone()[0]
        sources = [r[0] for r in conn.execute(
            "SELECT DISTINCT source FROM ingestion_batches WHERE case_id=? "
            "ORDER BY source", (row["case_id"],)).fetchall()]
        cases.append({
            "case_id": row["case_id"],
            "events": row["events"],
            "quarantined": row["quarantined"] or 0,
            "entities": row["entities"] or 0,
            "open_alerts": alerts,
            "data_sources": sources,
            "first_event": row["first_event"],
            "last_event": row["last_event"],
        })
    return cases


def load_events(
    conn: sqlite3.Connection,
    case_id: str,
    *,
    include_quarantined: bool = False,
    event_types: Sequence[str] | None = None,
    entity_id: str | None = None,
    since: str | None = None,
    until: str | None = None,
    limit: int | None = None,
) -> list[sqlite3.Row]:
    sql = ["SELECT * FROM events WHERE case_id = ?"]
    args: list[Any] = [case_id]
    if not include_quarantined:
        sql.append("AND quarantined = 0")
    if event_types:
        sql.append(f"AND event_type IN ({','.join('?' * len(event_types))})")
        args += list(event_types)
    if entity_id:
        sql.append("AND (actor_entity = ? OR target_entity = ?)")
        args += [entity_id, entity_id]
    if since:
        sql.append("AND timestamp >= ?")
        args.append(since)
    if until:
        sql.append("AND timestamp <= ?")
        args.append(until)
    sql.append("ORDER BY timestamp")
    if limit:
        sql.append("LIMIT ?")
        args.append(limit)
    return conn.execute(" ".join(sql), args).fetchall()


def load_unified_events(conn: sqlite3.Connection, case_id: str) -> list[UnifiedEvent]:
    """Rehydrate stored rows into UnifiedEvent objects for the analytics layer."""
    from app.models.event import Domain, EventFlags, EventType, Identifier, IdentifierType

    events: list[UnifiedEvent] = []
    for row in load_events(conn, case_id, include_quarantined=True):
        attributes = json.loads(row["attributes"] or "{}")
        events.append(UnifiedEvent(
            event_id=row["event_id"], case_id=row["case_id"],
            domain=Domain(row["domain"]), event_type=EventType(row["event_type"]),
            timestamp=datetime.fromisoformat(row["timestamp"]) if row["timestamp"] else None,
            end_timestamp=(datetime.fromisoformat(row["end_timestamp"])
                           if row["end_timestamp"] else None),
            actor=(Identifier(type=IdentifierType(row["actor_type"]), value=row["actor_value"])
                   if row["actor_value"] else None),
            target=(Identifier(type=IdentifierType(row["target_type"]), value=row["target_value"])
                    if row["target_value"] else None),
            amount=Decimal(row["amount"]) if row["amount"] else None,
            currency=row["currency"], duration_seconds=row["duration_seconds"],
            bytes_up=row["bytes_up"], bytes_down=row["bytes_down"],
            content=row["content"], attributes=attributes,
            source_file=row["source_file"] or "unknown", source_row=row["source_row"],
            flags=EventFlags(**json.loads(row["flags"] or "{}")),
        ))
    return events


def get_evidence(conn: sqlite3.Connection, event_id: str) -> dict[str, Any] | None:
    """
    One evidence record with its full provenance chain: the event, the batch it
    arrived in, and the SHA-256 of the file as received.
    """
    row = conn.execute("SELECT * FROM events WHERE event_id = ?", (event_id,)).fetchone()
    if row is None:
        return None
    batch = conn.execute("SELECT * FROM ingestion_batches WHERE batch_id = ?",
                         (row["batch_id"],)).fetchone()
    record = _row_to_event_dict(row)
    record["provenance"] = {
        "batch_id": row["batch_id"],
        "source_file": row["source_file"],
        "source_row": row["source_row"],
        "sha256": batch["sha256"] if batch else None,
        "received_at": batch["received_at"] if batch else None,
        "source": batch["source"] if batch else None,
        "chain_status": "VERIFIED" if batch else "BATCH MISSING",
    }
    return record


def store_alerts(conn: sqlite3.Connection, case_id: str,
                 results: Iterable[Any],
                 network_findings: Iterable[Any] = ()) -> int:
    """Persist CCC results that warrant investigator attention."""
    conn.execute("DELETE FROM alerts WHERE case_id = ?", (case_id,))
    rows = []
    for index, result in enumerate(results, start=1):
        if result.decision not in {"REVIEW", "MONITOR"}:
            continue
        payload = result.as_dict()
        severity = ("HIGH" if result.decision == "REVIEW" and result.stats.lift >= 10
                    else "MEDIUM" if result.decision == "REVIEW" else "LOW")
        rows.append((
            f"ALERT-{case_id}-{index:04d}", case_id, result.subject, result.pattern,
            result.decision, severity, result.stats.observed, result.stats.expected,
            result.stats.lift, result.stats.p_value, result.fdr_adjusted,
            result.stats.observed * len(result.sequence),
            datetime.now(timezone.utc).isoformat(), "OPEN", json.dumps(payload),
        ))
    for offset, finding in enumerate(network_findings, start=1):
        if finding.decision not in {"REVIEW", "MONITOR"}:
            continue
        rows.append((
            f"ALERT-{case_id}-NET-{offset:04d}", case_id, finding.entity,
            "STRUCTURAL_BRIDGE", finding.decision,
            "HIGH" if finding.decision == "REVIEW" else "LOW",
            finding.volume, None, None, None, None, finding.volume,
            datetime.now(timezone.utc).isoformat(), "OPEN",
            json.dumps(finding.as_dict()),
        ))

    conn.executemany(
        "INSERT OR REPLACE INTO alerts (alert_id, case_id, entity_id, pattern, "
        "decision, severity, observed, expected, lift, p_value, fdr_adjusted, "
        "evidence_count, created_at, status, detail) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    return len(rows)


def list_alerts(conn: sqlite3.Connection, case_id: str | None = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM alerts"
    args: list[Any] = []
    if case_id:
        sql += " WHERE case_id = ?"
        args.append(case_id)
    sql += " ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, lift DESC"
    out = []
    for row in conn.execute(sql, args).fetchall():
        record = dict(row)
        record["detail"] = json.loads(record.get("detail") or "{}")
        out.append(record)
    return out


def entity_profile(conn: sqlite3.Connection, case_id: str, entity_id: str) -> dict[str, Any]:
    """Identifiers (masked), activity counts and counterparties for one entity."""
    from app.models.event import mask

    identifiers = [
        {
            "type": row["identifier_type"],
            "value_masked": mask(row["identifier_value"], row["identifier_type"]),
            "confidence": row["confidence"],
            "origin": row["origin"],
            "basis": row["basis"],
        }
        for row in conn.execute(
            "SELECT * FROM entity_identifiers WHERE case_id=? AND entity_id=? "
            "ORDER BY identifier_value", (case_id, entity_id)).fetchall()
    ]
    by_type = conn.execute(
        "SELECT event_type, COUNT(*) AS n FROM events WHERE case_id=? "
        "AND actor_entity=? AND quarantined=0 GROUP BY event_type",
        (case_id, entity_id)).fetchall()
    counterparties = conn.execute(
        "SELECT target_entity AS entity, COUNT(*) AS n FROM events WHERE case_id=? "
        "AND actor_entity=? AND target_entity IS NOT NULL AND quarantined=0 "
        "GROUP BY target_entity ORDER BY n DESC", (case_id, entity_id)).fetchall()
    hours = conn.execute(
        "SELECT substr(timestamp, 12, 2) AS hour, COUNT(*) AS n FROM events "
        "WHERE case_id=? AND actor_entity=? AND quarantined=0 AND timestamp IS NOT NULL "
        "GROUP BY hour ORDER BY hour", (case_id, entity_id)).fetchall()
    return {
        "entity_id": entity_id,
        "case_id": case_id,
        "identifiers": identifiers,
        "activity": {row["event_type"]: row["n"] for row in by_type},
        "counterparties": [{"entity": r["entity"], "events": r["n"]} for r in counterparties],
        "active_hours": [{"hour": int(r["hour"]), "events": r["n"]} for r in hours],
    }


def entity_network(conn: sqlite3.Connection, case_id: str) -> dict[str, Any]:
    """
    Resolved-entity graph for the Network page. Edge type is the event type, so
    CALL / TRANSFER / SOCIAL are visually distinguishable in the UI.
    """
    edges = conn.execute(
        "SELECT actor_entity AS source, target_entity AS target, event_type, "
        "COUNT(*) AS weight FROM events WHERE case_id=? AND quarantined=0 "
        "AND actor_entity IS NOT NULL AND target_entity IS NOT NULL "
        "GROUP BY actor_entity, target_entity, event_type", (case_id,)).fetchall()
    nodes: dict[str, dict[str, Any]] = {}
    for row in edges:
        for key in (row["source"], row["target"]):
            nodes.setdefault(key, {"id": key, "type": "ENTITY", "events": 0})
        nodes[row["source"]]["events"] += row["weight"]
    return {
        "nodes": list(nodes.values()),
        "edges": [dict(row) for row in edges],
    }


def ingestion_batches(conn: sqlite3.Connection, case_id: str | None = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM ingestion_batches"
    args: list[Any] = []
    if case_id:
        sql += " WHERE case_id = ?"
        args.append(case_id)
    sql += " ORDER BY received_at DESC"
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def entity_registry(conn: sqlite3.Connection, case_id: str) -> dict[str, Any]:
    """
    Every entity discovered in a case — people AND the identifiers that belong
    to them — for the Entities page.

    Two kinds of row, kept distinct because they mean different things:
      PERSON      a resolved entity, with a count of who it is connected to
      identifier  a phone / account / device / handle, showing its owner
    """
    from app.models.event import mask

    rows: list[dict[str, Any]] = []

    # Resolved people, with the number of distinct counterparties.
    people = conn.execute(
        "SELECT actor_entity AS entity, COUNT(DISTINCT target_entity) AS connections, "
        "COUNT(*) AS events FROM events WHERE case_id=? AND quarantined=0 "
        "AND actor_entity IS NOT NULL GROUP BY actor_entity", (case_id,)).fetchall()
    inbound_rows = conn.execute(
        "SELECT target_entity AS entity, COUNT(DISTINCT actor_entity) AS connections, "
        "COUNT(*) AS events FROM events WHERE case_id=? AND quarantined=0 "
        "AND target_entity IS NOT NULL GROUP BY target_entity", (case_id,)).fetchall()
    inbound = {r["entity"]: r["connections"] for r in inbound_rows}
    inbound_events = {r["entity"]: r["events"] for r in inbound_rows}
    known = {r["entity"] for r in people} | set(inbound)
    for entity in sorted(known):
        row = next((r for r in people if r["entity"] == entity), None)
        rows.append({
            "kind": "PERSON",
            "type": "PERSON",
            "id": entity,
            "connections": (row["connections"] if row else 0) + inbound.get(entity, 0),
            # an entity that only ever appears as a target still has activity
            "events": (row["events"] if row else 0) + inbound_events.get(entity, 0),
            "linked_to": None,
        })

    # Identifiers, masked, with the person they resolved to. The same value can
    # be registered against both this case and 'ALL'; show it once, preferring
    # the row that carries a real type.
    seen: dict[tuple[str, str], dict[str, Any]] = {}
    for row in conn.execute(
        "SELECT entity_id, identifier_type, identifier_value, confidence, origin "
        "FROM entity_identifiers WHERE case_id IN (?, 'ALL') "
        "ORDER BY identifier_type, identifier_value", (case_id,)).fetchall():
        key = (row["identifier_value"], row["entity_id"])
        if key in seen and row["identifier_type"] == "UNKNOWN":
            continue
        seen[key] = {
            "kind": "IDENTIFIER",
            "type": row["identifier_type"],
            "id": mask(row["identifier_value"], row["identifier_type"]),
            "connections": None,
            "events": None,
            "linked_to": row["entity_id"],
            "confidence": row["confidence"],
            "origin": row["origin"],
        }
    rows.extend(seen.values())

    return {
        "case_id": case_id,
        "counts": {
            "people": sum(1 for r in rows if r["kind"] == "PERSON"),
            "identifiers": sum(1 for r in rows if r["kind"] == "IDENTIFIER"),
        },
        "entities": rows,
    }


def related_entities(conn: sqlite3.Connection, case_id: str,
                     entity_id: str) -> list[dict[str, Any]]:
    """
    Counterparties of one entity, with the domains connecting them.

    "P102 — CALL + TRANSFER + SOCIAL" is the single most useful line on an
    entity page: it says these two are linked across independent sources.
    """
    grouped: dict[str, dict[str, Any]] = {}
    for row in conn.execute(
        "SELECT actor_entity, target_entity, event_type, COUNT(*) AS n "
        "FROM events WHERE case_id=? AND quarantined=0 "
        "AND (actor_entity=? OR target_entity=?) "
        "AND actor_entity IS NOT NULL AND target_entity IS NOT NULL "
        "GROUP BY actor_entity, target_entity, event_type", (case_id, entity_id, entity_id)
    ).fetchall():
        other = (row["target_entity"] if row["actor_entity"] == entity_id
                 else row["actor_entity"])
        if other == entity_id:
            continue
        bucket = grouped.setdefault(other, {"entity": other, "events": 0,
                                            "relationships": set()})
        bucket["events"] += row["n"]
        bucket["relationships"].add(row["event_type"])

    return sorted(
        ({"entity": v["entity"], "events": v["events"],
          "relationships": sorted(v["relationships"]),
          "cross_domain": len(v["relationships"]) > 1} for v in grouped.values()),
        key=lambda r: (-len(r["relationships"]), -r["events"]),
    )


CASE_STATUSES = ("OPEN", "UNDER REVIEW", "PENDING APPROVAL", "CLOSED")


def get_case_metadata(conn: sqlite3.Connection, case_id: str) -> dict[str, Any]:
    """
    Investigation metadata for a case.

    Returns `recorded: False` when nothing has been entered yet, so the UI can
    invite the investigator to fill it in rather than displaying invented
    values or a dead-end notice.
    """
    row = conn.execute("SELECT * FROM case_registry WHERE case_id = ?",
                       (case_id,)).fetchone()
    if row is None:
        return {
            "case_id": case_id, "name": None, "status": "OPEN",
            "investigator": None, "authority_reference": None, "notes": None,
            "created_at": None, "updated_at": None, "recorded": False,
        }
    record = dict(row)
    record["recorded"] = True
    return record


def save_case_metadata(conn: sqlite3.Connection, case_id: str,
                       fields: dict[str, Any]) -> dict[str, Any]:
    """Create or update the registry entry. Only known columns are accepted."""
    allowed = ("name", "status", "investigator", "authority_reference", "notes")
    now = datetime.now(timezone.utc).isoformat()
    current = get_case_metadata(conn, case_id)

    status = fields.get("status", current.get("status") or "OPEN")
    if status not in CASE_STATUSES:
        raise ValueError(f"status must be one of {', '.join(CASE_STATUSES)}")

    merged = {k: fields.get(k, current.get(k)) for k in allowed}
    merged["status"] = status
    conn.execute(
        "INSERT INTO case_registry (case_id, name, status, investigator, "
        "authority_reference, notes, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?) "
        "ON CONFLICT(case_id) DO UPDATE SET name=excluded.name, "
        "status=excluded.status, investigator=excluded.investigator, "
        "authority_reference=excluded.authority_reference, notes=excluded.notes, "
        "updated_at=excluded.updated_at",
        (case_id, merged["name"], merged["status"], merged["investigator"],
         merged["authority_reference"], merged["notes"],
         current.get("created_at") or now, now))
    return get_case_metadata(conn, case_id)
