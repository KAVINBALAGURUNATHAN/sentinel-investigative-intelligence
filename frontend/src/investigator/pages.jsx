/*
  Investigator pages.

  Language rule, applied throughout: the interface never asserts guilt. It
  reports what was observed, how unusual it is against a stated baseline, and
  what legitimate explanations exist. Words like "criminal" or "guilty" appear
  nowhere. Findings are "requires review", "potentially anomalous", "pattern
  detected".
*/

import { useMemo, useState } from 'react'
import {
  Async, Chip, Empty, ErrorState, Hint, Icon, NotConnected, Panel, Pill,
  Table, Tile, useApi,
} from './ui.jsx'
import {
  api, DOMAIN_OF, fmtDateTime, fmtInr, fmtNum, fmtP, fmtTime, severityClass,
} from './api.js'
import NetworkGraph from './NetworkGraph.jsx'

const domainOf = t => DOMAIN_OF[t] || 'entity'

/* ── Dashboard ─────────────────────────────────────────────────────────── */

export function Dashboard({ caseId, onNavigate }) {
  const cases = useApi(() => api.cases(), [])
  const alerts = useApi(() => api.alerts(), [])
  const timeline = useApi(() => api.timeline(caseId, { limit: 12 }), [caseId], { enabled: !!caseId })
  const graph = useApi(() => api.graph(caseId), [caseId], { enabled: !!caseId })

  const all = cases.data?.cases || []
  const openAlerts = alerts.data?.alerts || []
  const high = openAlerts.filter(a => a.severity === 'HIGH')
  const entities = all.reduce((s, c) => s + (c.entities || 0), 0)
  const events = all.reduce((s, c) => s + (c.events || 0), 0)
  const crossDomain = all.filter(c => (c.data_sources || []).length > 1).length

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Investigation overview</h1>
        <span className="page-sub">Synthetic benchmark data</span>
      </div>

      <div className="grid metrics">
        <Tile label="Active cases" value={cases.loading ? '—' : all.length} />
        <Tile label="Entities analysed" value={cases.loading ? '—' : fmtNum(entities)} />
        <Tile label="Events stored" value={cases.loading ? '—' : fmtNum(events)} />
        <Tile label="Multi-source cases" value={cases.loading ? '—' : crossDomain}
          note="two or more data sources" />
        <Tile label="Open alerts" value={alerts.loading ? '—' : openAlerts.length}
          tone={openAlerts.length ? 'medium' : undefined} />
        <Tile label="High priority" value={alerts.loading ? '—' : high.length}
          tone={high.length ? 'high' : undefined} />
      </div>

      <div className="grid split" style={{ marginTop: 12 }}>
        <Panel title="Alert queue" flush
          actions={<button className="btn sm" onClick={() => onNavigate('alerts')}>Open</button>}>
          <Async state={alerts} rows={4}>
            {d => (
              <Table
                rowKey={r => r.alert_id}
                columns={[
                  { key: 'severity', label: 'Sev',
                    render: r => <Pill tone={severityClass(r.severity)}>{r.severity}</Pill> },
                  { key: 'entity_id', label: 'Entity', className: 'mono' },
                  { key: 'pattern', label: 'Finding' },
                  { key: 'lift', label: 'Lift', className: 'num',
                    render: r => (r.lift ? `${r.lift.toFixed(1)}×` : '—') },
                ]}
                rows={d.alerts.slice(0, 8)}
                empty={<Empty headline="No open alerts"
                  detail="Run pattern analysis on a case to generate findings." />}
              />
            )}
          </Async>
        </Panel>

        <Panel title={`Recent activity — ${caseId || 'no case'}`} flush>
          <Async state={timeline} rows={4}>
            {d => (
              <Table
                rowKey={r => r.event_id}
                columns={[
                  { key: 'timestamp', label: 'Time', className: 'mono',
                    render: r => fmtTime(r.timestamp) },
                  { key: 'event_type', label: 'Event',
                    render: r => <Chip domain={domainOf(r.event_type)}>{r.event_type}</Chip> },
                  { key: 'actor_entity', label: 'From', className: 'mono' },
                  { key: 'target_entity', label: 'To', className: 'mono' },
                ]}
                rows={d.events.slice(0, 8)}
                empty={<Empty headline="No events" />}
              />
            )}
          </Async>
        </Panel>
      </div>

      <Panel title="Data source status" >
        <Async state={cases} rows={3}>
          {d => (
            <Table
              rowKey={r => r.case_id}
              columns={[
                { key: 'case_id', label: 'Case', className: 'mono' },
                { key: 'data_sources', label: 'Sources',
                  render: r => (r.data_sources || []).map(s =>
                    <Chip key={s} domain={s}>{s.toUpperCase()}</Chip>) },
                { key: 'events', label: 'Events', className: 'num',
                  render: r => fmtNum(r.events) },
                { key: 'quarantined', label: 'Quarantined', className: 'num',
                  render: r => (r.quarantined
                    ? <span style={{ color: 'var(--medium)' }}>{r.quarantined}</span>
                    : '0') },
                { key: 'entities', label: 'Entities', className: 'num' },
              ]}
              rows={d.cases}
            />
          )}
        </Async>
      </Panel>

      {graph.data?.status === 'UNAVAILABLE' && (
        <div style={{ marginTop: 12 }}>
          <NotConnected>
            Neo4j is unreachable, so the relationship graph is unavailable. Event
            data, timelines and statistics are unaffected — they are served from
            the event store.
          </NotConnected>
        </div>
      )}
    </>
  )
}

