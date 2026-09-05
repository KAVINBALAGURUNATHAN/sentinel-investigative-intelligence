"""
SENTINEL — synthetic multi-domain dataset generator.

Produces CDR / IPDR / banking / social records plus an entity register and a
ground-truth file, covering seven labelled scenarios.

ALL DATA IS SYNTHETIC. Phone numbers use the reserved 99999xxxxx range, bank
accounts and handles are invented. No real personal data is present, and none
may ever be added to this directory.

Deterministic: seeded, so regenerating produces byte-identical files.

Run:  python data/synthetic/generate_datasets.py
"""

from __future__ import annotations

import csv
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

SEED = 20260815
OUT = Path(__file__).parent
BASE = datetime(2026, 8, 15, 9, 0, 0, tzinfo=timezone.utc)

rng = random.Random(SEED)

cdr_rows: list[dict] = []
ipdr_rows: list[dict] = []
bank_rows: list[dict] = []
social_rows: list[dict] = []
entity_rows: list[dict] = []

_counters = {"cdr": 0, "ipdr": 0, "bank": 0, "social": 0}


def _next(kind: str, prefix: str) -> str:
    _counters[kind] += 1
    return f"{prefix}{_counters[kind]:05d}"


def ts(minutes: float) -> str:
    """Timestamp offset from BASE, ISO-8601 UTC."""
    return (BASE + timedelta(minutes=minutes)).isoformat()


# ── Subjects ──────────────────────────────────────────────────────────────
# Each subject carries identifiers across all four domains so that entity
# resolution has something real to reconcile.

SUBJECTS = {
    "E-101": dict(name="Subject A", msisdn="9999900101", imei="356938035643101",
                  imsi="404450123456101", account="ICIC0001100101", upi="subjecta@upi",
                  handle="@subject_a", ip="203.0.113.11", device="DEV-101"),
    "E-102": dict(name="Subject B", msisdn="9999900102", imei="356938035643102",
                  imsi="404450123456102", account="HDFC0002200102", upi="subjectb@upi",
                  handle="@subject_b", ip="203.0.113.12", device="DEV-102"),
    "E-103": dict(name="Subject C", msisdn="9999900103", imei="356938035643103",
                  imsi="404450123456103", account="SBIN0003300103", upi="subjectc@upi",
                  handle="@subject_c", ip="203.0.113.13", device="DEV-103"),
    "E-104": dict(name="Subject D", msisdn="9999900104", imei="356938035643104",
                  imsi="404450123456104", account="AXIS0004400104", upi="subjectd@upi",
                  handle="@subject_d", ip="203.0.113.14", device="DEV-104"),
    "E-105": dict(name="Subject E", msisdn="9999900105", imei="356938035643105",
                  imsi="404450123456105", account="PUNB0005500105", upi="subjecte@upi",
                  handle="@subject_e", ip="203.0.113.15", device="DEV-105"),
    "E-106": dict(name="Subject F", msisdn="9999900106", imei="356938035643106",
                  imsi="404450123456106", account="KKBK0006600106", upi="subjectf@upi",
                  handle="@subject_f", ip="203.0.113.16", device="DEV-106"),
}

CELL_SITES = [("CHD-0142", "1201"), ("CHD-0177", "1201"), ("CHD-0219", "1202"),
              ("MOH-0031", "1305"), ("PKL-0088", "1410")]


def add_call(case: str, a: str, b: str, minute: float, duration: int,
             call_type: str = "OUT", cell: tuple[str, str] | None = None,
             source: str = "cdr.csv") -> None:
    sa, sb = SUBJECTS[a], SUBJECTS[b]
    cell = cell or rng.choice(CELL_SITES)
    cdr_rows.append({
        "record_id": _next("cdr", "CDR-"), "case_id": case,
        "caller_msisdn": sa["msisdn"], "callee_msisdn": sb["msisdn"],
        "start_time": ts(minute), "duration_sec": duration, "call_type": call_type,
        "imei": sa["imei"], "imsi": sa["imsi"],
        "cell_id": cell[0], "lac": cell[1], "source_file": source,
    })


