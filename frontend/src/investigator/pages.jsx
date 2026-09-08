/*
  Investigator pages.

  Language rule, applied throughout: the interface never asserts guilt. It
  reports what was observed, how unusual it is against a stated baseline, and
  what legitimate explanations exist. Words like "criminal" or "guilty" appear
  nowhere. Findings are "requires review", "potentially anomalous", "pattern
  detected".
*/

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  Async, Chip, Empty, ErrorState, Hint, Icon, NotConnected, Panel, Pill,
  Table, Tile, useApi,
} from './ui.jsx'
import {
  api, DOMAIN_OF, fmtDateTime, fmtInr, fmtNum, fmtP, fmtTime, severityClass,
} from './api.js'
import NetworkGraph, { edgeLabel } from './NetworkGraph.jsx'
import { Sparkline, toast } from './feedback.jsx'
import {
  NOT_GUILT, SOURCE_DEFS, caseHeadline, casePriority, caseStatus, caseStory,
  confidencePhrase, decisionLabel, eventLabel, findingLabel, findingMeaning,
  formatGap, priorityLabel, sourceLabel, sourcesForSequence, subjectLabel,
} from './labels.js'

const domainOf = t => DOMAIN_OF[t] || 'entity'

/*
  The API returns domains upper-case (CDR, BANK, IPDR, SOCIAL) while filter ids
  and CSS classes are lower-case. Comparing the two directly silently matched
  nothing — every event filtered out, and every domain colour dead. Normalise
  at every point of use.
*/
const domKey = d => String(d || '').toLowerCase()

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
                  <span className={`seq-kind dom-${domKey(e.domain)}`}>
                    {amount ? `${amount} ${eventLabel(e.event_type)}` : eventLabel(e.event_type)}
                  </span>
                  <span className="seq-who mono">
                    {e.actor_entity || e.actor || '—'}
                    {(e.target_entity || e.target) ? ` → ${e.target_entity || e.target}` : ''}
                  </span>
                </span>
                <Chip domain={domKey(e.domain)}>{sourceLabel(domKey(e.domain))}</Chip>
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
                    <span className={`dom-${domKey(e.domain)}`}>
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

/*
  Subject card.

  Reading order, enforced by weight rather than by boxes:

    1  who        Subject E-104, with the technical id demoted to a chip
    2  priority   a worded band, never colour alone
    3  why care   one line, from the finding actually recorded
    4  what we know   identifiers · activity · connections, three quiet columns
    5  what next  two actions

  Every value comes from the entity profile endpoint. Where a subject has no
  finding, the card says so — it does not leave the reader to infer that an
  empty space means innocence, nor invent a reason to care.
*/

const IDENTIFIER_ORDER = ['PHONE', 'BANK_ACCOUNT', 'UPI', 'IMEI', 'IMSI', 'DEVICE',
                          'IP', 'SOCIAL_HANDLE', 'ENTITY']

/** The one line telling an investigator why this subject is on screen. */
function subjectSummary(attention, related) {
  const finding = attention?.indicators?.find(i => i.indicator === 'FINDING')
  const crossed = (related || []).filter(r => r.cross_domain)

  if (!finding) {
    return crossed.length
      ? `No high-priority finding recorded. Linked to ${crossed.length} `
        + `${crossed.length === 1 ? 'subject' : 'subjects'} across more than one source.`
      : 'No high-priority finding currently associated with this subject.'
  }

  const domains = new Set()
  crossed.forEach(r => r.relationships.forEach(rel => domains.add(rel)))
  const money = [...domains].some(d => d === 'TRANSFER')
  const talk = [...domains].some(d => d.startsWith('CALL') || d.startsWith('SOCIAL'))

  if (money && talk) {
    return 'Potentially anomalous cross-source activity involving financial and '
      + 'communication relationships.'
  }
  return `${finding.detail}.`
}

