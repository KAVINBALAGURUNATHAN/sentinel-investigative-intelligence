# SENTINEL — Architecture Summary

**Purpose of this document:** a factual map of the codebase as it exists today, written before any
changes, to support a decision about reusing it as the base for a Chandigarh Police investigative
intelligence platform (CDR / IPDR / banking / social).

Nothing in this document is a proposal. Findings only. Every claim below was read from source.

Inspected at commit `d043bc9`, 2026-09-05.

---

## 1. Stack

| Layer | Technology | Where |
|---|---|---|
| Frontend | React 19 + Vite 8, **plain JS (no TypeScript)** | `frontend/src/` |
| Visualization | D3.js v7, force-directed, hand-written | `App.jsx` → `LiveCaseMap` |
| Styling | Single hand-authored CSS file, CSS custom properties, no framework | `frontend/src/index.css` |
| Backend | FastAPI + Uvicorn | `backend/app/` |
| Agent runtime | **LangGraph** `StateGraph`, 12 sequential nodes | `app/agents/orchestrator.py` |
| Graph store | **Neo4j** (AuraDB Free), driver only — no GDS | `app/services/graph_db.py` |
| Graph analytics | **NetworkX** (PageRank, betweenness) | `module_06_network.py` |
| Vector store | **ChromaDB** + `sentence-transformers` | `module_05_words.py` only |
| LLM | Groq via OpenAI-compatible SDK | `module_10_simulation.py` only |
| PDF | ReportLab | `app/services/pdf_export.py` |
| Tests | pytest, 4 files | `backend/tests/` |

**There is no relational database.** No Postgres, no SQLite, no ORM. Neo4j is the only persistent
store; ChromaDB is ephemeral. This matters: CDR/IPDR/bank records are fundamentally tabular and
high-volume, and there is currently nowhere appropriate to put them.

**There is no authentication.** No login, no sessions, no users, no roles, no access control
anywhere in the codebase. `case_id` is a URL string with no authorization check — any caller can
read any case.

---

## 2. Backend structure

```
backend/app/
├── main.py                  81 loc   FastAPI app, CORS, load_dotenv(override=True)
├── models/raw_message.py   118 loc   Pydantic RawMessage + quarantine flags
├── api/
│   ├── ingestion.py        113 loc   POST /api/v1/ingest   (multipart file)
│   ├── pipeline.py         222 loc   POST /api/v1/run/{case_id}
│   ├── dashboard.py        167 loc   GET  /api/v1/dashboard/{case_id}
│   ├── hitl.py              53 loc   POST /api/v1/hitl/{case_id}  (analyst feedback)
│   └── export.py           100 loc   GET  court-pack PDF / audit-bundle JSON
├── services/
│   ├── graph_db.py         234 loc   Neo4j driver, case-scoped queries, circuit breaker
│   ├── ledger.py            87 loc   SHA-256 chained execution log
│   └── pdf_export.py       216 loc   ReportLab court pack
└── agents/                          12 LangGraph nodes + orchestrator
```

### Existing endpoints (complete list — verified against `/openapi.json`)

```
GET  /health
POST /api/v1/ingest
POST /api/v1/run/{case_id}
GET  /api/v1/dashboard/{case_id}
GET  /api/v1/ledger/{case_id}
POST /api/v1/hitl/{case_id}
GET  /api/v1/hitl/{case_id}/appeals
GET  /api/v1/export/court-pack/{case_id}
GET  /api/v1/export/audit-bundle/{case_id}
```

Nine endpoints. All are real and connected to data — none are stubs.

### The agent pipeline

`orchestrator.py` wires 12 nodes in fixed dependency order, each mutating one shared `state` dict.
Every node is wrapped by `_ledger_wrapped()`, which writes a SHA-256-chained ledger entry per step.

```
identity_fusion → timeline_engine → behavioral_print → network_mapping
→ subject_profiling → role_discovery → word_patterns → gap_detector
→ exculpatory_context → risk_score_engine → case_simulation → feedback_loop
```