/* ── Cases ─────────────────────────────────────────────────────────────── */

export function Cases({ caseId, onSelectCase }) {
  const cases = useApi(() => api.cases(), [])
  const detail = useApi(() => api.case(caseId), [caseId], { enabled: !!caseId })

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Cases</h1>
      </div>

      <Panel flush>
        <Async state={cases} rows={4}>
          {d => (
            <Table
              rowKey={r => r.case_id}
              selectedKey={caseId}
              onRowClick={r => onSelectCase(r.case_id)}
              columns={[
                { key: 'case_id', label: 'Case ID', className: 'mono' },
                { key: 'data_sources', label: 'Sources',
                  render: r => (r.data_sources || []).map(s =>
                    <Chip key={s} domain={s}>{s.toUpperCase()}</Chip>) },
                { key: 'events', label: 'Events', className: 'num', render: r => fmtNum(r.events) },
                { key: 'entities', label: 'Entities', className: 'num' },
                { key: 'open_alerts', label: 'Alerts', className: 'num',
                  render: r => (r.open_alerts
                    ? <Pill tone="medium">{r.open_alerts}</Pill> : '0') },
                { key: 'first_event', label: 'First event', className: 'mono',
                  render: r => fmtDateTime(r.first_event) },
              ]}
              rows={d.cases}
            />
          )}
        </Async>
      </Panel>

      {caseId && (
        <Panel title={`Case ${caseId}`}>
          <Async state={detail} rows={3}>
            {d => (
              <>
                <div className="stat-row" style={{ marginBottom: 12 }}>
                  <dl className="kv">
                    <dt>Events</dt><dd>{fmtNum(d.events)}</dd>
                    <dt>Entities</dt><dd>{d.entities}</dd>
                    <dt>Quarantined</dt><dd>{d.quarantined}</dd>
                    <dt>Batches</dt><dd>{d.batches?.length || 0}</dd>
                  </dl>
                </div>
                <CaseMetadataForm caseId={caseId} initial={d.case_metadata}
                  onSaved={detail.reload} />
              </>
            )}
          </Async>
        </Panel>
      )}
    </>
  )
}

/* ── Entities ──────────────────────────────────────────────────────────── */

export function Entities({ caseId, onOpenEntity }) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('ALL')
  const state = useApi(() => api.entities(caseId), [caseId], { enabled: !!caseId })

  const rows = useMemo(() => {
    const all = state.data?.entities || []
    return all.filter(r => {
      if (kind === 'PEOPLE' && r.kind !== 'PERSON') return false
      if (kind === 'IDENTIFIERS' && r.kind !== 'IDENTIFIER') return false
      if (!query) return true
      const hay = `${r.id} ${r.type} ${r.linked_to || ''}`.toLowerCase()
      return hay.includes(query.toLowerCase())
    })
  }, [state.data, query, kind])

  if (!caseId) return <Empty headline="Select a case first" />

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Entities</h1>
        <span className="page-sub">
          {state.data ? `${state.data.counts.people} people · ${state.data.counts.identifiers} identifiers` : ''}
        </span>
        <div className="spacer" />
        <div className="controls">
          <label className="field">
            <span>Search</span>
            <input type="search" value={query} placeholder="entity, phone, account…"
              onChange={e => setQuery(e.target.value)} style={{ width: 210 }} />
          </label>
          <label className="field">
            <span>Type</span>
            <select value={kind} onChange={e => setKind(e.target.value)}>
              <option value="ALL">All</option>
              <option value="PEOPLE">People</option>
              <option value="IDENTIFIERS">Identifiers</option>
            </select>
          </label>
        </div>
      </div>

      <Panel flush>
        <Async state={state} rows={6}>
          {() => (
            <Table
              rowKey={r => `${r.kind}-${r.type}-${r.id}`}
              onRowClick={r => r.kind === 'PERSON' && onOpenEntity(r.id)}
              columns={[
                { key: 'type', label: 'Type',
                  render: r => <Chip>{r.type}</Chip> },
                { key: 'id', label: 'Identifier', className: 'mono' },
                { key: 'linked_to', label: 'Linked to', className: 'mono',
                  render: r => r.linked_to || '—' },
                { key: 'connections', label: 'Connections', className: 'num',
                  render: r => (r.connections == null ? '—' : r.connections) },
                { key: 'events', label: 'Events', className: 'num',
                  render: r => (r.events == null ? '—' : fmtNum(r.events)) },
                { key: 'origin', label: 'Origin',
                  render: r => (r.origin
                    ? <Pill tone={r.origin === 'INFERRED' ? 'medium' : 'neutral'}>{r.origin}</Pill>
                    : '—') },
              ]}
              rows={rows}
              empty={<Empty headline="No entities match" />}
            />
          )}
        </Async>
      </Panel>
      <div style={{ marginTop: 10 }}>
        <NotConnected>
          Identifier values are masked by default. Unmasking is an authorisation
          decision and this prototype has no authentication, so no unmasked view
          is exposed.
        </NotConnected>
      </div>
    </>
  )
}

