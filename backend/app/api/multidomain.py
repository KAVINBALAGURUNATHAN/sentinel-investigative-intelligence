"""
SENTINEL — multi-domain investigation API (CDR / IPDR / bank / social).

These endpoints are additive. The existing WhatsApp routes (/api/v1/ingest,
/run, /dashboard, /export) are untouched and continue to serve the original
pipeline.

Every route here reads or writes real stored data. Nothing returns a
placeholder shaped like a result: where a capability is not implemented, the
route says so explicitly rather than fabricating numbers.

Identifier masking is ON by default on every response. Unmasking is an
authorisation decision, and this prototype has no authentication yet, so the
unmasked path is deliberately not exposed.
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, Response, UploadFile
from fastapi.responses import Response

from app.analytics.ccc_engine import PATTERNS, analyse_case, diagnose_case
from app.analytics.entity_risk import score_entity
from app.analytics.network_metrics import detect_bridges, network_summary
from app.config import display_policy
from app.services import event_store as store
from app.services.case_report import (
    build_audit_bundle,
    generate_court_pack,
    generate_investigation_report,
)
from app.services.entity_resolution import resolve_case
from app.services.graph_projection import clear_case, fetch_case_graph, project_case
from app.services.normalizers import NORMALIZERS, ingestion_summary, normalize_csv_bytes

router = APIRouter(prefix="/api/v1", tags=["multi-domain"])

SOURCES = tuple(NORMALIZERS)  # cdr, ipdr, bank, social


# ── Ingestion ─────────────────────────────────────────────────────────────

@router.post("/ingest/{source}")
async def ingest_source(
    source: str,
    file: UploadFile = File(...),
    case_id: str = Query("CASE_001", description="Case to attach records to"),
) -> dict[str, Any]:
    """
    Ingest one CSV of CDR / IPDR / bank / social records.

    Pipeline: hash the raw bytes → normalise every row → resolve entities →
    store valid AND quarantined records. Rows in always equals events out.
    """
    if source not in SOURCES:
        raise HTTPException(400, f"Unknown source '{source}'. "
                                 f"Supported: {', '.join(SOURCES)}")
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Uploaded file is empty.")

    digest = store.sha256_bytes(raw)  # hashed before parsing
    events = normalize_csv_bytes(source, raw)
    for event in events:
        if not event.case_id or event.case_id == "UNASSIGNED":
            event.case_id = case_id

    cases = sorted({e.case_id for e in events})
    with store.connect() as conn:
        for case in cases:
            subset = [e for e in events if e.case_id == case]
            registry = resolve_case(subset, _declared_identifiers(conn, case))
            store.store_events(conn, subset, case_id=case, source=source,
                               filename=file.filename, sha256=digest)
            store.store_entities(conn, case, registry, subset)

    summary = ingestion_summary(events)
    return {
        "source": source,
        "filename": file.filename,
        "sha256": digest,
        "cases": cases,
        **summary,
        "stages": ["UPLOAD", "VALIDATE", "NORMALIZE", "ENTITY_RESOLUTION", "STORE"],
        "note": "Quarantined records are stored, never discarded.",
    }


@router.post("/ingest/entities/register")
async def ingest_entities(
    file: UploadFile = File(...),
    case_id: str = Query("ALL"),
) -> dict[str, Any]:
    """Load a declared entity register (entities.csv) for identity resolution."""
    raw = await file.read()
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8", errors="replace"))))
    if not rows:
        raise HTTPException(400, "No rows found in entity register.")

    stored = 0
    with store.connect() as conn:
        for row in rows:
            case = str(row.get("case_id") or case_id).strip() or case_id
            entity = str(row.get("entity_id") or "").strip()
            value = str(row.get("identifier_value") or "").strip()
            if not entity or not value:
                continue
            try:
                confidence = float(row.get("confidence") or 1.0)
            except (TypeError, ValueError):
                confidence = 1.0
            conn.execute(
                "INSERT OR REPLACE INTO entity_identifiers (case_id, entity_id, "
                "identifier_type, identifier_value, confidence, origin, basis) "
                "VALUES (?,?,?,?,?,'DECLARED',NULL)",
                (case, entity, str(row.get("identifier_type") or "UNKNOWN").strip(),
                 value, confidence))
            stored += 1
    return {"identifiers_registered": stored, "rows_received": len(rows)}


def _declared_identifiers(conn, case_id: str) -> list[dict[str, Any]]:
    """Registered identifiers for a case, plus any registered against ALL."""
    rows = conn.execute(
        "SELECT entity_id, identifier_type, identifier_value, confidence "
        "FROM entity_identifiers WHERE case_id IN (?, 'ALL')", (case_id,)).fetchall()
    return [dict(r) for r in rows]


@router.get("/ingestion/batches")
def ingestion_history(case_id: str | None = None) -> dict[str, Any]:
    """Batch history for the Data Ingestion page, with source hashes."""
    with store.connect() as conn:
        return {"batches": store.ingestion_batches(conn, case_id)}


@router.get("/system/display-policy")
def get_display_policy() -> dict[str, Any]:
    """
    Whether identifiers may be shown in full, and why.

    The interface states the policy rather than leaving a viewer to infer it
    from whether asterisks happen to be present.
    """
    return display_policy()


@router.get("/search")
def global_search(
    q: str = Query(..., min_length=1, description="Free text"),
    case_id: str | None = Query(None, description="Restrict to one case"),
    limit: int = Query(10, le=50),
) -> dict[str, Any]:
    """
    Search across cases, subjects, identifiers, evidence records and findings.

    An investigator is handed a number and asked what it is. They should not
    have to know whether it is a phone, an account or an evidence id before
    they can look it up, so one query covers all of them and the results say
    which kind each match is.

    Matching is a case-insensitive substring, applied to the stored values.
    Identifier values in results follow the display policy, like everywhere else.
    """
    from app.models.event import present

    term = q.strip()
    like = f"%{term}%"
    results: dict[str, list[dict[str, Any]]] = {
        "cases": [], "subjects": [], "identifiers": [], "evidence": [], "findings": [],
    }

    with store.connect() as conn:
        scope = "AND case_id = ?" if case_id else ""
        args_tail = [case_id] if case_id else []

        for row in conn.execute(
            "SELECT DISTINCT case_id FROM events WHERE case_id LIKE ? ORDER BY case_id "
            "LIMIT ?", (like, limit)).fetchall():
            results["cases"].append({"case_id": row["case_id"]})

        for row in conn.execute(
            f"SELECT DISTINCT actor_entity AS entity, case_id FROM events "
            f"WHERE actor_entity LIKE ? {scope} ORDER BY entity LIMIT ?",
            (like, *args_tail, limit)).fetchall():
            if row["entity"]:
                results["subjects"].append(
                    {"entity_id": row["entity"], "case_id": row["case_id"]})

        # The declared register is stored under 'ALL' as well as against each
        # case, so the same value matches twice. Show it once, preferring the
        # row that names a real case.
        seen_identifiers: dict[tuple[str, str], dict[str, Any]] = {}
        for row in conn.execute(
            f"SELECT entity_id, identifier_type, identifier_value, case_id "
            f"FROM entity_identifiers WHERE identifier_value LIKE ? "
            f"{'AND case_id = ?' if case_id else ''} "
            f"ORDER BY CASE WHEN case_id = 'ALL' THEN 1 ELSE 0 END, identifier_type "
            f"LIMIT ?",
            (like, *args_tail, limit * 2)).fetchall():
            key = (row["identifier_value"], row["entity_id"])
            if key in seen_identifiers:
                continue
            seen_identifiers[key] = {
                "value": present(row["identifier_value"], row["identifier_type"]),
                "type": row["identifier_type"],
                "entity_id": row["entity_id"],
                "case_id": row["case_id"],
            }
        results["identifiers"] = list(seen_identifiers.values())[:limit]

        for row in conn.execute(
            f"SELECT event_id, case_id, event_type, timestamp, source_file "
            f"FROM events WHERE (event_id LIKE ? OR source_file LIKE ?) {scope} "
            f"ORDER BY timestamp LIMIT ?",
            (like, like, *args_tail, limit)).fetchall():
            results["evidence"].append(dict(row))

        for row in conn.execute(
            f"SELECT alert_id, case_id, entity_id, pattern, severity FROM alerts "
            f"WHERE (pattern LIKE ? OR entity_id LIKE ? OR alert_id LIKE ?) {scope} "
            f"LIMIT ?", (like, like, like, *args_tail, limit)).fetchall():
            results["findings"].append(dict(row))

    total = sum(len(v) for v in results.values())
    return {"query": term, "case_id": case_id, "total": total, "results": results}


# ── Cases ─────────────────────────────────────────────────────────────────

@router.get("/cases")
def get_cases() -> dict[str, Any]:
    with store.connect() as conn:
        return {"cases": store.list_cases(conn)}


@router.get("/cases/{case_id}")
def get_case(case_id: str) -> dict[str, Any]:
    with store.connect() as conn:
        cases = {c["case_id"]: c for c in store.list_cases(conn)}
        if case_id not in cases:
            raise HTTPException(404, f"No ingested data for case '{case_id}'.")
        case = cases[case_id]
        case["batches"] = store.ingestion_batches(conn, case_id)
        case["alerts"] = store.list_alerts(conn, case_id)
        # Facts about the investigation, not derivable from the records.
        case["case_metadata"] = store.get_case_metadata(conn, case_id)
        return case


@router.put("/cases/{case_id}/metadata")
def update_case_metadata(case_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """
    Record investigation metadata: name, status, investigator, authority
    reference. These are entered by a person; nothing here is inferred.
    """
    with store.connect() as conn:
        known = {c["case_id"] for c in store.list_cases(conn)}
        if case_id not in known:
            raise HTTPException(404, f"No ingested data for case '{case_id}'.")
        try:
            return store.save_case_metadata(conn, case_id, payload)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc


@router.get("/cases/{case_id}/metadata")
def read_case_metadata(case_id: str) -> dict[str, Any]:
    with store.connect() as conn:
        return store.get_case_metadata(conn, case_id)


@router.get("/case-statuses")
def case_statuses() -> dict[str, Any]:
    return {"statuses": list(store.CASE_STATUSES)}


@router.get("/cases/{case_id}/timeline")
def get_timeline(
    case_id: str,
    entity_id: str | None = None,
    event_types: str | None = Query(None, description="Comma-separated event types"),
    since: str | None = None,
    until: str | None = None,
    limit: int = Query(500, le=5000),
) -> dict[str, Any]:
    """Chronological events, filterable by entity, type and date."""
    types = [t.strip().upper() for t in event_types.split(",")] if event_types else None
    with store.connect() as conn:
        rows = store.load_events(conn, case_id, event_types=types, entity_id=entity_id,
                                 since=since, until=until, limit=limit)
        return {
            "case_id": case_id,
            "count": len(rows),
            "events": [store._row_to_event_dict(r) for r in rows],  # noqa: SLF001
        }


@router.get("/cases/{case_id}/patterns")
def get_patterns(
    case_id: str,
    window_minutes: int = Query(30, ge=1, le=1440),
    permutations: int = Query(1000, ge=100, le=5000),
) -> dict[str, Any]:
    """
    Run the CCC engine over a case: permutation test, subject baseline and FDR.

    Statistical output only. It never asserts wrongdoing.
    """
    with store.connect() as conn:
        events = store.load_unified_events(conn, case_id)
        if not events:
            raise HTTPException(404, f"No ingested data for case '{case_id}'.")
        diagnostics = diagnose_case(events, window_minutes=window_minutes)
        results = analyse_case(events, window_minutes=window_minutes,
                               permutations=permutations)
        bridges = detect_bridges(events)
        stored = store.store_alerts(conn, case_id, results, network_findings=bridges)

    tested = [r for r in results if r.stats.observed > 0]
    return {
        "case_id": case_id,
        "patterns_tested": sorted(PATTERNS),
        "window_minutes": window_minutes,
        "permutations": permutations,
        "results": [r.as_dict() for r in tested],
        "network_findings": [f.as_dict() for f in bridges],
        # Always present: an empty result must explain itself with the same
        # numbers that produced it.
        "diagnostics": diagnostics,
        "analysis_status": (
            "COMPLETED" if tested else
            "SKIPPED_NO_OCCURRENCES"),
        "analysis_note": (
            None if tested else
            "Statistical analysis skipped because no valid pattern occurrences "
            "were detected. The permutation test was not run; no p-value or "
            "lift is reported."),
        "alerts_created": stored,
        "disclaimer": "Synthetic benchmark data. Statistical association is not "
                      "evidence of wrongdoing; review supporting evidence.",
    }


# ── Entities ──────────────────────────────────────────────────────────────

@router.get("/cases/{case_id}/entities")
def get_case_entities(case_id: str) -> dict[str, Any]:
    """
    Every entity discovered in the case: resolved people and the identifiers
    belonging to them. Identifier values are masked.
    """
    with store.connect() as conn:
        known = {c["case_id"] for c in store.list_cases(conn)}
        if case_id not in known:
            raise HTTPException(404, f"No ingested data for case '{case_id}'.")
        # An empty registry is a real answer, not an error: the case may hold
        # only quarantined records. The response carries the reason so the
        # interface can explain it rather than looking broken.
        registry = store.entity_registry(conn, case_id)
        alerts = store.list_alerts(conn, case_id)
        events = store.load_unified_events(conn, case_id)
        structural = [f.as_dict() for f in detect_bridges(events)]
        for row in registry["entities"]:
            if row["kind"] != "PERSON":
                continue
            related = store.related_entities(conn, case_id, row["id"])
            profile = store.entity_profile(conn, case_id, row["id"])
            row["attention"] = score_entity(
                row["id"], alerts=alerts, related=related,
                activity=profile["activity"], structural=structural)
            row["activity_series"] = store.entity_activity_series(conn, case_id, row["id"])
        return registry


# ── Neo4j projection (workflow step 6) ────────────────────────────────────

@router.post("/cases/{case_id}/graph/build")
def build_case_graph(case_id: str) -> dict[str, Any]:
    """
    Project resolved entities and observed activity into Neo4j.

    Idempotent — safe to re-run. If Neo4j is unreachable the response says so
    rather than reporting a graph that was not written.
    """
    with store.connect() as conn:
        events = store.load_unified_events(conn, case_id)
        # Case-scoped only. The shared 'ALL' register exists so that resolution
        # can consult it; projecting it would put every registered identifier
        # into every case's graph, including cases that never observed them.
        identifiers = conn.execute(
            "SELECT entity_id, identifier_type, identifier_value, confidence, "
            "origin, basis FROM entity_identifiers WHERE case_id = ?",
            (case_id,)).fetchall()
    if not events:
        raise HTTPException(404, f"No ingested data for case '{case_id}'.")

    # Replace, do not accumulate. Every write is a MERGE, so re-projecting
    # without clearing leaves behind nodes that no longer belong to the case —
    # an entity removed from the register, or identifiers written before case
    # scoping was corrected, would linger and be read as current evidence.
    # Scoped to this case_id, so no other investigation is touched.
    cleared = clear_case(case_id)

    result = project_case(case_id, events, [dict(r) for r in identifiers])
    result["previous_projection_cleared"] = cleared.get("status") == "OK"
    return result


@router.get("/cases/{case_id}/graph")
def read_case_graph(case_id: str) -> dict[str, Any]:
    """The projected Neo4j graph, typed for D3."""
    return fetch_case_graph(case_id)


@router.delete("/cases/{case_id}/graph")
def delete_case_graph(case_id: str) -> dict[str, Any]:
    """Remove one case's projection. Case-scoped."""
    return clear_case(case_id)