| Module | Does | Depends on |
|---|---|---|
| 02 identity | Merges sender/receiver IDs into Person nodes | Neo4j |
| 08 timeline | Orders events, computes inter-event deltas | — |
| 04 baseline | Per-pair active-hours profile | — |
| 06 network | PageRank + betweenness | NetworkX |
| 03 profiling | Per-person aggregates | — |
| 07 roles | Role tags (Orchestrator/Bridge/…) from centrality | 06 |
| 05 words | Semantic search for coercive language | **ChromaDB + embeddings** |
| 09 gap | Flags silence inside normally-active hours | 04, 08 |
| 11 context | Suppresses gap alerts with innocent explanations | **embeddings**, LLM |
| 12 risk | Log-odds weight-of-evidence score → 0–100 | 05,06,07,09,11 |
| 10 simulation | LLM writes 2 competing theories | **Groq** |
| 13 feedback | Applies analyst approve/reject to weights | 12 |

---

## 3. Findings that matter for the police platform

### 3.1 `RawMessage` is the single chokepoint

Every downstream module reads the same shape (`app/models/raw_message.py`):

```python
message_id, timestamp, sender_id, receiver_id, content, platform, metadata, flags
```

This is **the** structural fact of the codebase. It is a *messaging* model: two parties, a
timestamp, and a text body. It is not WhatsApp-specific in its field names — `platform` is already
a free string — but it assumes:

- exactly **two** participants per record (`sender_id` → `receiver_id`)
- a **text `content`** field carrying the analytic payload
- **one** record type, so no notion of event kind

Mapping the four target domains onto it:

| Domain | Fits? | Problem |
|---|---|---|
| CDR (calls) | Mostly | Caller→callee maps cleanly. **Duration, cell tower/LAC-CID, IMEI/IMSI have nowhere to go.** No `content`. |
| IPDR | Poorly | Actor is subscriber→**service/IP**, not person→person. Needs bytes up/down, port, session start/end. |
| Banking | Poorly | Payer→payee maps, but **amount is the entire analytic signal** and there is no numeric field. |
| Social | Partly | Posts have **one** actor, not two. `receiver_id` would be null for most records. |

**Consequence:** `RawMessage` needs to become a typed event model (`event_type` + per-type payload)
before any domain work begins. This is the highest-leverage change in the migration, and almost
everything else depends on it.

### 3.2 What is genuinely WhatsApp-specific

Less than expected. The coupling is concentrated:

| Location | Coupling | Severity |
|---|---|---|
| `module_05_words.py` | Grooming/coercive-language phrase semantics | **High** — meaningless for CDR/bank |
| `module_11_context.py` | Reads message text to find innocent explanations | **High** — no text in CDR/bank |
| `module_12_risk.py` | Indicator weights hand-set for grooming (NCMEC taxonomy) | **High** — wrong indicator set |
| `pdf_export.py` | Exhibits are message excerpts; cites BSA 2023 s.63 | Medium — structure reusable, content not |
| `ingestion.py` | Hardcoded map of synthetic filenames → case_id | Medium — trivially replaced |
| `module_09_gap.py` | "Silence" = absence of messages | Medium — concept generalizes well to calls |
| `raw_message.py` | Two-party text message | **Structural** — see 3.1 |

### 3.3 What is reusable as-is (the real value of this repo)

These are domain-agnostic and are the reason to keep the codebase rather than start fresh:

- **`services/ledger.py`** — SHA-256 chained audit log. Directly satisfies your evidence-traceability
  and audit requirements. No changes needed.
- **`services/graph_db.py`** — case-scoped Cypher, connection circuit breaker, batch loading. Solid.
- **`agents/orchestrator.py`** — the LangGraph pattern (typed state dict + per-node ledger wrapper)
  is exactly the right shape for a longer pipeline. Add nodes, don't rewrite.
- **`module_06_network.py`** — PageRank/betweenness on NetworkX. Domain-neutral: works on any graph,
  including a mixed phone/account/device graph.
- **`module_08_timeline.py`**, **`module_04_baseline.py`** — event ordering and per-subject
  active-hours baselines. **`module_04` is the natural foundation for the CCC engine's
  subject-specific baseline** — that requirement is partially built already.
- **Ingestion quarantine model** — validate per record, never drop, always quarantine, hash the
  source file first. This is the correct evidential design and matches your Data Ingestion page.
- **`module_11`'s "exculpatory context" concept** — the mechanism is text-specific, but the
  *idea* is precisely your "WHY IT MAY NOT BE SUSPICIOUS" panel. Reuse the concept and the
  suppress-but-retain-in-audit-trail behavior.
- **`hitl.py`** — analyst approve/reject feedback loop.

### 3.4 Gaps against your specification

