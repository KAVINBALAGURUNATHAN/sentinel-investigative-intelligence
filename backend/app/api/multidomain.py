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
from app.analytics.network_metrics import detect_bridges, network_summary
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
        return store.entity_registry(conn, case_id)


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
    return project_case(case_id, events, [dict(r) for r in identifiers])


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