function SubjectCard({ person, identifiers, caseId, onOpenEntity, onNavigate }) {
  const [why, setWhy] = useState(false)
  const detail = useApi(() => api.entity(person.id, caseId), [person.id, caseId],
    { enabled: !!caseId })

  const activity = detail.data?.activity || {}
  const related = detail.data?.related_entities || []
  const rows = (detail.data?.identifiers || identifiers || [])
    .slice()
    .sort((a, b) => IDENTIFIER_ORDER.indexOf(a.type) - IDENTIFIER_ORDER.indexOf(b.type))

  const attention = person.attention
  const band = attention?.band || 'LOW'
  const tone = band === 'HIGH' ? 'high' : band === 'MEDIUM' ? 'medium' : 'low'
  const sources = [...new Set(Object.keys(activity)
    .map(t => sourcesForSequence([t])[0]).filter(Boolean))]

  return (
    <article className="scard">
      <header className="scard-head">
        <h3 className="scard-who">
          {subjectLabel(person.id)}
          <code className="tech-id">{person.id}</code>
        </h3>
        <div className="scard-head-right">
          {person.activity_series?.length > 0 && (
            <span className="spark-wrap">
              <Sparkline series={person.activity_series} />
              <span className="spark-caption">
                {person.activity_series.length}-day activity
              </span>
            </span>
          )}
          <button className={`prio-pill tone-${tone}`}
            onClick={e => { e.stopPropagation(); setWhy(!why) }}
            aria-expanded={why}
            title="Show what produced this priority">
            {band} priority
          </button>
        </div>
      </header>

      <p className="scard-summary">{subjectSummary(attention, related)}</p>

      {why && (
        <div className="scard-why">
          {attention?.indicators?.length ? (
            <ul className="score-list">
              {attention.indicators.map((i, n) => (
                <li key={n}>
                  <span className="score-points">+{i.points}</span>
                  <span>{i.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="t-dim">
              No finding has been raised against this subject. The band records the
              absence of analysis, not a judgement that nothing happened.
            </p>
          )}
          <p className="caveat">{attention?.basis}</p>
        </div>
      )}

      <div className="scard-grid">
        <section>
          <h4 className="scard-label">Identifiers</h4>
          {rows.length ? (
            <dl className="kvrows">
              {rows.map(i => (
                <Fragment key={`${i.type}-${i.value}`}>
                  <dt>{identifierLabel(i.type)}</dt>
                  <dd className="mono">{i.value}</dd>
                </Fragment>
              ))}
            </dl>
          ) : <p className="t-dim">None resolved</p>}
        </section>

        <section>
          <h4 className="scard-label">Activity summary</h4>
          {Object.keys(activity).length ? (
            <dl className="kvrows">
              {Object.entries(activity)
                .sort((a, b) => b[1] - a[1])
                .map(([type, n]) => (
                  <Fragment key={type}>
                    <dt>{eventLabel(type)}</dt>
                    <dd className="num">{fmtNum(n)}</dd>
                  </Fragment>
                ))}
            </dl>
          ) : detail.loading
            ? <p className="t-dim">Loading…</p>
            : <p className="t-dim">No recorded activity</p>}
        </section>

        <section>
          <div className="scard-label-row">
            <h4 className="scard-label">Key connections</h4>
            <span className="t-dim">
              {related.length
                ? `${related.length} connected ${related.length === 1 ? 'entity' : 'entities'}`
                : 'No connected entities'}
            </span>
          </div>
          {related.slice(0, 4).map(r => (
            <div key={r.entity} className="conn">
              <button className="conn-who"
                onClick={e => { e.stopPropagation(); onOpenEntity?.(r.entity) }}>
                {r.entity}
              </button>
              <span className="conn-badges">
                {r.relationships.map(rel => (
                  <span key={rel} className="badge badge-rel">{eventLabel(rel)}</span>
                ))}
                {sourcesForSequence(r.relationships).map(d => (
                  <span key={d} className="badge badge-src">
                    {(SOURCE_DEFS[d]?.name || d).toUpperCase()}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </section>
      </div>

      <footer className="scard-foot">
        <div className="scard-actions">
          <button className="btn" onClick={() => onOpenEntity?.(person.id)}>
            View investigation
          </button>
          <button className="btn" onClick={() => onNavigate?.('network', person.id)}>
            View network
          </button>
        </div>
        <div className="scard-meta">
          {detail.data?.last_activity && (
            <span className="meta-pair">
              <span className="meta-k">Last activity</span>
              <span className="meta-v mono">{fmtDateTime(detail.data.last_activity)}</span>
            </span>
          )}
          {sources.length > 0 && (
            <span className="meta-pair">
              <span className="meta-k">Sources</span>
              <span className="meta-v">{sources.map(sourceLabel).join(' · ')}</span>
            </span>
          )}
        </div>
      </footer>
    </article>
  )
}


/*
  States the identifier display policy rather than leaving a viewer to infer it
  from whether asterisks happen to be present. The policy is set by the backend
  (SENTINEL_DATA_MODE); this only reports it.
*/
function DataModeBadge() {
  const policy = useApi(() => api.displayPolicy(), [])
  const d = policy.data
  if (!d) return null
  return (
    <Hint tip={d.explanation}>
      <span className={`mode-badge mode-${d.data_mode.toLowerCase()}`}>
        Data mode: {d.label}
      </span>
    </Hint>
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
    .sort((a, b) => (b.attention?.score || 0) - (a.attention?.score || 0))
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
        <DataModeBadge />
        <span className="sep" aria-hidden="true">·</span>
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

/* ── Search results ────────────────────────────────────────────────────── */

/*
  One query, every kind of record.

  An investigator is handed a number and asked what it is. They should not need
  to know whether it is a phone, an account or an evidence id before they can
  look it up — so the result says which kind each match is, and clicking it
  goes to the page that can act on it.
*/
export function SearchResults({ term, onNavigate, onOpenEntity, onOpenEvidence,
                                onSelectCase }) {
  const state = useApi(() => api.search(term), [term], { enabled: !!term })

  if (!term) return <Empty headline="Type a query to search" />

  const KINDS = [
    { id: 'subjects', label: 'Subjects',
      render: r => ({
        primary: subjectLabel(r.entity_id), secondary: r.case_id,
        onOpen: () => { onSelectCase?.(r.case_id); onOpenEntity?.(r.entity_id) } }) },
    { id: 'identifiers', label: 'Identifiers',
      render: r => ({
        primary: r.value, secondary: `${r.type} · belongs to ${r.entity_id}`,
        onOpen: () => { onSelectCase?.(r.case_id); onOpenEntity?.(r.entity_id) } }) },
    { id: 'evidence', label: 'Evidence records',
      render: r => ({
        primary: r.event_id,
        secondary: `${eventLabel(r.event_type)} · ${fmtDateTime(r.timestamp)} · ${r.source_file}`,
        onOpen: () => { onSelectCase?.(r.case_id); onOpenEvidence?.(r.event_id) } }) },
    { id: 'findings', label: 'Findings',
      render: r => ({
        primary: findingLabel(r.pattern),
        secondary: `${subjectLabel(r.entity_id)} · ${r.severity} · ${r.case_id}`,
        onOpen: () => { onSelectCase?.(r.case_id); onNavigate?.('alerts') } }) },
    { id: 'cases', label: 'Cases',
      render: r => ({
        primary: r.case_id, secondary: 'Investigation',
        onOpen: () => { onSelectCase?.(r.case_id); onNavigate?.('cases') } }) },
  ]

  return (
    <div className="cases-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Search</h1>
          <p className="page-lede">
            Results for <code className="tech-id">{term}</code>
            {state.data && <> · {state.data.total} {state.data.total === 1 ? 'match' : 'matches'}</>}
          </p>
        </div>
      </div>

      <Async state={state} rows={4}>
        {d => (d.total === 0 ? (
          <Panel>
            <Empty headline="No matches"
              detail="Nothing in this store matches that text. Identifiers, evidence ids, subjects, findings and case ids are all searched." />
          </Panel>
        ) : (
          KINDS.filter(k => d.results[k.id]?.length).map(kind => (
            <section key={kind.id} className="cases-section">
              <h2 className="section-h">
                {kind.label} <span className="t-dim">({d.results[kind.id].length})</span>
              </h2>
              <Panel flush>
                <div className="findings">
                  {d.results[kind.id].map((row, i) => {
                    const view = kind.render(row)
                    return (
                      <button key={i} className="finding-row" onClick={view.onOpen}>
                        <span className="src-badge">{kind.label.replace(/s$/, '')}</span>
                        <div className="finding-main">
                          <div className="finding-subject mono">{view.primary}</div>
                          <div className="finding-name t-dim">{view.secondary}</div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </Panel>
            </section>
          ))
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
                  rowKey={r => `${r.type}-${r.value}`}
                  columns={[
                    { key: 'type', label: 'Type', render: r => <Chip>{r.type}</Chip> },
                    { key: 'value', label: 'Value', className: 'mono' },
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

/* ── Network ───────────────────────────────────────────────────────────── */

/*
  The graph answers WHO, WHAT, WHEN, HOW and FROM WHICH SOURCE — but only as
  much as is asked for. Showing every phone, SIM, IP and account at once is
  technically complete and practically unreadable, so the default is the
  selected subject and its direct links, and everything else is opt-in.

  Every number shown comes from the API. Edge counts, durations, amounts and
  timestamps are properties Neo4j holds; the individual events behind an edge
  are fetched on demand from the event store.
*/

const NODE_KINDS = [
  { id: 'Person', label: 'People' },
  { id: 'Phone', label: 'Phones' },
  { id: 'BankAccount', label: 'Bank accounts' },
  { id: 'Device', label: 'Devices' },
  { id: 'Sim', label: 'SIMs' },
  { id: 'IpAddress', label: 'IP addresses' },
  { id: 'SocialAccount', label: 'Social accounts' },
  { id: 'UpiHandle', label: 'UPI handles' },
]

// Default view: people and the phones that connect them. Everything else off.
const DEFAULT_KINDS = new Set(['Person', 'Phone'])

/*
  `needs` is the node type each relationship actually connects. Financial edges
  run bank account to bank account, so switching Financial on while bank
  accounts are hidden would show nothing and read as "no financial activity".
  Turning a link group on turns on the nodes it needs.
*/
const REL_GROUPS = [
  { id: 'communication', label: 'Communication', rels: ['CALLED', 'MESSAGED'],
    needs: ['Phone'] },
  { id: 'financial', label: 'Financial', rels: ['TRANSFERRED'],
    needs: ['BankAccount'] },
  { id: 'digital', label: 'Digital', rels: ['CONNECTED_FROM', 'LOGGED_IN_FROM'],
    needs: ['Phone', 'IpAddress'] },
  { id: 'social', label: 'Social', rels: ['POSTED', 'CONNECTED_TO'],
    needs: ['SocialAccount'] },
  { id: 'ownership', label: 'Ownership', rels: ['OWNS', 'USES', 'IDENTIFIES'],
    needs: [] },
]
const OWNERSHIP_RELS = ['OWNS', 'USES', 'IDENTIFIES']

const HOPS = [
  { id: '0', label: 'Direct links' },
  { id: '1', label: 'Expand 1 hop' },
  { id: '2', label: 'Expand 2 hops' },
  { id: 'all', label: 'Show everything' },
]

/**
 * Reduce the graph to what was asked for.
 *
 * Ownership is traversed freely: a person keeps their own phone and accounts
 * at every depth, because charging a hop for "your own handset" would put a
 * direct contact three hops away and make "direct links" show nobody.
 */
function shapeGraph(graph, { root, hops, kinds, rels }) {
  if (!graph?.nodes?.length) return graph

  const allowedRels = new Set(rels)
  let edges = (graph.edges || []).filter(e => allowedRels.has(e.relationship))

  if (root && hops !== 'all') {
    const own = edges.filter(e => OWNERSHIP_RELS.includes(e.relationship))
    const act = edges.filter(e => !OWNERSHIP_RELS.includes(e.relationship))
    const close = set => {
      let grew = true
      while (grew) {
        grew = false
        own.forEach(e => {
          if (set.has(e.source) && !set.has(e.target)) { set.add(e.target); grew = true }
          if (set.has(e.target) && !set.has(e.source)) { set.add(e.source); grew = true }
        })
      }
      return set
    }
    const keep = close(new Set([root]))
    let frontier = new Set(keep)
    // "Direct links" is one activity hop: the subject and who they interacted with.
    for (let i = 0; i <= Number(hops); i++) {
      const reached = new Set()
      act.forEach(e => {
        if (frontier.has(e.source) && !keep.has(e.target)) reached.add(e.target)
        if (frontier.has(e.target) && !keep.has(e.source)) reached.add(e.source)
      })
      if (!reached.size) break
      reached.forEach(id => keep.add(id))
      close(keep)
      frontier = reached
    }
    edges = edges.filter(e => keep.has(e.source) && keep.has(e.target))
    graph = { ...graph, nodes: graph.nodes.filter(n => keep.has(n.id)) }
  }

  // Node-type filters apply last so a hidden type also drops its edges.
  const visible = new Set(
    graph.nodes.filter(n => kinds.has(n.label)).map(n => n.id))
  return {
    ...graph,
    nodes: graph.nodes.filter(n => visible.has(n.id)),
    edges: edges.filter(e => visible.has(e.source) && visible.has(e.target)),
  }
}

function Toggle({ on, onClick, children }) {
  return (
    <button className={`toggle ${on ? 'on' : ''}`} onClick={onClick}
      aria-pressed={on}>
      <span className="toggle-box" aria-hidden="true">{on ? '✓' : ''}</span>
      {children}
    </button>
  )
}

function Legend() {
  return (
    <div className="legend-grid">
      {NODE_KINDS.map(k => (
        <span key={k.id} className="legend-item">
          <span className={`legend-dot dot-${k.id}`} aria-hidden="true" />
          {k.label}
        </span>
      ))}
      <span className="legend-item">
        <span className="legend-line solid" aria-hidden="true" /> Observed event
      </span>
      <span className="legend-item">
        <span className="legend-line dashed" aria-hidden="true" /> Resolution conclusion
      </span>
    </div>
  )
}

/* ── Inspector: one event ──────────────────────────────────────────────── */

function EventDetail({ event, onBack, onOpenEvidence }) {
  const attrs = event.attributes || {}
  // Location only if the record actually carries it — never inferred.
  const cell = attrs.cell_id || attrs.tower_id
  const rows = [
    ['Event', eventLabel(event.event_type)],
    ['Date', fmtDateTime(event.timestamp)?.slice(0, 11)],
    ['Time', fmtTime(event.timestamp)],
    ['From', event.actor_entity ? `${event.actor_entity} · ${event.actor}` : event.actor],
    ['To', event.target_entity ? `${event.target_entity} · ${event.target}` : event.target],
  ]
  if (event.duration_seconds) rows.push(['Duration', `${event.duration_seconds} seconds`])
  if (event.amount) rows.push(['Amount', fmtInr(event.amount)])
  if (attrs.txn_type) rows.push(['Channel', `${attrs.txn_type}${attrs.channel ? ` · ${attrs.channel}` : ''}`])
  if (attrs.dest_ip) rows.push(['Destination', `${attrs.dest_ip}${attrs.dest_port ? `:${attrs.dest_port}` : ''}`])
  if (event.bytes_up || event.bytes_down) {
    rows.push(['Volume', `${fmtNum(event.bytes_up || 0)} up · ${fmtNum(event.bytes_down || 0)} down`])
  }
  if (attrs.activity_type) rows.push(['Interaction', attrs.activity_type])
  if (cell) rows.push(['Cell site', `${cell}${attrs.lac ? ` · LAC ${attrs.lac}` : ''}`])
  rows.push(['Source', sourceLabel(domKey(event.domain))])
  rows.push(['Evidence id', event.event_id])

  return (
    <div className="inspector">
      <button className="link-back" onClick={onBack}>← Back to relationship</button>
      <h3 className="inspector-title">{eventLabel(event.event_type)}</h3>
      <dl className="kv">
        {rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
          <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>
        ))}
      </dl>
      {!cell && (
        <p className="t-dim" style={{ fontSize: 12 }}>
          This record carries no location information.
        </p>
      )}
      <div className="inspector-actions">
        <button className="btn sm" onClick={() => onOpenEvidence?.(event.event_id)}>
          Open evidence record
        </button>
      </div>
    </div>
  )
}

/* ── Inspector: one relationship ───────────────────────────────────────── */

function RelationshipDetail({ edge, caseId, onBack, onOpenEvidence }) {
  const [event, setEvent] = useState(null)
  const detail = useApi(
    () => api.relationship(caseId, edge.source, edge.target, edge.relationship),
    [caseId, edge.source, edge.target, edge.relationship], { enabled: !!caseId })

  if (event) {
    return <EventDetail event={event} onBack={() => setEvent(null)}
      onOpenEvidence={onOpenEvidence} />
  }

  return (
    <div className="inspector">
      <button className="link-back" onClick={onBack}>← Back to summary</button>
      <h3 className="inspector-title">{edgeLabel(edge.relationship)}</h3>
      <p className="inspector-pair mono">{edge.source} → {edge.target}</p>

      <Async state={detail} rows={3}>
        {d => (d.kind === 'RESOLUTION' ? (
          <>
            <p className="why-text">{d.note}</p>
            <dl className="kv">
              {edge.confidence != null && (
                <><dt>Confidence</dt><dd>{edge.confidence}</dd></>
              )}
              {edge.basis && (<><dt>Basis</dt><dd>{edge.basis}</dd></>)}
            </dl>
          </>
        ) : (
          <>
            <dl className="kv">
              <dt>Events</dt><dd>{d.count}</dd>
              <dt>First</dt><dd>{fmtDateTime(d.first_seen)}</dd>
              <dt>Last</dt><dd>{fmtDateTime(d.last_seen)}</dd>
              {d.total_duration_seconds != null && (
                <><dt>Total duration</dt>
                  <dd>{Math.round(d.total_duration_seconds / 60)} min</dd></>
              )}
              {d.total_amount != null && (
                <><dt>Total amount</dt><dd>{fmtInr(d.total_amount)}</dd></>
              )}
              <dt>Sources</dt>
              <dd>{d.sources.map(sourceLabel).join(' · ')}</dd>
            </dl>

            <div className="crow-label" style={{ marginTop: 14 }}>
              Events ({d.events.length})
            </div>
            <ul className="event-list">
              {d.events.slice(0, 40).map(e => (
                <li key={e.event_id}>
                  <button onClick={() => setEvent(e)}>
                    <time className="mono">{fmtDateTime(e.timestamp)}</time>
                    <span className={`dom-${domKey(e.domain)}`}>
                      {e.amount ? fmtInr(e.amount) : eventLabel(e.event_type)}
                    </span>
                    <span className="t-dim mono">{e.event_id}</span>
                  </button>
                </li>
              ))}
            </ul>
            {d.events.length > 40 && (
              <p className="t-dim" style={{ fontSize: 12 }}>
                Showing 40 of {d.events.length}.
              </p>
            )}
          </>
        ))}
      </Async>
    </div>
  )
}

/* ── Inspector: default summary ────────────────────────────────────────── */

function NetworkOverview({ graph, shown, metrics, people, caseInfo }) {
  if (!graph?.nodes?.length) {
    return <p className="t-dim">No graph has been projected for this case yet.</p>
  }
  const observed = (graph.edges || [])
    .filter(e => !OWNERSHIP_RELS.includes(e.relationship))
  const busiest = metrics?.metrics
    ? Object.entries(metrics.metrics).sort((a, b) => b[1].degree - a[1].degree)[0]
    : null

  return (
    <div className="inspector">
      <dl className="kv">
        <dt>Subjects</dt><dd>{people.length}</dd>
        <dt>Identifiers</dt><dd>{graph.nodes.length - people.length}</dd>
        <dt>Relationships</dt><dd>{graph.edges.length}</dd>
        <dt>Observed interactions</dt>
        <dd>{observed.reduce((sum, e) => sum + (e.count || 0), 0)}</dd>
        <dt>Shown in this view</dt>
        <dd>{shown?.nodes?.length ?? 0} of {graph.nodes.length}</dd>
      </dl>
      {busiest && (
        <p className="netsum-note">
          Most connected: <strong>{subjectLabel(busiest[0])}</strong>{' '}
          <span className="t-dim">({busiest[1].degree} direct links)</span>
        </p>
      )}
      {caseInfo?.data_sources?.length > 0 && (
        <p className="netsum-note t-dim">
          Sources: {caseInfo.data_sources.map(sourceLabel).join(' · ')}
        </p>
      )}
      <p className="netsum-note t-dim">
        Select a node or a relationship to inspect it.
      </p>
      <div className="crow-label" style={{ marginTop: 14 }}>Legend</div>
      <Legend />
    </div>
  )
}

/* ── Timeline view of the same data ────────────────────────────────────── */

function GraphTimeline({ caseId, focusRoot, onOpenEvidence }) {
  const state = useApi(
    () => api.timeline(caseId, { limit: 200, entity_id: focusRoot || '' }),
    [caseId, focusRoot], { enabled: !!caseId })

  return (
    <Async state={state} rows={6}>
      {d => {
        const groups = buildSequences(d.events)
        if (!d.events.length) {
          return <Empty headline="No events for this subject" />
        }
        return (
          <div className="graph-timeline">
            {groups.length > 0 && groups.map((g, i) => (
              <div key={i} onClick={() => onOpenEvidence?.(g.events[0].event_id)}
                role="button" tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && onOpenEvidence?.(g.events[0].event_id)}
                style={{ cursor: 'pointer' }}>
                <ActivitySequence group={g} />
              </div>
            ))}
            {groups.length === 0 && (
              <Empty headline="No multi-step sequences"
                detail="These events do not cluster within 30 minutes of one another." />
            )}
          </div>
        )
      }}
    </Async>
  )
}

export function Network({ caseId, onOpenEntity, onOpenEvidence, onNavigate, focusEntity }) {
  const [query, setQuery] = useState('')
  // Arriving from the timeline's "View in network" focuses that subject.
  const [root, setRoot] = useState(focusEntity || '')
  // Arriving from the timeline's "View in network" focuses that subject.
  useEffect(() => { if (focusEntity) setRoot(focusEntity) }, [focusEntity])
  const [hops, setHops] = useState('0')
  const [view, setView] = useState('graph')
  const [kinds, setKinds] = useState(() => new Set(DEFAULT_KINDS))
  const [groups, setGroups] = useState(
    () => new Set(['communication', 'financial', 'ownership']))
  const [selected, setSelected] = useState(null)
  const [edge, setEdge] = useState(null)
  const [building, setBuilding] = useState(false)
  const [buildResult, setBuildResult] = useState(null)

  const graph = useApi(() => api.graph(caseId), [caseId], { enabled: !!caseId })
  const metrics = useApi(() => api.networkMetrics(caseId), [caseId], { enabled: !!caseId })
  const caseInfo = useApi(() => api.case(caseId), [caseId], { enabled: !!caseId })
  const registry = useApi(() => api.entities(caseId), [caseId], { enabled: !!caseId })

  const build = async () => {
    setBuilding(true)
    setBuildResult(null)
    try {
      const result = await api.buildGraph(caseId)
      setBuildResult(result)
      toast(result.status === 'OK'
        ? `Graph rebuilt: ${result.person_nodes} subjects, `
          + `${result.ownership_edges + result.activity_edges} relationships`
        : `Nothing to project for ${caseId}`,
        result.status === 'OK' ? 'ok' : 'warn')
      graph.reload()
      metrics.reload()
    } catch (err) {
      setBuildResult({ status: 'FAILED', reason: err.message })
      toast(`Rebuild failed: ${err.message}`, 'bad')
    } finally {
      setBuilding(false)
    }
  }

  const rels = useMemo(() => {
    const out = []
    REL_GROUPS.forEach(g => { if (groups.has(g.id)) out.push(...g.rels) })
    return out
  }, [groups])

  const people = useMemo(
    () => (graph.data?.nodes || []).filter(n => n.label === 'Person'), [graph.data])
  const focusRoot = root || people[0]?.id || ''
  const shown = useMemo(
    () => shapeGraph(graph.data, { root: focusRoot, hops, kinds, rels }),
    [graph.data, focusRoot, hops, kinds, rels])

  const toggleKind = id => setKinds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const toggleGroup = id => {
    setGroups(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    // Switching a link type on reveals the nodes it connects, so the choice
    // produces a visible answer instead of an empty canvas.
    const group = REL_GROUPS.find(g => g.id === id)
    if (group && !groups.has(id) && group.needs.length) {
      setKinds(prev => new Set([...prev, ...group.needs]))
    }
  }

  if (!caseId) return <Empty headline="Select a case first" />

  const unavailable = graph.data?.status === 'UNAVAILABLE'
  const findings = metrics.data?.findings || []
  const hopLabel = HOPS.find(h => h.id === hops)?.label
  const hiddenCount = (graph.data?.nodes?.length || 0) - (shown?.nodes?.length || 0)

  return (
    <div className="network-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Relationship network</h1>
          <p className="page-lede">
            Case <code className="tech-id">{caseId}</code>
            {caseInfo.data?.data_sources?.length > 0 && (
              <> · Sources {caseInfo.data.data_sources.map(sourceLabel).join(' · ')}</>
            )}
            {focusRoot && <> · Subject <strong>{subjectLabel(focusRoot)}</strong></>}
            {' '}· View <strong>{view === 'graph' ? hopLabel : 'Timeline'}</strong>
          </p>
        </div>
        <div className="spacer" />
        <div className="seg" role="group" aria-label="View mode">
          <button className={view === 'graph' ? 'on' : ''}
            onClick={() => setView('graph')}>Graph</button>
          <button className={view === 'timeline' ? 'on' : ''}
            onClick={() => setView('timeline')}>Timeline</button>
        </div>
        <input type="search" placeholder="highlight node…" value={query}
          onChange={e => setQuery(e.target.value)} style={{ width: 160 }} />
        <button className="btn" onClick={build} disabled={building}>
          <Icon name="refresh" size={12} /> {building ? 'Building…' : 'Rebuild graph'}
        </button>
      </div>

      {buildResult && (
        <div className={`build-result ${buildResult.status === 'OK' ? 'ok' : 'bad'}`}
          role="status">
          {buildResult.status === 'OK' ? (
            <>
              <strong>Graph ready.</strong>{' '}
              {buildResult.person_nodes} subjects and {buildResult.identifier_nodes}{' '}
              identifiers projected,{' '}
              {buildResult.ownership_edges + buildResult.activity_edges} relationships written.
            </>
          ) : buildResult.status === 'EMPTY' ? (
            <><strong>Nothing to project.</strong> {buildResult.reason}</>
          ) : (
            <><strong>Rebuild failed.</strong> {buildResult.reason}</>
          )}
          <button className="btn sm" onClick={() => setBuildResult(null)}>Dismiss</button>
        </div>
      )}

      {view === 'graph' && (
        <div className="controls-bar">
          <div className="control-row">
            <label className="control-label">Focus</label>
            {people.length ? (
              <select value={focusRoot}
                onChange={e => { setRoot(e.target.value); setSelected(null); setEdge(null) }}>
                {people.map(p => (
                  <option key={p.id} value={p.id}>{subjectLabel(p.id)}</option>
                ))}
              </select>
            ) : <span className="t-dim">no subject in this graph yet</span>}

            <div className="seg" role="group" aria-label="Depth">
              {HOPS.map(h => (
                <button key={h.id} className={hops === h.id ? 'on' : ''}
                  onClick={() => setHops(h.id)}>{h.label}</button>
              ))}
            </div>
          </div>

          <div className="control-row">
            <label className="control-label">Show</label>
            {NODE_KINDS.map(k => (
              <Toggle key={k.id} on={kinds.has(k.id)} onClick={() => toggleKind(k.id)}>
                {k.label}
              </Toggle>
            ))}
          </div>

          <div className="control-row">
            <label className="control-label">Links</label>
            {REL_GROUPS.map(g => (
              <Toggle key={g.id} on={groups.has(g.id)} onClick={() => toggleGroup(g.id)}>
                {g.label}
              </Toggle>
            ))}
            {hiddenCount > 0 && (
              <span className="t-dim" style={{ fontSize: 12 }}>
                {hiddenCount} hidden by the current filters
              </span>
            )}
          </div>
        </div>
      )}

      <div className="network-layout">
        <Panel flush>
          {view === 'timeline' ? (
            <div style={{ padding: 14 }}>
              <GraphTimeline caseId={caseId} focusRoot={focusRoot}
                onOpenEvidence={onOpenEvidence} />
            </div>
          ) : graph.loading ? (
            <div style={{ padding: 16 }}><Empty headline="Loading graph…" /></div>
          ) : graph.error ? (
            <ErrorState error={graph.error} onRetry={graph.reload} />
          ) : unavailable ? (
            <div style={{ padding: 16 }}>
              <Empty headline="Graph database did not answer"
                detail="The hosted graph instance pauses when idle and can take a few seconds to wake. Event data, timelines and statistics are read from the event store and are unaffected." />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
                <button className="btn primary" onClick={() => { graph.reload(); metrics.reload() }}>
                  Try again
                </button>
                <button className="btn" onClick={build} disabled={building}>
                  {building ? 'Rebuilding…' : 'Rebuild graph'}
                </button>
              </div>
              {graph.data?.reason && (
                <p className="t-dim" style={{ fontSize: 12, textAlign: 'center', marginTop: 10 }}>
                  {graph.data.reason}
                </p>
              )}
            </div>
          ) : !graph.data?.nodes?.length ? (
            <div style={{ padding: 16 }}>
              <Empty headline={registry.data?.counts?.people
                ? 'Graph not yet projected'
                : 'No relationships available for this case'}
                detail={registry.data?.counts?.people
                  ? "This case has resolved entities, but they have not been written to the investigation graph yet."
                  : (registry.data?.no_people_reason
                    || 'No identifier in this case links two parties.')} />
              {registry.data?.counts?.people > 0 && (
                <button className="btn primary" onClick={build} disabled={building}
                  style={{ marginTop: 12 }}>
                  {building ? 'Building…' : 'Rebuild graph'}
                </button>
              )}
            </div>
          ) : !shown?.nodes?.length ? (
            <div style={{ padding: 16 }}>
              <Empty headline="Nothing matches the current filters"
                detail="Every node or relationship type in view is switched off. Turn one back on, or widen the depth." />
            </div>
          ) : (
            <div style={{ height: 620 }}>
              <NetworkGraph graph={shown} filters={{ query }} selected={selected?.id} focusId={focusRoot}
                onSelect={n => { setSelected(n); setEdge(null) }}
                onEdgeSelect={e => { setEdge(e); setSelected(null) }} />
            </div>
          )}
        </Panel>

        <div className="network-side">
          <Panel title={edge ? 'Relationship' : selected ? 'Entity' : 'Network summary'}>
            {edge ? (
              <RelationshipDetail edge={edge} caseId={caseId}
                onBack={() => setEdge(null)} onOpenEvidence={onOpenEvidence} />
            ) : selected ? (
              <NodeDetail node={selected} caseId={caseId} graph={graph.data}
                onNavigate={onNavigate} onOpenEntity={onOpenEntity} />
            ) : (
              <NetworkOverview graph={graph.data} shown={shown} metrics={metrics.data}
                people={people} caseInfo={caseInfo.data} />
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
                      <button className="btn sm"
                        onClick={() => { setRoot(f.entity); setSelected(null); setEdge(null) }}>
                        Focus on this subject
                      </button>
                    </div>
                  ))}
                  <div className="disclaimer">{d.disclaimer}</div>
                </>
              ) : (
                <Empty headline="No structural anomaly detected"
                  detail="No entity in this case's graph connects groups that would otherwise be separate." />
              ))}
            </Async>
          </Panel>
        </div>
      </div>
    </div>
  )
}


/* ── Timeline ──────────────────────────────────────────────────────────── */

/* ── Timeline ──────────────────────────────────────────────────────────── */

/*
  An investigation timeline, not an event log.

  The previous page printed every event as a block with "↓ 12 min later"
  repeated between each one — correct, and unreadable at any length. Here the
  unit is the EPISODE: events that happened close together in time, summarised
  in one line, expanded only when asked.

  Everything shown comes from the API. Which events belong to a detected
  pattern is computed by matching each alert's own sequence and window against
  the real events; nothing is marked as "part of a pattern" by guesswork.
*/

const SOURCE_FILTERS = [
  { id: 'cdr', label: 'Call records' },
  { id: 'bank', label: 'Banking' },
  { id: 'ipdr', label: 'Internet' },
  { id: 'social', label: 'Social' },
]

const TYPE_FILTERS = [
  { id: 'calls', label: 'Calls', types: ['CALL', 'SMS'] },
  { id: 'transfers', label: 'Transfers', types: ['TRANSFER'] },
  { id: 'internet', label: 'Internet', types: ['DATA_SESSION', 'LOGIN'] },
  { id: 'social', label: 'Social', types: ['SOCIAL_POST', 'SOCIAL_CONNECTION', 'MESSAGE'] },
]

const WINDOWS = [
  { id: 10, label: '10 min' }, { id: 30, label: '30 min' },
  { id: 60, label: '1 hour' }, { id: 360, label: '6 hours' },
  { id: 1440, label: '24 hours' },
]


/** Split a chronological list into episodes separated by more than `window`. */
function toEpisodes(events, windowMinutes) {
  const episodes = []
  let current = []
  for (const e of events) {
    if (!e.timestamp) continue
    if (!current.length) { current = [e]; continue }
    const gap = (new Date(e.timestamp) - new Date(current[current.length - 1].timestamp)) / 60000
    if (gap >= 0 && gap <= windowMinutes) current.push(e)
    else { episodes.push(current); current = [e] }
  }
  if (current.length) episodes.push(current)

  return episodes.map(list => {
    const domains = [...new Set(list.map(e => e.domain))]
    const span = (new Date(list[list.length - 1].timestamp) - new Date(list[0].timestamp)) / 60000
    return {
      events: list,
      domains,
      crossSource: domains.length > 1,
      minutes: Math.round(span),
      start: list[0].timestamp,
      end: list[list.length - 1].timestamp,
    }
  })
}

/**
 * Mark the episodes that contain a flagged sequence.
 *
 * An alert names its sequence (CALL, TRANSFER, SOCIAL_POST), its subject and
 * its window. An episode matches when those event types appear in that order,
 * for that subject, inside that window. This is the same rule the CCC engine
 * counted with, so the marks agree with the statistics.
 */
function markPatterns(episodes, alerts) {
  const sequences = alerts
    .filter(a => a.detail?.sequence?.length)
    .map(a => ({ alert: a, seq: a.detail.sequence, subject: a.entity_id,
                 window: a.detail.window_minutes || 30 }))
  if (!sequences.length) return episodes

  return episodes.map(ep => {
    const matches = []
    // The events that actually form a matched sequence. An episode is a time
    // grouping, so it can hold events that are not part of the pattern —
    // marking those as "part of detected pattern" would mislabel evidence.
    const matchedIds = new Set()

    for (const { alert, seq, subject, window } of sequences) {
      const own = ep.events.filter(e => e.actor_entity === subject)
      let index = 0
      let firstAt = null
      const trail = []
      for (const event of own) {
        const want = seq[index]
        if (event.event_type === want || event.event_type.startsWith(want)) {
          if (index === 0) firstAt = new Date(event.timestamp)
          const within = !firstAt
            || (new Date(event.timestamp) - firstAt) / 60000 <= window
          if (within) {
            trail.push(event.event_id)
            index += 1
          }
          if (index === seq.length) break
        }
      }
      if (index === seq.length) {
        matches.push(alert)
        trail.forEach(id => matchedIds.add(id))
      }
    }
    return { ...ep, patterns: matches, matchedIds }
  })
}

/*
  A real vertical timeline: timestamp | spine | detail.

  The spine carries continuity — one line through the episode, a node per
  event, and the gap written on the line itself rather than as another row.
  That is what lets an investigator see "6 minutes" and "8 hours" as different
  shapes rather than as two sentences that read alike.
*/

// Small glyphs, drawn rather than emoji so they render identically everywhere.
const EVENT_GLYPHS = {
  CALL: 'M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.7 1.5A15.5 15.5 0 0 1 5 6.2 1.5 1.5 0 0 1 6.5 3.5z',
  SMS: 'M4 5.5h16v10H9l-5 4v-14z',
  MESSAGE: 'M4 5.5h16v10H9l-5 4v-14z',
  TRANSFER: 'M4 8.5h13M13.5 5l3.5 3.5-3.5 3.5M20 15.5H7M10.5 12 7 15.5 10.5 19',
  DATA_SESSION: 'M12 3v7M12 14v7M4.5 12h4M15.5 12h4M7 7l2.5 2.5M17 7l-2.5 2.5M7 17l2.5-2.5M17 17l-2.5-2.5',
  LOGIN: 'M10 4.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 19.5h4M14 8l4 4-4 4M18 12H9',
  SOCIAL_POST: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  SOCIAL_CONNECTION: 'M9 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM17 4.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 15.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM11 9.5l4-2M11 12l4 4',
}

function EventGlyph({ type, size = 13 }) {
  const d = EVENT_GLYPHS[type]
  if (!d) return null
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  )
}

/** Identifiers read as technical data, never louder than the event itself. */
function EntityPill({ id }) {
  if (!id) return null
  return <span className="ent-pill mono">{id}</span>
}

function SourceTag({ domain }) {
  return (
    <span className={`src-tag src-${domKey(domain)}`}>
      {String(domain || '').toUpperCase()}
    </span>
  )
}

/**
 * The gap between two events, drawn on the spine.
 *
 * Under two hours it is a short segment with a small label. Beyond that the
 * segment lengthens and gains a rule, so a break in activity is a different
 * shape rather than a different sentence.
 */
function SpineGap({ minutes }) {
  if (minutes <= 0) return null
  const long = minutes >= 120
  const label = minutes >= 1440
    ? `${Math.round(minutes / 1440)}d`
    : minutes >= 60
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      : `${minutes} min`
  return (
    <div className={`spine-gap ${long ? 'is-long' : ''}`}>
      <div className="spine-col"><span className="spine-line" /></div>
      <span className="spine-gap-label">{label}</span>
    </div>
  )
}

function EventRow({ event, selected, flagged, onSelect }) {
  const amount = event.amount ? fmtInr(event.amount) : null
  const title = amount
    ? `${amount} financial transfer`
    : eventLabel(event.event_type)
  const from = event.actor_entity || event.actor
  const to = event.target_entity || event.target

  return (
    <div className={`tl-row ${selected ? 'is-selected' : ''} ${flagged ? 'is-flagged' : ''}`}>
      <time className="tl-clock mono" dateTime={event.timestamp}>
        {fmtTime(event.timestamp)}
      </time>

      <div className="spine-col">
        <span className={`spine-node ${flagged ? 'is-flagged' : ''}`} aria-hidden="true" />
        <span className="spine-line" />
      </div>

      {/*
        A native title tooltip floats over whatever is under the cursor, which
        on a dense timeline means it covers the next event. The evidence id
        lives on the row instead, in space the row already owns.
      */}
      <button className="tl-card" onClick={() => onSelect(event)}
        aria-label={`${title} at ${fmtTime(event.timestamp)}, `
          + `${sourceLabel(domKey(event.domain))}, evidence ${event.event_id}`}>
          <span className="tl-title">
            <span className={`tl-glyph dom-${domKey(event.domain)}`}>
              <EventGlyph type={event.event_type} />
            </span>
            {title}
            {flagged && (
              <span className="tl-flag" title="This event is one step of a detected sequence">
                in sequence
              </span>
            )}
          </span>
          <span className="tl-parties">
            <EntityPill id={from} />
            {to && <><span className="tl-arrow" aria-hidden="true">→</span><EntityPill id={to} /></>}
          </span>
          <span className="tl-right">
            <span className="tl-evid mono">{event.event_id}</span>
            <SourceTag domain={event.domain} />
          </span>
        </button>
    </div>
  )
}

/* Plain English first, the statistics underneath. */
function WhyPanel({ alert, onClose }) {
  const d = alert.detail || {}
  return (
    <div className="why-inline">
      <div className="why-inline-head">
        <strong>Why was this flagged?</strong>
        <button className="btn sm" onClick={onClose}>Close</button>
      </div>
      <p className="why-text">
        {d.observed} occurrences were observed against about {d.expected?.toFixed(2)}{' '}
        expected under this subject&rsquo;s own randomised baseline.
      </p>
      <dl className="kv">
        <dt>Observed</dt><dd>{d.observed}</dd>
        <dt>Expected</dt><dd>{d.expected?.toFixed(2)}</dd>
        <dt>Lift</dt><dd>{d.lift?.toFixed(1)}×</dd>
        <dt>p-value</dt><dd>{fmtP(d.p_value)}</dd>
        <dt>FDR-adjusted</dt><dd>{fmtP(d.fdr_adjusted)}</dd>
        {d.baseline?.span_days != null && (
          <><dt>Baseline period</dt><dd>{d.baseline.span_days} days</dd></>
        )}
      </dl>
      <p className="caveat">{NOT_GUILT}</p>
    </div>
  )
}

function Episode({ episode, selectedId, onSelect, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const [why, setWhy] = useState(null)
  const patterns = episode.patterns || []
  const flaggedIds = episode.matchedIds || new Set()

  // The order sources were touched is the investigative story of the episode.
  const sourcePath = episode.events
    .map(e => (e.domain || '').toUpperCase())
    .filter((d, i, all) => d && d !== all[i - 1])

  return (
    <section className={`episode ${patterns.length ? 'is-flagged' : ''}`}>
      {patterns.length > 0 && (
        <div className="pattern-banner">
          <span className="status-dot tone-high" aria-hidden="true" />
          <div>
            <strong>Cross-source pattern</strong>{' '}
            {findingLabel(patterns[0].pattern, patterns[0].detail?.sequence)}
            <div className="t-dim" style={{ fontSize: 12 }}>
              {episode.matchedIds?.size || 0} of {episode.events.length} events in this
              window form the sequence
            </div>
          </div>
          <button className="btn sm" onClick={() => setWhy(why ? null : patterns[0])}>
            {why ? 'Hide' : 'Why was this flagged?'}
          </button>
        </div>
      )}

      {why && <WhyPanel alert={why} onClose={() => setWhy(null)} />}

      <header className="episode-head" onClick={() => setOpen(!open)} role="button"
        tabIndex={0} onKeyDown={e => e.key === 'Enter' && setOpen(!open)}>
        <div>
          <div className="episode-title">
            {episode.crossSource ? 'Cross-source activity sequence' : 'Activity sequence'}
          </div>
          <div className="episode-meta">
            {fmtTime(episode.start)} – {fmtTime(episode.end)}
            {' · '}{episode.events.length} events
            {' · '}{episode.minutes} min
          </div>
          {episode.crossSource && (
            <div className="episode-path mono">{sourcePath.join(' → ')}</div>
          )}
        </div>
        <span className="episode-toggle">{open ? 'Collapse' : 'Expand'} episode</span>
      </header>

      {open && (
        <div className="episode-body">
          {episode.events.map((e, i) => (
            <Fragment key={e.event_id}>
              {i > 0 && (
                <SpineGap minutes={Math.round(
                  (new Date(e.timestamp) - new Date(episode.events[i - 1].timestamp)) / 60000)} />
              )}
              <EventRow event={e} selected={selectedId === e.event_id}
                flagged={flaggedIds.has(e.event_id)} onSelect={onSelect} />
            </Fragment>
          ))}
        </div>
      )}
    </section>
  )
}

function EventInspector({ event, onOpenEvidence, onNavigate }) {
  if (!event) {
    return (
      <div className="inspector">
        <p className="t-dim">Select an event to inspect its details.</p>
      </div>
    )
  }
  const a = event.attributes || {}
  const rows = [['Event', eventLabel(event.event_type)],
                ['Date', fmtDateTime(event.timestamp)?.slice(0, 11)],
                ['Time', fmtTime(event.timestamp)]]

  if (event.event_type === 'TRANSFER') {
    rows.push(['From account', event.actor], ['To account', event.target])
    if (event.amount) rows.push(['Amount', fmtInr(event.amount)])
    if (a.txn_type) rows.push(['Channel', a.txn_type + (a.channel ? ` · ${a.channel}` : '')])
    rows.push(['Transaction id', event.event_id])
  } else if (event.event_type === 'DATA_SESSION' || event.event_type === 'LOGIN') {
    rows.push(['Subscriber', event.actor])
    if (a.imei) rows.push(['Device', a.imei])
    if (a.public_ip) rows.push(['IP address', a.public_ip])
    if (event.target) rows.push(['Destination', event.target + (a.dest_port ? `:${a.dest_port}` : '')])
    if (event.bytes_up || event.bytes_down) {
      rows.push(['Volume', `${fmtNum(event.bytes_up || 0)} up · ${fmtNum(event.bytes_down || 0)} down`])
    }
    if (a.access_type) rows.push(['Access', a.access_type])
  } else if (event.event_type.startsWith('SOCIAL')) {
    rows.push(['Account', event.actor])
    if (event.target) rows.push(['Target', event.target])
    if (a.activity_type) rows.push(['Interaction', a.activity_type])
  } else {
    rows.push(['From', event.actor_entity ? `${event.actor_entity} · ${event.actor}` : event.actor])
    rows.push(['To', event.target_entity ? `${event.target_entity} · ${event.target}` : event.target])
    if (event.duration_seconds) rows.push(['Duration', `${event.duration_seconds} seconds`])
    if (a.cell_id) rows.push(['Cell site', a.cell_id + (a.lac ? ` · LAC ${a.lac}` : '')])
  }

  rows.push(['Source', sourceLabel(domKey(event.domain))])
  rows.push(['Evidence id', event.event_id])

  const both = (event.actor_entity || event.actor) && (event.target_entity || event.target)

  return (
    <div className="inspector">
      <h3 className="inspector-title">{eventLabel(event.event_type)}</h3>
      <dl className="kv">
        {rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
          <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>
        ))}
      </dl>
      {!a.cell_id && event.event_type === 'CALL' && (
        <p className="t-dim" style={{ fontSize: 12 }}>No location recorded for this call.</p>
      )}
      <div className="inspector-actions">
        <button className="btn sm" onClick={() => onOpenEvidence?.(event.event_id)}>
          Open evidence
        </button>
        {both && (
          <button className="btn sm"
            onClick={() => onNavigate?.('network', event.actor_entity || event.actor)}>
            View in network
          </button>
        )}
      </div>
    </div>
  )
}

/*
  A compact filter that keeps its options behind a button.

  Four sources and four types shown permanently cost three toolbar rows and
  read as a settings page. The count on the button is the useful part; the
  checkboxes only matter while someone is changing them.
*/
function FilterPopover({ label, options, selected, onToggle }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const away = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const escape = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  return (
    <div className="pop" ref={ref}>
      <button className={`pop-btn ${selected.size < options.length ? 'is-filtered' : ''}`}
        onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true">
        {label} <span className="pop-count">{selected.size}</span>
        <span className="pop-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="pop-menu" role="group" aria-label={label}>
          {options.map(o => (
            <label key={o.id} className="pop-item">
              <input type="checkbox" checked={selected.has(o.id)}
                onChange={() => onToggle(o.id)} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

const DATE_PRESETS = [
  { id: 'all', label: 'All dates', days: null },
  { id: '24h', label: 'Last 24 hours', days: 1 },
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
]

/*
  One filter surface instead of a row of controls.

  Source, type, window, subject and dates all live behind a single button that
  carries a count. What is actually set then appears as removable chips, so the
  toolbar shows the current state rather than every available control.
*/
function FiltersMenu({ state, set, activeCount }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const away = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const esc = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const toggleIn = (key, id) => {
    const next = new Set(state[key])
    if (next.has(id)) next.delete(id)
    else next.add(id)
    set({ [key]: next })
  }

  return (
    <div className="pop" ref={ref}>
      <button className={`pop-btn ${activeCount ? 'is-filtered' : ''}`}
        onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true">
        <Icon name="patterns" size={12} /> Filters
        {activeCount > 0 && <span className="pop-count">{activeCount}</span>}
        <span className="pop-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="filters-menu">
          <div className="fm-group">
            <div className="fm-label">Sources</div>
            {SOURCE_FILTERS.map(o => (
              <label key={o.id} className="pop-item">
                <input type="checkbox" checked={state.sources.has(o.id)}
                  onChange={() => toggleIn('sources', o.id)} />
                {o.label}
              </label>
            ))}
          </div>

          <div className="fm-group">
            <div className="fm-label">Event types</div>
            {TYPE_FILTERS.map(o => (
              <label key={o.id} className="pop-item">
                <input type="checkbox" checked={state.types.has(o.id)}
                  onChange={() => toggleIn('types', o.id)} />
                {o.label}
              </label>
            ))}
          </div>

          <div className="fm-group">
            <div className="fm-label">Date range</div>
            {DATE_PRESETS.map(p => (
              <label key={p.id} className="pop-item">
                <input type="radio" name="daterange" checked={state.datePreset === p.id}
                  onChange={() => set({ datePreset: p.id, since: '', until: '' })} />
                {p.label}
              </label>
            ))}
            <label className="pop-item">
              <input type="radio" name="daterange" checked={state.datePreset === 'custom'}
                onChange={() => set({ datePreset: 'custom' })} />
              Custom range
            </label>
            {state.datePreset === 'custom' && (
              <div className="fm-dates">
                <label>From
                  <input type="date" value={state.since}
                    onChange={e => set({ since: e.target.value })} />
                </label>
                <label>To
                  <input type="date" value={state.until}
                    onChange={e => set({ until: e.target.value })} />
                </label>
              </div>
            )}
          </div>

          <div className="fm-group">
            <div className="fm-label">Grouping window</div>
            <select value={state.windowMinutes}
              onChange={e => set({ windowMinutes: Number(e.target.value) })}>
              {WINDOWS.map(w => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
            <p className="fm-note">
              Groups nearby events and matches sequences. It never hides events
              in All events.
            </p>
          </div>

          <div className="fm-group">
            <div className="fm-label">Subject</div>
            <input type="text" value={state.entity} placeholder="any subject"
              onChange={e => set({ entity: e.target.value })} />
          </div>
        </div>
      )}
    </div>
  )
}

/** What is actually set, and a way to unset each of them. */
function ActiveFilters({ state, set, clearAll }) {
  const chips = []
  if (state.sources.size < SOURCE_FILTERS.length) {
    SOURCE_FILTERS.filter(o => !state.sources.has(o.id)).forEach(o =>
      chips.push({ key: `s-${o.id}`, label: `${o.label} hidden`,
        clear: () => set({ sources: new Set([...state.sources, o.id]) }) }))
  }
  if (state.types.size < TYPE_FILTERS.length) {
    TYPE_FILTERS.filter(o => !state.types.has(o.id)).forEach(o =>
      chips.push({ key: `t-${o.id}`, label: `${o.label} hidden`,
        clear: () => set({ types: new Set([...state.types, o.id]) }) }))
  }
  if (state.entity) {
    chips.push({ key: 'entity', label: `Subject ${state.entity}`,
      clear: () => set({ entity: '' }) })
  }
  if (state.datePreset !== 'all') {
    const preset = DATE_PRESETS.find(p => p.id === state.datePreset)
    chips.push({
      key: 'date',
      label: preset ? preset.label
        : `${state.since || 'any'} → ${state.until || 'any'}`,
      clear: () => set({ datePreset: 'all', since: '', until: '' }),
    })
  }
  if (!chips.length) return null

  return (
    <div className="chips">
      {chips.map(c => (
        <button key={c.key} className="filter-chip" onClick={c.clear}>
          {c.label}<span aria-hidden="true">×</span>
        </button>
      ))}
      <button className="filter-chip-clear" onClick={clearAll}>Clear all</button>
    </div>
  )
}

/*
  With nothing selected the inspector states what the investigator is looking
  at, rather than sitting blank. Every figure comes from the loaded events.
*/
function TimelineContext({ events, patternCount, windowMinutes }) {
  if (!events.length) {
    return <p className="t-dim" style={{ fontSize: 13 }}>
      Select an event in the timeline to inspect its details.
    </p>
  }
  const bySource = {}
  events.forEach(e => { const k = domKey(e.domain); bySource[k] = (bySource[k] || 0) + 1 })
  const first = events[0]?.timestamp
  const last = events[events.length - 1]?.timestamp

  return (
    <div className="ctx-panel">
      <p className="ctx-hint">Select an event to inspect its details.</p>

      <div className="ins-label">Period covered</div>
      <p className="ctx-range">
        {fmtDateTime(first)?.slice(0, 11)} – {fmtDateTime(last)?.slice(0, 11)}
      </p>

      <div className="ins-label">Records by source</div>
      <ul className="ctx-sources">
        {Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
          <li key={k}>
            <span className={`src-tag src-${k}`}>{k.toUpperCase()}</span>
            <span className="ctx-count mono">{fmtNum(n)}</span>
          </li>
        ))}
      </ul>

      <div className="ins-label">Analysis</div>
      <p className="ctx-note">
        {patternCount} detected {patternCount === 1 ? 'pattern' : 'patterns'} ·
        grouped in {windowMinutes}-minute windows
      </p>
    </div>
  )
}

export function Timeline({ caseId, onOpenEvidence, onNavigate }) {
  /*
    Two modes, two sources of truth. The window governs grouping and pattern
    matching; it never removes an event from the chronology.
  */
  const [viewMode, setViewMode] = useState('all')
  const [selected, setSelected] = useState(null)
  const [filters, setFilters] = useState(() => ({
    windowMinutes: 30,
    entity: '',
    datePreset: 'all',
    since: '',
    until: '',
    sources: new Set(SOURCE_FILTERS.map(s => s.id)),
    types: new Set(TYPE_FILTERS.map(t => t.id)),
  }))
  const set = patch => setFilters(prev => ({ ...prev, ...patch }))

  const resetFilters = () => setFilters({
    windowMinutes: filters.windowMinutes,
    entity: '', datePreset: 'all', since: '', until: '',
    sources: new Set(SOURCE_FILTERS.map(s => s.id)),
    types: new Set(TYPE_FILTERS.map(t => t.id)),
  })

  useEffect(() => { resetFilters(); setSelected(null) }, [caseId])  // eslint-disable-line

  // A preset is resolved to a real date only when one is chosen.
  const range = useMemo(() => {
    if (filters.datePreset === 'custom') return { since: filters.since, until: filters.until }
    const preset = DATE_PRESETS.find(p => p.id === filters.datePreset)
    if (!preset?.days) return { since: '', until: '' }
    const from = new Date(Date.now() - preset.days * 86400000)
    return { since: from.toISOString().slice(0, 10), until: '' }
  }, [filters.datePreset, filters.since, filters.until])

  const state = useApi(
    () => api.timeline(caseId, {
      limit: 500,
      entity_id: filters.entity,
      since: range.since ? `${range.since}T00:00:00+00:00` : '',
      until: range.until ? `${range.until}T23:59:59+00:00` : '',
    }),
    [caseId, filters.entity, range.since, range.until], { enabled: !!caseId })
  const alerts = useApi(() => api.alerts(caseId), [caseId], { enabled: !!caseId })
  const caseInfo = useApi(() => api.case(caseId), [caseId], { enabled: !!caseId })

  const allEvents = useMemo(() => state.data?.events || [], [state.data])

  const allowedTypes = useMemo(() => {
    const out = new Set()
    TYPE_FILTERS.forEach(t => { if (filters.types.has(t.id)) t.types.forEach(x => out.add(x)) })
    return out
  }, [filters.types])

  const filteredEvents = useMemo(
    () => allEvents.filter(
      e => filters.sources.has(domKey(e.domain)) && allowedTypes.has(e.event_type)),
    [allEvents, filters.sources, allowedTypes])

  const episodes = useMemo(
    () => markPatterns(toEpisodes(filteredEvents, filters.windowMinutes),
                       alerts.data?.alerts || []),
    [filteredEvents, filters.windowMinutes, alerts.data])

  const patternMatches = useMemo(
    () => episodes.filter(ep => ep.patterns?.length), [episodes])

  const shown = viewMode === 'patterns' ? patternMatches : episodes
  const shownCount = shown.reduce((n, ep) => n + ep.events.length, 0)

  const activeCount =
    (SOURCE_FILTERS.length - filters.sources.size)
    + (TYPE_FILTERS.length - filters.types.size)
    + (filters.entity ? 1 : 0)
    + (filters.datePreset !== 'all' ? 1 : 0)

  if (!caseId) return <Empty headline="Select a case first" />

  const patternCount = (alerts.data?.alerts || []).filter(a => a.detail?.sequence).length
  const caseSources = caseInfo.data?.data_sources || []

  return (
    <div className="timeline-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Investigation timeline</h1>
          <div className="tl-figures">
            <span className="fig"><b>{allEvents.length}</b><i>events</i></span>
            <span className="fig"><b>{caseSources.length}</b><i>sources</i></span>
            <span className="fig"><b>{patternCount}</b><i>patterns</i></span>
            <span className="fig-case">
              <span className="ctx-k">Case</span> <code className="tech-id">{caseId}</code>
            </span>
          </div>
        </div>
      </div>

      <div className="tl-toolbar">
        <div className="seg" role="group" aria-label="View mode">
          <button className={viewMode === 'all' ? 'on' : ''}
            onClick={() => setViewMode('all')}>All events</button>
          <button className={viewMode === 'patterns' ? 'on' : ''}
            onClick={() => setViewMode('patterns')}>Patterns only</button>
        </div>

        <FiltersMenu state={filters} set={set} activeCount={activeCount} />

        <span className="tl-showing">
          {viewMode === 'patterns'
            ? `${patternMatches.length} matching ${patternMatches.length === 1 ? 'sequence' : 'sequences'}`
            : `showing ${shownCount} of ${allEvents.length}`}
        </span>
      </div>

      <ActiveFilters state={filters} set={set} clearAll={resetFilters} />

      <div className="timeline-layout">
        <Panel flush>
          <Async state={state} rows={6}>
            {() => {
              if (!allEvents.length) {
                return <div className="tl-empty">
                  <Empty headline="No events"
                    detail="This case contains no timeline events." />
                </div>
              }
              if (!filteredEvents.length) {
                return (
                  <div className="tl-empty">
                    <Empty headline="No events match these filters"
                      detail="A source or type is switched off, or the date range excludes them." />
                    <button className="btn" onClick={resetFilters}
                      style={{ marginTop: 12 }}>Clear filters</button>
                  </div>
                )
              }
              if (viewMode === 'patterns' && !patternMatches.length) {
                return (
                  <div className="tl-empty">
                    <Empty headline="No patterns detected"
                      detail={`No configured sequence matched the ${filters.windowMinutes}-minute window.`} />
                    <p className="t-dim" style={{ fontSize: 12.5 }}>
                      {filteredEvents.length} events available · {patternCount} patterns checked
                    </p>
                    <button className="btn primary" onClick={() => setViewMode('all')}
                      style={{ marginTop: 10 }}>Show all events</button>
                  </div>
                )
              }

              const days = []
              shown.forEach(ep => {
                const day = (ep.start || '').slice(0, 10)
                const last = days[days.length - 1]
                if (last && last.day === day) last.episodes.push(ep)
                else days.push({ day, episodes: [ep] })
              })

              return (
                <div className="episodes">
                  {days.map(group => (
                    <section key={group.day} className="day-group">
                      <h2 className="day-heading">
                        {new Date(group.day).toLocaleDateString('en-GB', {
                          day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()}
                        <span className="day-count">
                          {group.episodes.reduce((n, e) => n + e.events.length, 0)} events
                        </span>
                      </h2>
                      {group.episodes.map((ep, i) => (
                        <Fragment key={ep.start + i}>
                          {i > 0 && (
                            <SpineGap minutes={Math.round(
                              (new Date(ep.start) - new Date(group.episodes[i - 1].end)) / 60000)} />
                          )}
                          <Episode episode={ep} selectedId={selected?.event_id}
                            onSelect={setSelected}
                            defaultOpen={ep.events.length === 1 || !!ep.patterns?.length} />
                        </Fragment>
                      ))}
                    </section>
                  ))}
                </div>
              )
            }}
          </Async>
        </Panel>

        <div className="timeline-side">
          <Panel title={selected ? 'Event inspector' : 'Timeline context'}>
            {selected
              ? <EventInspector event={selected} onOpenEvidence={onOpenEvidence}
                  onNavigate={onNavigate} />
              : <TimelineContext events={filteredEvents} patternCount={patternCount}
                  windowMinutes={filters.windowMinutes} />}
          </Panel>
        </div>
      </div>
    </div>
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

/*
  One finding, one surface.

  The previous version wrapped six bordered metric tiles inside a bordered
  panel inside the page — seven containers to read one result. Here the panel
  is the only border; the metrics are content blocks separated by space and a
  hairline, and meaning comes before the numbers that produced it.
*/
function FindingCard({ finding: r, permutations, open, onToggle, onNavigate, onOpenEntity }) {
  const review = r.decision === 'REVIEW'
  const sequence = r.sequence || r.pattern.split('_')
  const baseline = r.baseline || {}
  const thinHistory = baseline.established_routine === false && baseline.span_days != null

  return (
    <section className="finding-card">
      <header className="fc-head">
        <div>
          <div className="fc-kind">Cross-source pattern</div>
          <div className="fc-seq">
            {sequence.map((step, i) => (
              <Fragment key={`${step}-${i}`}>
                {i > 0 && <span className="fc-arrow" aria-hidden="true">→</span>}
                <span className="fc-pill">{eventLabel(step)}</span>
              </Fragment>
            ))}
          </div>
          <div className="fc-name">
            {findingLabel(r.pattern, r.sequence)}
            <code className="tech-id">{r.pattern}</code>
          </div>
        </div>
        <div className="fc-head-right">
          <Pill tone={review ? 'high' : 'low'}>
            {review ? 'Requires investigation' : decisionLabel(r.decision)}
          </Pill>
          <button className="btn sm" onClick={onToggle}>
            {open ? 'Hide detail' : 'Explain'}
          </button>
        </div>
      </header>

      {/* borderless metric strip — space and one hairline, not six boxes */}
      <dl className="fc-metrics">
        <div><dt>Subject</dt><dd className="mono">{r.subject}</dd></div>
        <div><dt>Observed</dt><dd>{r.observed}</dd></div>
        <div><dt>Expected</dt><dd>{r.expected?.toFixed(2)}</dd></div>
        <div>
          <dt>Lift</dt>
          <dd className={review && r.lift >= 3 ? 'is-high' : ''}>
            {r.lift ? `${r.lift.toFixed(1)}×` : '—'}
          </dd>
        </div>
        <div>
          <dt><Hint tip="Share of random rearrangements that reached this many occurrences">p-value</Hint></dt>
          <dd>{fmtP(r.p_value, permutations)}</dd>
        </div>
        <div>
          <dt><Hint tip="Benjamini-Hochberg adjusted for testing many patterns at once">FDR adjusted</Hint></dt>
          <dd>{r.fdr_adjusted != null ? r.fdr_adjusted.toFixed(4) : '—'}</dd>
        </div>
      </dl>

      <p className="fc-read">
        {r.observed} occurrences were observed against approximately{' '}
        {r.expected?.toFixed(2)} expected under this subject&rsquo;s randomised baseline
        {r.lift ? `, about ${r.lift.toFixed(1)}× more often than expected` : ''}.
      </p>
      <p className="fc-stat">
        Statistically unusual under the selected null model. Association is not
        evidence of wrongdoing.
      </p>

      {thinHistory && (
        <p className="fc-warn">
          <strong>Limited history.</strong> {baseline.span_days} days available;
          14 days preferred before a behavioural baseline is treated as settled.
        </p>
      )}

      {open && (
        <div className="fc-detail">
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
        </div>
      )}

      <footer className="fc-actions">
        <button className="btn sm" onClick={() => onNavigate?.('timeline')}>View timeline</button>
        <button className="btn sm" onClick={() => onNavigate?.('evidence')}>View evidence</button>
        <button className="btn sm" onClick={() => onOpenEntity?.(r.subject)}>View entity</button>
      </footer>
    </section>
  )
}

export function Patterns({ caseId, onNavigate, onOpenEntity }) {
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

            {d.results.map(r => (
              <FindingCard key={r.pattern} finding={r} permutations={d.permutations}
                open={expanded === r.pattern}
                onToggle={() => setExpanded(expanded === r.pattern ? null : r.pattern)}
                onNavigate={onNavigate} onOpenEntity={onOpenEntity} />
            ))}

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

/*
  Evidence explorer: scan, select, inspect, trace.

  The left pane is dense so many records are visible at once; the right pane
  carries the depth. Which fields appear depends on what the record is — a call
  has a duration and possibly a cell site, a transfer has an amount and a
  channel — and a field with no value is omitted rather than shown empty.
*/

const EVENT_TONE = {
  CALL: 'cdr', SMS: 'cdr', MESSAGE: 'social',
  TRANSFER: 'bank',
  DATA_SESSION: 'ipdr', LOGIN: 'ipdr',
  SOCIAL_POST: 'social', SOCIAL_CONNECTION: 'social',
}

function EvidenceRow({ record: r, selected, onSelect }) {
  const stamp = new Date(r.timestamp)
  const ok = !Number.isNaN(stamp.getTime())
  return (
    <tr className={`erow ${selected ? 'is-selected' : ''}`}
      onClick={() => onSelect(r.event_id)} tabIndex={0} role="button"
      onKeyDown={e => e.key === 'Enter' && onSelect(r.event_id)}>
      <td className="erow-id mono">{r.event_id}</td>
      <td>
        <span className={`ev-badge tone-${EVENT_TONE[r.event_type] || 'entity'}`}>
          {eventLabel(r.event_type)}
        </span>
      </td>
      <td className="erow-when">
        {ok ? (
          <>
            <span className="erow-date">{stamp.toISOString().slice(0, 10)}</span>
            <span className="erow-time">{stamp.toISOString().slice(11, 19)}</span>
          </>
        ) : <span className="mono">{r.timestamp || '—'}</span>}
      </td>
      <td className="erow-src mono">{r.source_file}</td>
    </tr>
  )
}

/** Only the fields this kind of record actually carries. */
function detailFields(d) {
  const a = d.attributes || {}
  const rows = []
  const push = (k, v) => { if (v != null && v !== '') rows.push([k, v]) }

  if (d.event_type === 'TRANSFER') {
    push('From account', d.actor)
    push('To account', d.target)
    push('Amount', d.amount ? fmtInr(d.amount) : null)
    push('Channel', a.txn_type ? `${a.txn_type}${a.channel ? ` · ${a.channel}` : ''}` : null)
    push('Payer UPI', a.payer_upi)
    push('Payee UPI', a.payee_upi)
    push('IFSC', a.ifsc)
  } else if (d.event_type === 'DATA_SESSION' || d.event_type === 'LOGIN') {
    push('Subscriber', d.actor)
    push('Device', a.imei)
    push('IP address', a.public_ip)
    push('Destination', d.target ? `${d.target}${a.dest_port ? `:${a.dest_port}` : ''}` : null)
    push('Access', a.access_type)
    push('Data up', d.bytes_up ? `${fmtNum(d.bytes_up)} bytes` : null)
    push('Data down', d.bytes_down ? `${fmtNum(d.bytes_down)} bytes` : null)
  } else if ((d.event_type || '').startsWith('SOCIAL')) {
    push('Account', d.actor)
    push('Target', d.target)
    push('Interaction', a.activity_type)
    push('Content', d.content)
  } else {
    push('From', d.actor)
    push('To', d.target)
    push('Duration', d.duration_seconds ? `${d.duration_seconds} seconds` : null)
    push('Call type', a.call_type)
    // Location only when the record genuinely carries it.
    push('Cell site', a.cell_id ? `${a.cell_id}${a.lac ? ` · LAC ${a.lac}` : ''}` : null)
    push('IMEI', a.imei)
    push('IMSI', a.imsi)
  }
  return rows
}

function EvidenceDetail({ state, onOpenEntity, onNavigate }) {
  if (state.loading) return <div className="ins-empty"><span className="t-dim">Loading record…</span></div>
  if (state.error) return <ErrorState error={state.error} />
  const d = state.data
  if (!d) {
    return (
      <div className="ins-empty">
        <Icon name="evidence" size={34} strokeWidth={1.2} />
        <p>Select an evidence record to inspect its details.</p>
      </div>
    )
  }

  const p = d.provenance || {}
  const stamp = new Date(d.timestamp)
  const ok = !Number.isNaN(stamp.getTime())
  const entities = [d.actor_entity, d.target_entity].filter(Boolean)

  return (
    <div className="ins">
      <div className="ins-kind">
        <span className={`ev-badge tone-${EVENT_TONE[d.event_type] || 'entity'}`}>
          {eventLabel(d.event_type)}
        </span>
        <code className="tech-id">{d.event_id}</code>
      </div>

      {ok && (
        <div className="ins-when">
          <span className="ins-date">
            {stamp.toLocaleDateString('en-GB',
              { day: '2-digit', month: 'short', year: 'numeric' })}
          </span>
          <span className="ins-time mono">{stamp.toISOString().slice(11, 19)}</span>
        </div>
      )}

      {entities.length > 0 && (
        <div className="ins-block">
          <div className="ins-label">Participants</div>
          <div className="ins-parties">
            {entities.map((e, i) => (
              <Fragment key={e}>
                {i > 0 && <span className="tl-arrow" aria-hidden="true">→</span>}
                <button className="ent-chip mono" onClick={() => onOpenEntity?.(e)}>{e}</button>
              </Fragment>
            ))}
          </div>
        </div>
      )}

      <dl className="ins-fields">
        {detailFields(d).map(([k, v]) => (
          <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>
        ))}
      </dl>

      <div className="ins-block">
        <div className="ins-label">Provenance</div>
        <dl className="ins-fields">
          <dt>Case</dt><dd className="mono">{d.case_id}</dd>
          <dt>Source</dt><dd>{sourceLabel(domKey(d.domain))}</dd>
          <dt>File</dt><dd className="mono">{p.source_file} · row {p.source_row}</dd>
          <dt>Received</dt><dd>{fmtDateTime(p.received_at)}</dd>
          <dt>Chain</dt><dd>{p.chain_status}</dd>
          <dt>SHA-256</dt>
          <dd className="mono ins-hash" title={p.sha256}>{p.sha256}</dd>
        </dl>
      </div>

      <div className="ins-actions">
        <button className="btn sm" onClick={() => onNavigate?.('timeline')}>View timeline</button>
        {entities.length > 0 && (
          <>
            <button className="btn sm"
              onClick={() => onNavigate?.('network', entities[0])}>View network</button>
            <button className="btn sm"
              onClick={() => onOpenEntity?.(entities[0])}>Open entity</button>
          </>
        )}
      </div>
    </div>
  )
}

export function Evidence({ caseId, eventId, onOpenEvidence, onOpenEntity, onNavigate }) {
  const [selectedId, setSelectedId] = useState(eventId || '')
  const [query, setQuery] = useState('')
  const [sources, setSources] = useState(() => new Set(SOURCE_FILTERS.map(s => s.id)))

  const list = useApi(() => api.timeline(caseId, { limit: 300 }), [caseId], { enabled: !!caseId })
  const record = useApi(() => api.evidence(selectedId), [selectedId], { enabled: !!selectedId })

  useEffect(() => { if (eventId) setSelectedId(eventId) }, [eventId])

  const all = useMemo(() => list.data?.events || [], [list.data])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter(r => {
      if (!sources.has(domKey(r.domain))) return false
      if (!q) return true
      return [r.event_id, r.event_type, r.source_file, r.actor_entity, r.target_entity,
              r.actor, r.target, r.case_id]
        .some(v => String(v || '').toLowerCase().includes(q))
    })
  }, [all, query, sources])

  const select = id => { setSelectedId(id); onOpenEvidence?.(id) }
  const clear = () => {
    setQuery('')
    setSources(new Set(SOURCE_FILTERS.map(s => s.id)))
  }

  if (!caseId) return <Empty headline="Select a case first" />

  return (
    <div className="evidence-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Evidence</h1>
          <div className="tl-context">
            <span><strong>{all.length}</strong> records</span>
            <span className="ctx-sep" aria-hidden="true" />
            <span><strong>{new Set(all.map(r => r.domain)).size}</strong> sources</span>
            <span className="ctx-sep" aria-hidden="true" />
            <span><span className="ctx-k">Case</span> <code className="tech-id">{caseId}</code></span>
          </div>
        </div>
        <div className="spacer" />
        <div className="search-wrap">
          <Icon name="search" size={13} />
          <input type="search" value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search evidence, event, source or entity…" />
        </div>
        <FilterPopover label="Sources" options={SOURCE_FILTERS} selected={sources}
          onToggle={id => setSources(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })} />
      </div>

      <div className="evidence-layout">
        <Panel flush>
          <Async state={list} rows={8}>
            {() => {
              if (!all.length) {
                return <div style={{ padding: 20 }}>
                  <Empty headline="No evidence records"
                    detail="This case has no stored records yet." />
                </div>
              }
              if (!filtered.length) {
                return (
                  <div style={{ padding: 20 }}>
                    <Empty headline="No matching evidence"
                      detail="No record matches the current search or source filter." />
                    <div style={{ textAlign: 'center', marginTop: 12 }}>
                      <button className="btn" onClick={clear}>Clear filters</button>
                    </div>
                  </div>
                )
              }
              return (
                <>
                  <div className="elist-head">
                    <span className="section-h" style={{ margin: 0 }}>Records</span>
                    <span className="t-dim">
                      {filtered.length === all.length
                        ? `${all.length} records`
                        : `${filtered.length} of ${all.length}`}
                    </span>
                  </div>
                  <div className="elist-wrap">
                    <table className="elist">
                      <thead>
                        <tr>
                          <th>Evidence ID</th><th>Event</th><th>Timestamp</th><th>Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map(r => (
                          <EvidenceRow key={r.event_id} record={r}
                            selected={selectedId === r.event_id} onSelect={select} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )
            }}
          </Async>
        </Panel>

        <Panel title="Record detail" flush>
          <EvidenceDetail state={record} onOpenEntity={onOpenEntity} onNavigate={onNavigate} />
        </Panel>
      </div>
    </div>
  )
}


/* ── Data ingestion ────────────────────────────────────────────────────── */

/*
  Ingestion log rather than a table dump.

  Priority runs: case, then anything wrong with the batch, then source, then
  when, then counts, and finally the technical metadata. The SHA-256 is the
  least prominent thing on the row precisely because it is the most technical —
  it is there to be checked, not read.
*/

/**
 * Status is DERIVED, not stored: the backend records counts, not a state.
 * This restates those counts and invents nothing. If a status field is added
 * later, use it instead of this.
 */
function batchStatus(b) {
  if (b.total === 0) return { label: 'Empty', tone: 'neutral' }
  if (b.quarantined === 0) return { label: 'Validated', tone: 'ok' }
  if (b.quarantined === b.total) return { label: 'Quarantined', tone: 'bad' }
  return { label: 'Partial', tone: 'warn' }
}

function BatchRow({ batch: b, selected, onSelect }) {
  const status = batchStatus(b)
  const received = new Date(b.received_at)
  const valid = Number.isNaN(received.getTime())

  return (
    <tr className={`blog-row ${selected ? 'is-selected' : ''}`}
      onClick={() => onSelect(b)} tabIndex={0} role="button"
      onKeyDown={e => e.key === 'Enter' && onSelect(b)}>
      <td className="blog-when">
        {valid ? <span className="mono">{b.received_at}</span> : (
          <>
            <span className="blog-date">
              {received.toLocaleDateString('en-GB',
                { day: '2-digit', month: 'short', year: 'numeric' })}
            </span>
            <span className="blog-time mono">
              {received.toLocaleTimeString('en-GB', { hour12: false })}
            </span>
          </>
        )}
      </td>
      <td className="blog-case mono">{b.case_id}</td>
      <td><span className={`src-tag src-${b.source}`}>{b.source.toUpperCase()}</span></td>
      <td className="blog-file mono" title={b.filename}>{b.filename}</td>
      <td className="blog-num">{fmtNum(b.total)}</td>
      <td className="blog-num">{fmtNum(b.validated)}</td>
      <td className="blog-num">
        {b.quarantined
          ? <span className="quar-flag">{b.quarantined}</span>
          : <span className="quar-zero">0</span>}
      </td>
      <td className="blog-hash mono" title={`SHA-256\n${b.sha256}`}>
        {b.sha256.slice(0, 8)}…{b.sha256.slice(-4)}
      </td>
      <td><span className={`blog-status tone-${status.tone}`}>{status.label}</span></td>
    </tr>
  )
}

function BatchHistory({ batches }) {
  const [selected, setSelected] = useState(null)

  if (!batches?.length) {
    return (
      <div style={{ padding: 20 }}>
        <Empty headline="No ingestion batches yet"
          detail="Uploaded datasets will appear here after ingestion." />
      </div>
    )
  }

  return (
    <>
      <div className="blog-wrap">
        <table className="blog">
          <thead>
            <tr>
              <th>Received</th>
              <th>Case</th>
              <th>Source</th>
              <th>File</th>
              <th className="blog-num">Total</th>
              <th className="blog-num">Valid</th>
              <th className="blog-num">Quar.</th>
              <th>SHA-256</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {batches.map(b => (
              <BatchRow key={b.batch_id} batch={b}
                selected={selected?.batch_id === b.batch_id}
                onSelect={x => setSelected(
                  selected?.batch_id === x.batch_id ? null : x)} />
            ))}
          </tbody>
        </table>
      </div>

      {/* detail comes from the row already loaded — no extra request */}
      {selected && (
        <div className="blog-detail">
          <div className="blog-detail-head">
            <strong>Batch detail</strong>
            <button className="btn sm" onClick={() => setSelected(null)}>Close</button>
          </div>
          <dl className="kv">
            <dt>Batch</dt><dd className="mono">{selected.batch_id}</dd>
            <dt>Case</dt><dd className="mono">{selected.case_id}</dd>
            <dt>Source</dt><dd>{sourceLabel(selected.source)}</dd>
            <dt>Received</dt><dd>{fmtDateTime(selected.received_at)}</dd>
            <dt>File</dt><dd className="mono">{selected.filename}</dd>
            <dt>Total records</dt><dd>{fmtNum(selected.total)}</dd>
            <dt>Validated</dt><dd>{fmtNum(selected.validated)}</dd>
            <dt>Quarantined</dt><dd>{fmtNum(selected.quarantined)}</dd>
            <dt>SHA-256</dt>
            <dd className="mono" style={{ wordBreak: 'break-all' }}>{selected.sha256}</dd>
          </dl>
          {selected.quarantined > 0 && (
            <p className="t-dim" style={{ fontSize: 12, marginTop: 8 }}>
              Quarantined records are retained and can be reviewed on the Evidence page.
            </p>
          )}
        </div>
      )}
    </>
  )
}

const SOURCE_KINDS = [
  ['cdr', 'CDR', 'Call detail records'],
  ['ipdr', 'IPDR', 'Internet session records'],
  ['bank', 'Banking', 'Financial transactions'],
  ['social', 'Social', 'Social media activity'],
]

export function Ingestion({ caseId }) {
  const [source, setSource] = useState('cdr')
  const [dragging, setDragging] = useState(false)
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
        {/*
          One drop area rather than four boxes that each repeated "Choose CSV".
          The source is a choice, not a separate surface: pick the kind of record
          first, then hand over the file.
        */}
        <div className="ingest">
          <div className="ingest-sources" role="radiogroup" aria-label="Record type">
            {SOURCE_KINDS.map(([key, label, note]) => (
              <button key={key} role="radio" aria-checked={source === key}
                className={`ingest-source ${source === key ? 'on' : ''}`}
                onClick={() => setSource(key)}>
                <span className="ingest-source-name">{label}</span>
                <span className="ingest-source-note">{note}</span>
              </button>
            ))}
          </div>

          <label className={`ingest-drop ${busy ? 'is-busy' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => {
              e.preventDefault(); setDragging(false)
              upload(source, e.dataTransfer.files?.[0])
            }}
            data-dragging={dragging || undefined}>
            <input type="file" accept=".csv" style={{ display: 'none' }}
              onChange={e => upload(source, e.target.files?.[0])} />
            <Icon name="ingestion" size={18} />
            <span className="ingest-drop-main">
              {busy
                ? `Uploading ${busy.toUpperCase()}…`
                : `Drop a ${source.toUpperCase()} file here, or choose one`}
            </span>
            <span className="ingest-drop-note">
              CSV · hashed before parsing · invalid rows quarantined, never dropped
            </span>
          </label>
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
            <BatchHistory batches={d.batches} />
          )}
        </Async>
      </Panel>
    </>
  )
}

/* ── System validation ─────────────────────────────────────────────────── */

/*
  A validation console, read top to bottom:

    1  did it pass                the verdict, in the largest type on the page
    2  by how much                precision, recall, false positives
    3  what was actually tested   the scenarios, so "7/7" means something
    4  case by case               each result, with the two that matter first
    5  what it does not claim     the synthetic-data caveat

  Failures are surfaced above everything else. A benchmark that failed at the
  bottom of a table is a benchmark nobody read.
*/

/** What each scenario demonstrates, keyed by the backend's own scenario text. */
const SCENARIO_MEANING = {
  'Normal behaviour': 'Ordinary activity is left alone',
  'Cross-domain anomaly': 'A sequence spanning several sources is detected',
  'Repeated legitimate behaviour': 'A long-standing routine is not flagged',
  'Suspicious network structure': 'A subject bridging separate groups is found',
  'Entity resolution': 'Identifiers are attributed to the right subject',
  'Corrupted input': 'Malformed records are quarantined, not trusted',
  'Missing data': 'Incomplete records are quarantined, not guessed',
}

/** The capabilities a judge most needs to see demonstrated. */
const HEADLINE_CASES = {
  CASE_002: 'Call records → Banking → Social',
  CASE_004: 'Relationship and network analysis',
}

function ValidationCase({ test }) {
  const passed = test.result === 'PASS'
  const headline = HEADLINE_CASES[test.case_id]
  const quarantined = test.actual_quarantine > 0 || test.expected_quarantine > 0

  return (
    <div className={`vcase ${passed ? '' : 'is-failed'} ${headline ? 'is-headline' : ''}`}>
      <span className={`vcase-mark ${passed ? 'ok' : 'bad'}`} aria-hidden="true">
        {passed ? '✓' : '⚠'}
      </span>

      <div className="vcase-main">
        <div className="vcase-title">
          <code className="tech-id">{test.case_id}</code>
          <span className="vcase-scenario">{test.scenario}</span>
        </div>
        {headline && <div className="vcase-headline">{headline}</div>}
        {test.rationale && <div className="vcase-why">{test.rationale}</div>}
        {quarantined && (
          <div className="vcase-quar">
            Quarantined {test.actual_quarantine} of {test.expected_quarantine} invalid records
            {test.actual_quarantine === test.expected_quarantine && ' · input isolation handled correctly'}
          </div>
        )}
      </div>

      <div className="vcase-verdict">
        <span className="vcase-exp">
          <span className="ctx-k">Expected</span> {test.expected}
        </span>
        <span className="vcase-arrow" aria-hidden="true">→</span>
        <span className={`vcase-act ${test.expected === test.actual ? 'match' : 'mismatch'}`}>
          <span className="ctx-k">Detected</span> {test.actual}
        </span>
      </div>

      <span className={`vcase-result ${passed ? 'ok' : 'bad'}`}>{test.result}</span>
    </div>
  )
}

export function Validation() {
  const [permutations, setPermutations] = useState(200)
  const state = useApi(() => api.benchmark(permutations), [permutations])

  return (
    <div className="validation-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">System validation</h1>
          <p className="page-lede">
            Benchmarked against labelled ground truth in <code className="tech-id">
            data/synthetic/ground_truth.json</code>
          </p>
        </div>
        <div className="spacer" />
        <label className="tl-field">
          <span>Permutations</span>
          <select value={permutations} onChange={e => setPermutations(Number(e.target.value))}>
            {[200, 500, 1000].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button className="btn" onClick={state.reload}>
          <Icon name="refresh" size={12} /> Re-run
        </button>
      </div>

      <Async state={state} rows={5}>
        {d => {
          const s = d.summary
          const failures = d.tests.filter(t => t.result !== 'PASS')
          const passed = failures.length === 0
          const health = s.tests ? Math.round((s.passed / s.tests) * 100) : 0
          const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`)

          return (
            <>
              {/* the verdict, and nothing competing with it */}
              <section className={`verdict ${passed ? 'is-pass' : 'is-fail'}`}>
                <div className="verdict-line">
                  <span className="verdict-mark" aria-hidden="true">{passed ? '✓' : '⚠'}</span>
                  <div>
                    <h2 className="verdict-head">
                      {passed ? 'Validation passed' : 'Validation requires review'}
                    </h2>
                    <p className="verdict-sub">
                      {passed
                        ? `${s.passed} of ${s.tests} benchmarks passed · no failures detected`
                        : `${s.passed} of ${s.tests} benchmarks passed · ${s.failed} failed`}
                    </p>
                  </div>
                  <div className="verdict-score">
                    <span className="verdict-num">{s.passed}<span className="verdict-of">/{s.tests}</span></span>
                    <span className="verdict-label">benchmarks passed</span>
                  </div>
                </div>

                <div className="health">
                  <div className="health-bar" role="img"
                    aria-label={`${health}% of benchmarks passed`}>
                    <div className={`health-fill ${passed ? 'ok' : 'bad'}`}
                      style={{ width: `${health}%` }} />
                  </div>
                  <span className="health-pct">{health}%</span>
                </div>

                <dl className="verdict-metrics">
                  <div><dt>Precision</dt><dd>{pct(s.precision)}</dd></div>
                  <div><dt>Recall</dt><dd>{pct(s.recall)}</dd></div>
                  <div><dt>False positives</dt>
                    <dd className={s.false_positives ? 'bad' : ''}>{s.false_positives}</dd></div>
                  <div><dt>False negatives</dt>
                    <dd className={s.false_negatives ? 'bad' : ''}>{s.false_negatives}</dd></div>
                  <div><dt>Correct alerts</dt><dd>{s.true_positives}</dd></div>
                </dl>
              </section>

              {/* a failure is never left to be discovered further down */}
              {failures.length > 0 && (
                <section className="fail-banner">
                  <h3>{failures.length} benchmark{failures.length === 1 ? '' : 's'} failed</h3>
                  {failures.map(t => (
                    <div key={t.case_id} className="fail-row">
                      <code className="tech-id">{t.case_id}</code>
                      <span>{t.scenario}</span>
                      <span className="t-dim">
                        expected <strong>{t.expected}</strong>, detected <strong>{t.actual}</strong>
                      </span>
                    </div>
                  ))}
                </section>
              )}

              <section className="vsection">
                <h3 className="section-h">What was tested</h3>
                <ul className="coverage">
                  {d.tests.map(t => (
                    <li key={t.case_id} className={t.result === 'PASS' ? 'ok' : 'bad'}>
                      <span className="cov-mark" aria-hidden="true">
                        {t.result === 'PASS' ? '✓' : '⚠'}
                      </span>
                      <span className="cov-name">{t.scenario}</span>
                      <span className="cov-meaning">
                        {SCENARIO_MEANING[t.scenario] || ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="vsection">
                <h3 className="section-h">Benchmark results</h3>
                <div className="vcases">
                  {[...d.tests]
                    .sort((a, b) => {
                      // failures first, then the two headline capabilities
                      const rank = t => (t.result !== 'PASS' ? 0 : HEADLINE_CASES[t.case_id] ? 1 : 2)
                      return rank(a) - rank(b) || a.case_id.localeCompare(b.case_id)
                    })
                    .map(t => <ValidationCase key={t.case_id} test={t} />)}
                </div>
              </section>

              <p className="vfoot">{d.label} — {d.disclaimer}</p>
            </>
          )
        }}
      </Async>
    </div>
  )
}



/* ── Reports ───────────────────────────────────────────────────────────── */

/*
  Export console.

  Each report states what it contains and carries its own button on the same
  row, so there is never a question of which action produces which document.

  Availability is observed, not assumed: a download is fetched, and the row
  reports what actually happened. A button that looks ready but produces an
  empty document is worse than one that says it cannot.
*/

const REPORT_KINDS = [
  {
    id: 'report',
    title: 'Investigation report',
    description: 'Case overview, findings with their statistics and baselines, '
      + 'the alternative explanations considered, and the supporting records.',
    includes: ['Overview', 'Findings', 'Statistics', 'Evidence'],
    primary: true,
    url: api.reportUrl,
    filename: c => `sentinel-report-${c}.pdf`,
  },
  {
    id: 'court-pack',
    title: 'Court pack',
    description: 'Exhibits only — source records, timestamps, identifiers and the '
      + 'SHA-256 of each file. Carries no score, p-value or finding, so the '
      + 'exhibits stand on their own.',
    includes: ['Source integrity', 'Exhibits', 'Provenance'],
    url: api.courtPackUrl,
    filename: c => `sentinel-court-pack-${c}.pdf`,
  },
  {
    id: 'audit-bundle',
    title: 'Audit bundle',
    description: 'Machine-readable export of every record, its provenance and the '
      + 'findings, hashed so alteration of the export itself is detectable.',
    includes: ['Records', 'Provenance', 'Findings', 'Integrity'],
    url: api.auditBundleUrl,
    filename: c => `sentinel-audit-${c}.json`,
  },
]

function ReportRow({ report, caseId, meta, last }) {
  const [status, setStatus] = useState('ready')
  const [error, setError] = useState(null)

  const download = async () => {
    setStatus('generating')
    setError(null)
    try {
      const response = await fetch(report.url(caseId))
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail.detail || `${response.status} ${response.statusText}`)
      }
      const blob = await response.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = report.filename(caseId)
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(href)
      setStatus('ready')
      toast(`${report.title} downloaded`, 'ok')
    } catch (e) {
      setStatus('failed')
      setError(e.message)
      toast(`${report.title} could not be generated`, 'bad')
    }
  }

  return (
    <div className={`rrow ${last ? 'is-last' : ''}`}>
      <div className="rrow-main">
        <div className="rrow-title">
          <Icon name={report.id === 'audit-bundle' ? 'validation' : 'reports'} size={13} />
          {report.title}
          {report.primary && <span className="rrow-primary">Primary</span>}
        </div>
        <p className="rrow-desc">{report.description}</p>
        <div className="rrow-meta">
          <span className="rrow-includes">
            Includes {report.includes.join(' · ')}
          </span>
          {meta && (
            <span className="rrow-payload mono">
              {meta.records} records · {meta.findings} findings
            </span>
          )}
        </div>
        {status === 'failed' && (
          <p className="rrow-error">Generation failed. {error}</p>
        )}
      </div>

      <div className="rrow-action">
        <button
          className={`btn ${report.primary ? 'primary' : ''}`}
          onClick={download}
          disabled={status === 'generating'}>
          {status === 'generating'
            ? 'Generating…'
            : status === 'failed'
              ? 'Retry'
              : report.id === 'audit-bundle' ? 'Download bundle' : 'Download'}
        </button>
      </div>
    </div>
  )
}

export function Reports({ caseId }) {
  const preview = useApi(() => api.reportPreview(caseId), [caseId], { enabled: !!caseId })

  if (!caseId) return <Empty headline="Select a case first" />

  return (
    <div className="reports-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            Investigation reports
            <code className="tech-id">{caseId}</code>
          </h1>
          <p className="page-lede">
            Generate investigation-ready documents from this case&rsquo;s evidence,
            findings and correlated activity.
          </p>
        </div>
      </div>

      <Async state={preview} rows={3}>
        {d => (
          <>
            <div className="payload">
              <span><strong>{fmtNum(d.records)}</strong> records</span>
              <span className="payload-sep" aria-hidden="true" />
              <span><strong>{d.subjects}</strong> subjects</span>
              <span className="payload-sep" aria-hidden="true" />
              <span><strong>{d.identifiers}</strong> identifiers</span>
              <span className="payload-sep" aria-hidden="true" />
              <span><strong>{d.findings}</strong> findings</span>
              <span className="payload-sep" aria-hidden="true" />
              <span><strong>{d.batches}</strong> source files</span>
              {d.quarantined > 0 && (
                <>
                  <span className="payload-sep" aria-hidden="true" />
                  <span className="warn"><strong>{d.quarantined}</strong> quarantined</span>
                </>
              )}
            </div>

            <div className="legal">
              <Icon name="alerts" size={14} />
              <p>
                Statistics appear with the baseline and testing assumptions they were
                measured against. Unusual activity does not imply guilt. These results
                are investigative leads, not conclusions, and require corroboration
                before any action is taken.
              </p>
            </div>

            <section className="reports-surface">
              <h2 className="section-h">Available reports</h2>
              {REPORT_KINDS.map((r, i) => (
                <ReportRow key={r.id} report={r} caseId={caseId} meta={d}
                  last={i === REPORT_KINDS.length - 1} />
              ))}
            </section>

            {d.records === 0 && (
              <p className="t-dim" style={{ fontSize: 12.5, marginTop: 12 }}>
                This case holds no usable records
                {d.quarantined ? ` — ${d.quarantined} were quarantined` : ''}. The
                documents will state that rather than omit it.
              </p>
            )}
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