@router.get("/entities/{entity_id}")
def get_entity(entity_id: str, case_id: str = Query(...)) -> dict[str, Any]:
    """Entity profile. Identifiers are masked."""
    with store.connect() as conn:
        profile = store.entity_profile(conn, case_id, entity_id)
        if not profile["identifiers"] and not profile["activity"]:
            raise HTTPException(404, f"Entity '{entity_id}' not found in {case_id}.")
        profile["related_entities"] = store.related_entities(conn, case_id, entity_id)
        profile["connections"] = len(profile["related_entities"])
        profile["activity_series"] = store.entity_activity_series(conn, case_id, entity_id)
        alerts = store.list_alerts(conn, case_id)
        events = store.load_unified_events(conn, case_id)

    # Ranking aid only: every point traces to a named indicator returned with it.
    profile["attention"] = score_entity(
        entity_id, alerts=alerts, related=profile["related_entities"],
        activity=profile["activity"], structural=[f.as_dict() for f in detect_bridges(events)])
    return profile


@router.get("/entities/{entity_id}/network")
def get_entity_network(entity_id: str, case_id: str = Query(...)) -> dict[str, Any]:
    """The entity's immediate neighbourhood, typed by relationship."""
    with store.connect() as conn:
        graph = store.entity_network(conn, case_id)
    edges = [e for e in graph["edges"]
             if e["source"] == entity_id or e["target"] == entity_id]
    keep = {entity_id} | {e["source"] for e in edges} | {e["target"] for e in edges}
    return {
        "entity_id": entity_id,
        "nodes": [n for n in graph["nodes"] if n["id"] in keep],
        "edges": edges,
    }