/* ── Entity detail ─────────────────────────────────────────────────────── */

export function EntityDetail({ caseId, entityId, onNavigate, onOpenEntity }) {
  const state = useApi(() => api.entity(entityId, caseId), [entityId, caseId],
    { enabled: !!entityId && !!caseId })

  return (
    <>
      <div className="page-head">
        <button className="btn sm" onClick={() => onNavigate('entities')}>Back</button>
        <h1 className="page-title" style={{ fontFamily: 'var(--mono)' }}>{entityId}</h1>
        <div className="spacer" />
        <button className="btn sm" onClick={() => onNavigate('network')}>View graph</button>
        <button className="btn sm" onClick={() => onNavigate('timeline')}>View timeline</button>
      </div>

      <Async state={state} rows={5}>
        {d => (
          <div className="grid split">
            <div>
              <Panel title="Identifiers" flush>
                <Table
                  rowKey={r => `${r.type}-${r.value_masked}`}
                  columns={[
                    { key: 'type', label: 'Type', render: r => <Chip>{r.type}</Chip> },
                    { key: 'value_masked', label: 'Value', className: 'mono' },
                    { key: 'confidence', label: 'Conf.', className: 'num',
                      render: r => r.confidence?.toFixed(2) ?? '—' },
                    { key: 'origin', label: 'Origin',
                      render: r => <Pill tone={r.origin === 'INFERRED' ? 'medium' : 'neutral'}>
                        {r.origin}</Pill> },
                  ]}
                  rows={d.identifiers}
                  empty={<Empty headline="No identifiers resolved" />}
                />
              </Panel>

              <Panel title="Behaviour summary">
                <dl className="kv">
                  {Object.entries(d.activity || {}).map(([type, n]) => (
                    <Fragment2 key={type}>
                      <dt>{type.replace(/_/g, ' ')}</dt><dd>{fmtNum(n)}</dd>
                    </Fragment2>
                  ))}
                </dl>
                {!!d.active_hours?.length && (
                  <>
                    <div style={{ margin: '12px 0 6px', fontSize: 9.5, letterSpacing: '.1em',
                      textTransform: 'uppercase', color: 'var(--text-3)' }}>
                      Typical active hours (UTC)
                    </div>
                    <HourHistogram hours={d.active_hours} />
                  </>
                )}
              </Panel>
            </div>

            <Panel title={`Related entities — ${d.connections ?? 0} connections`} flush>
              <Table
                rowKey={r => r.entity}
                onRowClick={r => onOpenEntity(r.entity)}
                columns={[
                  { key: 'entity', label: 'Entity', className: 'mono' },
                  { key: 'relationships', label: 'Linked by',
                    render: r => r.relationships.map(rel =>
                      <Chip key={rel} domain={domainOf(rel)}>{rel}</Chip>) },
                  { key: 'events', label: 'Events', className: 'num',
                    render: r => fmtNum(r.events) },
                  { key: 'cross_domain', label: '',
                    render: r => (r.cross_domain
                      ? <Pill tone="accent">Cross-domain</Pill> : null) },
                ]}
                rows={d.related_entities || []}
                empty={<Empty headline="No counterparties" />}
              />
            </Panel>
          </div>
        )}
      </Async>
    </>
  )
}

// React.Fragment with a key, kept local to avoid an extra import line
function Fragment2({ children }) { return <>{children}</> }

function HourHistogram({ hours }) {
  const max = Math.max(...hours.map(h => h.events), 1)
  const byHour = new Map(hours.map(h => [h.hour, h.events]))
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 46 }}>
      {Array.from({ length: 24 }, (_, h) => {
        const n = byHour.get(h) || 0
        return (
          <div key={h} title={`${String(h).padStart(2, '0')}:00 — ${n} events`}
            style={{
              flex: 1,
              height: `${Math.max(2, (n / max) * 100)}%`,
              background: n ? 'var(--accent)' : 'var(--surface-3)',
              opacity: n ? 0.75 : 1,
              borderRadius: 1,
            }} />
        )
      })}
    </div>
  )
}

/* ── Network ───────────────────────────────────────────────────────────── */

