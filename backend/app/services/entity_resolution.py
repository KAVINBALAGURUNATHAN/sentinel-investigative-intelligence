"""
Entity resolution — identifiers to people.

A subject appears as a phone number in CDR, a bank account in transactions and
a handle on social media. Until those are known to be the same person, no
cross-domain pattern can be detected at all: the CCC engine finds zero
sequences because CALL and TRANSFER appear to involve different actors.

Two sources of linkage, kept apart because they carry different evidential
weight:

  DECLARED   the case's entity register (entities.csv) — supplied by the
             investigation, with its own confidence value.
  INFERRED   shared strong identifiers observed in the data itself: two
             MSISDNs on one IMEI, or on one public IP at the same time.

Inferred links are always reported with the evidence that produced them, never
asserted silently. An investigator must be able to see *why* two numbers were
treated as one person, and to reject it.

DELIBERATE LIMITS
  - IMEI is treated as strong (one handset), IP as corroborating only: carrier
    NAT puts thousands of subscribers behind one address, so IP alone would
    merge unrelated people. It is never sufficient on its own here.
  - No fuzzy name matching. Name similarity is not identity, and silently
    merging two people in a police system is a serious error.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

# Identifier types strong enough to merge two records on their own.
STRONG_IDENTIFIERS = {"IMEI", "IMSI"}
# Corroborating only: needs a second, independent signal.
WEAK_IDENTIFIERS = {"IP", "DEVICE"}


@dataclass
class ResolvedLink:
    """One inferred identity claim, with the evidence behind it."""

    identifier_a: str
    identifier_b: str
    basis: list[str]
    confidence: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "identifier_a": self.identifier_a,
            "identifier_b": self.identifier_b,
            "basis": self.basis,
            "confidence": round(self.confidence, 2),
            "status": "INFERRED — requires investigator confirmation",
        }


@dataclass
class EntityRegistry:
    """Maps identifier values to entity IDs."""

    _by_identifier: dict[str, str] = field(default_factory=dict)
    _confidence: dict[str, float] = field(default_factory=dict)
    inferred_links: list[ResolvedLink] = field(default_factory=list)

    def add(self, identifier: str, entity_id: str, confidence: float = 1.0) -> None:
        if not identifier:
            return
        # Keep the highest-confidence claim for an identifier.
        if self._confidence.get(identifier, -1.0) < confidence:
            self._by_identifier[identifier] = entity_id
            self._confidence[identifier] = confidence

    def resolve(self, identifier: str | None) -> str | None:
        return self._by_identifier.get(identifier) if identifier else None

    def confidence_for(self, identifier: str) -> float:
        return self._confidence.get(identifier, 0.0)

    def identifiers_for(self, entity_id: str) -> list[str]:
        return sorted(k for k, v in self._by_identifier.items() if v == entity_id)

    @property
    def entity_count(self) -> int:
        return len(set(self._by_identifier.values()))

    def as_dict(self) -> dict[str, Any]:
        grouped: dict[str, list[str]] = defaultdict(list)
        for ident, entity in self._by_identifier.items():
            grouped[entity].append(ident)
        return {
            "entities": {e: sorted(v) for e, v in sorted(grouped.items())},
            "identifier_count": len(self._by_identifier),
            "entity_count": self.entity_count,
            "inferred_links": [l.as_dict() for l in self.inferred_links],
        }


def build_registry(entity_rows: Iterable[dict[str, Any]]) -> EntityRegistry:
    """Load the declared entity register (entities.csv)."""
    registry = EntityRegistry()
    for row in entity_rows:
        entity_id = str(row.get("entity_id") or "").strip()
        value = str(row.get("identifier_value") or "").strip()
        if not entity_id or not value:
            continue
        try:
            confidence = float(row.get("confidence") or 1.0)
        except (TypeError, ValueError):
            confidence = 1.0
        registry.add(value, entity_id, confidence)
    return registry


def infer_links(events: Sequence[Any], registry: EntityRegistry) -> list[ResolvedLink]:
    """
    Find identifiers that behave like one person, from the data alone.

    Strong signal: two actor identifiers observed on the same IMEI.
    Corroboration: the same pair also sharing a public IP.
    """
    by_imei: dict[str, set[str]] = defaultdict(set)
    by_ip: dict[str, set[str]] = defaultdict(set)

    for event in events:
        if getattr(event, "quarantined", False):
            continue
        actor = getattr(event, "actor", None)
        if actor is None:
            continue
        attrs = getattr(event, "attributes", {}) or {}
        imei = str(attrs.get("imei") or "").strip()
        public_ip = str(attrs.get("public_ip") or "").strip()
        if imei:
            by_imei[imei].add(actor.value)
        if public_ip:
            by_ip[public_ip].add(actor.value)

    ip_pairs: set[tuple[str, str]] = set()
    for identifiers in by_ip.values():
        ordered = sorted(identifiers)
        for i, a in enumerate(ordered):
            for b in ordered[i + 1:]:
                ip_pairs.add((a, b))

    links: list[ResolvedLink] = []
    for imei, identifiers in sorted(by_imei.items()):
        if len(identifiers) < 2:
            continue
        ordered = sorted(identifiers)
        for i, a in enumerate(ordered):
            for b in ordered[i + 1:]:
                basis = [f"shared IMEI {imei}"]
                confidence = 0.85
                if (a, b) in ip_pairs:
                    basis.append("shared public IP")
                    confidence = 0.95
                links.append(ResolvedLink(a, b, basis, confidence))
    return links


def apply_inferred_links(registry: EntityRegistry, links: Sequence[ResolvedLink]) -> None:
    """
    Fold inferred links into the registry.

    An unknown identifier adopts the entity of its known partner. Two already
    known — and *different* — entities are never merged automatically: that is
    a decision for an investigator, so the link is recorded and left for review.
    """
    for link in links:
        a_entity = registry.resolve(link.identifier_a)
        b_entity = registry.resolve(link.identifier_b)
        if a_entity and not b_entity:
            registry.add(link.identifier_b, a_entity, link.confidence)
        elif b_entity and not a_entity:
            registry.add(link.identifier_a, b_entity, link.confidence)
        registry.inferred_links.append(link)


def resolve_events(events: Sequence[Any], registry: EntityRegistry) -> dict[str, int]:
    """
    Annotate events in place with resolved entity IDs.

    Writes `actor_entity` / `target_entity` into `attributes`. Unresolved
    identifiers are left absent rather than invented — an unknown person must
    stay visibly unknown.
    """
    stats = {"actor_resolved": 0, "actor_unresolved": 0,
             "target_resolved": 0, "target_unresolved": 0}
    for event in events:
        attrs = getattr(event, "attributes", None)
        if attrs is None:
            continue
        for role in ("actor", "target"):
            identifier = getattr(event, role, None)
            if identifier is None:
                continue
            entity = registry.resolve(identifier.value)
            if entity:
                attrs[f"{role}_entity"] = entity
                stats[f"{role}_resolved"] += 1
            else:
                stats[f"{role}_unresolved"] += 1
    return stats


def resolve_case(events: Sequence[Any],
                 entity_rows: Iterable[dict[str, Any]]) -> EntityRegistry:
    """Declared register, then inference from the data, then annotation."""
    registry = build_registry(entity_rows)
    apply_inferred_links(registry, infer_links(events, registry))
    resolve_events(events, registry)
    return registry
