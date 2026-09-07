/*
  API client for the multi-domain investigation backend.

  One rule governs this file: never invent data. If a request fails, the error
  reaches the page and the page says so. A dashboard that silently renders
  zeros when the backend is down is worse than one that shows an error, because
  an investigator cannot tell the difference between "no alerts" and "not
  loaded".
*/

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const V1 = `${BASE}/api/v1`

export class ApiError extends Error {
  constructor(message, status, url) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.url = url
  }
}

async function request(path, options = {}) {
  let response
  try {
    response = await fetch(`${V1}${path}`, options)
  } catch (cause) {
    throw new ApiError(
      `Cannot reach the backend at ${BASE}. Is it running?`, 0, path, { cause })
  }
  if (!response.ok) {
    let detail = `Request failed (${response.status})`
    try {
      const body = await response.json()
      if (body?.detail) detail = body.detail
    } catch {
      /* response had no JSON body; keep the status message */
    }
    throw new ApiError(detail, response.status, path)
  }
  return response.json()
}

export const api = {
  health: () => fetch(`${BASE}/health`).then(r => r.json()),

  cases: () => request('/cases'),
  case: id => request(`/cases/${encodeURIComponent(id)}`),
  entities: caseId => request(`/cases/${encodeURIComponent(caseId)}/entities`),
  caseMetadata: id => request(`/cases/${encodeURIComponent(id)}/metadata`),
  saveCaseMetadata: (id, body) => request(`/cases/${encodeURIComponent(id)}/metadata`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  caseStatuses: () => request('/case-statuses'),
  entity: (id, caseId) =>
    request(`/entities/${encodeURIComponent(id)}?case_id=${encodeURIComponent(caseId)}`),

  timeline: (caseId, params = {}) => {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null))
    return request(`/cases/${encodeURIComponent(caseId)}/timeline?${query}`)
  },

  // window_minutes is configurable: a sequence that falls outside the default
  // 30 minutes is a real finding at a wider window, not an absence.
  patterns: (caseId, permutations = 500, windowMinutes = 30) =>
    request(`/cases/${encodeURIComponent(caseId)}/patterns` +
            `?permutations=${permutations}&window_minutes=${windowMinutes}`),
  networkMetrics: caseId =>
    request(`/cases/${encodeURIComponent(caseId)}/network/metrics`),
  network: caseId => request(`/cases/${encodeURIComponent(caseId)}/network`),

  graph: caseId => request(`/cases/${encodeURIComponent(caseId)}/graph`),
  buildGraph: caseId =>
    request(`/cases/${encodeURIComponent(caseId)}/graph/build`, { method: 'POST' }),

  alerts: caseId =>
    request(`/alerts${caseId ? `?case_id=${encodeURIComponent(caseId)}` : ''}`),
  evidence: eventId => request(`/evidence/${encodeURIComponent(eventId)}`),

  batches: caseId =>
    request(`/ingestion/batches${caseId ? `?case_id=${encodeURIComponent(caseId)}` : ''}`),
  ingest: (source, file, caseId) => {
    const form = new FormData()
    form.append('file', file)
    return request(
      `/ingest/${source}?case_id=${encodeURIComponent(caseId || 'CASE_001')}`,
      { method: 'POST', body: form })
  },

  benchmark: (permutations = 200) =>
    request(`/validation/benchmark?permutations=${permutations}`),

  reportPreview: caseId =>
    request(`/cases/${encodeURIComponent(caseId)}/report/preview`),
  reportUrl: caseId => `${V1}/cases/${encodeURIComponent(caseId)}/report`,
  courtPackUrl: caseId =>
    `${V1}/cases/${encodeURIComponent(caseId)}/report/court-pack`,
  auditBundleUrl: caseId => `${V1}/cases/${encodeURIComponent(caseId)}/audit-bundle`,
}

/* ── formatting ─────────────────────────────────────────────────────────
   Kept here so every page renders a timestamp or an amount the same way. */

export function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().slice(11, 19)
}

export function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().slice(0, 10)
}

export function fmtDateTime(iso) {
  if (!iso) return '—'
  return `${fmtDate(iso)} ${fmtTime(iso)}`
}

export function fmtInr(value) {
  if (value == null || value === '') return '—'
  const n = Number(value)
  if (Number.isNaN(n)) return String(value)
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}

export function fmtNum(value) {
  if (value == null) return '—'
  const n = Number(value)
  return Number.isNaN(n) ? String(value) : n.toLocaleString('en-IN')
}

/* p-values below the resolution of the permutation test must not be printed
   as "0.000" — that would claim more precision than the test can support. */
export function fmtP(p, permutations = 1000) {
  if (p == null) return '—'
  const floor = 1 / (permutations + 1)
  if (p <= floor) return `<${floor.toFixed(4)}`
  return p.toFixed(4)
}

export const DOMAIN_OF = {
  CALL: 'cdr', SMS: 'cdr', MESSAGE: 'cdr',
  DATA_SESSION: 'ipdr', LOGIN: 'ipdr',
  TRANSFER: 'bank',
  SOCIAL_POST: 'social', SOCIAL_CONNECTION: 'social',
}

export const severityClass = s => (s || '').toLowerCase() || 'neutral'