export function Network({ caseId, onOpenEntity }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null)
  const graph = useApi(() => api.graph(caseId), [caseId], { enabled: !!caseId })
  const metrics = useApi(() => api.networkMetrics(caseId), [caseId], { enabled: !!caseId })
  const [building, setBuilding] = useState(false)

  const build = async () => {
    setBuilding(true)
    try { await api.buildGraph(caseId); graph.reload(); metrics.reload() }
    finally { setBuilding(false) }
  }

  if (!caseId) return <Empty headline="Select a case first" />

  const unavailable = graph.data?.status === 'UNAVAILABLE'
  const findings = metrics.data?.findings || []

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Network</h1>
        <span className="page-sub">
          {graph.data?.nodes ? `${graph.data.nodes.length} nodes · ${graph.data.edges.length} edges` : ''}
        </span>
        <div className="spacer" />
        <input type="search" placeholder="highlight node…" value={query}
          onChange={e => setQuery(e.target.value)} style={{ width: 200 }} />
        <button className="btn" onClick={build} disabled={building}>
          <Icon name="refresh" size={12} /> {building ? 'Building…' : 'Rebuild graph'}
        </button>
      </div>

      {unavailable && (
        <div style={{ marginBottom: 12 }}>
          <NotConnected>
            Neo4j is unreachable, so the projected graph cannot be read. Use
            “Rebuild graph” once the database is available. No graph is drawn
            rather than showing a stale or invented one.
          </NotConnected>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: '1fr 320px' }}>
        <Panel flush>
          {graph.loading ? <div style={{ padding: 12 }}><Empty headline="Loading graph…" /></div>
            : graph.error ? <ErrorState error={graph.error} onRetry={graph.reload} />
              : graph.data?.nodes?.length
                ? <div style={{ height: 560 }}>
                  <NetworkGraph graph={graph.data} filters={{ query }}
                    selected={selected?.id}
                    onSelect={n => {
                      setSelected(n)
                      if (n.label === 'Person') onOpenEntity?.(n.id, { keepPage: true })
                    }} />
                </div>
                : <Empty headline="No graph projected"
                  detail="Run “Rebuild graph” to project this case's resolved entities into Neo4j." />}
        </Panel>

        <div>
          <Panel title="Selection">
            {selected ? (
              <dl className="kv">
                <dt>Type</dt><dd>{selected.label}</dd>
                <dt>Id</dt><dd>{selected.id}</dd>
                {selected.identifier_type && (<><dt>Identifier</dt>
                  <dd>{selected.identifier_type}</dd></>)}
              </dl>
            ) : <div className="page-sub">Click a node to inspect it.</div>}
          </Panel>

          <Panel title="Structural findings">
            <Async state={metrics} rows={3}>
              {d => (d.findings?.length ? (
                <>
                  {findings.map(f => (
                    <div key={f.entity} style={{ marginBottom: 12 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span className="mono">{f.entity}</span>
                        <Pill tone={f.decision === 'REVIEW' ? 'high' : 'low'}>
                          {f.decision === 'REVIEW' ? 'Requires review' : 'Monitor'}
                        </Pill>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4,
                        lineHeight: 1.5 }}>
                        {f.interpretation}
                      </div>
                    </div>
                  ))}
                  <div className="disclaimer">{d.disclaimer}</div>
                </>
              ) : <Empty headline="No structural findings"
                detail="No entity bridges otherwise separate groups in this case." />)}
            </Async>
          </Panel>
        </div>
      </div>
    </>
  )
}

/* ── Timeline ──────────────────────────────────────────────────────────── */