def add_session(case: str, a: str, minute: float, dur_min: int, up: int, down: int,
                dest_ip: str = "198.51.100.7", port: int = 443,
                access: str = "4G") -> None:
    s = SUBJECTS[a]
    ipdr_rows.append({
        "record_id": _next("ipdr", "IPDR-"), "case_id": case,
        "subscriber_msisdn": s["msisdn"], "private_ip": "10.14.7.22",
        "public_ip": s["ip"], "dest_ip": dest_ip, "dest_port": port,
        "start_time": ts(minute), "end_time": ts(minute + dur_min),
        "bytes_up": up, "bytes_down": down, "imei": s["imei"],
        "access_type": access, "source_file": "ipdr.csv",
    })


def add_txn(case: str, a: str, b: str, minute: float, amount: float,
            txn_type: str = "UPI", channel: str = "MOBILE") -> None:
    sa, sb = SUBJECTS[a], SUBJECTS[b]
    bank_rows.append({
        "txn_id": _next("bank", "TXN-"), "case_id": case,
        "payer_account": sa["account"], "payee_account": sb["account"],
        "payer_upi": sa["upi"], "payee_upi": sb["upi"],
        "amount_inr": f"{amount:.2f}", "txn_type": txn_type,
        "timestamp": ts(minute), "channel": channel,
        "ifsc": sb["account"][:4] + "0001234", "source_file": "bank.csv",
    })


def add_social(case: str, a: str, minute: float, activity: str,
               target: str | None = None, content: str = "") -> None:
    s = SUBJECTS[a]
    social_rows.append({
        "post_id": _next("social", "SOC-"), "case_id": case,
        "handle": s["handle"], "platform": "synthetic-social",
        "timestamp": ts(minute), "activity_type": activity,
        "target_handle": SUBJECTS[target]["handle"] if target else "",
        "content": content, "ip_address": s["ip"], "source_file": "social.csv",
    })


# ── CASE_001 — Normal behaviour (expected: no alert) ──────────────────────
# Routine, well-spaced activity across domains. No cross-domain clustering.
for day in range(3):
    d = day * 1440
    add_call("CASE_001", "E-101", "E-102", d + 30, rng.randint(40, 180))
    add_call("CASE_001", "E-102", "E-103", d + 190, rng.randint(30, 120))
    add_session("CASE_001", "E-101", d + 300, 12, rng.randint(4000, 9000), rng.randint(20000, 60000))
    add_txn("CASE_001", "E-101", "E-103", d + 620, rng.choice([250.0, 480.0, 1200.0]))
    add_social("CASE_001", "E-102", d + 900, "POST", content="Routine synthetic post")

# ── CASE_002 — Cross-domain anomaly (expected: ALERT) ─────────────────────
# CALL -> TRANSFER -> SOCIAL repeatedly inside a 30-minute window, and the
# subject has no comparable history. This is the CCC engine's target pattern.
for i in range(18):
    t = i * 240
    add_call("CASE_002", "E-104", "E-105", t, rng.randint(20, 55))
    add_txn("CASE_002", "E-104", "E-105", t + rng.randint(6, 14), rng.choice([49000.0, 48500.0, 50000.0]))
    add_social("CASE_002", "E-104", t + rng.randint(16, 28), "POST",
               content="Synthetic activity following transfer")
# Sparse unrelated baseline activity so the subject is not pattern-only.
for i in range(10):
    add_call("CASE_002", "E-104", "E-106", i * 610 + 95, rng.randint(60, 200))
# Data sessions bracketing each transfer — IPDR corroboration for the pattern.
for i in range(18):
    add_session("CASE_002", "E-104", i * 240 - 3, 6,
                rng.randint(1500, 4000), rng.randint(9000, 25000))