@router.get("/cases/{case_id}/network/metrics")
def get_network_metrics(case_id: str) -> dict[str, Any]:
    """
    PageRank, betweenness and structural-bridge findings (NetworkX).

    Complements the CCC engine: this finds entities that JOIN groups, which a
    temporal sequence test cannot see.
    """
    with store.connect() as conn:
        events = store.load_unified_events(conn, case_id)
    if not events:
        raise HTTPException(404, f"No ingested data for case '{case_id}'.")
    return {
        "case_id": case_id,
        **network_summary(events),
        "disclaimer": "Structural prominence is not evidence of wrongdoing.",
    }


@router.get("/cases/{case_id}/network")
def get_case_network(case_id: str) -> dict[str, Any]:
    """Full resolved-entity graph for the Network page."""
    with store.connect() as conn:
        graph = store.entity_network(conn, case_id)
    if not graph["nodes"]:
        raise HTTPException(404, f"No resolved network for case '{case_id}'.")
    return {"case_id": case_id, **graph}


@router.get("/cases/{case_id}/relationship")
def get_relationship(
    case_id: str,
    source: str = Query(..., description="Identifier or entity at one end"),
    target: str = Query(..., description="Identifier or entity at the other end"),
    relationship: str | None = Query(None, description="Graph relationship type"),
    limit: int = Query(200, le=2000),
) -> dict[str, Any]:
    """
    The events behind one graph edge.

    An edge is an aggregate — "called ×18". This returns the individual records
    that were aggregated, so an investigator can go from a line on the graph to
    the exact call at the exact minute, and from there to its evidence record.

    Ownership edges (OWNS/USES) are conclusions of entity resolution, not
    observations, so they have no events; the response says so rather than
    returning an empty list that reads as missing data.
    """
    ownership = {"OWNS", "USES", "IDENTIFIES"}
    if relationship and relationship.upper() in ownership:
        return {
            "case_id": case_id, "source": source, "target": target,
            "relationship": relationship, "kind": "RESOLUTION",
            "events": [], "count": 0,
            "note": "This link is a conclusion of entity resolution, not an "
                    "observed event. It records that the identifier was "
                    "attributed to this subject, and carries the basis for "
                    "that attribution rather than a list of events.",
        }

    with store.connect() as conn:
        if case_id not in {c["case_id"] for c in store.list_cases(conn)}:
            raise HTTPException(404, f"No ingested data for case '{case_id}'.")
        rows = conn.execute(
            "SELECT * FROM events WHERE case_id = ? AND quarantined = 0 AND ("
            "  (actor_value = ? AND target_value = ?) OR"
            "  (actor_value = ? AND target_value = ?) OR"
            "  (actor_entity = ? AND target_entity = ?) OR"
            "  (actor_entity = ? AND target_entity = ?)"
            ") ORDER BY timestamp LIMIT ?",
            (case_id, source, target, target, source,
             source, target, target, source, limit)).fetchall()
        events = [store._row_to_event_dict(r) for r in rows]  # noqa: SLF001

    if relationship:
        wanted = {
            "CALLED": {"CALL"}, "MESSAGED": {"SMS", "MESSAGE"},
            "TRANSFERRED": {"TRANSFER"}, "CONNECTED_FROM": {"DATA_SESSION"},
            "LOGGED_IN_FROM": {"LOGIN"}, "POSTED": {"SOCIAL_POST"},
            "CONNECTED_TO": {"SOCIAL_CONNECTION"},
        }.get(relationship.upper())
        if wanted:
            events = [e for e in events if e["event_type"] in wanted]

    durations = [e["duration_seconds"] for e in events if e.get("duration_seconds")]
    amounts = [float(e["amount"]) for e in events if e.get("amount")]
    stamps = [e["timestamp"] for e in events if e.get("timestamp")]

    return {
        "case_id": case_id,
        "source": source,
        "target": target,
        "relationship": relationship,
        "kind": "OBSERVATION",
        "count": len(events),
        "first_seen": min(stamps) if stamps else None,
        "last_seen": max(stamps) if stamps else None,
        "total_duration_seconds": sum(durations) if durations else None,
        "total_amount": sum(amounts) if amounts else None,
        "sources": sorted({e["domain"] for e in events}),
        "events": events,
    }


