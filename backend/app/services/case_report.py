"""
SENTINEL — multi-domain investigation report (workflow step 15).

The existing services/pdf_export.py builds a court pack for the original
messaging pipeline and reads that schema. This is the equivalent for CDR /
IPDR / banking / social cases, reading the SQLite event store.

Two documents, deliberately separate, because they answer different questions
and carry different risks if confused:

  Court pack        Exhibits only. Source records, timestamps, identifiers and
                    the SHA-256 of the file each came from. NO risk scores, NO
                    statistics, NO findings. Section 63 of the Bharatiya Sakshya
                    Adhiniyam, 2023 governs electronic evidence; a document that
                    mixes exhibits with inference invites the whole thing to be
                    challenged.

  Investigation     Working document for the investigating officer. Carries the
  report            CCC statistics, the structural findings and — always — the
                    alternative explanations and the limits of the method.

Language rule, enforced by tests: nothing here asserts guilt. Findings are
"requires investigation", never "criminal". Statistical association is not
proof, and the report says so on its face.
"""

from __future__ import annotations

import hashlib
import io
import json
import sqlite3
from datetime import datetime, timezone
from html import escape
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.models.event import mask
from app.services import event_store as store

DISCLAIMER = (
    "This document is decision-support output. It records patterns observed in "
    "the supplied records and how unusual they are under a stated statistical "
    "model. It does not establish that any person committed an offence. "
    "Statistical association is not evidence of wrongdoing. Every finding "
    "requires corroboration from source material before any action is taken."
)

SYNTHETIC_NOTICE = (
    "Prepared from synthetic test data. Not a real investigation."
)


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("t", parent=base["Heading1"], fontSize=16,
                                spaceAfter=4, textColor=colors.HexColor("#14202f")),
        "sub": ParagraphStyle("s", parent=base["Normal"], fontSize=8.5,
                              textColor=colors.HexColor("#66768a"), spaceAfter=12),
        "h2": ParagraphStyle("h2", parent=base["Heading2"], fontSize=11,
                             spaceBefore=14, spaceAfter=6,
                             textColor=colors.HexColor("#1f4e79")),
        "body": ParagraphStyle("b", parent=base["Normal"], fontSize=9,
                               leading=13, spaceAfter=6),
        "caveat": ParagraphStyle("c", parent=base["Normal"], fontSize=8,
                                 leading=11, textColor=colors.HexColor("#8a5a00"),
                                 borderPadding=5, spaceBefore=6, spaceAfter=8),
        "mono": ParagraphStyle("m", parent=base["Normal"], fontName="Courier",
                               fontSize=7.5, leading=10),
    }


def _table(rows: list[list[str]], widths: list[float]) -> Table:
    table = Table(rows, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef2f6")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#14202f")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.5),
        ("LEADING", (0, 0), (-1, -1), 9.5),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#dfe5ec")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1),
         [colors.white, colors.HexColor("#f8fafc")]),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return table


def _header(story: list, styles: dict, case_id: str, meta: dict[str, Any],
            title: str) -> None:
    story.append(Paragraph(escape(title), styles["title"]))
    story.append(Paragraph(
        f"Case {escape(case_id)} &nbsp;·&nbsp; generated "
        f"{datetime.now(timezone.utc).strftime('%d %b %Y %H:%M UTC')} "
        f"&nbsp;·&nbsp; {escape(SYNTHETIC_NOTICE)}", styles["sub"]))

    rows = [["Field", "Value"]]
    for label, key in (("Case name", "name"), ("Status", "status"),
                       ("Investigating officer", "investigator"),
                       ("Authority reference", "authority_reference")):
        value = (meta or {}).get(key)
        rows.append([label, str(value) if value else "— not recorded —"])
    story.append(_table(rows, [5 * cm, 11 * cm]))


def _case_facts(conn: sqlite3.Connection, case_id: str) -> dict[str, Any]:
    cases = {c["case_id"]: c for c in store.list_cases(conn)}
    if case_id not in cases:
        raise LookupError(case_id)
    return cases[case_id]


# ── Court pack: exhibits only ─────────────────────────────────────────────