export function Timeline({ caseId, onOpenEvidence }) {
  const [type, setType] = useState('')
  const [entity, setEntity] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')

  const state = useApi(
    () => api.timeline(caseId, {
      limit: 300,
      event_types: type,
      entity_id: entity,
      since: since ? `${since}T00:00:00+00:00` : '',
      until: until ? `${until}T23:59:59+00:00` : '',
    }),
    [caseId, type, entity, since, until], { enabled: !!caseId })

  if (!caseId) return <Empty headline="Select a case first" />

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Timeline</h1>
        <span className="page-sub">{state.data ? `${state.data.count} events` : ''}</span>
        <div className="spacer" />
        <div className="controls">
          <label className="field"><span>Event type</span>
            <select value={type} onChange={e => setType(e.target.value)}>
              <option value="">All</option>
              {['CALL', 'SMS', 'TRANSFER', 'DATA_SESSION', 'SOCIAL_POST', 'LOGIN']
                .map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="field"><span>Entity</span>
            <input type="text" value={entity} placeholder="E-104"
              onChange={e => setEntity(e.target.value)} style={{ width: 90 }} />
          </label>
          <label className="field"><span>From</span>
            <input type="date" value={since} onChange={e => setSince(e.target.value)} />
          </label>
          <label className="field"><span>To</span>
            <input type="date" value={until} onChange={e => setUntil(e.target.value)} />
          </label>
        </div>
      </div>

      <Panel>
        <Async state={state} rows={6}>
          {d => (d.events.length ? (
            <div className="tl">
              {d.events.map(e => {
                const domain = domainOf(e.event_type)
                return (
                  <div className="tl-row" key={e.event_id}>
                    <div className="tl-time">{fmtDateTime(e.timestamp).slice(5)}</div>
                    <div className="tl-dot" style={{ background: `var(--${domain})` }} />
                    <div className="tl-card" onClick={() => onOpenEvidence(e.event_id)}
                      role="button" tabIndex={0}
                      onKeyDown={ev => ev.key === 'Enter' && onOpenEvidence(e.event_id)}>
                      <div className="tl-head">
                        <Chip domain={domain}>{e.event_type}</Chip>
                        <span className="tl-what mono">
                          {e.actor_entity || e.actor} → {e.target_entity || e.target || '—'}
                        </span>
                        <div className="spacer" />
                        {e.amount && <span className="mono"
                          style={{ color: 'var(--bank)' }}>{fmtInr(e.amount)}</span>}
                        {e.duration_seconds != null && e.duration_seconds > 0 &&
                          <span className="mono t-dim">{e.duration_seconds}s</span>}
                      </div>
                      <div className="tl-detail">
                        {e.actor} {e.target ? `→ ${e.target}` : ''} · {e.source_file}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : <Empty headline="No events match these filters" />)}
        </Async>
      </Panel>
    </>
  )
}

/* ── Patterns / CCC ────────────────────────────────────────────────────── */

export function Patterns({ caseId }) {
  const [permutations, setPermutations] = useState(500)
  const [expanded, setExpanded] = useState(null)
  const state = useApi(() => api.patterns(caseId, permutations),
    [caseId, permutations], { enabled: !!caseId })

  if (!caseId) return <Empty headline="Select a case first" />

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Cross-domain patterns</h1>
        <span className="page-sub">CCC engine — permutation test with FDR correction</span>
        <div className="spacer" />
        <label className="field"><span>Permutations</span>
          <select value={permutations} onChange={e => setPermutations(Number(e.target.value))}>
            {[200, 500, 1000, 2000].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button className="btn" onClick={state.reload}>
          <Icon name="refresh" size={12} /> Re-run
        </button>
      </div>

      <Async state={state} rows={5}>
        {d => (
          <>
            {d.results.length === 0 && (
              <Panel><Empty headline="No pattern occurrences"
                detail="No configured sequence occurred in this case within the time window." />
              </Panel>
            )}

            {d.results.map(r => {
              const open = expanded === r.pattern
              const review = r.decision === 'REVIEW'
              return (
                <Panel key={r.pattern} title={r.pattern.replace(/_/g, ' → ')}
                  actions={
                    <>
                      <Pill tone={review ? 'high' : 'low'}>
                        {review ? 'Requires review' : r.decision.replace(/_/g, ' ')}
                      </Pill>
                      <button className="btn sm" onClick={() => setExpanded(open ? null : r.pattern)}>
                        {open ? 'Hide' : 'Explain'}
                      </button>
                    </>
                  }>
                  <div className="grid metrics" style={{ marginBottom: open ? 12 : 0 }}>
                    <Tile label="Subject" value={<span style={{ fontSize: 16 }}>{r.subject}</span>} />
                    <Tile label="Observed" value={r.observed} />
                    <Tile label="Expected" value={r.expected?.toFixed(2)}
                      note="mean of null distribution" />
                    <Tile label="Lift" value={r.lift ? `${r.lift.toFixed(1)}×` : '—'}
                      tone={r.lift >= 10 ? 'high' : r.lift >= 2 ? 'medium' : undefined} />
                    <Tile label={<Hint tip="Probability of seeing this many occurrences under the null model">p-value</Hint>}
                      value={fmtP(r.p_value, d.permutations)} />
                    <Tile label={<Hint tip="Benjamini-Hochberg adjusted for testing many patterns at once">FDR adjusted</Hint>}
                      value={r.fdr_adjusted != null ? r.fdr_adjusted.toFixed(4) : '—'} />
                  </div>

                  {open && (
                    <>
                      <ExplainBlock title="Does this subject normally do this?">
                        {r.interpretation}
                      </ExplainBlock>
                      {!!r.rationale?.length && (
                        <ExplainBlock title="Why it was flagged">
                          <ul style={{ paddingLeft: 16 }}>
                            {r.rationale.map((line, i) => <li key={i}>{line}</li>)}
                          </ul>
                        </ExplainBlock>
                      )}
                      {!!r.exculpatory_context?.length && (
                        <ExplainBlock title="Why it may not be suspicious">
                          <ul style={{ paddingLeft: 16 }}>
                            {r.exculpatory_context.map((line, i) => <li key={i}>{line}</li>)}
                          </ul>
                        </ExplainBlock>
                      )}
                    </>
                  )}
                </Panel>
              )
            })}

            {!!d.network_findings?.length && (
              <Panel title="Structural findings">
                {d.network_findings.map(f => (
                  <div key={f.entity} style={{ marginBottom: 10 }}>
                    <span className="mono">{f.entity}</span>{' '}
                    <Pill tone={f.decision === 'REVIEW' ? 'high' : 'low'}>{f.decision}</Pill>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 3 }}>
                      {f.interpretation}
                    </div>
                  </div>
                ))}
              </Panel>
            )}

            <div className="disclaimer">{d.disclaimer}</div>
          </>
        )}
      </Async>
    </>
  )
}

function ExplainBlock({ title, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase',
        color: 'var(--text-3)', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6 }}>{children}</div>
    </div>
  )
}

/* ── Alerts ────────────────────────────────────────────────────────────── */

export function Alerts({ caseId, onOpenEntity }) {
  const [open, setOpen] = useState(null)
  const state = useApi(() => api.alerts(caseId), [caseId])

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Alert queue</h1>
        <span className="page-sub">{caseId ? `case ${caseId}` : 'all cases'}</span>
      </div>

      <Panel flush>
        <Async state={state} rows={5}>
          {d => (
            <Table
              rowKey={r => r.alert_id}
              selectedKey={open?.alert_id}
              onRowClick={r => setOpen(open?.alert_id === r.alert_id ? null : r)}
              columns={[
                { key: 'alert_id', label: 'Alert', className: 'mono' },
                { key: 'case_id', label: 'Case', className: 'mono' },
                { key: 'entity_id', label: 'Entity', className: 'mono' },
                { key: 'pattern', label: 'Finding' },
                { key: 'severity', label: 'Severity',
                  render: r => <Pill tone={severityClass(r.severity)}>{r.severity}</Pill> },
                { key: 'evidence_count', label: 'Evidence', className: 'num' },
                { key: 'fdr_adjusted', label: 'FDR', className: 'num',
                  render: r => (r.fdr_adjusted != null ? r.fdr_adjusted.toFixed(4) : '—') },
                { key: 'status', label: 'Status',
                  render: r => <Pill tone="neutral">{r.status}</Pill> },
              ]}
              rows={d.alerts}
              empty={<Empty headline="No alerts"
                detail="Run pattern analysis to generate findings." />}
            />
          )}
        </Async>
      </Panel>

      {open && (
        <Panel title={`${open.alert_id} — why was this flagged?`}
          actions={<button className="btn sm" onClick={() => setOpen(null)}>
            <Icon name="close" size={11} /></button>}>
          <div className="grid metrics" style={{ marginBottom: 12 }}>
            <Tile label="Observed" value={open.observed ?? '—'} />
            <Tile label="Expected" value={open.expected != null ? open.expected.toFixed(2) : '—'} />
            <Tile label="Lift" value={open.lift ? `${open.lift.toFixed(1)}×` : '—'} />
            <Tile label="p-value" value={open.p_value != null ? open.p_value.toFixed(4) : '—'} />
            <Tile label="FDR adjusted"
              value={open.fdr_adjusted != null ? open.fdr_adjusted.toFixed(4) : '—'} />
          </div>

          {open.detail?.interpretation && (
            <ExplainBlock title="What was observed">{open.detail.interpretation}</ExplainBlock>
          )}
          {!!open.detail?.rationale?.length && (
            <ExplainBlock title="Why it was flagged">
              <ul style={{ paddingLeft: 16 }}>
                {open.detail.rationale.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </ExplainBlock>
          )}
          {!!open.detail?.exculpatory_context?.length && (
            <ExplainBlock title="Why it may not be suspicious">
              <ul style={{ paddingLeft: 16 }}>
                {open.detail.exculpatory_context.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </ExplainBlock>
          )}
          {open.entity_id && (
            <button className="btn sm" onClick={() => onOpenEntity(open.entity_id)}>
              <Icon name="link" size={11} /> Open entity {open.entity_id}
            </button>
          )}
        </Panel>
      )}
    </>
  )
}

/* ── Evidence ──────────────────────────────────────────────────────────── */

export function Evidence({ caseId, eventId, onOpenEvidence }) {
  const [lookup, setLookup] = useState(eventId || '')
  const list = useApi(() => api.timeline(caseId, { limit: 200 }), [caseId], { enabled: !!caseId })
  const record = useApi(() => api.evidence(lookup), [lookup], { enabled: !!lookup })

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Evidence</h1>
        <div className="spacer" />
        <input type="search" value={lookup} placeholder="evidence id…"
          onChange={e => setLookup(e.target.value)} style={{ width: 220 }} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 380px' }}>
        <Panel title="Records" flush>
          <Async state={list} rows={6}>
            {d => (
              <Table
                rowKey={r => r.event_id}
                selectedKey={lookup}
                onRowClick={r => { setLookup(r.event_id); onOpenEvidence?.(r.event_id) }}
                columns={[
                  { key: 'event_id', label: 'Evidence ID', className: 'mono' },
                  { key: 'event_type', label: 'Event',
                    render: r => <Chip domain={domainOf(r.event_type)}>{r.event_type}</Chip> },
                  { key: 'timestamp', label: 'Timestamp', className: 'mono',
                    render: r => fmtDateTime(r.timestamp) },
                  { key: 'source_file', label: 'Source', className: 'mono' },
                ]}
                rows={d.events}
              />
            )}
          </Async>
        </Panel>

        <Panel title="Record detail">
          {!lookup ? <Empty headline="Select a record" icon="evidence" />
            : <Async state={record} rows={5}>
              {r => (
                <>
                  <dl className="kv">
                    <dt>Evidence</dt><dd>{r.event_id}</dd>
                    <dt>Case</dt><dd>{r.case_id}</dd>
                    <dt>Event</dt><dd>{r.event_type}</dd>
                    <dt>Timestamp</dt><dd>{fmtDateTime(r.timestamp)}</dd>
                    <dt>From</dt><dd>{r.actor} {r.actor_entity ? `(${r.actor_entity})` : ''}</dd>
                    <dt>To</dt><dd>{r.target || '—'} {r.target_entity ? `(${r.target_entity})` : ''}</dd>
                    {r.amount && <><dt>Amount</dt><dd>{fmtInr(r.amount)}</dd></>}
                    {r.duration_seconds != null && r.duration_seconds > 0 &&
                      <><dt>Duration</dt><dd>{r.duration_seconds}s</dd></>}
                  </dl>

                  <div style={{ marginTop: 14, fontSize: 9.5, letterSpacing: '.1em',
                    textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 6 }}>
                    Provenance chain
                  </div>
                  <dl className="kv">
                    <dt>Source file</dt><dd>{r.provenance.source_file}</dd>
                    <dt>Row</dt><dd>{r.provenance.source_row}</dd>
                    <dt>Batch</dt><dd>{r.provenance.batch_id}</dd>
                    <dt>Received</dt><dd>{fmtDateTime(r.provenance.received_at)}</dd>
                    <dt>Chain</dt><dd>
                      <Pill tone={r.provenance.chain_status === 'VERIFIED' ? 'low' : 'medium'}>
                        {r.provenance.chain_status}
                      </Pill></dd>
                  </dl>
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 9.5, letterSpacing: '.1em',
                      textTransform: 'uppercase', color: 'var(--text-3)' }}>
                      SHA-256 of source file as received
                    </div>
                    <div className="mono" style={{ fontSize: 10.5, wordBreak: 'break-all',
                      color: 'var(--text-2)', marginTop: 3 }}>
                      {r.provenance.sha256}
                    </div>
                  </div>
                  {r.quarantined && (
                    <div style={{ marginTop: 10 }}>
                      <Pill tone="medium">Quarantined</Pill>
                      <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 5 }}>
                        This record failed validation and is retained unmodified.
                        It does not contribute to statistics or the graph.
                      </div>
                    </div>
                  )}
                </>
              )}
            </Async>}
        </Panel>
      </div>
    </>
  )
}

