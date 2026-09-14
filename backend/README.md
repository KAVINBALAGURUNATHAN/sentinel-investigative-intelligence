# SENTINEL — Backend

FastAPI service over a SQLite event store, with a Neo4j projection for
relationship navigation and a deterministic statistics engine.

**No model is involved in producing a finding.** Detection, scoring and
decisions are permutation testing, empirical p-values, Benjamini–Hochberg
correction and a per-subject activity baseline. `app/analytics/` is arithmetic
over stored events and nothing else — a test fails if it ever imports a model
client.

---

## Running it

```bash
python -m venv .venv
.venv/Scripts/activate                  # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements.txt
cp .env.example .env                    # optional: Neo4j, Groq
python -m uvicorn app.main:app --port 8000
```

`http://127.0.0.1:8000/docs` for the generated OpenAPI browser.

**Every external service is optional.** Without Neo4j the network view is rebuilt
from the event store and says so; without Groq the case summary is assembled
deterministically and says so. Nothing silently degrades — a reduced capability
always reports itself.

### Load the synthetic data

```bash
cd .. && python ingest_all.py
```

Seven labelled cases, each built to prove a different behaviour (see
`data/synthetic/ground_truth.json`).

### Tests

```bash
pytest -q          # 271 passed, 4 skipped
```

`tests/conftest.py` mocks Neo4j and ChromaDB, so the suite runs fully offline.

---

## Layout

```
app/
├── main.py                    FastAPI app, CORS, logging, .env
├── config.py                  Display policy (identifier masking)
├── models/
│   ├── event.py               UnifiedEvent, identifier types, masking
│   └── raw_message.py         Legacy messaging model
├── services/
│   ├── event_store.py         SQLite: schema, ingestion, queries, alerts
│   ├── normalizers.py         CDR / IPDR / bank / social → UnifiedEvent
│   ├── entity_resolution.py   Identifier → Person, declared and inferred
│   ├── graph_projection.py    Neo4j write/read + event-store fallback
│   ├── graph_db.py            Neo4j driver, case-scoped, circuit breaker
│   ├── case_report.py         Investigation report and court pack (PDF)
│   ├── case_narrative.py      Case summary: brief, verification, fallback
│   ├── llm.py                 Groq client — narrative prose only
│   └── ledger.py              SHA-256 chained execution log
├── analytics/                 NO MODEL CODE. Asserted by test.
│   ├── ccc_engine.py          Pattern detection and the decision ladder
│   ├── permutation_test.py    Null model, sequence counting, p-value
│   ├── fdr.py                 Benjamini–Hochberg, from the definition
│   ├── baseline.py            Per-subject routine assessment
│   ├── network_metrics.py     PageRank, betweenness, structural bridges
│   └── entity_risk.py         Attention score — a ranking aid, not a verdict
├── api/
│   ├── multidomain.py         The multi-source platform (most routes)
│   ├── ingestion.py           Legacy messaging ingest
│   ├── pipeline.py            Legacy agent pipeline runner
│   ├── dashboard.py           Legacy dashboard
│   ├── hitl.py                Analyst feedback
│   └── export.py              Court pack / audit bundle
└── agents/                    12 LangGraph nodes (legacy messaging pipeline)
```

---

## The two pipelines are kept apart

| | Multi-domain | Legacy messaging |
|---|---|---|
| Endpoint | `POST /api/v1/ingest/{source}` | `POST /api/v1/ingest` |
| Input | CSV — cdr, ipdr, bank, social | JSON array of messages |
| Writes to | **SQLite event store** | Neo4j only |
| Visible to | Timeline, CCC, graph, evidence | Dashboard, ledger |

This matters enough to be enforced, not just documented. Sending CDR to the
legacy endpoint would hash it, count it, load a message-shaped graph and leave
it absent from every analytical view — silently. The legacy endpoint therefore
refuses multi-domain files by extension, filename and header row, and names the
endpoint that should have been used.

---

## Data invariants

These hold everywhere and the tests exist to keep them holding.

| Invariant | Why |
|---|---|
| Row in = event out | Ingestion figures reconcile; nothing vanishes between stages |
| Quarantine, never drop | A discarded record is an unanswerable question later |
| `quarantined = 0` on analysis | Invalid rows never reach a statistic, but stay in the audit bundle |
| Hash before parse | The digest covers the bytes as received, not as interpreted |
| Identity is `(case_id, event_id)` | Re-uploading a file cannot duplicate evidence and inflate a count |
| Case-scoped reads and writes | Including graph clears — one investigation never touches another |
| Seeded statistics | Identical input reproduces an identical p-value |

---

## Key endpoints

```
POST /api/v1/ingest/{source}          cdr | ipdr | bank | social
POST /api/v1/ingest/entities/register declared entity register
GET  /api/v1/cases                    case list with usable / quarantined counts
GET  /api/v1/cases/{id}/timeline      chronological events, filterable
GET  /api/v1/cases/{id}/patterns      CCC engine: permutation test + FDR
GET  /api/v1/cases/{id}/graph         network graph (Neo4j, or rebuilt)
POST /api/v1/cases/{id}/graph/build   project to Neo4j; idempotent
GET  /api/v1/cases/{id}/network/metrics   PageRank, betweenness, bridges
GET  /api/v1/cases/{id}/entities      resolved entities and their identifiers
GET  /api/v1/cases/{id}/summary       case narrative + the brief behind it
GET  /api/v1/evidence/{event_id}      one record with its full provenance
GET  /api/v1/cases/{id}/report        investigation report (PDF)
GET  /api/v1/validation/benchmark     score against labelled ground truth
```

Full list at `/docs`.

---

## Environment

| Variable | Required | Effect if absent |
|---|---|---|
| `SENTINEL_DB_PATH` | no | Defaults to `backend/sentinel_events.db` |
| `SENTINEL_DATA_MODE` | no | Fails safe to `SENSITIVE` — identifiers masked |
| `SENTINEL_LOG_LEVEL` | no | `INFO` |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | no | Graph rebuilt from the event store, labelled `EVENT_STORE` |
| `GROQ_API_KEY` / `GROQ_MODEL` | no | Case summary assembled deterministically, labelled `TEMPLATE` |

---

## Where the language model is, and is not

One narrow use, fenced on both sides.

- **It writes prose only**, over figures the statistics engine has already
  computed. It queries nothing, scores nothing, decides nothing.
- **Its output is verified before display.** Every number and every subject
  identifier in the generated text must appear in the brief it was given, and no
  sentence may assert criminality. Text that fails is discarded — not repaired —
  and a deterministic summary replaces it.
- **The response always says which path ran.** `LIVE` means model-generated and
  verified; `TEMPLATE` means assembled deterministically, with the reason given.

A language model cannot be held to an evidential standard: it cannot show its
working, it is not reproducible across versions, and it will produce a confident
number when it has none. So it is kept out of the analytical path entirely.
