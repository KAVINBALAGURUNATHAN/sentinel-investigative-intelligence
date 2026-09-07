/*
  Investigator pages.

  Language rule, applied throughout: the interface never asserts guilt. It
  reports what was observed, how unusual it is against a stated baseline, and
  what legitimate explanations exist. Words like "criminal" or "guilty" appear
  nowhere. Findings are "requires review", "potentially anomalous", "pattern
  detected".
*/

import { useEffect, useMemo, useState } from 'react'
import {
  Async, Chip, Empty, ErrorState, Hint, Icon, NotConnected, Panel, Pill,
  Table, Tile, useApi,
} from './ui.jsx'
import {
  api, DOMAIN_OF, fmtDateTime, fmtInr, fmtNum, fmtP, fmtTime, severityClass,
} from './api.js'
import NetworkGraph from './NetworkGraph.jsx'
import {
  NOT_GUILT, SOURCE_DEFS, caseHeadline, casePriority, caseStatus, caseStory,
  confidencePhrase, decisionLabel, eventLabel, findingLabel, findingMeaning,
  formatGap, priorityLabel, sourceLabel, sourcesForSequence, subjectLabel,
} from './labels.js'

const domainOf = t => DOMAIN_OF[t] || 'entity'

/* ── Dashboard ─────────────────────────────────────────────────────────── */

/* ── Dashboard ─────────────────────────────────────────────────────────── */

/*
  Meaning first, technical data second.

  A reader gets the story in four widening layers:
    1  What is happening?   the priority panel headline
    2  Why does it matter?  "Why was this flagged?"
    3  What evidence?       the cross-source activity sequence
    4  Raw records          expandable, never the first thing on screen

  Internal names (CALL_TRANSFER_SOCIAL, E-104) stay visible as secondary
  detail, because an investigator may need to quote them — but they are never
  the primary label.
*/

function Disclosure({ summary, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`disclose ${open ? 'is-open' : ''}`}>
      <button className="disclose-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="disclose-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        {summary}
      </button>
      {open && <div className="disclose-body">{children}</div>}
    </div>
  )
}

function SourceList({ sources }) {
  if (!sources?.length) return <span className="dim">Network structure</span>
  return (
    <span className="src-list">
      {sources.map(s => <Chip key={s} domain={s}>{sourceLabel(s)}</Chip>)}
    </span>
  )
}

