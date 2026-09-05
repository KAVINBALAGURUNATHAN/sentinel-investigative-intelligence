# SENTINEL — Investigative Intelligence Platform

Decision-support software for multi-source investigative analysis: call records,
internet session records, banking transactions and social activity, correlated
into one timeline, one entity graph and one statistically-tested set of leads.

**Synthetic data only.** Every dataset in this repository is generated. No real
personal data is present, and none may be added.

---

## What this is, and what it is not

This is **decision-support** software. It surfaces patterns for a human
investigator to examine. It does not determine guilt and does not make
accusations.

The interface and API use the language of evidence, not verdicts:

- "potentially suspicious", "anomalous", "requires investigation"
- "pattern detected", "evidence indicates"

Words such as "criminal", "guilty" or "offender" appear nowhere in the output.
Statistical significance is reported as what it is — a measurement against a
stated null model — never as proof of wrongdoing. Every finding is required to
carry its own counter-argument (see *Exculpatory context* below).

---

## Origin and attribution

This project began as a fork of
[MADHANSA147/sentinel](https://github.com/MADHANSA147/sentinel), a hackathon MVP
for child-protection digital forensics over messaging data. That codebase
contributed the LangGraph agent pipeline, the SHA-256 execution ledger, the
court-pack PDF export and the quarantine-not-drop ingestion discipline, all of
which remain here.

The multi-domain work (CDR / IPDR / banking / social), the unified event store,
entity resolution, the CCC statistical engine, the Neo4j projection and the
investigator interface were built on top of it. The original messaging pipeline
is preserved and still runs.

---

## Architecture

```
CDR · IPDR · Bank · Social  (CSV)
            ↓
    Ingestion  — SHA-256 of raw bytes taken BEFORE parsing
            ↓
    Normalization — every source becomes a UnifiedEvent
            ↓
    Event store (SQLite) — valid AND quarantined records
            ↓
    Entity resolution — phone / account / device / handle → Person
            ↓
    ┌───────────────┴───────────────┐
    ↓                               ↓
Neo4j graph                    Analytics
(relationships)                 · timeline
    ↓                           · CCC engine: permutation test, lift,
NetworkX metrics                  empirical p-value, Benjamini-Hochberg FDR
(betweenness, PageRank)         · personal baseline
    └───────────────┬───────────────┘
                    ↓
      FastAPI  →  React + D3 investigator UI
```

**Division of responsibility, kept deliberate:**

| Component | Role |
|---|---|
| SQLite | The event record of truth — rows, filters, timelines, evidence |
| Neo4j | Relationships between resolved entities |
| NetworkX | Graph metrics over those relationships |
| NumPy / stdlib | Deterministic statistics — no LLM touches a p-value |
| D3 | Visualisation |

### Why SQLite, not PostgreSQL

Considered and deliberately dropped. There is no server to run, no credentials
and no container; the workload is one writer and many readers; volume is
thousands of rows per case. All access goes through
`backend/app/services/event_store.py` in plain SQL, so a migration later is
contained to one module. MySQL was never a candidate.

---

## Running it

### Backend

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate          # Windows;  source .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
cp .env.example .env            # fill in Neo4j and Groq values
uvicorn app.main:app --reload
```

Neo4j and Groq are **optional**. Without them the event store, timeline,
entity resolution, CCC statistics and validation all work; only the
relationship graph and the LLM narrative degrade, and they say so rather than
returning fabricated results.

On Windows, if Neo4j Aura fails to connect, the Python trust store may lack the
SSL.com root Aura chains to. Point TLS at certifi in `.env`:

```
SSL_CERT_FILE=<path>/.venv/lib/site-packages/certifi/cacert.pem
```

### Frontend

```bash
cd frontend
npm install
npm run dev            # http://localhost:5173
```

### Load the synthetic data

```bash
python data/synthetic/generate_datasets.py     # regenerate (deterministic)

curl -X POST localhost:8000/api/v1/ingest/entities/register -F file=@data/synthetic/entities.csv
for s in cdr ipdr bank social; do
  curl -X POST localhost:8000/api/v1/ingest/$s -F file=@data/synthetic/$s.csv
done
```

### Tests

```bash
cd backend && pytest -q          # 151 passed, 2 skipped
```

The suite mocks Neo4j (`tests/conftest.py`), so it runs fully offline.

---

## The CCC engine

The question it answers is not "is ₹5 lakh a lot?" but **"does this person
normally do this?"**

1. Detect an ordered pattern (e.g. `CALL → TRANSFER → SOCIAL`) within a window.
2. Build a subject-specific baseline from that person's own history.
3. Permute the subject's own event labels to build a null distribution — the
   permutation preserves their real activity rhythm, so the comparison is
   against themselves, not against a population average.
4. Compute lift, an empirical p-value, then Benjamini-Hochberg FDR correction
   across every pattern and subject tested.
5. Apply the exculpatory guard before deciding.

No LLM is involved in any of this. The numbers are reproducible.

### Exculpatory context

A finding must survive its own counter-argument. The benchmark contains two
cases with the *same* pattern shape:

| Case | Pattern | Lift | Decision |
|---|---|---|---|
| CASE_002 | `CALL → TRANSFER → SOCIAL` | 17.1× | **REVIEW** |
| CASE_003 | `CALL → TRANSFER → SOCIAL` | **18.3×** | **NO_ACTION** |

CASE_003 has the *higher* lift and produces *no alert*, because the behaviour is
that subject's established 30-day routine. Statistical extremity alone is not a
lead. This is the false-positive control, and it is the property that matters
most for real use.

---

## Validation

`GET /api/v1/validation/benchmark` scores the engine against
`data/synthetic/ground_truth.json` — seven labelled scenarios covering normal
behaviour, cross-domain anomaly, repeated legitimate behaviour, suspicious
network structure, entity resolution, corrupted input and missing data.

Current result: **7/7 pass, precision 1.00, recall 1.00.**

These are **synthetic benchmark results on labelled data**. They are not an
estimate of real-world accuracy and must never be presented as one.

---

## Evidence and privacy

- The raw upload is SHA-256 hashed **before** parsing; every event points at its
  batch, so any record traces back to the exact bytes received.
- Invalid records are **quarantined, never dropped** — a discarded row is an
  unanswerable question later. They are stored and excluded from statistics.
- Identifiers are **masked by default** in every API response
  (`+91 ******3210`). Unmasking is an authorisation decision, and this prototype
  has no authentication, so no unmasked path is exposed.
- Ownership edges in the graph (`OWNS` / `USES`) are drawn dashed and carry a
  confidence, because they are *conclusions* from entity resolution. Activity
  edges (`CALLED`, `TRANSFERRED`) are solid, because they are *observations*
  from source records. The distinction matters evidentially and the UI keeps it.

---

## Known limitations

Stated plainly, because a tool used in investigations should not overstate
itself:

- **No authentication or role-based access.** Anyone who can reach the API can
  read every case. This must be built before any non-synthetic use.
- **Risk-score weights are illustrative**, hand-set for demonstration and not
  empirically calibrated.
- **The exculpatory guard is a heuristic** (established-routine detection), not
  a proof of innocence.
- **Report export is not wired to the multi-domain store.** The court-pack PDF
  reads the original messaging schema; the Reports page says so rather than
  producing a misleading document.
- **Entity resolution is deterministic**, based on shared identifiers. It has no
  probabilistic matching and will miss links that require fuzzy inference.

---

## Repository layout

```
backend/
  app/
    analytics/     CCC engine, permutation test, FDR, network metrics
    api/           FastAPI routes (multidomain.py is the investigation API)
    models/        UnifiedEvent and the original message model
    services/      event store, normalizers, entity resolution, Neo4j projection
    agents/        original LangGraph messaging pipeline (preserved)
  tests/           151 tests, offline
frontend/
  src/investigator/  the investigator workspace (App, pages, graph, theme)
  src/App.jsx        original messaging dashboard (preserved)
data/synthetic/      generated datasets + ground truth
ARCHITECTURE.md      component inventory and build status
```