# ── Alerts and evidence ───────────────────────────────────────────────────

@router.get("/alerts")
def get_alerts(case_id: str | None = None) -> dict[str, Any]:
    with store.connect() as conn:
        return {"alerts": store.list_alerts(conn, case_id)}


@router.get("/evidence/{event_id}")
def get_evidence(event_id: str) -> dict[str, Any]:
    """One evidence record with its provenance chain back to the source hash."""
    with store.connect() as conn:
        record = store.get_evidence(conn, event_id)
    if record is None:
        raise HTTPException(404, f"No evidence record '{event_id}'.")
    return record


# ── Reports ───────────────────────────────────────────────────────────────

def _analysis_for(case_id: str) -> dict[str, Any]:
    """
    Current statistical results for a case, recomputed so the report cannot
    disagree with what the interface shows.
    """
    with store.connect() as conn:
        events = store.load_unified_events(conn, case_id)
    if not events:
        return {"results": [], "network_findings": []}
    return {
        "results": [r.as_dict() for r in analyse_case(events)],
        "network_findings": [f.as_dict() for f in detect_bridges(events)],
    }


def _require_case(conn, case_id: str) -> None:
    if case_id not in {c["case_id"] for c in store.list_cases(conn)}:
        raise HTTPException(404, f"No ingested data for case '{case_id}'.")