def generate_court_pack(conn: sqlite3.Connection, case_id: str,
                        limit: int = 400) -> bytes:
    """
    Exhibit bundle. Source records with provenance, and nothing inferred.

    No score, no p-value, no finding appears in this document by design.
    """
    facts = _case_facts(conn, case_id)
    meta = store.get_case_metadata(conn, case_id)
    batches = store.ingestion_batches(conn, case_id)
    rows = store.load_events(conn, case_id, limit=limit)

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, title=f"Court pack {case_id}",
                            leftMargin=1.8 * cm, rightMargin=1.8 * cm,
                            topMargin=1.6 * cm, bottomMargin=1.6 * cm)
    styles = _styles()
    story: list = []

    _header(story, styles, case_id, meta, "Court pack — exhibits")
    story.append(Paragraph(
        "This bundle contains source records only. Risk scores, statistical "
        "results and analytical conclusions are deliberately excluded so that "
        "the exhibits stand on their own.", styles["caveat"]))

    story.append(Paragraph("Source files and integrity", styles["h2"]))
    story.append(Paragraph(
        "Each file was SHA-256 hashed on receipt, before parsing. Any later "
        "alteration of a source file changes its digest.", styles["body"]))
    integrity = [["Source", "File", "Received (UTC)", "Records", "SHA-256"]]
    for batch in batches:
        integrity.append([
            batch["source"].upper(), batch["filename"] or "—",
            (batch["received_at"] or "")[:19].replace("T", " "),
            str(batch["total"]), batch["sha256"]])
    story.append(_table(integrity, [1.8 * cm, 3.1 * cm, 3.1 * cm, 1.5 * cm, 6.5 * cm])
                 if batches else Paragraph("No ingestion batches.", styles["body"]))

    story.append(Paragraph("Exhibits", styles["h2"]))
    story.append(Paragraph(
        f"{facts['events']} records were ingested for this case; "
        f"{facts['quarantined']} could not be validated and are listed "
        f"separately. Identifiers are masked.", styles["body"]))

    exhibits = [["Exhibit", "Timestamp (UTC)", "Type", "From", "To", "Detail", "Source"]]
    for row in rows:
        record = store._row_to_event_dict(row)  # noqa: SLF001
        detail = []
        if record["amount"]:
            detail.append(f"INR {record['amount']}")
        if record["duration_seconds"]:
            detail.append(f"{record['duration_seconds']}s")
        exhibits.append([
            record["event_id"],
            (record["timestamp"] or "—")[:19].replace("T", " "),
            record["event_type"],
            record["actor"] or "—",
            record["target"] or "—",
            ", ".join(detail) or "—",
            f"{record['source_file']}:{record['source_row']}",
        ])
    story.append(_table(exhibits, [2.3 * cm, 2.9 * cm, 2.2 * cm, 2.2 * cm,
                                   2.2 * cm, 2.0 * cm, 2.4 * cm]))
    if len(rows) >= limit:
        story.append(Paragraph(
            f"Truncated at {limit} exhibits. The full record set is available "
            f"in the audit bundle.", styles["body"]))

    quarantined = [r for r in store.load_events(conn, case_id,
                                                include_quarantined=True)
                   if r["quarantined"]]
    if quarantined:
        story.append(Paragraph("Quarantined records", styles["h2"]))
        story.append(Paragraph(
            "These records failed validation and were excluded from analysis. "
            "They are retained and listed because a discarded record is an "
            "unanswerable question later.", styles["body"]))
        rows_q = [["Record", "Source", "Reason"]]
        for row in quarantined:
            flags = json.loads(row["flags"] or "{}")
            reasons = ", ".join(k for k, v in flags.items() if v) or "unspecified"
            rows_q.append([row["event_id"],
                           f"{row['source_file']}:{row['source_row']}", reasons])
        story.append(_table(rows_q, [3.5 * cm, 4.5 * cm, 8.0 * cm]))

    doc.build(story)
    return buffer.getvalue()


# ── Investigation report: findings, with their limits ─────────────────────

