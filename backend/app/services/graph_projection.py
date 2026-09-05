"""
SENTINEL — Neo4j projection (workflow step 6: Graph Creation).

Takes the output of entity resolution and writes the investigation graph:

    P101 ──OWNS──▶ Phone A ──CALLED──▶ Phone B ◀──OWNS── P102
    P101 ──OWNS──▶ Acct A  ──TRANSFERRED──▶ Acct B ◀──OWNS── P102
    P101 ──USES──▶ Device A ──CONNECTED_FROM──▶ IP-X

Two layers are stored deliberately:

  ownership   Person → identifier (OWNS / USES). This is what entity
              resolution concluded, and it carries the confidence and the
              basis for that conclusion so the investigator can see why.
  activity    identifier → identifier (CALLED / TRANSFERRED / ...). This is
              what the source records actually observed. It is never inferred.

Keeping them separate matters evidentially: a call between two handsets is a
fact from the CDR, while "these two people spoke" is a conclusion that depends
on the resolution being right. The graph must not blur the two.

Neo4j's job here is storage and navigation of relationships. Metrics are
NetworkX's job (app/analytics/network_metrics.py); this module computes none.

Relationship direction note: OWNS runs Person → identifier. Neo4j traverses
relationships in both directions, so a separate BELONGS_TO inverse would be
redundant storage; the read queries below traverse it either way.

Degradation: if Neo4j is unreachable, every function returns a status saying
so. It never invents counts, and the rest of the application keeps working —
SQLite remains the record of truth.
"""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Any, Iterable, Sequence

from app.services.graph_db import run_query_for_case, run_write

# graph_db opens its driver with connection_timeout=3s and no transaction
# retries — deliberately tight for a small deployment. Against a hosted Aura
# instance the FIRST call after idle spends longer than that on the TLS
# handshake and routing-table fetch, so it fails and the next one succeeds.
# Rather than change that shared setting, absorb the cold start here.
_PROJECTION_ATTEMPTS = 4


def _with_retry(operation, *args):
    """Run a graph operation, tolerating a cold-start failure."""
    last: Exception | None = None
    for attempt in range(_PROJECTION_ATTEMPTS):
        try:
            return operation(*args)
        except Exception as exc:  # noqa: BLE001 - re-raised below
            last = exc
            if attempt == _PROJECTION_ATTEMPTS - 1:
                break
            # graph_db opens a cooldown circuit breaker on failure; clear it so
            # the retry is actually attempted rather than short-circuited.
            from app.services import graph_db

            graph_db._unavailable_until = 0.0  # noqa: SLF001
            graph_db._driver = None  # noqa: SLF001
            time.sleep(1.5 * (attempt + 1))  # let the handshake complete
    raise last  # type: ignore[misc]

# Identifier type → (node label, relationship from Person)
IDENTIFIER_NODES: dict[str, tuple[str, str]] = {
    "PHONE": ("Phone", "OWNS"),
    "IMEI": ("Device", "USES"),
    "IMSI": ("Sim", "USES"),
    "BANK_ACCOUNT": ("BankAccount", "OWNS"),
    "UPI": ("UpiHandle", "OWNS"),
    "SOCIAL_HANDLE": ("SocialAccount", "OWNS"),
    "IP": ("IpAddress", "USES"),
    "DEVICE": ("Device", "USES"),
    # An already-resolved entity id used as an identifier refers to the Person
    # node itself rather than to something the Person owns.
    "ENTITY": ("Person", "IDENTIFIES"),
}

# Event type → activity relationship between identifier nodes.
# Keys are the EventType enum values; every member is covered, enforced by
# test_every_event_type_has_a_relationship_name.
ACTIVITY_RELATIONSHIPS: dict[str, str] = {
    "CALL": "CALLED",
    "SMS": "MESSAGED",
    "MESSAGE": "MESSAGED",
    "TRANSFER": "TRANSFERRED",
    "DATA_SESSION": "CONNECTED_FROM",
    "LOGIN": "LOGGED_IN_FROM",
    "SOCIAL_POST": "POSTED",
    "SOCIAL_CONNECTION": "CONNECTED_TO",
}