Present in the spec, **absent** from the codebase:

- No relational/tabular store for high-volume CDR/IPDR/bank rows
- No entity-resolution across identifier types (phone ↔ IMEI ↔ account ↔ handle).
  `module_02` merges IDs by exact string match only.
- **No CCC engine.** No permutation testing, no p-value, no lift, no Benjamini-Hochberg FDR
  anywhere in the codebase. `backend/analytics/` does not exist. This is net-new work.
- No cross-domain pattern detection (the CALL→TRANSFER→SOCIAL sequence concept)
- No authentication, roles, or case-based access control
- No data masking
- No routing in the frontend — see §4
- No system-validation/benchmark page; ground truth exists only inside pytest files
- Synthetic data is **4 WhatsApp JSON files**; no CSV, no `cdr.csv`/`ipdr.csv`/`bank.csv`/
  `social.csv`/`entities.csv`/`ground_truth.json`

### 3.5 Currently degraded at runtime (measured, not theoretical)

- **`module_10_simulation`** falls back to canned theories. Verified cause: the response hits
  `max_tokens=512` with `finish_reason=length` and the JSON truncates mid-object. GPT-OSS is a
  reasoning model, so thinking tokens consume the same budget.
- **`module_11_context`** is disabled entirely by `ENABLE_SEMANTIC_EMBEDDINGS=false`; it logs
  `[WARN] Exculpatory context unavailable` and returns without doing work.
- **`module_05_words`** depends on the same embeddings and is therefore also inert.

So **3 of 12 agents currently do no real work** in the default configuration.

---

## 4. Frontend structure

```
frontend/src/
├── main.jsx      10 loc   mount only
├── App.jsx      ~700 loc  ENTIRE APPLICATION
└── index.css    ~200 loc  entire design system
```

**The whole frontend is one file.** `App.jsx` contains, in order: helpers, an icon set, the case
list, `StatsStrip`, `PersonCard`, `PriorityBoard`, `AlertList`, `LiveCaseMap` (~190 loc of D3),
`TheoriesPanel`, and `App`.

Critical structural facts for your redesign:

- **No router.** No `react-router`, no routes. Navigation is `useState` between two sidebar tabs
  (Priority / Alerts). Your specification requires **12 sidebar destinations** plus tabbed case
  pages — this is the largest single frontend gap.
- **No component directory, no design tokens file, no TypeScript.**
- **No state management** beyond `useState`, and no data-fetching layer — `fetch` is called inline.
- **No loading skeletons, no error boundaries.** There is a spinner overlay and empty states.
- **Light theme only.** Your spec requires a dark professional interface; the palette is defined as
  CSS custom properties on `:root`, so a dark theme is a token swap plus a D3 color pass, not a
  rewrite.
- The D3 graph renders **one node type** (Person) and one edge type (MESSAGED, with a GAP badge).
  Your spec needs 7 node types and 6 edge types with visual differentiation.

**Reusable:** the D3 force-simulation scaffolding (zoom, drag, tooltip, fit-to-viewport, collision),
the CSS custom-property token system, the icon set, and the risk-color scale.

---

## 5. Data flow (as built)

```
JSON file → POST /ingest → SHA-256 hash of raw bytes → per-record Pydantic validation
   → quarantine invalid (never dropped) → batch_load_graph() → Neo4j Person/MESSAGED
   → POST /run/{case_id} → LangGraph 12 nodes, each writing a chained ledger entry
   → GET /dashboard/{case_id} → React renders
   → GET /export/court-pack → ReportLab PDF (score-free exhibits only)
```

This flow is sound and is worth preserving. Your target pipeline (ingest → validate → normalize →
entity resolution → unified event store → graph → timeline → pattern → baseline → CCC → FDR →
exculpatory → risk → ledger → dashboard → PDF) is **the same spine with more stations**.

Missing stations: normalize, entity resolution, unified event store, cross-domain patterns, CCC/FDR.

---

## 6. Assessment

**Reuse the repository.** The evidential architecture — hash-on-ingest, quarantine-don't-drop,
chained ledger, score-free court pack, per-step audit, suppress-but-retain — is the hard,
unglamorous part of an investigative platform, and it is already built and tested. Rebuilding that
from scratch would be the larger mistake.

The work divides cleanly:

