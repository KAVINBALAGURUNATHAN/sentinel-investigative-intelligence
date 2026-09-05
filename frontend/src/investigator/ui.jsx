/*
  Shared interface primitives.

  Icons are drawn as inline SVG rather than emoji: consistent across operating
  systems, crisp when projected, and appropriate for evidentiary presentation.
*/

import { useCallback, useEffect, useRef, useState } from 'react'

const PATHS = {
  dashboard: 'M3 3h7v8H3zM14 3h7v5h-7zM14 11h7v10h-7zM3 14h7v7H3z',
  cases: 'M3 7a1 1 0 011-1h5l2 2.5h9a1 1 0 011 1V19a1 1 0 01-1 1H4a1 1 0 01-1-1z',
  entities: 'M12 3a3 3 0 100 6 3 3 0 000-6zM5 21v-2a4 4 0 014-4h6a4 4 0 014 4v2',
  network: 'M12 3a2.4 2.4 0 100 4.8A2.4 2.4 0 0012 3zM4.5 16a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8zM19.5 16a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8zM10.6 7.6L6 15M13.4 7.6L18 15M7 18.4h10',
  timeline: 'M6 3v18M6 7h9M6 12h13M6 17h7',
  patterns: 'M4 18l4-7 4 4 4-9 4 5',
  alerts: 'M12 4.5L2.9 20h18.2L12 4.5zM12 10v4.3M12 17.2v.2',
  evidence: 'M7 3.5h7l5 5v12a1 1 0 01-1 1H7a1 1 0 01-1-1v-16a1 1 0 011-1zM14 3.5v5h5M9 13h6M9 16.5h6',
  ingestion: 'M12 16V4M8 8l4-4 4 4M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2',
  validation: 'M4 12.5l5 5L20 6.5',
  reports: 'M5 20h14M8 16V9M12 16V5M16 16v-5',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM16.2 16.2L21 21',
  shield: 'M12 2.5l8 3v6c0 5-3.4 9.2-8 10.5-4.6-1.3-8-5.5-8-10.5v-6l8-3z',
  info: 'M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17zM12 11v5.5M12 7.8v.3',
  empty: 'M4 8.5h16v11a1 1 0 01-1 1H5a1 1 0 01-1-1zM3 4.5h18v4H3zM10 12.5h4',
  refresh: 'M20 12a8 8 0 11-2.6-5.9M20 4v4.5h-4.5',
  chevron: 'M9 6l6 6-6 6',
  close: 'M6 6l12 12M18 6L6 18',
  link: 'M9.5 14.5l5-5M8 12l-2.5 2.5a3.2 3.2 0 004.5 4.5L12.5 16.5M16 12l2.5-2.5a3.2 3.2 0 00-4.5-4.5L11.5 7.5',
}

export function Icon({ name, size = 14, strokeWidth = 1.8, className = '' }) {
  const d = PATHS[name]
  if (!d) return null
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  )
}

export function Panel({ title, actions, children, flush = false }) {
  return (
    <section className="panel">
      {(title || actions) && (
        <header className="panel-head">
          {title && <h2 className="panel-title">{title}</h2>}
          <div className="spacer" />
          {actions}
        </header>
      )}
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  )
}

export function Tile({ label, value, note, tone }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className={`tile-value${tone ? ` ${tone}` : ''}`}>{value}</div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  )
}

export const Pill = ({ tone = 'neutral', children }) =>
  <span className={`pill ${tone}`}>{children}</span>

export const Chip = ({ domain, children }) =>
  <span className={`chip${domain ? ` ${domain}` : ''}`}>{children}</span>

export function Loading({ rows = 5 }) {
  return (
    <div style={{ padding: 12 }} aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${100 - i * 8}%` }} />
      ))}
    </div>
  )
}

export function Empty({ headline = 'Nothing to show', detail, icon = 'empty' }) {
  return (
    <div className="state">
      <Icon name={icon} size={26} strokeWidth={1.3} />
      <div className="headline">{headline}</div>
      {detail && <div className="detail">{detail}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry }) {
  const status = error?.status
  return (
    <div className="state error">
      <Icon name="alerts" size={26} strokeWidth={1.3} />
      <div className="headline">
        {status === 404 ? 'No data for this case' : 'Could not load'}
      </div>
      <div className="detail">{error?.message || String(error)}</div>
      {onRetry && <button className="btn sm" onClick={onRetry}>
        <Icon name="refresh" size={11} /> Retry
      </button>}
    </div>
  )
}

/* A capability with no data behind it. Shown instead of inventing values. */
export function NotConnected({ children }) {
  return (
    <div className="not-connected">
      <Icon name="info" size={13} />
      <div><strong>Prototype / Not Connected.</strong> {children}</div>
    </div>
  )
}

export const Hint = ({ tip, children }) =>
  <span className="hint" title={tip}>{children}</span>

export function Table({ columns, rows, empty, onRowClick, selectedKey, rowKey }) {
  if (!rows?.length) return empty || <Empty />
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map(c => <th key={c.key} style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const key = rowKey ? rowKey(row) : i
            return (
              <tr key={key}
                className={`${onRowClick ? 'selectable' : ''}${selectedKey === key ? ' selected' : ''}`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map(c => (
                  <td key={c.key} className={c.className}>
                    {c.render ? c.render(row) : (row[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/*
  Data loading hook.

  Returns an explicit state machine — loading / error / data — so a page can
  never accidentally render "0" while a request is still in flight.
*/
export function useApi(fn, deps = [], { enabled = true } = {}) {
  const [state, setState] = useState({ loading: enabled, error: null, data: null })
  const [nonce, setNonce] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!enabled) {
      setState({ loading: false, error: null, data: null })
      return
    }
    let live = true
    setState(s => ({ ...s, loading: true, error: null }))
    fnRef.current()
      .then(data => { if (live) setState({ loading: false, error: null, data }) })
      .catch(error => { if (live) setState({ loading: false, error, data: null }) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled])

  const reload = useCallback(() => setNonce(n => n + 1), [])
  return { ...state, reload }
}

/* Renders the right thing for each state, so pages stay declarative. */
export function Async({ state, children, empty, rows }) {
  if (state.loading) return <Loading rows={rows} />
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />
  if (!state.data) return empty || <Empty />
  return children(state.data)
}
