/**
 * Human-readable labels.
 *
 * The backend speaks in identifiers: CALL_TRANSFER_SOCIAL, STRUCTURAL_BRIDGE,
 * DATA_SESSION. Those are correct and must stay available — an investigator
 * may need to quote the exact finding name — but they are not what a person
 * should read first.
 *
 * Every function here returns the plain-English meaning. The technical string
 * is shown alongside, smaller, never instead.
 */

// ── Event types ───────────────────────────────────────────────────────────

const EVENT_LABELS = {
  CALL: 'Call',
  SMS: 'Text Message',
  MESSAGE: 'Message',
  TRANSFER: 'Financial Transfer',
  DATA_SESSION: 'Internet Session',
  LOGIN: 'Account Login',
  SOCIAL_POST: 'Social Interaction',
  SOCIAL_CONNECTION: 'Social Connection',
}

export function eventLabel(type) {
  return EVENT_LABELS[type] || titleCase(type)
}

// ── Finding names ─────────────────────────────────────────────────────────

const FINDING_LABELS = {
  STRUCTURAL_BRIDGE: 'Connects otherwise separate groups',
}

/**
 * "CALL_TRANSFER_SOCIAL" → "Call → Financial Transfer → Social Interaction"
 *
 * Sequence patterns are built from event types joined by underscores, so they
 * are decoded rather than enumerated: a new pattern gets a readable name
 * without anyone editing this file.
 */
export function findingLabel(pattern, sequence) {
  if (!pattern) return 'Unnamed finding'
  if (FINDING_LABELS[pattern]) return FINDING_LABELS[pattern]

  const steps = (sequence?.length ? sequence : pattern.split('_')).map(step => {
    if (EVENT_LABELS[step]) return EVENT_LABELS[step]
    // Patterns abbreviate: SOCIAL means SOCIAL_POST, so match on the prefix.
    const match = Object.keys(EVENT_LABELS).find(key => key.startsWith(step))
    return match ? EVENT_LABELS[match] : titleCase(step)
  })

  if (steps.length === 1) return steps[0]
  if (steps.length === 2) return `${steps[0]} followed by ${steps[1]}`
  return steps.join(' → ')
}

/** One line an investigator can act on, without statistics. */
export function findingMeaning(pattern) {
  if (pattern === 'STRUCTURAL_BRIDGE') {
    return 'This subject is the link between groups that otherwise have no contact.'
  }
  return 'These actions repeatedly happened together, in this order, within a short window.'
}

// ── Subjects ──────────────────────────────────────────────────────────────

/**
 * Investigators think in subjects, not database keys. The technical id stays
 * visible next to this, never replaced by it.
 */
export function subjectLabel(entityId) {
  if (!entityId) return 'Unidentified subject'
  return `Subject ${entityId}`
}

// ── Data sources ──────────────────────────────────────────────────────────

const SOURCE_LABELS = {
  cdr: 'Call Records',
  ipdr: 'Internet Records',
  bank: 'Banking',
  social: 'Social Media',
}

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || titleCase(source)
}

const DOMAIN_BY_EVENT = {
  CALL: 'cdr', SMS: 'cdr', MESSAGE: 'social',
  TRANSFER: 'bank',
  DATA_SESSION: 'ipdr', LOGIN: 'ipdr',
  SOCIAL_POST: 'social', SOCIAL_CONNECTION: 'social',
}

/** Which independent record sources support a finding. */
export function sourcesForSequence(sequence = []) {
  const seen = []
  sequence.forEach(step => {
    const key = DOMAIN_BY_EVENT[step]
      || Object.entries(DOMAIN_BY_EVENT).find(([k]) => k.startsWith(step))?.[1]
    if (key && !seen.includes(key)) seen.push(key)
  })
  return seen
}

// ── Priority and decisions ────────────────────────────────────────────────

