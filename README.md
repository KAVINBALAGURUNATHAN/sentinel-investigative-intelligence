# SENTINEL — Investigative Intelligence Platform

Decision-support software for multi-source investigative analysis: call records,
internet session records, banking transactions and social activity, correlated
into one timeline, one entity graph and one statistically-tested set of leads.

**Every finding is produced by a deterministic statistical method.** Detection,
scoring and decisions are permutation testing, empirical p-values,
Benjamini-Hochberg false-discovery control and a per-subject activity baseline —
no machine-learned model, no black box, nothing that cannot be re-derived by
hand from the stored records. Seeded throughout: identical input reproduces an
identical p-value, which is a requirement for evidence rather than a
convenience.

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

## What was built here

The multi-source investigative platform is the work in this repository:

| Built here | Where |
|---|---|
| Unified event store and schema | `backend/app/services/event_store.py` |
| Four domain normalizers (CDR / IPDR / banking / social) | `backend/app/services/normalizers.py` |
| Deterministic entity resolution | `backend/app/services/entity_resolution.py` |
| CCC statistical engine — permutation test, lift, empirical p-value | `backend/app/analytics/ccc_engine.py` |
| Benjamini-Hochberg FDR correction, written from the definition | `backend/app/analytics/fdr.py` |
| Per-subject activity baseline and established-routine guard | `backend/app/analytics/baseline.py` |
| Structural bridge detection over NetworkX | `backend/app/analytics/network_metrics.py` |
| Two-layer Neo4j projection and its event-store fallback | `backend/app/services/graph_projection.py` |
| Timeline, evidence and provenance API | `backend/app/api/multidomain.py` |
| Investigator interface (React + D3) | `frontend/src/investigator/` |

### Prior work this builds on

The repository started from
[MADHANSA147/sentinel](https://github.com/MADHANSA147/sentinel), a hackathon MVP
for child-protection forensics over messaging data. Four things from that
codebase remain in use and are credited accordingly: the 12-node LangGraph agent
pipeline (`backend/app/agents/`), the SHA-256 chained execution ledger
(`backend/app/services/ledger.py`), the court-pack PDF export, and the
quarantine-not-drop ingestion discipline. That messaging pipeline is preserved
and still runs, kept deliberately separate from the multi-domain path.

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
cd backend && pytest -q          # 271 passed, 4 skipped
```

The suite mocks Neo4j (`tests/conftest.py`), so it runs fully offline.

---

## The two stores

Not redundancy — each answers the question the other answers badly.

| Question | Answered by | Why not the other |
|---|---|---|
| How many transfers over ₹50,000 in March? | **SQLite** | Cypher aggregation over 100k rows is slow and awkward |
| Which subjects link these two networks? | **Neo4j** | Recursive SQL for variable-depth paths is unmaintainable |
| Every event for this subject, in order | **SQLite** | The timeline is an indexed row scan, not a traversal |
| What file and row did this event come from? | **SQLite** | Provenance is a column on the row, not an edge |

**Neo4j holds a projection, never the source.** Everything it contains is
derived from the event store, so it can be rebuilt at any time. When the graph
database is unreachable the network view is reconstructed from SQLite using the
same functions that generate the projection writes — the graph cannot drift from
what would have been projected — and the response is labelled `EVENT_STORE` with
a visible banner. An outage costs navigation, never evidence.

### The graph model has two layers, kept apart

| Layer | Edges | Meaning |
|---|---|---|
| Ownership | `OWNS`, `USES`, `IDENTIFIES` | A **conclusion** of entity resolution. Dashed. Carries confidence and basis. |
| Activity | `CALLED`, `TRANSFERRED`, `CONNECTED_FROM`, … | An **observation** from source records. Solid. Aggregated with counts. |

A call between two handsets is a fact from the CDR. "These two people spoke" is
a conclusion that depends on the resolution being correct. Collapsing both into
one edge type would let an inference be presented with the authority of an
observation; in court that difference is the case. The relationship API labels
every edge `RESOLUTION` or `OBSERVATION` accordingly.

---

## Timeline construction

One chronology across all four sources, because they are one table:

```sql
SELECT * FROM events
 WHERE case_id = ?              -- scoped to one investigation
   AND quarantined = 0          -- invalid rows never reach analysis
   AND (event_type IN ?)        -- optional type filter
   AND (actor_entity = ? OR target_entity = ?)
   AND timestamp BETWEEN ? AND ?
 ORDER BY timestamp
```

**The pattern window must not shrink the timeline.** The CCC engine tests
sequences inside a 30-minute window; that window belongs to the test, not to the
chronology. If the timeline filtered by it, an investigator would see only
events that fell inside a detected pattern and would have no way to know what
else happened that day — the chronology would silently become a summary of the
findings. The full event list is always loaded; filters narrow the view, never
the query behind it.

Every row carries its `event_id`, which resolves through the evidence API to the
batch, the source file, the row number within it, and the SHA-256 of the bytes
the file arrived as.

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

Nothing in this path is learned, fitted or inferred by a model. The whole
computation is arithmetic over the subject's own stored events, seeded so it
reproduces exactly — enforced by a test that fails if `backend/app/analytics/`
ever imports a model client.

### Exculpatory context

A finding must survive its own counter-argument. The benchmark contains two
cases with the *same* pattern shape:

| Case | Pattern | Observed | Lift | q | Decision |
|---|---|---|---|---|---|
| CASE_002 | `CALL → TRANSFER → SOCIAL` | 18 | 15.7× | 0.000999 | **REVIEW** |
| CASE_003 | `CALL → TRANSFER → SOCIAL` | 30 | **18.4×** | 0.000999 | **NO_ACTION** |

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
- **Entity resolution is deterministic**, based on shared identifiers. It has no
  probabilistic matching and will miss links that require fuzzy inference. This
  is a deliberate trade: a resolution an investigator cannot re-derive by hand
  is one that cannot be defended.
- **The graph database is optional and currently paused.** The network view is
  served from the event store and labelled as such. The live-projection path is
  covered by code and idempotency tests rather than against a running instance.
- **Dense graphs hide some edge labels.** To guarantee no label overlaps a node
  or another label, labels are dropped by edge weight once the layout settles —
  about 36% of them on the densest synthetic case. Every edge still shows its
  count on hover and click.
- **CDR `call_type` carries two vocabularies** (modality and direction) across
  operators. Both are read; an unrecognised code quarantines the row rather than
  being guessed into an event type.

---

## Further reading

| Document | Covers |
|---|---|
| [backend/README.md](backend/README.md) | Service layout, data invariants, endpoints, environment |
| [frontend/README.md](frontend/README.md) | Interface structure and its display obligations |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Historical audit of the inherited codebase — superseded |

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