/* Level 2 — the statistics, each one captioned in plain words. */
function WhyFlagged({ detail }) {
  if (!detail || detail.observed == null) return null
  const baseline = detail.baseline || {}
  return (
    <div className="why">
      <h3 className="why-h">Why was this flagged?</h3>
      <div className="why-stats">
        <div><b>{detail.observed}</b><span>times observed<br />within {detail.window_minutes} min</span></div>
        <div><b>{detail.expected?.toFixed(1)}</b><span>expected from this<br />subject&rsquo;s own history</span></div>
        <div><b>{detail.lift?.toFixed(1)}×</b><span>more often<br />than expected</span></div>
        <div><b>{fmtP(detail.p_value)}</b><span>chance of coincidence<br />({detail.permutations} rearrangements)</span></div>
        <div><b>{fmtP(detail.fdr_adjusted)}</b><span>after multiple-test<br />correction (FDR)</span></div>
      </div>
      <p className="why-text">{detail.interpretation}</p>
      {detail.rationale?.length > 0 && (
        <ul className="why-list">
          {detail.rationale.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
      <Disclosure summary="What would make this NOT suspicious?">
        {detail.exculpatory_context?.length > 0 ? (
          <ul className="why-list">
            {detail.exculpatory_context.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        ) : (
          <p className="why-text dim">
            No innocent explanation was found in the available records. That is not
            the same as there being none — the records cover
            {baseline.span_days ? ` ${baseline.span_days} days` : ' a limited period'},
            and legitimate reasons may lie outside them.
          </p>
        )}
        {baseline.explanation && <p className="why-text dim">{baseline.explanation}</p>}
      </Disclosure>
      <p className="caveat">{NOT_GUILT}</p>
    </div>
  )
}

/* Level 1 — the five-second story. */
function PriorityInvestigation({ alert, onOpen }) {
  if (!alert) {
    return (
      <Panel title="Priority investigation">
        <Empty headline="Nothing requires investigation"
          detail="Every analysed pattern was consistent with normal behaviour for its subject." />
      </Panel>
    )
  }
  const d = alert.detail || {}
  const sources = sourcesForSequence(d.sequence || [])

  return (
    <section className={`priority sev-${(alert.severity || 'low').toLowerCase()}`}>
      <div className="priority-top">
        <Pill tone={severityClass(alert.severity)}>{priorityLabel(alert.severity)} priority</Pill>
        <span className="priority-decision">{decisionLabel(alert.decision)}</span>
      </div>

      <h2 className="priority-subject">
        {subjectLabel(alert.entity_id)}
        <code className="tech-id">{alert.entity_id}</code>
      </h2>

      <p className="priority-finding">{findingLabel(alert.pattern, d.sequence)}</p>
      <p className="priority-meaning">{findingMeaning(alert.pattern)}</p>

      <div className="priority-facts">
        <div>
          <b>{alert.lift != null ? `${alert.lift.toFixed(1)}×` : '—'}</b>
          <span>above this subject&rsquo;s historical baseline</span>
        </div>
        <div>
          <b>{fmtP(alert.p_value)}</b>
          <span>{confidencePhrase(alert.p_value).replace(/\s*\(p.*\)$/, '')}</span>
        </div>
        <div>
          <b>{sources.length || '—'}</b>
          <span>independent sources agree</span>
        </div>
      </div>

      <div className="priority-src"><SourceList sources={sources} /></div>

      <button className="btn primary lg" onClick={() => onOpen(alert)}>
        View investigation
      </button>

      <Disclosure summary="Why was this flagged?" defaultOpen={false}>
        <WhyFlagged detail={d} />
      </Disclosure>
    </section>
  )
}

/* Priority findings — replaces the raw alert queue. */
function PriorityFindings({ state, onOpen }) {
  return (
    <Panel title="Priority findings">
      <Async state={state} rows={4}>
        {data => {
          const rows = data.alerts || []
          if (!rows.length) {
            return <Empty headline="No open findings"
              detail="Run pattern analysis on a case to generate findings." />
          }
          return (
            <>
              <div className="findings">
                {rows.slice(0, 8).map(a => {
                  const d = a.detail || {}
                  return (
                    <button key={a.alert_id} className="finding"
                      onClick={() => onOpen(a)}>
                      <Pill tone={severityClass(a.severity)}>{priorityLabel(a.severity)}</Pill>
                      <span className="finding-who">
                        {subjectLabel(a.entity_id)}
                        <code className="tech-id">{a.entity_id}</code>
                      </span>
                      <span className="finding-what">
                        {findingLabel(a.pattern, d.sequence)}
                      </span>
                      <span className="finding-src">
                        <SourceList sources={sourcesForSequence(d.sequence || [])} />
                      </span>
                      <span className="finding-lift">
                        <b>{a.lift != null ? `${a.lift.toFixed(1)}×` : '—'}</b>
                        <span>{a.lift != null ? 'above normal' : 'structural'}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
              <p className="caveat">{NOT_GUILT}</p>
            </>
          )
        }}
      </Async>
    </Panel>
  )
}

/*
  Group consecutive events into sequences. A sequence spanning more than one
  record source is the thing worth seeing: independent systems corroborating
  each other.
*/
function buildSequences(events, windowMinutes = 30) {
  const groups = []
  let current = []
  for (const e of events) {
    if (!e.timestamp) continue
    if (!current.length) { current = [e]; continue }
    const gap = (new Date(e.timestamp) - new Date(current[current.length - 1].timestamp)) / 60000
    if (gap >= 0 && gap <= windowMinutes) current.push(e)
    else { groups.push(current); current = [e] }
  }
  if (current.length) groups.push(current)
  return groups
    .map(g => ({ events: g, domains: [...new Set(g.map(e => e.domain))] }))
    .filter(g => g.events.length > 1)
    .sort((a, b) => b.domains.length - a.domains.length || b.events.length - a.events.length)
}

function ActivitySequence({ group }) {
  const cross = group.domains.length > 1
  return (
    <div className={`seq ${cross ? 'is-cross' : ''}`}>
      <div className="seq-head">
        <span className="seq-title">
          {cross ? 'Cross-source activity sequence' : 'Activity sequence'}
        </span>
        <span className="seq-date">{fmtDateTime(group.events[0].timestamp)}</span>
      </div>
      <ol className="seq-steps">
        {group.events.map((e, i) => {
          const prev = i > 0 ? group.events[i - 1] : null
          const amount = e.amount ? fmtInr(e.amount) : null
          return (
            <li key={e.event_id}>
              {prev && (
                <div className="seq-gap">
                  <span aria-hidden="true">↓</span> {formatGap(prev.timestamp, e.timestamp)}
                </div>
              )}
              <div className="seq-step">
                <time className="seq-time mono">{fmtTime(e.timestamp)}</time>
                <span className="seq-what">
                  <span className={`seq-kind dom-${e.domain}`}>
                    {amount ? `${amount} ${eventLabel(e.event_type)}` : eventLabel(e.event_type)}
                  </span>
                  <span className="seq-who mono">
                    {e.actor_entity || e.actor || '—'}
                    {(e.target_entity || e.target) ? ` → ${e.target_entity || e.target}` : ''}
                  </span>
                </span>
                <Chip domain={e.domain}>{sourceLabel(e.domain)}</Chip>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function InvestigationTimeline({ state, caseId }) {
  return (
    <Panel title={`Investigation timeline — ${caseId || 'no case selected'}`}>
      <Async state={state} rows={4}>
        {data => {
          const events = data.events || []
          const sequences = buildSequences(events)
          if (!sequences.length) {
            return <Empty headline="No multi-step sequences"
              detail="Events in this case do not cluster into cross-source sequences." />
          }
          return (
            <>
              {sequences.slice(0, 2).map((g, i) => <ActivitySequence key={i} group={g} />)}
              {sequences.length > 2 && (
                <Disclosure summary={`Show ${sequences.length - 2} more sequences`}>
                  {sequences.slice(2).map((g, i) => <ActivitySequence key={i} group={g} />)}
                </Disclosure>
              )}
            </>
          )
        }}
      </Async>
    </Panel>
  )
}

/* Data sources: a readable checklist, with the dense table behind disclosure. */
function DataSourceStatus({ state, caseId }) {
  const ALL = ['cdr', 'ipdr', 'bank', 'social']
  return (
    <Panel title="Data sources">
      <Async state={state} rows={3}>
        {data => {
          const cases = data.cases || []
          const active = cases.find(c => c.case_id === caseId) || cases[0]
          if (!active) return <Empty headline="No cases ingested" />
          const present = active.data_sources || []
          return (
            <>
              <div className="src-case mono">{active.case_id}</div>
              <ul className="src-check">
                {ALL.map(s => (
                  <li key={s} className={present.includes(s) ? 'yes' : 'no'}>
                    <span className="src-mark" aria-hidden="true">
                      {present.includes(s) ? '✓' : '—'}
                    </span>
                    {sourceLabel(s)}
                    {!present.includes(s) && <span className="dim"> not supplied</span>}
                  </li>
                ))}
              </ul>
              <div className="src-totals">
                <span><b>{fmtNum(active.events)}</b> events</span>
                <span className={active.quarantined ? 'warn' : ''}>
                  <b>{active.quarantined}</b> quarantined
                </span>
              </div>

              <Disclosure summary="All cases in detail">
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
                  rows={cases}
                />
              </Disclosure>
            </>
          )
        }}
      </Async>
    </Panel>
  )
}

export function Dashboard({ caseId, onNavigate }) {
  const cases = useApi(() => api.cases(), [])
  const alerts = useApi(() => api.alerts(), [])
  const timeline = useApi(() => api.timeline(caseId, { limit: 120 }), [caseId],
    { enabled: !!caseId })
  const graph = useApi(() => api.graph(caseId), [caseId], { enabled: !!caseId })

  const all = cases.data?.cases || []
  const open = alerts.data?.alerts || []
  const high = open.filter(a => a.severity === 'HIGH')
  const top = open[0] || null

  const openInvestigation = () => onNavigate('alerts')

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Investigation overview</h1>
        <span className="page-sub">Synthetic benchmark data</span>
      </div>

      {/* Counters, not a wall of KPI cards. */}
      <div className="counters">
        <span><b>{cases.loading ? '—' : all.length}</b> active cases</span>
        <span className="sep" aria-hidden="true">·</span>
        <span><b>{alerts.loading ? '—' : open.length}</b> open findings</span>
        <span className="sep" aria-hidden="true">·</span>
        <span className={high.length ? 'warn' : ''}>
          <b>{alerts.loading ? '—' : high.length}</b> high priority
        </span>
      </div>

      <div className="dash-grid">
        <div className="dash-main">
          <Async state={alerts} rows={3}>
            {() => <PriorityInvestigation alert={top} onOpen={openInvestigation} />}
          </Async>
          <PriorityFindings state={alerts} onOpen={openInvestigation} />
          <InvestigationTimeline state={timeline} caseId={caseId} />
        </div>
        <aside className="dash-side">
          <DataSourceStatus state={cases} caseId={caseId} />
        </aside>
      </div>

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

/*
  Cases: interpretation, not records.

  The old page was a spreadsheet — case_id, events, entities, quarantined,
  first_event — which answers "what is in the database?" This one answers
  "which investigation needs attention, and why?"

  Raw counts, batches, hashes and quarantine figures still exist; they moved
  behind disclosure or to the Evidence page, where an investigator goes
  deliberately rather than by default.

  Everything shown is derived from the API. No case is described by hand.
*/

function SourceBadge({ source }) {
  const def = SOURCE_DEFS[source]
  if (!def) return <Chip domain={source}>{source.toUpperCase()}</Chip>
  return (
    <Hint tip={def.tip}>
      <span className={`src-badge dom-${source}`}>{def.name}</span>
    </Hint>
  )
}

function SourceChecklist({ sources = [] }) {
  const ALL = ['bank', 'cdr', 'ipdr', 'social']
  return (
    <ul className="src-legend">
      {ALL.map(s => {
        const has = sources.includes(s)
        const def = SOURCE_DEFS[s]
        return (
          <li key={s} className={has ? 'yes' : 'no'}>
            <span className="src-mark" aria-hidden="true">{has ? '✓' : '—'}</span>
            <Hint tip={def.tip}>
              <span>{def.name} <span className="t-dim">— {def.full}</span></span>
            </Hint>
          </li>
        )
      })}
    </ul>
  )
}

function StatusText({ kase, alerts }) {
  const status = caseStatus(kase, alerts)
  const priority = casePriority(alerts)
  const tone = priority === 'HIGH' ? 'high' : priority === 'MEDIUM' ? 'medium' : 'low'
  return (
    <span className="case-status">
      <span className={`status-dot tone-${tone}`} aria-hidden="true" />
      {status}
    </span>
  )
}

/* The 2–3 cases that deserve attention first, as readable cards. */
function PriorityCase({ kase, alerts, onOpen }) {
  const top = alerts[0]
  const detail = top?.detail || {}
  const sources = kase.data_sources || []
  const priority = casePriority(alerts)

  return (
    <article className={`pcase tone-${priority.toLowerCase()}`}
      onClick={() => onOpen(kase.case_id)} role="button" tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onOpen(kase.case_id)}>
      <div className="pcase-top">
        <Pill tone={priority === 'HIGH' ? 'high' : priority === 'MEDIUM' ? 'medium' : 'low'}>
          {priorityLabel(priority)} priority
        </Pill>
        <code className="tech-id">{kase.case_id}</code>
      </div>

      <h3 className="pcase-title">{caseHeadline(kase, alerts)}</h3>

      {top && (
        <div className="pcase-subject">
          Subject <strong>{subjectLabel(top.entity_id)}</strong>
        </div>
      )}

      {detail.sequence?.length > 0 && (
        <ol className="pcase-seq">
          {detail.sequence.map((step, i) => (
            <li key={i}>
              {i > 0 && <span className="pcase-arrow" aria-hidden="true">↓</span>}
              <span className={`pcase-step dom-${sourcesForSequence([step])[0] || 'entity'}`}>
                {eventLabel(step)}
              </span>
            </li>
          ))}
        </ol>
      )}

      {top?.lift != null && (
        <div className="pcase-lift">
          <b>{top.lift.toFixed(1)}×</b> historical baseline
        </div>
      )}
      {top && top.lift == null && (
        <div className="pcase-lift subtle">{findingLabel(top.pattern, detail.sequence)}</div>
      )}

      <div className="pcase-src">
        {sources.map(s => <SourceBadge key={s} source={s} />)}
      </div>

      <div className="pcase-scale">
        {fmtNum(kase.events)} events · {kase.entities} {kase.entities === 1 ? 'entity' : 'entities'}
        {' '}· {alerts.length} {alerts.length === 1 ? 'finding' : 'findings'}
      </div>

      <button className="btn primary" onClick={e => { e.stopPropagation(); onOpen(kase.case_id) }}>
        Open investigation
      </button>
    </article>
  )
}

/* One row of the full list. Reads as a summary, not a spreadsheet row. */
function CaseRow({ kase, alerts, selected, onOpen }) {
  const top = alerts[0]
  const priority = casePriority(alerts)

  return (
    <article className={`crow ${selected ? 'is-selected' : ''} tone-${priority.toLowerCase()}`}
      onClick={() => onOpen(kase.case_id)} role="button" tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onOpen(kase.case_id)}>
      <div className="crow-head">
        <div>
          <h3 className="crow-title">{caseHeadline(kase, alerts)}</h3>
          <code className="tech-id">{kase.case_id}</code>
        </div>
        <StatusText kase={kase} alerts={alerts} />
      </div>

      <div className="crow-scale">
        <span><b>{fmtNum(kase.events)}</b> events</span>
        <span><b>{kase.entities}</b> {kase.entities === 1 ? 'entity' : 'entities'}</span>
        <span className={alerts.length ? 'warn' : ''}>
          <b>{alerts.length}</b> {alerts.length === 1 ? 'finding' : 'findings'}
        </span>
      </div>

      <div className="crow-grid">
        <div>
          <div className="crow-label">Data sources</div>
          <div className="crow-src">
            {(kase.data_sources || []).map(s => <SourceBadge key={s} source={s} />)}
          </div>
        </div>

        <div>
          <div className="crow-label">{top ? 'Key finding' : 'Status'}</div>
          <div className="crow-finding">
            {top
              ? findingLabel(top.pattern, top.detail?.sequence)
              : 'No current high-priority findings'}
          </div>
        </div>

        <div>
          <div className="crow-label">{top?.lift != null ? 'Unusualness' : 'Latest activity'}</div>
          <div className="crow-finding">
            {top?.lift != null
              ? <><b>{top.lift.toFixed(1)}×</b> baseline</>
              : fmtDateTime(kase.last_event)}
          </div>
        </div>
      </div>

      <button className="btn" onClick={e => { e.stopPropagation(); onOpen(kase.case_id) }}>
        View investigation
      </button>
    </article>
  )
}

/* Level 2: the selected case, explained. */
function CaseSummary({ caseId, alerts, onNavigate }) {
  const detail = useApi(() => api.case(caseId), [caseId], { enabled: !!caseId })
  const top = alerts[0]
  const subject = top?.entity_id
  const events = useApi(
    () => api.timeline(caseId, { limit: 60, entity_id: subject || '' }),
    [caseId, subject], { enabled: !!caseId })

  const story = caseStory(top, events.data?.events || [])
  const keyActivity = (events.data?.events || []).slice(0, 6)

  return (
    <Async state={detail} rows={4}>
      {d => (
        <div className="csum">
          <header className="csum-head">
            <div>
              <h2 className="csum-title">{caseHeadline(d, alerts)}</h2>
              <code className="tech-id">{caseId}</code>
            </div>
            <StatusText kase={d} alerts={alerts} />
          </header>

          <dl className="csum-facts">
            <div><dt>Status</dt><dd>{caseStatus(d, alerts)}</dd></div>
            <div><dt>Priority</dt><dd>{priorityLabel(casePriority(alerts))}</dd></div>
            {subject && <div><dt>Subject</dt><dd>{subjectLabel(subject)}</dd></div>}
          </dl>

          {story && (
            <section className="csum-story">
              <h3 className="csum-h">Case story</h3>
              <p>{story}</p>
              <p className="caveat">{NOT_GUILT}</p>
            </section>
          )}

          {top && (
            <section>
              <h3 className="csum-h">Why this case matters</h3>
              <p className="csum-text">
                {top.detail?.interpretation
                  || findingMeaning(top.pattern)}
              </p>
            </section>
          )}

          <section>
            <h3 className="csum-h">Data sources</h3>
            <SourceChecklist sources={d.data_sources || []} />
          </section>

          {keyActivity.length > 0 && (
            <section>
              <h3 className="csum-h">Key activity</h3>
              <ul className="csum-acts">
                {keyActivity.map(e => (
                  <li key={e.event_id}>
                    <time className="mono">{fmtTime(e.timestamp)}</time>
                    <span className={`dom-${e.domain}`}>
                      {e.amount ? `${fmtInr(e.amount)} ${eventLabel(e.event_type).toLowerCase()}` : eventLabel(e.event_type)}
                    </span>
                    <span className="t-dim mono">
                      {e.actor_entity || e.actor}
                      {(e.target_entity || e.target) ? ` → ${e.target_entity || e.target}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {alerts.length > 0 && (
            <section>
              <h3 className="csum-h">Findings</h3>
              <ul className="csum-findings">
                {alerts.map(a => (
                  <li key={a.alert_id}>
                    <span className={`status-dot tone-${severityClass(a.severity)}`} aria-hidden="true" />
                    <span className="csum-fname">{findingLabel(a.pattern, a.detail?.sequence)}</span>
                    <span className="t-dim">
                      {a.lift != null ? `${a.lift.toFixed(1)}× baseline` : priorityLabel(a.severity) + ' priority'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="csum-actions">
            <button className="btn primary" onClick={() => onNavigate('alerts')}>Open investigation</button>
            <button className="btn" onClick={() => onNavigate('network')}>View graph</button>
            <button className="btn" onClick={() => onNavigate('timeline')}>View timeline</button>
            <button className="btn" onClick={() => onNavigate('evidence')}>View evidence</button>
            <button className="btn" onClick={() => onNavigate('reports')}>Generate report</button>
          </div>

          <Disclosure summary="Technical detail">
            <dl className="kv">
              <dt>Case id</dt><dd className="mono">{caseId}</dd>
              <dt>Events stored</dt><dd>{fmtNum(d.events)}</dd>
              <dt>Quarantined</dt><dd>{d.quarantined}</dd>
              <dt>Ingestion batches</dt><dd>{d.batches?.length || 0}</dd>
              <dt>First record</dt><dd>{fmtDateTime(d.first_event)}</dd>
              <dt>Last record</dt><dd>{fmtDateTime(d.last_event)}</dd>
            </dl>
            <p className="t-dim" style={{ fontSize: 12, marginTop: 8 }}>
              Source hashes and per-record provenance are on the Evidence page.
            </p>
            <CaseMetadataForm caseId={caseId} initial={d.case_metadata}
              onSaved={detail.reload} />
          </Disclosure>
        </div>
      )}
    </Async>
  )
}

export function Cases({ caseId, onSelectCase, onNavigate }) {
  const [query, setQuery] = useState('')
  const [only, setOnly] = useState('all')
  const cases = useApi(() => api.cases(), [])
  const alerts = useApi(() => api.alerts(), [])

  const byCase = useMemo(() => {
    const map = {}
    for (const a of alerts.data?.alerts || []) (map[a.case_id] ||= []).push(a)
    // highest lift first, structural findings after scored ones
    Object.values(map).forEach(list => list.sort((x, y) => (y.lift || 0) - (x.lift || 0)))
    return map
  }, [alerts.data])

  const all = useMemo(() => cases.data?.cases || [], [cases.data])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter(k => {
      const list = byCase[k.case_id] || []
      if (only === 'priority' && casePriority(list) === 'NORMAL') return false
      if (only === 'findings' && !list.length) return false
      if (!q) return true
      return k.case_id.toLowerCase().includes(q)
        || caseHeadline(k, list).toLowerCase().includes(q)
        || list.some(a => findingLabel(a.pattern, a.detail?.sequence).toLowerCase().includes(q))
    })
  }, [all, byCase, query, only])

  const ranked = useMemo(() => {
    const weight = k => {
      const list = byCase[k.case_id] || []
      const p = casePriority(list)
      return (p === 'HIGH' ? 2000 : p === 'MEDIUM' ? 1000 : 0)
        + (list[0]?.lift || 0) + list.length
    }
    return [...visible].sort((a, b) => weight(b) - weight(a))
  }, [visible, byCase])

  const priority = ranked.filter(k => casePriority(byCase[k.case_id] || []) !== 'NORMAL').slice(0, 3)
  const totals = {
    cases: all.length,
    high: all.filter(k => casePriority(byCase[k.case_id] || []) === 'HIGH').length,
    findings: (alerts.data?.alerts || []).length,
    multi: all.filter(k => (k.data_sources || []).length > 1).length,
  }

  const select = id => onSelectCase(id)

  return (
    <div className="cases-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Case investigations</h1>
          <p className="page-lede">
            Review active investigations, cross-source findings, entities and evidence.
          </p>
        </div>
        <div className="spacer" />
        <input type="search" placeholder="Search cases…" value={query}
          onChange={e => setQuery(e.target.value)} style={{ width: 200 }} />
        <div className="seg" role="group" aria-label="Filter cases">
          {[['all', 'All'], ['priority', 'Priority'], ['findings', 'With findings']].map(
            ([v, label]) => (
              <button key={v} className={only === v ? 'on' : ''}
                onClick={() => setOnly(v)}>{label}</button>
            ))}
        </div>
      </div>

      <div className="counters">
        <span><b>{cases.loading ? '—' : totals.cases}</b> active cases</span>
        <span className="sep" aria-hidden="true">·</span>
        <span className={totals.high ? 'warn' : ''}><b>{totals.high}</b> high priority</span>
        <span className="sep" aria-hidden="true">·</span>
        <span><b>{totals.findings}</b> open findings</span>
        <span className="sep" aria-hidden="true">·</span>
        <span><b>{totals.multi}</b> multi-source</span>
      </div>

      <Async state={cases} rows={4}>
        {() => (
          <>
            {priority.length > 0 && (
              <section className="cases-section">
                <h2 className="section-h">Priority investigations</h2>
                <div className="pcases">
                  {priority.map(k => (
                    <PriorityCase key={k.case_id} kase={k}
                      alerts={byCase[k.case_id] || []} onOpen={select} />
                  ))}
                </div>
              </section>
            )}

            <section className="cases-section">
              <h2 className="section-h">All investigations</h2>
              {ranked.length === 0
                ? <Empty headline="No cases match" detail="Adjust the search or filter." />
                : (
                  <div className="crows">
                    {ranked.map(k => (
                      <CaseRow key={k.case_id} kase={k} alerts={byCase[k.case_id] || []}
                        selected={k.case_id === caseId} onOpen={select} />
                    ))}
                  </div>
                )}
            </section>

            {caseId && (
              <section className="cases-section">
                <h2 className="section-h">Selected investigation</h2>
                <Panel>
                  <CaseSummary caseId={caseId} alerts={byCase[caseId] || []}
                    onNavigate={onNavigate || (() => {})} />
                </Panel>
              </section>
            )}
          </>
        )}
      </Async>
    </div>
  )
}

/* ── Entities ──────────────────────────────────────────────────────────── */

/*
  Entities: organised around people, not rows.

  The previous page listed 48 identifier rows with empty Connections and Events
  columns — a database view that answered "what is stored?" rather than "who is
  in this case, and what do we know about them?"

  Identifiers still matter, so each subject carries its own, and the flat list
  remains available behind disclosure for anyone who wants to scan values.
*/

const IDENTIFIER_LABELS = {
  PHONE: 'Phone', BANK_ACCOUNT: 'Bank account', DEVICE: 'Device',
  IMEI: 'IMEI (handset)', IMSI: 'IMSI (SIM)', IP: 'IP address',
  SOCIAL_HANDLE: 'Social account', UPI: 'UPI handle', ENTITY: 'Entity id',
}
const identifierLabel = t => IDENTIFIER_LABELS[t] || t

function SubjectCard({ person, identifiers, caseId, onOpenEntity, onNavigate }) {
  const detail = useApi(() => api.entity(person.id, caseId), [person.id, caseId],
    { enabled: !!caseId })
  const activity = detail.data?.activity || {}
  const related = detail.data?.related_entities || []
  const crossDomain = related.filter(r => r.cross_domain)

  return (
    <article className="subject" onClick={() => onOpenEntity(person.id)}
      role="button" tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onOpenEntity(person.id)}>
      <header className="subject-head">
        <h3 className="subject-name">
          {subjectLabel(person.id)}
          <code className="tech-id">{person.id}</code>
        </h3>
        <span className="subject-count">
          {person.connections} connected {person.connections === 1 ? 'entity' : 'entities'}
        </span>
      </header>

      <div className="subject-grid">
        <div>
          <div className="crow-label">Identifiers</div>
          {identifiers.length ? (
            <ul className="ident-list">
              {identifiers.map(i => (
                <li key={`${i.type}-${i.id}`}>
                  <span className="ident-type">{identifierLabel(i.type)}</span>
                  <span className="mono">{i.id}</span>
                </li>
              ))}
            </ul>
          ) : <span className="t-dim">None resolved</span>}
        </div>

        <div>
          <div className="crow-label">Activity</div>
          {Object.keys(activity).length ? (
            <ul className="ident-list">
              {Object.entries(activity).map(([type, n]) => (
                <li key={type}>
                  <span className="ident-type">{eventLabel(type)}</span>
                  <span className="mono">{fmtNum(n)}</span>
                </li>
              ))}
            </ul>
          ) : detail.loading ? <span className="t-dim">Loading…</span>
            : <span className="t-dim">No recorded activity</span>}
        </div>

        <div>
          <div className="crow-label">Connected to</div>
          {related.length ? (
            <ul className="ident-list">
              {related.slice(0, 4).map(r => (
                <li key={r.entity}>
                  <span className="ident-type">{r.entity}</span>
                  <span className={r.cross_domain ? 'cross' : 't-dim'}>
                    {r.relationships.map(eventLabel).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          ) : <span className="t-dim">No counterparties recorded</span>}
          {crossDomain.length > 0 && (
            <p className="subject-note">
              {crossDomain.length} {crossDomain.length === 1 ? 'link is' : 'links are'}
              {' '}corroborated by more than one record source.
            </p>
          )}
        </div>
      </div>

      <div className="subject-actions">
        <button className="btn" onClick={e => { e.stopPropagation(); onOpenEntity(person.id) }}>
          View investigation
        </button>
        <button className="btn" onClick={e => { e.stopPropagation(); onNavigate?.('network') }}>
          View network
        </button>
      </div>
    </article>
  )
}

export function Entities({ caseId, onOpenEntity, onNavigate, onSelectCase }) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('ALL')
  const cases = useApi(() => api.cases(), [])
  const state = useApi(() => api.entities(caseId), [caseId], { enabled: !!caseId })

  if (!caseId) return <Empty headline="Select a case first" />

  const rows = state.data?.entities || []
  const counts = state.data?.counts || {}
  const people = rows.filter(r => r.kind === 'PERSON')
  const identifiers = rows.filter(r => r.kind === 'IDENTIFIER')

  const byPerson = {}
  identifiers.forEach(i => { (byPerson[i.linked_to] ||= []).push(i) })

  const q = query.trim().toLowerCase()
  const matches = person => {
    if (!q) return true
    if (person.id.toLowerCase().includes(q)) return true
    return (byPerson[person.id] || []).some(i => i.id.toLowerCase().includes(q))
  }
  const visiblePeople = people.filter(matches)
  const visibleIdentifiers = identifiers.filter(i =>
    (kind === 'ALL' || i.type === kind)
    && (!q || i.id.toLowerCase().includes(q) || (i.linked_to || '').toLowerCase().includes(q)))

  const types = [...new Set(identifiers.map(i => i.type))].sort()
  const relationships = people.reduce((sum, p) => sum + (p.connections || 0), 0)

  return (
    <div className="entities-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Entities</h1>
          <p className="page-lede">
            People, identifiers and relationships resolved from authorised case data.
          </p>
        </div>
        <div className="spacer" />
        <input type="search" placeholder="Search subject or identifier…" value={query}
          onChange={e => setQuery(e.target.value)} style={{ width: 220 }} />
        <label className="field"><span>Case</span>
          <select value={caseId} onChange={e => onSelectCase?.(e.target.value)}>
            {(cases.data?.cases || []).map(c => (
              <option key={c.case_id} value={c.case_id}>{c.case_id}</option>
            ))}
          </select>
        </label>
        <label className="field"><span>Type</span>
          <select value={kind} onChange={e => setKind(e.target.value)}>
            <option value="ALL">All</option>
            {types.map(t => <option key={t} value={t}>{identifierLabel(t)}</option>)}
          </select>
        </label>
      </div>

      <div className="counters">
        <span><b>{state.loading ? '—' : counts.people ?? 0}</b> people</span>
        <span className="sep" aria-hidden="true">·</span>
        <span><b>{state.loading ? '—' : counts.identifiers ?? 0}</b> identifiers</span>
        <span className="sep" aria-hidden="true">·</span>
        <span><b>{relationships}</b> relationships</span>
        <span className="sep" aria-hidden="true">·</span>
        <span><b>{people.filter(pp => (pp.events || 0) > 0).length}</b> active</span>
        <span className="sep" aria-hidden="true">·</span>
        <span className="t-dim">case <code className="tech-id">{caseId}</code></span>
      </div>

      <Async state={state} rows={4}>
        {d => (!people.length ? (
          <Panel>
            <Empty headline="No people resolved for this case"
              detail={d.no_people_reason
                || 'No identifier in this case resolved to a person.'} />
            {d.counts?.quarantined > 0 && (
              <p className="t-dim" style={{ fontSize: 13, marginTop: 8 }}>
                {d.counts.quarantined} of {d.counts.records} records were quarantined.
                They are retained and can be reviewed on the Evidence page.
              </p>
            )}
          </Panel>
        ) : (
          <>
            <section className="cases-section">
              <h2 className="section-h">Subjects</h2>
              {visiblePeople.length ? (
                <div className="subjects">
                  {visiblePeople.map(p => (
                    <SubjectCard key={p.id} person={p} identifiers={byPerson[p.id] || []}
                      caseId={caseId} onOpenEntity={onOpenEntity} onNavigate={onNavigate} />
                  ))}
                </div>
              ) : <Empty headline="No subject matches that search" />}
            </section>

            <section className="cases-section">
              <h2 className="section-h">All identifiers</h2>
              <Panel flush>
                <Disclosure summary={`Show the full identifier list (${visibleIdentifiers.length})`}>
                  <Table
                    rowKey={r => `${r.type}-${r.id}-${r.linked_to}`}
                    columns={[
                      { key: 'type', label: 'Type',
                        render: r => identifierLabel(r.type) },
                      { key: 'id', label: 'Identifier', className: 'mono' },
                      { key: 'linked_to', label: 'Belongs to',
                        render: r => (r.linked_to
                          ? <span>{subjectLabel(r.linked_to)}</span>
                          : <span className="t-dim">Unresolved</span>) },
                      { key: 'origin', label: 'Basis',
                        render: r => (r.origin === 'INFERRED'
                          ? <Pill tone="medium">Inferred</Pill>
                          : <span className="t-dim">Declared</span>) },
                    ]}
                    rows={visibleIdentifiers}
                    empty={<Empty headline="No identifiers match" />}
                  />
                </Disclosure>
              </Panel>
            </section>
          </>
        ))}
      </Async>
    </div>
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

/*
  Showing every node at once produces a hairball nobody can read. The graph
  opens focused on one subject and one hop, and the investigator widens it
  deliberately.

  Link groups let them ask a specific question — "who did this subject move
  money with?" — without the communication edges on top of the answer.
*/
const LINK_GROUPS = {
  all: null,
  financial: ['TRANSFERRED'],
  communication: ['CALLED', 'MESSAGED'],
  digital: ['CONNECTED_FROM', 'LOGGED_IN_FROM', 'POSTED', 'CONNECTED_TO'],
}
const OWNERSHIP = ['OWNS', 'USES', 'IDENTIFIES']

function focusGraph(graph, { root, hops, linkGroup }) {
  if (!graph?.nodes?.length) return graph
  if (!root || hops === 'all') return graph

  const allowed = LINK_GROUPS[linkGroup]
  const edges = (graph.edges || []).filter(e =>
    !allowed || allowed.includes(e.relationship) || OWNERSHIP.includes(e.relationship))

  // Ownership is free to traverse, activity is what counts as a hop.
  //
  // Activity edges run identifier-to-identifier (phone CALLED phone), so a
  // person reaches another person only via own-identifier → their-identifier →
  // them. Charging a hop for each of those would put a direct contact three
  // hops away and make "direct links" show nobody. Instead, ownership closes
  // for free and one hop means one real interaction.
  const ownership = edges.filter(e => OWNERSHIP.includes(e.relationship))
  const activity = edges.filter(e => !OWNERSHIP.includes(e.relationship))

  const closeOwnership = set => {
    let grew = true
    while (grew) {
      grew = false
      ownership.forEach(e => {
        if (set.has(e.source) && !set.has(e.target)) { set.add(e.target); grew = true }
        if (set.has(e.target) && !set.has(e.source)) { set.add(e.source); grew = true }
      })
    }
    return set
  }

  const keep = closeOwnership(new Set([root]))
  let frontier = new Set(keep)
  for (let hop = 0; hop < Number(hops); hop++) {
    const reached = new Set()
    activity.forEach(e => {
      if (frontier.has(e.source) && !keep.has(e.target)) reached.add(e.target)
      if (frontier.has(e.target) && !keep.has(e.source)) reached.add(e.source)
    })
    if (!reached.size) break
    reached.forEach(id => keep.add(id))
    closeOwnership(keep)
    frontier = reached
  }

  return {
    ...graph,
    nodes: graph.nodes.filter(n => keep.has(n.id)),
    edges: edges.filter(e => keep.has(e.source) && keep.has(e.target)),
  }
}

/* Shown before anything is selected: orient the investigator in the case. */
function NetworkSummary({ graph, metrics, people, focusRoot }) {
  if (!graph?.nodes?.length) {
    return <div className="t-dim" style={{ fontSize: 13 }}>
      No graph has been projected for this case yet.
    </div>
  }
  const identifiers = graph.nodes.filter(n => n.label !== 'Person')
  const observed = graph.edges.filter(n => !['OWNS', 'USES', 'IDENTIFIES'].includes(n.relationship))
  const busiest = metrics?.metrics
    ? Object.entries(metrics.metrics).sort((a, b) => b[1].degree - a[1].degree)[0]
    : null

  return (
    <div className="netsum">
      <dl className="kv">
        <dt>Subjects</dt><dd>{people.length}</dd>
        <dt>Identifiers</dt><dd>{identifiers.length}</dd>
        <dt>Relationships</dt><dd>{graph.edges.length}</dd>
        <dt>Observed interactions</dt><dd>{observed.length}</dd>
      </dl>
      {busiest && (
        <p className="netsum-note">
          Most connected: <strong>{subjectLabel(busiest[0])}</strong>{' '}
          <span className="t-dim">({busiest[1].degree} direct links)</span>
        </p>
      )}
      {focusRoot && (
        <p className="netsum-note t-dim">
          The view is centred on {subjectLabel(focusRoot)}. Widen it with the depth
          controls above, or select a node to inspect it.
        </p>
      )}
    </div>
  )
}

/* Shown after a node is clicked. */
function NodeDetail({ node, caseId, graph, onNavigate, onOpenEntity }) {
  const isPerson = node.label === 'Person'
  const detail = useApi(() => api.entity(node.id, caseId), [node.id, caseId],
    { enabled: isPerson && !!caseId })

  const own = (graph?.edges || []).filter(e =>
    ['OWNS', 'USES', 'IDENTIFIES'].includes(e.relationship)
    && (e.source === node.id || e.target === node.id))
  const links = (graph?.edges || []).filter(e =>
    !['OWNS', 'USES', 'IDENTIFIES'].includes(e.relationship)
    && (e.source === node.id || e.target === node.id))

  return (
    <div className="nodedetail">
      <div className="nodedetail-head">
        <strong>{isPerson ? subjectLabel(node.id) : node.id}</strong>
        <code className="tech-id">{node.label}</code>
      </div>

      {isPerson && detail.data?.activity && Object.keys(detail.data.activity).length > 0 && (
        <>
          <div className="crow-label" style={{ marginTop: 12 }}>Activity</div>
          <ul className="ident-list">
            {Object.entries(detail.data.activity).map(([type, n]) => (
              <li key={type}>
                <span className="ident-type">{eventLabel(type)}</span>
                <span className="mono">{fmtNum(n)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {isPerson && detail.data?.related_entities?.length > 0 && (
        <>
          <div className="crow-label" style={{ marginTop: 12 }}>Connected to</div>
          <ul className="ident-list">
            {detail.data.related_entities.map(r => (
              <li key={r.entity}>
                <span className="ident-type">{r.entity}</span>
                <span className={r.cross_domain ? 'cross' : 't-dim'}>
                  {r.relationships.map(eventLabel).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {own.length > 0 && (
        <>
          <div className="crow-label" style={{ marginTop: 12 }}>
            {isPerson ? 'Identifiers linked to this subject' : 'Belongs to'}
          </div>
          <ul className="ident-list">
            {own.slice(0, 8).map((e, i) => (
              <li key={i}>
                <span className="ident-type">
                  {e.relationship === 'OWNS' ? 'Linked to subject' : 'Associated with subject'}
                </span>
                <span className="mono">{e.source === node.id ? e.target : e.source}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {links.length === 0 && (
        <p className="t-dim" style={{ fontSize: 12.5, marginTop: 10 }}>
          No observed interactions involve this node directly.
        </p>
      )}

      <div className="nodedetail-actions">
        {isPerson && (
          <button className="btn sm" onClick={() => onOpenEntity?.(node.id)}>
            Open entity
          </button>
        )}
        <button className="btn sm" onClick={() => onNavigate?.('timeline')}>View timeline</button>
        <button className="btn sm" onClick={() => onNavigate?.('alerts')}>View findings</button>
      </div>
    </div>
  )
}

export function Network({ caseId, onOpenEntity, onNavigate }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null)
  const [root, setRoot] = useState('')
  const [hops, setHops] = useState('1')
  const [linkGroup, setLinkGroup] = useState('all')
  const graph = useApi(() => api.graph(caseId), [caseId], { enabled: !!caseId })
  const metrics = useApi(() => api.networkMetrics(caseId), [caseId], { enabled: !!caseId })
  const caseInfo = useApi(() => api.case(caseId), [caseId], { enabled: !!caseId })
  // Carries no_people_reason: why a case resolved to nothing, in words.
  const registry = useApi(() => api.entities(caseId), [caseId], { enabled: !!caseId })
  const [building, setBuilding] = useState(false)
  const [buildResult, setBuildResult] = useState(null)

  const build = async () => {
    setBuilding(true)
    setBuildResult(null)
    try {
      const result = await api.buildGraph(caseId)
      setBuildResult(result)
      graph.reload()
      metrics.reload()
    } catch (err) {
      // Surface the real reason rather than leaving the button looking stuck.
      setBuildResult({ status: 'FAILED', reason: err.message })
    } finally {
      setBuilding(false)
    }
  }

  if (!caseId) return <Empty headline="Select a case first" />

  const unavailable = graph.data?.status === 'UNAVAILABLE'
  const findings = metrics.data?.findings || []

  const people = (graph.data?.nodes || []).filter(n => n.label === 'Person')
  const focusRoot = root || findings[0]?.entity || people[0]?.id || ''
  const shown = focusGraph(graph.data, { root: focusRoot, hops, linkGroup })
  const hiddenCount = (graph.data?.nodes?.length || 0) - (shown?.nodes?.length || 0)

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Relationship network</h1>
          <p className="page-lede">
            Case <code className="tech-id">{caseId}</code>
            {caseInfo.data?.data_sources?.length > 0 && (
              <> · Sources {caseInfo.data.data_sources.map(sourceLabel).join(' · ')}</>
            )}
            {focusRoot && <> · Subject <strong>{subjectLabel(focusRoot)}</strong></>}
            {shown?.nodes?.length
              ? <> · {shown.nodes.length} shown of {graph.data.nodes.length} entities</>
              : null}
          </p>
        </div>
        <div className="spacer" />
        <input type="search" placeholder="highlight node…" value={query}
          onChange={e => setQuery(e.target.value)} style={{ width: 180 }} />
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

      {buildResult && (
        <div className={`build-result ${buildResult.status === 'OK' ? 'ok' : 'bad'}`}
          role="status">
          {buildResult.status === 'OK' ? (
            <>
              <strong>Graph ready.</strong>{' '}
              {buildResult.person_nodes} {buildResult.person_nodes === 1 ? 'subject' : 'subjects'}
              {' '}and {buildResult.identifier_nodes} identifiers projected,
              {' '}{buildResult.ownership_edges + buildResult.activity_edges} relationships written.
            </>
          ) : buildResult.status === 'EMPTY' ? (
            <><strong>Nothing to project.</strong> {buildResult.reason}</>
          ) : (
            <>
              <strong>Rebuild failed.</strong>{' '}
              {buildResult.reason || 'The graph database did not accept the write.'}
              {buildResult.detail && <span className="t-dim"> {buildResult.detail}</span>}
            </>
          )}
          <button className="btn sm" onClick={() => setBuildResult(null)}>Dismiss</button>
        </div>
      )}

      <div className="focus-bar">
        <label>
          Focus on
          <select value={focusRoot} onChange={e => { setRoot(e.target.value); setSelected(null) }}>
            {people.map(p => (
              <option key={p.id} value={p.id}>{subjectLabel(p.id)}</option>
            ))}
          </select>
        </label>

        <div className="seg" role="group" aria-label="Relationship depth">
          {[['1', 'Direct links'], ['2', 'Expand 2 hops'], ['all', 'Show everything']].map(
            ([value, label]) => (
              <button key={value} className={hops === value ? 'on' : ''}
                onClick={() => setHops(value)}>{label}</button>
            ))}
        </div>

        <div className="seg" role="group" aria-label="Link type">
          {[['all', 'All links'], ['financial', 'Financial'],
            ['communication', 'Communication'], ['digital', 'Digital']].map(
            ([value, label]) => (
              <button key={value} className={linkGroup === value ? 'on' : ''}
                onClick={() => setLinkGroup(value)}>{label}</button>
            ))}
        </div>

        {hiddenCount > 0 && (
          <span className="focus-note">
            {hiddenCount} further {hiddenCount === 1 ? 'node' : 'nodes'} hidden — widen the
            view to include them
          </span>
        )}
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 320px' }}>
        <Panel flush>
          {graph.loading ? <div style={{ padding: 12 }}><Empty headline="Loading graph…" /></div>
            : graph.error ? <ErrorState error={graph.error} onRetry={graph.reload} />
              : graph.data?.nodes?.length === 0 && graph.data?.status === 'OK'
                ? <div style={{ padding: 16 }}>
                  <Empty headline="No relationships available for this case yet"
                    detail={registry.data?.no_people_reason
                      || 'Records have been ingested but no identifier in them links two parties, so there is nothing to draw.'} />
                </div>
                : graph.data?.nodes?.length
                ? <div style={{ height: 560 }}>
                  <NetworkGraph graph={shown} filters={{ query }}
                    selected={selected?.id}
                    onSelect={n => {
                      setSelected(n)
                      if (n.label === 'Person') onOpenEntity?.(n.id, { keepPage: true })
                    }} />
                </div>
                : unavailable
                  ? <div style={{ padding: 16 }}>
                    <Empty headline="Graph database unreachable"
                      detail="Neo4j did not answer, so no graph can be read. Event data, timelines and statistics are unaffected." />
                  </div>
                  : <div style={{ padding: 16 }}>
                    <Empty headline="Graph projection required"
                      detail={registry.data?.counts?.people
                        ? "This case's entities have been resolved but not yet written to the graph database."
                        : (registry.data?.no_people_reason
                          || "This case's entities have not been resolved yet.")} />
                    <button className="btn primary" onClick={build} disabled={building}
                      style={{ marginTop: 12 }}>
                      {building ? 'Building…' : 'Rebuild graph'}
                    </button>
                  </div>}
        </Panel>

        <div>
          <Panel title={selected ? 'Entity details' : 'Network summary'}>
            {selected ? (
              <NodeDetail node={selected} caseId={caseId} graph={graph.data}
                onNavigate={onNavigate} onOpenEntity={onOpenEntity} />
            ) : (
              <NetworkSummary graph={graph.data} metrics={metrics.data} people={people}
                focusRoot={focusRoot} />
            )}
          </Panel>

          <Panel title="Structural findings">
            <Async state={metrics} rows={3}>
              {d => (d.findings?.length ? (
                <>
                  {findings.map(f => (
                    <div key={f.entity} className="sfind">
                      <div className="sfind-head">
                        <span className={`status-dot tone-${f.decision === 'REVIEW' ? 'high' : 'medium'}`}
                          aria-hidden="true" />
                        <strong>{findingLabel('STRUCTURAL_BRIDGE')}</strong>
                      </div>
                      <div className="sfind-who">
                        {subjectLabel(f.entity)}
                        <code className="tech-id">{f.entity}</code>
                      </div>
                      <p className="sfind-why">{f.interpretation}</p>
                      <button className="btn sm" onClick={() => { setRoot(f.entity); setSelected(null) }}>
                        Focus on this subject
                      </button>
                    </div>
                  ))}
                  <div className="disclaimer">{d.disclaimer}</div>
                </>
              ) : <Empty headline="No structural anomaly detected"
                detail="No entity in this case's graph connects groups that would otherwise be separate." />)}
            </Async>
          </Panel>
        </div>
      </div>
    </>
  )
}

/* ── Timeline ──────────────────────────────────────────────────────────── */

export function Timeline({ caseId, onOpenEvidence }) {
  const [grouped, setGrouped] = useState(true)
  const [type, setType] = useState('')
  const [entity, setEntity] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')

  // An entity or date filter from the previous case matches nothing in the new
  // one, which reads as "this case has no events" when it simply has different
  // people. Clear the filters whenever the case changes.
  useEffect(() => {
    setEntity('')
    setType('')
    setSince('')
    setUntil('')
  }, [caseId])

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
          <label className="field"><span>View</span>
            <select value={grouped ? 'seq' : 'flat'}
              onChange={e => setGrouped(e.target.value === 'seq')}>
              <option value="seq">Grouped sequences</option>
              <option value="flat">Every event</option>
            </select>
          </label>
          <label className="field"><span>Event type</span>
            <select value={type} onChange={e => setType(e.target.value)}>
              <option value="">All</option>
              {['CALL', 'SMS', 'TRANSFER', 'DATA_SESSION', 'SOCIAL_POST', 'LOGIN']
                .map(t => <option key={t} value={t}>{eventLabel(t)}</option>)}
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
          {d => (!d.events.length ? <Empty headline="No events match these filters" />
            : grouped ? (
            <div className="tl-seq">
              {(() => {
                const groups = buildSequences(d.events)
                if (!groups.length) {
                  return <Empty headline="No multi-step sequences"
                    detail="These events do not cluster within 30 minutes of each other. Switch to “Every event” to see them individually." />
                }
                return groups.map((g, i) => (
                  <div key={i} onClick={() => onOpenEvidence(g.events[0].event_id)}
                    role="button" tabIndex={0}
                    onKeyDown={ev => ev.key === 'Enter' && onOpenEvidence(g.events[0].event_id)}
                    style={{ cursor: 'pointer' }}>
                    <ActivitySequence group={g} />
                  </div>
                ))
              })()}
              <p className="caveat">
                Events grouped where they occur within 30 minutes of one another.
                A sequence spanning more than one record source is corroborated by
                independent systems. {NOT_GUILT}
              </p>
            </div>
          ) : (
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
                        <Chip domain={domain}>{eventLabel(e.event_type)}</Chip>
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
                        <span className="t-dim"> · {e.event_type}</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </Async>
      </Panel>
    </>
  )
}

/* ── Patterns / CCC ────────────────────────────────────────────────────── */

/* Why a sequence found nothing. Each reason is actionable: it names the
   subject, and says what would have to change for a match to be possible. */
const REJECTION_LABEL = {
  MISSING_EVENT_TYPE: 'Required data absent',
  OUTSIDE_TIME_WINDOW: 'Outside the time window',
  WRONG_ORDER: 'Never in this order',
  NO_SUBJECT: 'No resolved subject',
}

function DetectionReport({ d, windowMinutes, onWiden }) {
  const g = d.diagnostics
  if (!g) return null
  const widest = Math.max(0, ...g.checks
    .map(c => c.rejection?.closest_span_minutes || 0))
  const types = Object.entries(g.canonical_event_types || {})

  return (
    <Panel title="Why no pattern was found">
      <p className="t-dim" style={{ marginBottom: '.9rem', fontSize: '.78rem' }}>
        The detector ran over every event in this case. Nothing was hidden by an
        error — these are the numbers it worked from.
      </p>

      <div className="stat-row">
        <Tile label="Events analysed" value={g.events_analysed} />
        <Tile label="Patterns checked" value={g.patterns_checked} />
        <Tile label="Time window" value={`${g.window_minutes} min`} />
        <Tile label="Subjects" value={g.subjects.length} />
        {g.events_quarantined_excluded > 0 &&
          <Tile label="Quarantined (excluded)" value={g.events_quarantined_excluded}
            tone="warn" />}
      </div>

      <div className="sub-head">Event types present in this case</div>
      {types.length === 0
        ? <p className="t-dim">No usable events — every record was quarantined.</p>
        : <div className="chip-row">
            {types.map(([t, n]) =>
              <Chip key={t} domain={t}>{t.replace(/_/g, ' ')} · {n}</Chip>)}
          </div>}

      <div className="sub-head">Sequences checked</div>
      <div className="check-list">
        {g.checks.map(c => (
          <div key={c.pattern} className="check-row">
            <div className="check-seq mono">{c.sequence.join(' → ')}</div>
            <div className="check-body">
              {c.occurrences > 0
                ? <span className="ok">{c.occurrences} occurrence
                    {c.occurrences === 1 ? '' : 's'}</span>
                : <>
                    <Pill tone="neutral">
                      {REJECTION_LABEL[c.rejection?.reason] || 'No match'}
                    </Pill>
                    <span className="check-detail">{c.rejection?.detail}</span>
                  </>}
            </div>
          </div>
        ))}
      </div>

      {widest > windowMinutes && (
        <div className="widen-hint">
          <Icon name="info" size={13} />
          <span>
            A sequence exists {Math.round(widest)} minutes apart. It is outside the
            current window, not absent.
          </span>
          <button className="btn" onClick={() => onWiden(nextWindow(widest))}>
            Retry at {nextWindow(widest)} min
          </button>
        </div>
      )}
    </Panel>
  )
}

const WINDOW_CHOICES = [15, 30, 60, 120, 360, 720, 1440]
const nextWindow = span =>
  WINDOW_CHOICES.find(w => w >= span) || WINDOW_CHOICES[WINDOW_CHOICES.length - 1]

export function Patterns({ caseId }) {
  const [permutations, setPermutations] = useState(500)
  const [windowMinutes, setWindowMinutes] = useState(30)
  const [expanded, setExpanded] = useState(null)
  const state = useApi(() => api.patterns(caseId, permutations, windowMinutes),
    [caseId, permutations, windowMinutes], { enabled: !!caseId })

  if (!caseId) return <Empty headline="Select a case first" />

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Cross-domain patterns</h1>
        <span className="page-sub">CCC engine — permutation test with FDR correction</span>
        <div className="spacer" />
        <label className="field"><span>Window</span>
          <select value={windowMinutes}
            onChange={e => setWindowMinutes(Number(e.target.value))}>
            {WINDOW_CHOICES.map(n =>
              <option key={n} value={n}>{n < 60 ? `${n} min` : `${n / 60} h`}</option>)}
          </select>
        </label>
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
              <>
                <Panel>
                  <Empty headline="No cross-source patterns detected"
                    detail={d.analysis_note ||
                      'No configured sequence occurred within the time window.'} />
                </Panel>
                <DetectionReport d={d} windowMinutes={windowMinutes}
                  onWiden={setWindowMinutes} />
              </>
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
  const preview = useApi(() => api.reportPreview(caseId), [caseId], { enabled: !!caseId })

  if (!caseId) return <Empty headline="Select a case first" />

  return (
    <div className="cases-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-lede">
            Investigation report and audit bundle for case{' '}
            <code className="tech-id">{caseId}</code>, generated from the stored
            records rather than from anything typed here.
          </p>
        </div>
      </div>

      <Async state={preview} rows={3}>
        {d => (
          <>
            <Panel title="What this report contains">
              <div className="counters" style={{ marginBottom: 14 }}>
                <span><b>{fmtNum(d.records)}</b> records</span>
                <span className="sep" aria-hidden="true">·</span>
                <span><b>{d.subjects}</b> subjects</span>
                <span className="sep" aria-hidden="true">·</span>
                <span><b>{d.identifiers}</b> identifiers</span>
                <span className="sep" aria-hidden="true">·</span>
                <span className={d.findings ? 'warn' : ''}><b>{d.findings}</b> findings</span>
                <span className="sep" aria-hidden="true">·</span>
                <span><b>{d.batches}</b> source files</span>
              </div>

              <dl className="report-docs">
                {(d.documents || []).map(doc => (
                  <div key={doc.id}>
                    <dt>{doc.name}</dt>
                    <dd>{doc.purpose}</dd>
                  </div>
                ))}
              </dl>

              <p className="caveat">
                Statistics appear with the baseline they were measured against and the
                alternative explanations considered. {NOT_GUILT}
              </p>

              <div className="csum-actions">
                <a className="btn primary" href={api.reportUrl(caseId)}
                  target="_blank" rel="noreferrer">
                  Investigation report (PDF)
                </a>
                <a className="btn" href={api.courtPackUrl(caseId)}
                  target="_blank" rel="noreferrer">
                  Court pack — exhibits only (PDF)
                </a>
                <a className="btn" href={api.auditBundleUrl(caseId)}
                  target="_blank" rel="noreferrer">
                  Audit bundle (JSON)
                </a>
              </div>

              {d.records === 0 && (
                <p className="t-dim" style={{ fontSize: 13, marginTop: 10 }}>
                  This case has no usable records
                  {d.quarantined ? ` — ${d.quarantined} were quarantined` : ''}.
                  The report will state that rather than omit it.
                </p>
              )}
            </Panel>

            <Panel title="Original messaging court pack">
              <NotConnected>
                The court-pack PDF and audit-bundle exports built for the original
                messaging pipeline read that pipeline's schema, not the multi-domain
                event store. They remain available for the messaging cases and are not
                offered here, where they would produce an empty document.
              </NotConnected>
            </Panel>
          </>
        )}
      </Async>
    </div>
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