# ── CASE_003 — Repeated LEGITIMATE behaviour (expected: no alert) ─────────
# Same CALL -> TRANSFER -> SOCIAL shape, but it is this subject's long-running
# norm (daily payroll run), so a subject-specific baseline should absorb it.
for day in range(30):
    t = day * 1440 + 540
    add_call("CASE_003", "E-106", "E-101", t, rng.randint(30, 70))
    add_txn("CASE_003", "E-106", "E-101", t + rng.randint(5, 12), 15000.0, txn_type="NEFT")
    add_social("CASE_003", "E-106", t + rng.randint(14, 25), "POST",
               content="Daily reconciliation note")

# ── CASE_004 — Suspicious network structure (expected: ALERT) ─────────────
# E-105 is a low-volume bridge between two otherwise disconnected clusters.
CLUSTER_A = ["E-101", "E-102", "E-103"]
CLUSTER_B = ["E-104", "E-106"]
for i in range(24):
    a, b = rng.sample(CLUSTER_A, 2)
    add_call("CASE_004", a, b, i * 45, rng.randint(40, 240))
for i in range(18):
    a, b = rng.sample(CLUSTER_B, 2)
    add_call("CASE_004", a, b, i * 55 + 20, rng.randint(40, 240))
for i in range(4):  # the bridge: few calls, high structural importance
    add_call("CASE_004", "E-103", "E-105", i * 300 + 120, rng.randint(15, 40))
    add_call("CASE_004", "E-105", "E-104", i * 300 + 150, rng.randint(15, 40))
# Routine browsing for the cluster members, so IPDR is not pattern-only.
for i in range(20):
    add_session("CASE_004", rng.choice(CLUSTER_A + CLUSTER_B), i * 70 + 15,
                rng.randint(4, 25), rng.randint(2000, 12000), rng.randint(15000, 90000))

# Everyday sessions for the legitimate-behaviour control case.
for day in range(30):
    add_session("CASE_003", "E-106", day * 1440 + 545, 9,
                rng.randint(3000, 6000), rng.randint(18000, 40000))

# ── CASE_005 — Entity resolution (expected: identifier linkage) ───────────
# One person, five identifier types, observable only by shared IMEI/device/IP.
add_call("CASE_005", "E-101", "E-102", 10, 65)
cdr_rows.append({  # same IMEI, different SIM => same handset, new MSISDN
    "record_id": _next("cdr", "CDR-"), "case_id": "CASE_005",
    "caller_msisdn": "9999900901", "callee_msisdn": SUBJECTS["E-102"]["msisdn"],
    "start_time": ts(75), "duration_sec": 42, "call_type": "OUT",
    "imei": SUBJECTS["E-101"]["imei"], "imsi": "404450123456901",
    "cell_id": "CHD-0142", "lac": "1201", "source_file": "cdr.csv",
})
add_session("CASE_005", "E-101", 120, 8, 5200, 31000)
ipdr_rows.append({  # second MSISDN, same public IP and handset
    "record_id": _next("ipdr", "IPDR-"), "case_id": "CASE_005",
    "subscriber_msisdn": "9999900901", "private_ip": "10.14.7.31",
    "public_ip": SUBJECTS["E-101"]["ip"], "dest_ip": "198.51.100.7",
    "dest_port": 443, "start_time": ts(126), "end_time": ts(134),
    "bytes_up": 4100, "bytes_down": 28000, "imei": SUBJECTS["E-101"]["imei"],
    "access_type": "4G", "source_file": "ipdr.csv",
})
add_txn("CASE_005", "E-101", "E-103", 200, 7500.0)
add_social("CASE_005", "E-101", 240, "LOGIN")

