"""
Network structure analysis over resolved entities.

The CCC engine asks a temporal question: did these event types occur together
in time more than chance? Some structures are invisible to it. A courier who
speaks to two otherwise disconnected groups may make very few calls and follow
no sequence at all, yet be the single point joining two networks.

Betweenness centrality finds exactly that: the fraction of shortest paths
running through a node. A broker scores high on betweenness while scoring low
on raw volume — the combination is the signal, and volume alone would miss it
entirely.

Responsibilities (kept separate per the project's architecture):
    Neo4j     stores relationships
    NetworkX  computes metrics          <- this module
    D3        draws them

Structural prominence is NOT evidence of wrongdoing. A dispatcher, a
receptionist and a group admin are all structural bridges. Output is a lead to
examine, phrased accordingly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

import networkx as nx

# A node must sit on at least this share of shortest paths to be considered
# structurally prominent.
BRIDGE_BETWEENNESS = 0.15
# ...while carrying no more than this share of the traffic. High betweenness
# with high volume is a hub, which is ordinary and usually uninteresting.
BRIDGE_MAX_VOLUME_SHARE = 0.25
MIN_NODES = 4  # below this, centrality is not meaningful


@dataclass
class NetworkFinding:
    entity: str
    betweenness: float
    pagerank: float
    degree: int
    volume: int
    volume_share: float
    decision: str
    rationale: list[str] = field(default_factory=list)
    exculpatory: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "entity": self.entity,
            "finding": "STRUCTURAL_BRIDGE",
            "betweenness": round(self.betweenness, 4),
            "pagerank": round(self.pagerank, 4),
            "degree": self.degree,
            "events": self.volume,
            "volume_share": round(self.volume_share, 4),
            "decision": self.decision,
            "rationale": self.rationale,
            "exculpatory_context": self.exculpatory,
            "interpretation": self.interpretation(),
        }

    def interpretation(self) -> str:
        return (
            f"{self.entity} lies on {self.betweenness:.0%} of the shortest "
            f"communication paths in this case while carrying only "
            f"{self.volume_share:.0%} of the traffic ({self.volume} events "
            f"across {self.degree} direct contacts). Groups that would "
            f"otherwise be unconnected are joined through this entity. "
            f"Structural position is not evidence of wrongdoing — an "
            f"intermediary may be a dispatcher, an administrator or a shared "
            f"contact. Examine the supporting evidence."
        )


def build_graph(events: Iterable[Any]) -> nx.DiGraph:
    """
    Directed multigraph collapsed to weighted edges between resolved entities.

    Quarantined records are excluded: an unparsed record must not shape the
    structure that drives a lead.
    """
    graph = nx.DiGraph()
    for event in events:
        if getattr(event, "quarantined", False):
            continue
        attrs = getattr(event, "attributes", None) or {}
        source, target = attrs.get("actor_entity"), attrs.get("target_entity")
        if not source or not target or source == target:
            continue
        etype = getattr(event.event_type, "value", str(event.event_type))
        if graph.has_edge(source, target):
            graph[source][target]["weight"] += 1
            graph[source][target]["types"].add(etype)
        else:
            graph.add_edge(source, target, weight=1, types={etype})
    return graph


def compute_metrics(graph: nx.DiGraph) -> dict[str, dict[str, float]]:
    """PageRank and betweenness for every node."""
    if graph.number_of_nodes() == 0:
        return {}
    undirected = graph.to_undirected()
    betweenness = nx.betweenness_centrality(undirected, normalized=True)
    try:
        pagerank = nx.pagerank(graph, weight="weight")
    except nx.PowerIterationFailedConvergence:  # pragma: no cover - rare
        pagerank = {n: 1 / graph.number_of_nodes() for n in graph.nodes}
    return {
        node: {
            "betweenness": betweenness.get(node, 0.0),
            "pagerank": pagerank.get(node, 0.0),
            "degree": undirected.degree(node),
        }
        for node in graph.nodes
    }


def detect_bridges(
    events: Sequence[Any],
    *,
    min_betweenness: float = BRIDGE_BETWEENNESS,
    max_volume_share: float = BRIDGE_MAX_VOLUME_SHARE,
) -> list[NetworkFinding]:
    """
    Find entities that join otherwise separate groups on low traffic volume.

    Verified structurally: the finding is only reported if removing the node
    actually increases the number of connected components. Centrality alone can
    be high for reasons that do not mean "joins two groups", and a lead that
    cannot be demonstrated should not be raised.
    """
    graph = build_graph(events)
    if graph.number_of_nodes() < MIN_NODES:
        return []

    metrics = compute_metrics(graph)
    undirected = graph.to_undirected()
    total_weight = sum(d["weight"] for _, _, d in graph.edges(data=True)) or 1
    components_before = nx.number_connected_components(undirected)

    findings: list[NetworkFinding] = []
    for node, values in metrics.items():
        volume = sum(d["weight"] for _, _, d in graph.edges(node, data=True))
        volume += sum(d["weight"] for _, _, d in graph.in_edges(node, data=True))
        share = volume / (2 * total_weight)

        if values["betweenness"] < min_betweenness or share > max_volume_share:
            continue

        residual = undirected.copy()
        residual.remove_node(node)
        if residual.number_of_nodes() == 0:
            continue
        splits = nx.number_connected_components(residual) > components_before

        finding = NetworkFinding(
            entity=node,
            betweenness=values["betweenness"],
            pagerank=values["pagerank"],
            degree=values["degree"],
            volume=volume,
            volume_share=share,
            decision="REVIEW" if splits else "MONITOR",
        )
        finding.rationale.append(
            f"Sits on {values['betweenness']:.0%} of shortest paths while "
            f"carrying {share:.0%} of total traffic.")
        if splits:
            finding.rationale.append(
                "Removing this entity disconnects the network into additional "
                "separate groups — it is the sole link between them.")
        else:
            finding.rationale.append(
                "Network remains connected without this entity; prominence may "
                "reflect ordinary routing rather than brokerage.")
        finding.exculpatory.append(
            "Shared contacts, dispatchers and group administrators produce the "
            "same structural signature. Corroborate before escalating.")
        findings.append(finding)

    return sorted(findings, key=lambda f: -f.betweenness)


def network_summary(events: Sequence[Any]) -> dict[str, Any]:
    """Graph-level metrics for the Network page."""
    graph = build_graph(events)
    metrics = compute_metrics(graph)
    undirected = graph.to_undirected()
    return {
        "nodes": graph.number_of_nodes(),
        "edges": graph.number_of_edges(),
        "components": (nx.number_connected_components(undirected)
                       if graph.number_of_nodes() else 0),
        "density": round(nx.density(graph), 4) if graph.number_of_nodes() > 1 else 0.0,
        "metrics": {
            node: {k: round(v, 4) for k, v in values.items()}
            for node, values in sorted(metrics.items())
        },
        "findings": [f.as_dict() for f in detect_bridges(events)],
    }