/* ── Data ingestion ────────────────────────────────────────────────────── */

export function Ingestion({ caseId }) {
  const [busy, setBusy] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const batches = useApi(() => api.batches(), [])

  const upload = async (source, file) => {
    if (!file) return
    setBusy(source); setError(null); setResult(null)
    try {
      setResult(await api.ingest(source, file, caseId))
      batches.reload()
    } catch (e) { setError(e) } finally { setBusy(null) }
  }

  const STAGES = ['UPLOAD', 'VALIDATE', 'NORMALIZE', 'ENTITY RESOLUTION', 'STORE']

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Data ingestion</h1>
        <span className="page-sub">
          Records are hashed before parsing; invalid rows are quarantined, never dropped
        </span>
      </div>

      <Panel title="Upload">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
          {[['cdr', 'CDR', 'Call detail records'],
            ['ipdr', 'IPDR', 'Internet session records'],
            ['bank', 'Bank', 'Financial transactions'],
            ['social', 'Social', 'Social media activity']].map(([key, label, note]) => (
            <label key={key} className="tile" style={{ cursor: 'pointer' }}>
              <div className="tile-label">{label}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 8 }}>{note}</div>
              <input type="file" accept=".csv" style={{ display: 'none' }}
                onChange={e => upload(key, e.target.files?.[0])} />
              <span className="btn sm">
                {busy === key ? 'Uploading…' : 'Choose CSV'}
              </span>
            </label>
          ))}
        </div>
        {error && <div style={{ marginTop: 10 }}><ErrorState error={error} /></div>}
      </Panel>

      {result && (
        <Panel title={`Ingestion result — ${result.filename}`}>
          <div className="pipeline">
            {STAGES.map(stage => (
              <div key={stage} className="stage done">
                <div className="stage-name">{stage}</div>
                <div className="stage-value">
                  {stage === 'UPLOAD' ? result.total
                    : stage === 'VALIDATE' ? result.validated
                      : stage === 'NORMALIZE' ? result.total
                        : stage === 'ENTITY RESOLUTION' ? result.identifiers_discovered
                          : result.validated}
                </div>
              </div>
            ))}
          </div>
          <div className="grid metrics" style={{ marginTop: 12 }}>
            <Tile label="Received" value={result.total} />
            <Tile label="Valid" value={result.validated} />
            <Tile label="Quarantined" value={result.quarantined}
              tone={result.quarantined ? 'medium' : undefined} />
            <Tile label="Identifiers" value={result.identifiers_discovered} />
            <Tile label="Relationships" value={result.relationships_discovered} />
          </div>
          <div style={{ marginTop: 10, fontSize: 9.5, letterSpacing: '.1em',
            textTransform: 'uppercase', color: 'var(--text-3)' }}>SHA-256</div>
          <div className="mono" style={{ fontSize: 10.5, wordBreak: 'break-all',
            color: 'var(--text-2)' }}>{result.sha256}</div>
        </Panel>
      )}

      <Panel title="Batch history" flush>
        <Async state={batches} rows={4}>
          {d => (
            <Table
              rowKey={r => r.batch_id}
              columns={[
                { key: 'received_at', label: 'Received', className: 'mono',
                  render: r => fmtDateTime(r.received_at) },
                { key: 'case_id', label: 'Case', className: 'mono' },
                { key: 'source', label: 'Source',
                  render: r => <Chip domain={r.source}>{r.source.toUpperCase()}</Chip> },
                { key: 'filename', label: 'File', className: 'mono' },
                { key: 'total', label: 'Total', className: 'num' },
                { key: 'validated', label: 'Valid', className: 'num' },
                { key: 'quarantined', label: 'Quar.', className: 'num',
                  render: r => (r.quarantined
                    ? <span style={{ color: 'var(--medium)' }}>{r.quarantined}</span> : '0') },
                { key: 'sha256', label: 'SHA-256', className: 'mono',
                  render: r => `${r.sha256.slice(0, 12)}…` },
              ]}
              rows={d.batches}
              empty={<Empty headline="No batches ingested yet" />}
            />
          )}
        </Async>
      </Panel>
    </>
  )
}