@router.get("/cases/{case_id}/report/court-pack")
def download_court_pack(case_id: str) -> Response:
    """
    Exhibit bundle: source records and their provenance only.

    Carries no score, p-value or finding, so the exhibits stand on their own.
    """
    with store.connect() as conn:
        _require_case(conn, case_id)
        pdf = generate_court_pack(conn, case_id)
    return Response(
        content=pdf, media_type="application/pdf",
        headers={"Content-Disposition":
                 f'attachment; filename="sentinel-court-pack-{case_id}.pdf"'})


@router.get("/cases/{case_id}/report")
def download_investigation_report(case_id: str) -> Response:
    """Working document: findings, statistics and the caveats that go with them."""
    analysis = _analysis_for(case_id)
    with store.connect() as conn:
        _require_case(conn, case_id)
        pdf = generate_investigation_report(conn, case_id, analysis)
    return Response(
        content=pdf, media_type="application/pdf",
        headers={"Content-Disposition":
                 f'attachment; filename="sentinel-report-{case_id}.pdf"'})


@router.get("/cases/{case_id}/audit-bundle")
def download_audit_bundle(case_id: str) -> Response:
    """Machine-readable export of every record, its provenance and the findings."""
    analysis = _analysis_for(case_id)
    with store.connect() as conn:
        _require_case(conn, case_id)
        bundle = build_audit_bundle(conn, case_id, analysis)
    return Response(
        content=json.dumps(bundle, indent=2, default=str),
        media_type="application/json",
        headers={"Content-Disposition":
                 f'attachment; filename="sentinel-audit-{case_id}.json"'})