def generate_investigation_report(conn: sqlite3.Connection, case_id: str,
                                  analysis: dict[str, Any]) -> bytes:
    """
    Working document for the investigating officer.

    Carries the statistics AND the alternative explanations. A finding is never
    presented without what would explain it innocently.
    """
    facts = _case_facts(conn, case_id)
    meta = store.get_case_metadata(conn, case_id)
    alerts = store.list_alerts(conn, case_id)

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4,
                            title=f"Investigation report {case_id}",
                            leftMargin=1.8 * cm, rightMargin=1.8 * cm,
                            topMargin=1.6 * cm, bottomMargin=1.6 * cm)
    styles = _styles()
    story: list = []

    _header(story, styles, case_id, meta, "Investigation report")
    story.append(Paragraph(DISCLAIMER, styles["caveat"]))

    story.append(Paragraph("Material examined", styles["h2"]))
    diagnostics = analysis.get("diagnostics", {})
    summary = [["Measure", "Value"], ["Records ingested", str(facts["events"])],
               ["Records analysed", str(diagnostics.get("events_analysed", "—"))],
               ["Quarantined (excluded)", str(facts["quarantined"])],
               ["Data sources", ", ".join(facts["data_sources"]) or "—"],
               ["Entities resolved", str(facts["entities"])],
               ["Sequences tested", str(diagnostics.get("patterns_checked", "—"))],
               ["Time window", f"{diagnostics.get('window_minutes', '—')} minutes"],
               ["Permutations", str(analysis.get("permutations", "—"))]]
    story.append(_table(summary, [6 * cm, 10 * cm]))

    results = analysis.get("results", [])
    reviewable = [r for r in results if r.get("decision") == "REVIEW"]

    story.append(Paragraph("Cross-source patterns", styles["h2"]))
    if not results:
        story.append(Paragraph(
            escape(analysis.get("analysis_note")
                   or "No configured sequence occurred within the time window."),
            styles["body"]))
        for check in diagnostics.get("checks", []):
            rejection = check.get("rejection")
            if rejection:
                story.append(Paragraph(
                    f"<b>{escape(' → '.join(check['sequence']))}</b>: "
                    f"{escape(rejection['detail'])}", styles["body"]))
    else:
        for result in results:
            story.append(Paragraph(
                f"<b>{escape(result['pattern'].replace('_', ' → '))}</b> — "
                f"subject {escape(str(result.get('subject', '—')))} — "
                f"{escape(str(result.get('decision', '')).replace('_', ' ').lower())}",
                styles["body"]))
            stats = [["Observed", "Expected", "Lift", "p-value", "FDR-adjusted"],
                     [str(result.get("observed", "—")),
                      str(result.get("expected", "—")),
                      f"{result.get('lift', '—')}×",
                      str(result.get("p_value", "—")),
                      str(result.get("fdr_adjusted", "—"))]]
            story.append(_table(stats, [3.2 * cm] * 5))
            if result.get("interpretation"):
                story.append(Paragraph(escape(result["interpretation"]), styles["body"]))
            alternatives = (result.get("exculpatory_context")
                            or result.get("alternative_explanations") or [])
            if alternatives:
                story.append(Paragraph("<b>Possible innocent explanations</b>",
                                       styles["body"]))
                for item in alternatives:
                    story.append(Paragraph(f"• {escape(str(item))}", styles["body"]))
            story.append(Spacer(1, 6))

    findings = analysis.get("network_findings", [])
    if findings:
        story.append(Paragraph("Network structure", styles["h2"]))
        for finding in findings:
            story.append(Paragraph(
                f"<b>{escape(str(finding['entity']))}</b> — "
                f"{escape(finding['interpretation'])}", styles["body"]))
            for item in finding.get("exculpatory_context", []):
                story.append(Paragraph(f"• {escape(str(item))}", styles["body"]))

    if alerts:
        story.append(Paragraph("Open items for review", styles["h2"]))
        rows_a = [["Alert", "Subject", "Pattern", "Severity", "Evidence"]]
        for alert in alerts:
            rows_a.append([alert["alert_id"], alert["entity_id"] or "—",
                           alert["pattern"], alert["severity"],
                           str(alert["evidence_count"])])
        story.append(_table(rows_a, [4.4 * cm, 2.6 * cm, 4.6 * cm, 2.2 * cm, 2.2 * cm]))

    story.append(PageBreak())
    story.append(Paragraph("Method and its limits", styles["h2"]))
    for line in (
        "Occurrences are counted as non-overlapping ordered sequences within the "
        "stated time window, per resolved subject.",
        "The expected count is the mean of a null distribution built by permuting "
        "the subject's own event labels, holding their activity times fixed. It "
        "answers: how often would this sequence appear by chance, given this "
        "person's own rhythm?",
        "The p-value is empirical, with add-one smoothing, so it can never be "
        "reported as zero.",
        "Multiple sequences and subjects are tested together, so p-values are "
        "corrected with the Benjamini-Hochberg procedure. Without it, testing "
        "many innocent subjects produces apparent findings by chance alone.",
        "A sequence that is the subject's established routine is not reported as "
        "anomalous, even when statistically frequent.",
        "Entity resolution may be wrong. Where identifiers were linked by "
        "inference rather than declaration, the confidence and basis are recorded.",
        "These results were produced from synthetic test data.",
    ):
        story.append(Paragraph(f"• {line}", styles["body"]))

    doc.build(story)
    return buffer.getvalue()


# ── Audit bundle ──────────────────────────────────────────────────────────

def build_audit_bundle(conn: sqlite3.Connection, case_id: str,
                       analysis: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    Machine-readable export: every record, its provenance, and the findings.

    The bundle is hashed over its own canonical JSON so a recipient can detect
    alteration of the export itself, independently of the source-file digests.
    """
    facts = _case_facts(conn, case_id)
    rows = store.load_events(conn, case_id, include_quarantined=True)

    bundle: dict[str, Any] = {
        "case_id": case_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "notice": SYNTHETIC_NOTICE,
        "disclaimer": DISCLAIMER,
        "case": facts,
        "case_metadata": store.get_case_metadata(conn, case_id),
        "source_files": store.ingestion_batches(conn, case_id),
        "entities": store.entity_registry(conn, case_id),
        "events": [store._row_to_event_dict(r) for r in rows],  # noqa: SLF001
        "alerts": store.list_alerts(conn, case_id),
    }
    if analysis is not None:
        bundle["analysis"] = {
            "window_minutes": analysis.get("window_minutes"),
            "permutations": analysis.get("permutations"),
            "analysis_status": analysis.get("analysis_status"),
            "results": analysis.get("results", []),
            "network_findings": analysis.get("network_findings", []),
            "diagnostics": analysis.get("diagnostics", {}),
        }

    canonical = json.dumps(bundle, sort_keys=True, separators=(",", ":"),
                           default=str).encode("utf-8")
    bundle["bundle_sha256"] = hashlib.sha256(canonical).hexdigest()
    return bundle