/* ── System validation ─────────────────────────────────────────────────── */

export function Validation() {
  const [permutations, setPermutations] = useState(200)
  const state = useApi(() => api.benchmark(permutations), [permutations])

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">System validation</h1>
        <span className="page-sub">Synthetic benchmark against labelled ground truth</span>
        <div className="spacer" />
        <label className="field"><span>Permutations</span>
          <select value={permutations} onChange={e => setPermutations(Number(e.target.value))}>
            {[200, 500, 1000].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button className="btn" onClick={state.reload}>
          <Icon name="refresh" size={12} /> Re-run
        </button>
      </div>

      <Async state={state} rows={6}>
        {d => (
          <>
            <div className="grid metrics">
              <Tile label="Tests" value={d.summary.tests} />
              <Tile label="Passed" value={d.summary.passed}
                tone={d.summary.failed ? undefined : 'medium'} />
              <Tile label="Failed" value={d.summary.failed}
                tone={d.summary.failed ? 'high' : undefined} />
              <Tile label="Precision"
                value={d.summary.precision != null ? d.summary.precision.toFixed(2) : '—'} />
              <Tile label="Recall"
                value={d.summary.recall != null ? d.summary.recall.toFixed(2) : '—'} />
              <Tile label="False positives" value={d.summary.false_positives} />
              <Tile label="False negatives" value={d.summary.false_negatives} />
            </div>

            <Panel title={d.label} flush>
              <Table
                rowKey={r => r.case_id}
                columns={[
                  { key: 'case_id', label: 'Case', className: 'mono' },
                  { key: 'scenario', label: 'Scenario' },
                  { key: 'expected', label: 'Expected',
                    render: r => <Pill tone="neutral">{r.expected}</Pill> },
                  { key: 'actual', label: 'Actual',
                    render: r => <Pill tone={r.expected === r.actual ? 'low' : 'high'}>
                      {r.actual}</Pill> },
                  { key: 'quarantine', label: 'Quarantine', className: 'num',
                    render: r => `${r.actual_quarantine}/${r.expected_quarantine}` },
                  { key: 'result', label: 'Result',
                    render: r => <Pill tone={r.result === 'PASS' ? 'low' : 'high'}>
                      {r.result}</Pill> },
                ]}
                rows={d.tests}
              />
            </Panel>

            <div className="disclaimer">{d.disclaimer}</div>
          </>
        )}
      </Async>
    </>
  )
}

