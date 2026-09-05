"""
Network-structure tests.

CASE_004 is the scenario the CCC engine cannot see: a low-volume broker joining
two otherwise disconnected clusters. No temporal sequence is involved, so only
structural analysis can find it.
"""

from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.analytics.network_metrics import (
    build_graph,
    compute_metrics,
    detect_bridges,
    network_summary,
)
from app.services.entity_resolution import resolve_case
from app.services.normalizers import normalize_rows

DATA = Path(__file__).resolve().parents[2] / "data" / "synthetic"


def rows(name: str) -> list[dict]:
    with (DATA / name).open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


@pytest.fixture(scope="module")
def resolved() -> list:
    events: list = []
    for kind in ("cdr", "ipdr", "bank", "social"):
        events += normalize_rows(kind, rows(f"{kind}.csv"))
    resolve_case(events, rows("entities.csv"))
    return events


def case(events: list, case_id: str) -> list:
    return [e for e in events if e.case_id == case_id]


class FakeEvent:
    """Minimal stand-in for a UnifiedEvent."""

    def __init__(self, actor: str, target: str, quarantined: bool = False):
        self.attributes = {"actor_entity": actor, "target_entity": target}
        self.event_type = "CALL"
        self.quarantined = quarantined
        self.timestamp = datetime(2026, 8, 15, tzinfo=timezone.utc)


def chain(pairs: list[tuple[str, str]], repeat: int = 1) -> list[FakeEvent]:
    return [FakeEvent(a, b) for a, b in pairs for _ in range(repeat)]


# ── graph construction ────────────────────────────────────────────────────

def test_edges_are_weighted_by_repetition():
    graph = build_graph(chain([("A", "B")], repeat=5))
    assert graph["A"]["B"]["weight"] == 5


def test_self_loops_are_ignored():
    assert build_graph(chain([("A", "A")])).number_of_edges() == 0


def test_quarantined_events_do_not_shape_the_graph():
    events = chain([("A", "B")]) + [FakeEvent("X", "Y", quarantined=True)]
    graph = build_graph(events)
    assert "X" not in graph.nodes


def test_unresolved_entities_are_skipped():
    class NoEntity(FakeEvent):
        def __init__(self):
            super().__init__("A", "B")
            self.attributes = {}

    assert build_graph([NoEntity()]).number_of_nodes() == 0


# ── bridge detection ──────────────────────────────────────────────────────

def test_broker_between_two_clusters_is_flagged():
    """Two dense clusters joined only through BRIDGE, which is low-volume."""
    left = [("A", "B"), ("B", "C"), ("C", "A")]
    right = [("D", "E"), ("E", "F"), ("F", "D")]
    events = chain(left, repeat=10) + chain(right, repeat=10) + chain(
        [("C", "BRIDGE"), ("BRIDGE", "D")], repeat=1)
    findings = {f.entity: f for f in detect_bridges(events)}
    assert "BRIDGE" in findings
    assert findings["BRIDGE"].decision == "REVIEW"
    assert findings["BRIDGE"].volume_share < 0.25


def test_high_volume_hub_is_not_reported_as_a_bridge():
    """A busy centre is ordinary; only low-volume brokerage is of interest."""
    events = chain([("HUB", x) for x in "ABCDEF"], repeat=30)
    assert all(f.entity != "HUB" for f in detect_bridges(events))


def test_tiny_graphs_produce_no_findings():
    """Centrality is meaningless below a few nodes."""
    assert detect_bridges(chain([("A", "B")], repeat=50)) == []


def test_fully_connected_group_has_no_bridge():
    pairs = [(a, b) for a in "ABCDE" for b in "ABCDE" if a != b]
    assert detect_bridges(chain(pairs, repeat=3)) == []


# ── ground truth ──────────────────────────────────────────────────────────

def test_case_004_identifies_the_planted_bridge(resolved):
    findings = detect_bridges(case(resolved, "CASE_004"))
    assert findings, "no structural finding for the suspicious-network case"
    assert "E-105" in {f.entity for f in findings}


def test_planted_bridge_has_the_lowest_traffic_share(resolved):
    """The broker signature: high betweenness, low volume."""
    findings = {f.entity: f for f in detect_bridges(case(resolved, "CASE_004"))}
    bridge = findings["E-105"]
    assert bridge.volume_share == min(f.volume_share for f in findings.values())
    assert bridge.betweenness >= 0.15


def test_normal_case_has_no_structural_alert(resolved):
    assert all(f.decision != "REVIEW"
               for f in detect_bridges(case(resolved, "CASE_001")))


# ── output contract ───────────────────────────────────────────────────────

def test_findings_carry_exculpatory_context(resolved):
    for finding in detect_bridges(case(resolved, "CASE_004")):
        assert finding.exculpatory, "structural finding without alternatives"
        assert finding.rationale


def test_language_is_non_accusatory(resolved):
    banned = ("criminal", "guilty", "offender", "perpetrator", "proves")
    for finding in detect_bridges(case(resolved, "CASE_004")):
        text = " ".join([finding.interpretation(), *finding.rationale,
                         *finding.exculpatory]).lower()
        for word in banned:
            assert word not in text
        assert "not evidence of wrongdoing" in finding.interpretation().lower()


def test_summary_reports_graph_shape(resolved):
    summary = network_summary(case(resolved, "CASE_004"))
    assert summary["nodes"] > 0 and summary["edges"] > 0
    assert "metrics" in summary and summary["metrics"]


def test_metrics_cover_every_node(resolved):
    events = case(resolved, "CASE_004")
    graph = build_graph(events)
    assert set(compute_metrics(graph)) == set(graph.nodes)
