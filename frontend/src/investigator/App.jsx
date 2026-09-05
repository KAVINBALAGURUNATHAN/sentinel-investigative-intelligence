/*
  Application shell: top bar, persistent sidebar, routed workspace.

  Routing is hash-based and hand-rolled — the project has no router dependency
  and this needs eleven flat pages, not nested routes. The hash keeps a page
  linkable and survives a refresh, which matters when an investigator is asked
  to "look at entity E-104".
*/

import { useCallback, useEffect, useState } from 'react'
import './theme.css'
import { Icon, useApi } from './ui.jsx'
import { api } from './api.js'
import {
  Alerts, Cases, Dashboard, Entities, EntityDetail, Evidence, Ingestion,
  Network, Patterns, Reports, Timeline, Validation,
} from './pages.jsx'

const NAV = [
  { group: 'Investigation', items: [
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { id: 'cases', label: 'Cases', icon: 'cases' },
    { id: 'entities', label: 'Entities', icon: 'entities' },
    { id: 'network', label: 'Network', icon: 'network' },
    { id: 'timeline', label: 'Timeline', icon: 'timeline' },
  ] },
  { group: 'Analysis', items: [
    { id: 'patterns', label: 'Patterns', icon: 'patterns' },
    { id: 'alerts', label: 'Alerts', icon: 'alerts', badge: 'alerts' },
    { id: 'evidence', label: 'Evidence', icon: 'evidence' },
  ] },
  { group: 'System', items: [
    { id: 'ingestion', label: 'Data ingestion', icon: 'ingestion' },
    { id: 'validation', label: 'Validation', icon: 'validation' },
    { id: 'reports', label: 'Reports', icon: 'reports' },
  ] },
]

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const [page = 'dashboard', ...rest] = raw.split('/')
  return { page, param: rest.length ? decodeURIComponent(rest.join('/')) : null }
}

export default function App() {
  const [route, setRoute] = useState(parseHash)
  const [caseId, setCaseId] = useState(
    () => localStorage.getItem('sentinel.case') || '')
  const [search, setSearch] = useState('')

  const cases = useApi(() => api.cases(), [])
  const alerts = useApi(() => api.alerts(), [route.page === 'alerts'])
  const health = useApi(() => api.health(), [])

  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // adopt the first available case once the list loads
  useEffect(() => {
    const list = cases.data?.cases
    if (!list?.length) return
    if (!caseId || !list.some(c => c.case_id === caseId)) {
      setCaseId(list[0].case_id)
    }
  }, [cases.data, caseId])

  useEffect(() => {
    if (caseId) localStorage.setItem('sentinel.case', caseId)
  }, [caseId])

  const go = useCallback((page, param) => {
    window.location.hash = `/${page}${param ? `/${encodeURIComponent(param)}` : ''}`
  }, [])

  const openEntity = useCallback((id, opts = {}) => {
    if (opts.keepPage) return
    go('entity', id)
  }, [go])

  const openEvidence = useCallback(id => go('evidence', id), [go])

  const openAlerts = alerts.data?.alerts?.length || 0
  const backendDown = health.error

  const page = (() => {
    const shared = { caseId, onNavigate: go, onOpenEntity: openEntity, onOpenEvidence: openEvidence }
    switch (route.page) {
      case 'cases': return <Cases caseId={caseId} onSelectCase={setCaseId} />
      case 'entities': return <Entities {...shared} />
      case 'entity': return <EntityDetail {...shared} entityId={route.param} />
      case 'network': return <Network {...shared} />
      case 'timeline': return <Timeline {...shared} />
      case 'patterns': return <Patterns caseId={caseId} />
      case 'alerts': return <Alerts {...shared} />
      case 'evidence': return <Evidence {...shared} eventId={route.param} />
      case 'ingestion': return <Ingestion caseId={caseId} />
      case 'validation': return <Validation />
      case 'reports': return <Reports caseId={caseId} />
      default: return <Dashboard caseId={caseId} onNavigate={go} />
    }
  })()

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Icon name="shield" size={16} />
          <span className="brand-mark">SENTINEL</span>
          <span className="brand-sub">Investigative Intelligence</span>
        </div>

        <div className="topbar-search">
          <Icon name="search" size={13} />
          <input
            type="search"
            placeholder="Search entity, identifier or evidence id…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key !== 'Enter' || !search.trim()) return
              const term = search.trim()
              go(/^(E|EV)-/i.test(term) && term.includes('-') && term.length > 6
                ? 'evidence' : 'entity', term)
              setSearch('')
            }}
          />
        </div>

        <div className="topbar-right">
          <label className="topbar-field">
            <span className="k">Case</span>
            <select value={caseId} onChange={e => setCaseId(e.target.value)}
              style={{ height: 20, padding: '0 4px', fontSize: 11, background: 'transparent',
                border: 0, color: 'var(--text)', fontFamily: 'var(--mono)' }}>
              {(cases.data?.cases || []).map(c =>
                <option key={c.case_id} value={c.case_id}>{c.case_id}</option>)}
              {!cases.data?.cases?.length && <option value="">—</option>}
            </select>
          </label>
          <div className="topbar-field">
            <span className="k">Investigator</span>
            <span className="v" title="No authentication in this prototype">unauthenticated</span>
          </div>
          <div className="topbar-field">
            <span className="k">Backend</span>
            <span className="v" style={{ color: backendDown ? 'var(--high)' : 'var(--low)' }}>
              {health.loading ? '…' : backendDown ? 'offline' : 'online'}
            </span>
          </div>
        </div>
      </header>

      <div className="body">
        <nav className="sidebar">
          {NAV.map(section => (
            <div key={section.group}>
              <div className="nav-group">{section.group}</div>
              {section.items.map(item => (
                <button key={item.id}
                  className={`nav-item${route.page === item.id
                    || (item.id === 'entities' && route.page === 'entity') ? ' active' : ''}`}
                  onClick={() => go(item.id)}>
                  <Icon name={item.icon} size={14} />
                  {item.label}
                  {item.badge === 'alerts' && openAlerts > 0 &&
                    <span className="nav-count">{openAlerts}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <main className="main">
          {backendDown && (
            <div className="not-connected" style={{ marginBottom: 12 }}>
              <Icon name="info" size={13} />
              <div>
                <strong>Backend unreachable.</strong> Nothing on these pages is
                cached or simulated, so they will stay empty until the API at{' '}
                <code>{import.meta.env.VITE_API_URL || 'http://localhost:8000'}</code> responds.
              </div>
            </div>
          )}
          {page}
        </main>
      </div>
    </div>
  )
}