# ── CASE_006 — Corrupted input (expected: QUARANTINE) ─────────────────────
# Malformed values in required fields. Must be quarantined, never dropped.
cdr_rows += [
    {"record_id": _next("cdr", "CDR-"), "case_id": "CASE_006", "caller_msisdn": "9999900101",
     "callee_msisdn": "9999900102", "start_time": "NOT_A_TIMESTAMP", "duration_sec": "60",
     "call_type": "OUT", "imei": "356938035643101", "imsi": "404450123456101",
     "cell_id": "CHD-0142", "lac": "1201", "source_file": "cdr.csv"},
    {"record_id": _next("cdr", "CDR-"), "case_id": "CASE_006", "caller_msisdn": "9999900101",
     "callee_msisdn": "9999900102", "start_time": ts(20), "duration_sec": "-45",
     "call_type": "OUT", "imei": "356938035643101", "imsi": "404450123456101",
     "cell_id": "CHD-0142", "lac": "1201", "source_file": "cdr.csv"},
    {"record_id": _next("cdr", "CDR-"), "case_id": "CASE_006", "caller_msisdn": "99999�0101",
     "callee_msisdn": "9999900102", "start_time": ts(35), "duration_sec": "30",
     "call_type": "OUT", "imei": "356938035643101", "imsi": "404450123456101",
     "cell_id": "CHD-0142", "lac": "1201", "source_file": "cdr.csv"},
]
bank_rows += [
    {"txn_id": _next("bank", "TXN-"), "case_id": "CASE_006", "payer_account": "ICIC0001100101",
     "payee_account": "HDFC0002200102", "payer_upi": "subjecta@upi", "payee_upi": "subjectb@upi",
     "amount_inr": "NOT_A_NUMBER", "txn_type": "UPI", "timestamp": ts(40),
     "channel": "MOBILE", "ifsc": "HDFC0001234", "source_file": "bank.csv"},
    {"txn_id": _next("bank", "TXN-"), "case_id": "CASE_006", "payer_account": "ICIC0001100101",
     "payee_account": "HDFC0002200102", "payer_upi": "subjecta@upi", "payee_upi": "subjectb@upi",
     "amount_inr": "-9000.00", "txn_type": "UPI", "timestamp": ts(45),
     "channel": "MOBILE", "ifsc": "HDFC0001234", "source_file": "bank.csv"},
]

# ── CASE_007 — Missing data (expected: QUARANTINE / partial) ──────────────
cdr_rows += [
    {"record_id": _next("cdr", "CDR-"), "case_id": "CASE_007", "caller_msisdn": "",
     "callee_msisdn": "9999900102", "start_time": ts(10), "duration_sec": "55",
     "call_type": "OUT", "imei": "", "imsi": "", "cell_id": "", "lac": "",
     "source_file": "cdr.csv"},
    {"record_id": _next("cdr", "CDR-"), "case_id": "CASE_007", "caller_msisdn": "9999900101",
     "callee_msisdn": "", "start_time": "", "duration_sec": "", "call_type": "OUT",
     "imei": "356938035643101", "imsi": "404450123456101", "cell_id": "CHD-0177",
     "lac": "1201", "source_file": "cdr.csv"},
]
ipdr_rows.append(
    {"record_id": _next("ipdr", "IPDR-"), "case_id": "CASE_007", "subscriber_msisdn": "",
     "private_ip": "10.14.7.40", "public_ip": "", "dest_ip": "198.51.100.9",
     "dest_port": 443, "start_time": ts(60), "end_time": "", "bytes_up": "",
     "bytes_down": "12000", "imei": "", "access_type": "4G", "source_file": "ipdr.csv"})
social_rows.append(
    {"post_id": _next("social", "SOC-"), "case_id": "CASE_007", "handle": "",
     "platform": "synthetic-social", "timestamp": ts(70), "activity_type": "POST",
     "target_handle": "", "content": "Orphaned record with no actor",
     "ip_address": "", "source_file": "social.csv"})