/* ── Reports ───────────────────────────────────────────────────────────── */

export function Reports({ caseId }) {
  return (
    <>
      <div className="page-head"><h1 className="page-title">Reports</h1></div>
      <Panel>
        <NotConnected>
          The court-pack PDF and audit-bundle exports in this repository were
          built for the original messaging pipeline and read from that schema,
          not the multi-domain event store. They are not wired to case {caseId || '—'} and
          would produce an empty or misleading document, so no export button is
          offered here yet.
        </NotConnected>
      </Panel>
    </>
  )
}


/* ── Case metadata editor ──────────────────────────────────────────────────
   Investigation facts cannot be derived from CDR or bank rows. They are
   entered by a person here, and remain blank until someone does — the system
   never fills them in on its own. */

function CaseMetadataForm({ caseId, initial, onSaved }) {
  const [form, setForm] = useState({
    name: initial?.name || '',
    status: initial?.status || 'OPEN',
    investigator: initial?.investigator || '',
    authority_reference: initial?.authority_reference || '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  const statuses = useApi(() => api.caseStatuses(), [])
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setSaved(false) }

  const submit = async e => {
    e.preventDefault()
    setSaving(true); setError(null)
    try {
      await api.saveCaseMetadata(caseId, form)
      setSaved(true)
      onSaved?.()
    } catch (err) { setError(err) } finally { setSaving(false) }
  }

  return (
    <form onSubmit={submit}>
      <div style={{ fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase',
        color: 'var(--text-3)', marginBottom: 8 }}>
        Investigation record
        {initial?.recorded === false &&
          <span style={{ marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>
            — not yet recorded for this case
          </span>}
      </div>

      <div className="controls" style={{ alignItems: 'flex-end' }}>
        <label className="field"><span>Case name</span>
          <input type="text" value={form.name} placeholder="e.g. Operation Ridge"
            onChange={e => set('name', e.target.value)} style={{ width: 200 }} />
        </label>
        <label className="field"><span>Status</span>
          <select value={form.status} onChange={e => set('status', e.target.value)}>
            {(statuses.data?.statuses || ['OPEN']).map(s =>
              <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="field"><span>Investigator</span>
          <input type="text" value={form.investigator} placeholder="name or badge"
            onChange={e => set('investigator', e.target.value)} style={{ width: 170 }} />
        </label>
        <label className="field"><span>Authority reference</span>
          <input type="text" value={form.authority_reference} placeholder="FIR / warrant no."
            onChange={e => set('authority_reference', e.target.value)} style={{ width: 170 }} />
        </label>
        <button className="btn primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span style={{ color: 'var(--low)', fontSize: 11.5 }}>Saved</span>}
      </div>

      {error && <div style={{ marginTop: 8, color: 'var(--high)', fontSize: 11.5 }}>
        {error.message}</div>}

      {initial?.updated_at && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)' }}>
          Last updated {fmtDateTime(initial.updated_at)}
        </div>
      )}
    </form>
  )
}