| Effort | Work |
|---|---|
| **Keep unchanged** | ledger, graph_db, orchestrator pattern, network metrics, quarantine model, HITL |
| **Generalize** | `RawMessage` → typed event model (§3.1); ingestion; risk indicators |
| **Build new** | CCC engine (`backend/analytics/`), entity resolution, cross-domain patterns, tabular store, auth |
| **Rebuild** | Frontend shell — router + 12 destinations + dark theme (the D3 core survives) |

**Sequencing constraint:** the event model (§3.1) gates almost everything else. Domain ingestion,
entity resolution, cross-domain patterns and the CCC engine all read from it. It should be settled
first, and it should be settled with real sample CDR/IPDR/bank/social schemas in hand, because
guessing at those field names now will force a second migration later.

**Honest scope note:** the specification describes 12 pages, a statistics engine, entity resolution
across five identifier types, a new persistence layer, and an authentication system. That is a
multi-week build, not a single session. It should be staged, with each stage runnable and tested
before the next begins.

---

## Build status — workflow steps 1-7 (updated 5 Sep 2026)

| # | Step | State | Where |
|---|---|---|---|
| 1 | Data sources | Done | `data/synthetic/` — cdr, ipdr, bank, social, entities, ground_truth |
| 2 | Ingestion | Done | `POST /api/v1/ingest/{cdr,ipdr,bank,social}` — SHA-256 before parse |
| 3 | Normalization | Done | `app/services/normalizers.py` → `UnifiedEvent` |
| 4 | Storage | Done (SQLite) | `app/services/event_store.py` — SQLite is the decision, not a stepping stone |
| 5 | Entity resolution | Done | `app/services/entity_resolution.py` |
| 6 | Graph creation | Done | `app/services/graph_projection.py` → Neo4j |
| 7 | Graph analysis | Done | `app/analytics/network_metrics.py` (NetworkX) |
| 10-12 | Patterns / baseline / CCC | Done | `app/analytics/ccc_engine.py`, `permutation_test.py`, `fdr.py` |
| 13 | Exculpatory context | Partial | Routine-baseline guard only; no LLM path yet |
| 14 | Investigator UI | Done | `frontend/src/investigator/` — 11 pages, dark workspace |
| 15 | Report / audit | Inherited | Court-pack PDF + ledger exist, messaging-shaped |

### Graph model (step 6)

Two layers, deliberately separated:

- **Ownership** `(:Person)-[:OWNS|USES]->(:Phone|:BankAccount|:Device|:Sim|:UpiHandle|:SocialAccount|:IpAddress)`
  — what entity resolution *concluded*. Carries `confidence`, `origin`, `basis`.
- **Activity** `(:Phone)-[:CALLED]->(:Phone)`, `(:BankAccount)-[:TRANSFERRED]->(:BankAccount)`,
  `(:Phone)-[:CONNECTED_FROM]->(:IpAddress)` — what the source records *observed*. Never inferred.

A call between handsets is a fact from the CDR; "these two people spoke" depends on the
resolution being correct. The graph must not blur the two.

All nodes are keyed `(value, case_id)`, so cases are isolated and re-projection is
idempotent (MERGE). Neo4j stores and navigates; NetworkX computes metrics; D3 draws.

### Known constraints

- `graph_db` uses `connection_timeout=3s` with no transaction retries. Aura's first
  connection after idle exceeds that, so the first call fails. Absorbed by a retry with
  backoff in `graph_projection`, leaving the shared setting untouched.
- `tests/conftest.py` mocks the whole `neo4j` module, so the suite is offline-only. Live
  projection tests skip under pytest and are verified against the real instance via the API.


## Storage decision: SQLite, not PostgreSQL (5 Sep 2026)

PostgreSQL was considered and **dropped**. SQLite is the choice, not a
placeholder:

- No server to run, no credentials, no container. The deployment constraint is
  "opens with zero login"; a database daemon works against that.
- The workload is a single writer (ingestion) and many readers (the UI). That
  is precisely what SQLite is good at.
- Volume is thousands of rows per case, not millions. Indices on
  `(case_id, timestamp)` and `(case_id, actor_entity)` keep every query the UI
  makes well under a millisecond.
- All access goes through `app/services/event_store.py` in plain SQL, so if
  real volume or concurrent writers ever arrive, the migration is contained to
  that one module rather than spread through the codebase.

MySQL was never a candidate — it would carry the same server-setup cost as
PostgreSQL with no analytical advantage.