# ── Entity register ───────────────────────────────────────────────────────
for eid, s in SUBJECTS.items():
    for itype, val in (("PHONE", s["msisdn"]), ("IMEI", s["imei"]), ("IMSI", s["imsi"]),
                       ("BANK_ACCOUNT", s["account"]), ("UPI", s["upi"]),
                       ("SOCIAL_HANDLE", s["handle"]), ("IP", s["ip"]),
                       ("DEVICE", s["device"])):
        entity_rows.append({"entity_id": eid, "case_id": "ALL", "display_name": s["name"],
                            "identifier_type": itype, "identifier_value": val,
                            "confidence": "1.00", "source_file": "entities.csv"})
# The second SIM in CASE_005 is a claim to be *resolved*, not a given fact.
entity_rows.append({"entity_id": "E-101", "case_id": "CASE_005", "display_name": "Subject A",
                    "identifier_type": "PHONE", "identifier_value": "9999900901",
                    "confidence": "0.82", "source_file": "entities.csv"})

# ── Ground truth ──────────────────────────────────────────────────────────
GROUND_TRUTH = {
    "_meta": {
        "generator": "data/synthetic/generate_datasets.py",
        "seed": SEED,
        "warning": "Synthetic benchmark data only. Not real investigative material.",
        "note": "expected_* fields are the labels the System Validation page scores against.",
    },
    "CASE_001": {"scenario": "Normal behaviour", "expected_alert": False,
                 "expected_quarantine": 0, "expected_entity_links": [],
                 "rationale": "Routine, well-spaced activity; no cross-domain clustering."},
    "CASE_002": {"scenario": "Cross-domain anomaly", "expected_alert": True,
                 "expected_quarantine": 0, "expected_pattern": "CALL_TRANSFER_SOCIAL",
                 "expected_occurrences": 18, "expected_entity_links": [],
                 "rationale": "CALL->TRANSFER->SOCIAL repeats inside 30 min with no comparable history."},
    "CASE_003": {"scenario": "Repeated legitimate behaviour", "expected_alert": False,
                 "expected_quarantine": 0, "expected_pattern": "CALL_TRANSFER_SOCIAL",
                 "expected_occurrences": 30, "expected_entity_links": [],
                 "rationale": "Same shape as CASE_002 but it is the subject's 30-day norm; "
                              "a subject-specific baseline should absorb it. False-positive control."},
    "CASE_004": {"scenario": "Suspicious network structure", "expected_alert": True,
                 "expected_quarantine": 0, "expected_bridge_entity": "E-105",
                 "expected_entity_links": [],
                 "rationale": "E-105 bridges two otherwise disconnected clusters on low call volume."},
    "CASE_005": {"scenario": "Entity resolution", "expected_alert": False,
                 "expected_quarantine": 0,
                 "expected_entity_links": [["9999900101", "9999900901", "shared IMEI + public IP"]],
                 "rationale": "Two MSISDNs share one handset and public IP; should resolve to E-101."},
    "CASE_006": {"scenario": "Corrupted input", "expected_alert": False,
                 "expected_quarantine": 5, "expected_entity_links": [],
                 "rationale": "Unparseable timestamp, negative duration, replacement char, "
                              "non-numeric and negative amounts. Quarantine, never drop."},
    "CASE_007": {"scenario": "Missing data", "expected_alert": False,
                 "expected_quarantine": 4, "expected_entity_links": [],
                 "rationale": "Absent actor / timestamp / amount fields across three domains."},
}


def write_csv(name: str, rows: list[dict]) -> None:
    path = OUT / name
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"  {name:16} {len(rows):5d} rows")


if __name__ == "__main__":
    print("Writing synthetic multi-domain datasets:")
    write_csv("cdr.csv", cdr_rows)
    write_csv("ipdr.csv", ipdr_rows)
    write_csv("bank.csv", bank_rows)
    write_csv("social.csv", social_rows)
    write_csv("entities.csv", entity_rows)
    (OUT / "ground_truth.json").write_text(
        json.dumps(GROUND_TRUTH, indent=2) + "\n", encoding="utf-8")
    print(f"  ground_truth.json  {len(GROUND_TRUTH) - 1} labelled cases")