@router.get("/cases/{case_id}/report/preview")
def report_preview(case_id: str) -> dict[str, Any]:
    """What the documents will contain, so the page can describe them first."""
    with store.connect() as conn:
        _require_case(conn, case_id)
        cases = {c["case_id"]: c for c in store.list_cases(conn)}
        case = cases[case_id]
        registry = store.entity_registry(conn, case_id)
        alerts = store.list_alerts(conn, case_id)
        batches = store.ingestion_batches(conn, case_id)
    counts = registry.get("counts", {})
    return {
        "case_id": case_id,
        "records": case.get("events", 0),
        "quarantined": case.get("quarantined", 0),
        "subjects": counts.get("people", 0),
        "identifiers": counts.get("identifiers", 0),
        "findings": len(alerts),
        "sources": case.get("data_sources", []),
        "batches": len(batches),
        "documents": [
            {
                "id": "court-pack",
                "name": "Court pack",
                "purpose": "Exhibits only — source records, timestamps and the "
                           "SHA-256 of each file. No scores or findings.",
            },
            {
                "id": "report",
                "name": "Investigation report",
                "purpose": "Findings with their statistics, the baseline compared "
                           "against, and the alternative explanations considered.",
            },
            {
                "id": "audit-bundle",
                "name": "Audit bundle",
                "purpose": "Machine-readable export of every record and finding, "
                           "hashed so alteration of the export is detectable.",
            },
        ],
    }