export function priorityLabel(severity) {
  return { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' }[severity] || 'Unranked'
}

export function decisionLabel(decision) {
  return {
    REVIEW: 'Requires investigation',
    MONITOR: 'Worth monitoring',
    NO_ACTION: 'Consistent with normal behaviour',
    INSUFFICIENT_DATA: 'Not enough history to judge',
  }[decision] || titleCase(decision)
}

// ── Statistics, in words ──────────────────────────────────────────────────

/**
 * Lift expressed the way it should be said out loud. "17.3× more often than
 * expected" means nothing to most readers; anchoring it to the subject's own
 * history does.
 */
export function unusualnessPhrase(lift) {
  if (lift == null) return 'Not measured'
  if (lift >= 10) return `${round(lift)}× more often than this subject's own history`
  if (lift >= 3) return `${round(lift)}× more often than expected`
  if (lift >= 1.5) return `Somewhat more often than expected (${round(lift)}×)`
  return 'About as often as expected'
}

export function confidencePhrase(pValue) {
  if (pValue == null) return 'Not tested'
  if (pValue < 0.001) return 'Very unlikely to be coincidence (p < 0.001)'
  if (pValue < 0.01) return `Unlikely to be coincidence (p = ${pValue.toFixed(3)})`
  if (pValue < 0.05) return `Possibly not coincidence (p = ${pValue.toFixed(3)})`
  return `Could easily be coincidence (p = ${pValue.toFixed(2)})`
}

export function pValueText(p) {
  if (p == null) return '—'
  return p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`
}

// ── Formatting ────────────────────────────────────────────────────────────

export function formatAmount(amount, currency = 'INR') {
  if (amount == null) return null
  const value = Number(amount)
  if (Number.isNaN(value)) return null
  const symbol = currency === 'INR' ? '₹' : ''
  return `${symbol}${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

export function formatClock(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function formatGap(fromIso, toIso) {
  const a = new Date(fromIso).getTime()
  const b = new Date(toIso).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  const minutes = Math.round((b - a) / 60000)
  if (minutes < 1) return 'moments later'
  if (minutes < 60) return `${minutes} min later`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} hr later` : `${Math.round(hours / 24)} days later`
}

function round(value) {
  return Number(value).toFixed(1).replace(/\.0$/, '')
}

function titleCase(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join(' ')
}

/** Standing caveat. Shown wherever a finding is presented. */
export const NOT_GUILT =
  'Unusual activity does not imply guilt. These are leads for investigation, not conclusions.'

/* ══ Case-level interpretation ═══════════════════════════════════════════
   Everything below is DERIVED from case data. Nothing is hardcoded per case:
   add a case to the backend and it gets a headline, a status and a story
   without anyone editing this file. */

export const SOURCE_DEFS = {
  cdr: { name: 'CDR', full: 'Call Records',
    tip: 'Call Detail Records — who called whom, when, and for how long. Supplied by the telecom operator.' },
  ipdr: { name: 'IPDR', full: 'Internet Usage Records',
    tip: 'Internet Protocol Detail Records — data sessions, IP addresses and volumes. Content is not included.' },
  bank: { name: 'Banking', full: 'Financial Transactions',
    tip: 'Account-to-account transfers: payer, payee, amount and channel.' },
  social: { name: 'Social', full: 'Public Interactions',
    tip: 'Publicly visible social activity: posts, connections and login events.' },
}

/**
 * A one-line description of what a case is about, derived from the domains its
 * findings actually span. Falls back to describing the data when nothing has
 * been flagged — an unremarkable case still needs a name.
 */
export function caseHeadline(kase, alerts = []) {
  const structural = alerts.filter(a => a.pattern === 'STRUCTURAL_BRIDGE')
  const sequences = alerts.filter(a => a.pattern !== 'STRUCTURAL_BRIDGE')

  if (sequences.length) {
    const domains = new Set()
    sequences.forEach(a => sourcesForSequence(a.detail?.sequence || []).forEach(d => domains.add(d)))
    const money = domains.has('bank')
    const talk = domains.has('cdr') || domains.has('social')
    if (money && talk) return 'Unusual communication and financial activity'
    if (money) return 'Unusual financial activity'
    if (talk) return 'Unusual communication activity'
    return 'Unusual cross-source activity'
  }

  if (structural.length) return 'Communication network analysis'

  const count = (kase.data_sources || []).length
  if (count > 1) return 'Multi-source investigation'
  if (count === 1) return `${sourceLabel(kase.data_sources[0])} review`
  return 'Awaiting data'
}

/** Highest severity among a case's findings. */
export function casePriority(alerts = []) {
  if (alerts.some(a => a.severity === 'HIGH')) return 'HIGH'
  if (alerts.some(a => a.severity === 'MEDIUM')) return 'MEDIUM'
  return 'NORMAL'
}

/**
 * Status in words, never colour alone. Investigator-entered status wins when
 * it exists; otherwise it is inferred from whether anything is flagged.
 */
export function caseStatus(kase, alerts = []) {
  const declared = kase.case_metadata?.status
  if (declared && kase.case_metadata?.implemented !== false) return titleStatus(declared)
  if (!alerts.length) return 'No current findings'
  return alerts.some(a => a.severity === 'HIGH') ? 'Open' : 'Under review'
}

function titleStatus(value) {
  return String(value).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Plain-English account of what actually happened, built from real events.
 *
 * Reads the subject's own records rather than restating the pattern name, so
 * the sentence names real counterparties, real amounts and real gaps. Returns
 * null when the records cannot support a sentence — an empty story is better
 * than an invented one.
 */
export function caseStory(alert, events = []) {
  if (!alert) return null

  if (alert.pattern === 'STRUCTURAL_BRIDGE') {
    const d = alert.detail || {}
    if (d.betweenness == null) return null
    return `${subjectLabel(alert.entity_id)} sits on ${Math.round(d.betweenness * 100)}% of the `
      + `shortest paths through this network while carrying only `
      + `${Math.round((d.volume_share || 0) * 100)}% of its traffic. Groups that otherwise have `
      + `no contact are connected through this subject.`
  }

  const sequence = alert.detail?.sequence || []
  if (!sequence.length || !events.length) return null

  // Find the first real run of events matching the flagged sequence.
  const window = (alert.detail?.window_minutes || 30) * 60000
  let run = null
  for (let i = 0; i < events.length && !run; i++) {
    const candidate = [events[i]]
    for (let j = i + 1; j < events.length && candidate.length < sequence.length; j++) {
      const next = events[j]
      const want = sequence[candidate.length]
      const matches = next.event_type === want || next.event_type.startsWith(want)
      if (matches && new Date(next.timestamp) - new Date(candidate[0].timestamp) <= window) {
        candidate.push(next)
      }
    }
    const first = events[i]
    if (candidate.length === sequence.length
        && (first.event_type === sequence[0] || first.event_type.startsWith(sequence[0]))) {
      run = candidate
    }
  }
  if (!run) return null

  const who = run[0].actor_entity || run[0].actor
  const other = run[0].target_entity || run[0].target
  const parts = run.map((event, index) => {
    const amount = formatAmount(event.amount, event.currency)
    const name = eventLabel(event.event_type).toLowerCase()
    if (index === 0) {
      return other ? `${subjectLabel(who)} made a ${name} to ${other}` : `${subjectLabel(who)} made a ${name}`
    }
    const gap = formatGap(run[index - 1].timestamp, event.timestamp)
    const what = amount ? `a ${amount} ${name}` : `a ${name}`
    return `followed by ${what} ${gap}`
  })

  const lift = alert.lift != null
    ? ` This sequence occurs ${alert.lift.toFixed(1)}× more often than ${alert.entity_id}'s own historical baseline.`
    : ''
  return `${parts.join(', ')}.${lift}`
}