def _label_for(identifier_type: str) -> tuple[str, str]:
    return IDENTIFIER_NODES.get(str(identifier_type).upper(), ("Identifier", "LINKED_TO"))


def build_ownership_payload(identifiers: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Person → identifier rows for Neo4j.

    Pure function: no database contact, so the shape is unit-testable.
    """
    payload: list[dict[str, Any]] = []
    for row in identifiers:
        value = str(row.get("identifier_value") or "").strip()
        entity = str(row.get("entity_id") or "").strip()
        if not value or not entity:
            continue
        label, relationship = _label_for(row.get("identifier_type") or "")
        payload.append({
            "entity_id": entity,
            "label": label,
            "relationship": relationship,
            "value": value,
            "identifier_type": str(row.get("identifier_type") or "UNKNOWN").upper(),
            "confidence": float(row.get("confidence") or 1.0),
            "origin": str(row.get("origin") or "DECLARED"),
            "basis": row.get("basis"),
        })
    return payload


def build_activity_payload(events: Sequence[Any]) -> list[dict[str, Any]]:
    """
    Aggregate observed events into one weighted relationship per
    (source identifier, target identifier, relationship type).

    Quarantined records are excluded: an unparsed row must not create an edge
    an investigator could mistake for an observation.
    """
    grouped: dict[tuple[str, str, str, str, str], dict[str, Any]] = defaultdict(
        lambda: {"count": 0, "total_duration": 0, "total_amount": 0.0,
                 "first_seen": None, "last_seen": None})

    for event in events:
        if getattr(event, "quarantined", False):
            continue
        actor, target = getattr(event, "actor", None), getattr(event, "target", None)
        if not actor or not target or not actor.value or not target.value:
            continue

        etype = getattr(event.event_type, "value", str(event.event_type))
        relationship = ACTIVITY_RELATIONSHIPS.get(etype)
        if relationship is None:
            continue

        source_label, _ = _label_for(getattr(actor.type, "value", actor.type))
        target_label, _ = _label_for(getattr(target.type, "value", target.type))
        key = (source_label, actor.value, relationship, target_label, target.value)

        bucket = grouped[key]
        bucket["count"] += 1
        bucket["total_duration"] += int(getattr(event, "duration_seconds", 0) or 0)
        amount = getattr(event, "amount", None)
        if amount is not None:
            bucket["total_amount"] += float(amount)

        stamp = getattr(event, "timestamp", None)
        if stamp is not None:
            iso = stamp.isoformat()
            if bucket["first_seen"] is None or iso < bucket["first_seen"]:
                bucket["first_seen"] = iso
            if bucket["last_seen"] is None or iso > bucket["last_seen"]:
                bucket["last_seen"] = iso

    return [
        {
            "source_label": source_label, "source": source,
            "relationship": relationship,
            "target_label": target_label, "target": target,
            **values,
        }
        for (source_label, source, relationship, target_label, target), values
        in sorted(grouped.items())
    ]


def project_case(case_id: str, events: Sequence[Any],
                 identifiers: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """
    Write one case's investigation graph to Neo4j.

    Idempotent: every write is a MERGE keyed on (case_id, value), so
    re-projecting a case updates rather than duplicating.
    """
    ownership = build_ownership_payload(identifiers)
    activity = build_activity_payload(events)

    if not ownership and not activity:
        return {"status": "EMPTY", "case_id": case_id,
                "reason": "No resolved identifiers or observed events to project.",
                "person_nodes": 0, "identifier_nodes": 0,
                "ownership_edges": 0, "activity_edges": 0}

    try:
        # Person nodes and their identifiers. Grouped by label because a Neo4j
        # node label cannot be parameterised.
        by_label: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for row in ownership:
            by_label[(row["label"], row["relationship"])].append(row)

        for (label, relationship), rows in by_label.items():
            _with_retry(run_write,
                f"""
                UNWIND $rows AS row
                MERGE (p:Person {{entity_id: row.entity_id, case_id: $case_id}})
                MERGE (i:{label} {{value: row.value, case_id: $case_id}})
                  ON CREATE SET i.identifier_type = row.identifier_type
                MERGE (p)-[r:{relationship}]->(i)
                  SET r.confidence = row.confidence,
                      r.origin     = row.origin,
                      r.basis      = row.basis
                """,
                {"rows": rows, "case_id": case_id},
            )

        # Observed activity between identifiers.
        by_activity: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
        for row in activity:
            by_activity[(row["source_label"], row["relationship"],
                         row["target_label"])].append(row)

        for (source_label, relationship, target_label), rows in by_activity.items():
            _with_retry(run_write,
                f"""
                UNWIND $rows AS row
                MERGE (a:{source_label} {{value: row.source, case_id: $case_id}})
                MERGE (b:{target_label} {{value: row.target, case_id: $case_id}})
                MERGE (a)-[r:{relationship}]->(b)
                  SET r.count          = row.count,
                      r.total_duration = row.total_duration,
                      r.total_amount   = row.total_amount,
                      r.first_seen     = row.first_seen,
                      r.last_seen      = row.last_seen
                """,
                {"rows": rows, "case_id": case_id},
            )
    except Exception as exc:  # graph_db raises when the driver is unreachable
        return {"status": "UNAVAILABLE", "case_id": case_id,
                "reason": f"Neo4j write failed: {type(exc).__name__}",
                "detail": str(exc)[:200],
                "person_nodes": 0, "identifier_nodes": 0,
                "ownership_edges": 0, "activity_edges": 0}

    return {
        "status": "OK",
        "case_id": case_id,
        "person_nodes": len({row["entity_id"] for row in ownership}),
        "identifier_nodes": len({(row["label"], row["value"]) for row in ownership}),
        "ownership_edges": len(ownership),
        "activity_edges": len(activity),
        "relationship_types": sorted({row["relationship"] for row in activity}),
    }


def fetch_case_graph(case_id: str) -> dict[str, Any]:
    """
    Read the projected graph back for D3.

    Returns typed nodes and edges so the UI can distinguish a CALL from a
    TRANSFER, and a Person from a BankAccount.
    """
    try:
        nodes = _with_retry(
            run_query_for_case,
            case_id,
            """
            MATCH (n {case_id: $case_id})
            RETURN labels(n)[0] AS label,
                   coalesce(n.entity_id, n.value) AS id,
                   n.identifier_type AS identifier_type
            """,
        )
        edges = _with_retry(
            run_query_for_case,
            case_id,
            """
            MATCH (a {case_id: $case_id})-[r]->(b {case_id: $case_id})
            RETURN coalesce(a.entity_id, a.value) AS source,
                   coalesce(b.entity_id, b.value) AS target,
                   type(r) AS relationship,
                   coalesce(r.count, 1)        AS count,
                   coalesce(r.total_amount, 0) AS total_amount,
                   r.confidence                AS confidence
            """,
        )
    except Exception as exc:
        return {"status": "UNAVAILABLE", "case_id": case_id,
                "reason": f"Neo4j read failed: {type(exc).__name__}",
                "nodes": [], "edges": []}

    return {
        "status": "OK",
        "case_id": case_id,
        "nodes": [dict(n) for n in nodes],
        "edges": [dict(e) for e in edges],
        "note": "OWNS/USES edges are resolution conclusions; all others are "
                "observations from source records.",
    }


def clear_case(case_id: str) -> dict[str, Any]:
    """Remove one case's projection. Case-scoped: never touches other cases."""
    try:
        _with_retry(run_write, "MATCH (n {case_id: $case_id}) DETACH DELETE n",
                    {"case_id": case_id})
    except Exception as exc:
        return {"status": "UNAVAILABLE", "reason": str(exc)[:200]}
    return {"status": "OK", "case_id": case_id}