# ── Validation ────────────────────────────────────────────────────────────

@router.get("/validation/benchmark")
def validation_benchmark(permutations: int = Query(300, ge=100, le=2000)) -> dict[str, Any]:
    """
    Score the engine against data/synthetic/ground_truth.json.

    These are SYNTHETIC BENCHMARK RESULTS on labelled data, not a measure of
    real-world accuracy.
    """
    import json
    from pathlib import Path

    truth_path = (Path(__file__).resolve().parents[3] / "data" / "synthetic"
                  / "ground_truth.json")
    if not truth_path.exists():
        raise HTTPException(404, "ground_truth.json not found.")
    truth = json.loads(truth_path.read_text(encoding="utf-8"))

    tests: list[dict[str, Any]] = []
    tp = fp = tn = fn = 0
    with store.connect() as conn:
        available = {c["case_id"] for c in store.list_cases(conn)}
        for case_id, label in truth.items():
            if case_id.startswith("_") or case_id not in available:
                continue
            expected_alert = bool(label.get("expected_alert"))
            events = store.load_unified_events(conn, case_id)
            results = analyse_case(events, permutations=permutations)
            bridges = detect_bridges(events)
            actual_alert = (any(r.decision == "REVIEW" for r in results)
                            or any(b.decision == "REVIEW" for b in bridges))

            quarantined = sum(1 for e in events if e.quarantined)
            expected_q = label.get("expected_quarantine", 0)

            passed = (actual_alert == expected_alert) and (quarantined == expected_q)
            tp += int(expected_alert and actual_alert)
            fp += int(not expected_alert and actual_alert)
            tn += int(not expected_alert and not actual_alert)
            fn += int(expected_alert and not actual_alert)

            tests.append({
                "case_id": case_id,
                "scenario": label.get("scenario"),
                "expected": "ALERT" if expected_alert else "CLEAR",
                "actual": "ALERT" if actual_alert else "CLEAR",
                "expected_quarantine": expected_q,
                "actual_quarantine": quarantined,
                "result": "PASS" if passed else "FAIL",
                "rationale": label.get("rationale"),
            })

    precision = tp / (tp + fp) if (tp + fp) else None
    recall = tp / (tp + fn) if (tp + fn) else None
    return {
        "label": "Synthetic benchmark results",
        "disclaimer": "Measured on labelled synthetic data only. Not an estimate "
                      "of real-world accuracy.",
        "tests": tests,
        "summary": {
            "tests": len(tests),
            "passed": sum(1 for t in tests if t["result"] == "PASS"),
            "failed": sum(1 for t in tests if t["result"] == "FAIL"),
            "true_positives": tp, "false_positives": fp,
            "true_negatives": tn, "false_negatives": fn,
            "precision": precision, "recall": recall,
        },
    }
