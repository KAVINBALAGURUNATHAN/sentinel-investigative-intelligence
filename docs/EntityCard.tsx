/**
 * EntityCard — standalone Tailwind reference implementation.
 *
 * WHERE THIS FITS
 * This file is NOT part of the running SENTINEL application. That app is Vite +
 * JSX with a CSS-token design system, and it renders the same card from live
 * API data (see frontend/src/investigator/pages.jsx, SubjectCard). This is the
 * Next.js / TypeScript / Tailwind version, self-contained so it can be dropped
 * into another project and render immediately.
 *
 * It lives under docs/ deliberately: nothing imports it, so it cannot be pulled
 * into the Vite build or drift into the product by accident.
 *
 * THE DATA BELOW IS SYNTHETIC.
 * Values match data/synthetic/ — the same records the real card displays. They
 * are invented benchmark data: no phone number, account or handle here belongs
 * to a real person. When wiring this to a backend, replace `mockEntity` with the
 * response from GET /api/v1/entities/{id}?case_id={case} and delete the mock.
 *
 * Requires Tailwind with the default zinc palette. No other dependency.
 */

'use client'

import type { FC } from 'react'

/* ── Types ──────────────────────────────────────────────────────────────── */

export type Priority = 'HIGH' | 'MEDIUM' | 'LOW'

export interface Identifier {
  /** Human label, e.g. "Bank account". */
  label: string
  /** The value exactly as stored. Never reformatted for display. */
  value: string
}

export interface ActivityCount {
  label: string
  count: number
}

export interface Connection {
  entity: string
  /** Relationship kinds linking the two, e.g. ["Call", "Financial transfer"]. */
  relationships: string[]
  /** Independent record sources supporting them, e.g. ["CDR", "BANKING"]. */
  sources: string[]
}

export interface Entity {
  id: string
  priority: Priority
  /** One line on why this subject is on screen. Empty when nothing is flagged. */
  summary: string
  identifiers: Identifier[]
  activity: ActivityCount[]
  connections: Connection[]
  lastActivity: string
  sources: string[]
  /** Events per day, oldest first. Drives the trend line. */
  activityTrend?: number[]
}

export interface EntityCardProps {
  entity: Entity
  onOpenInvestigation?: (id: string) => void
  onOpenNetwork?: (id: string) => void
  onOpenEntity?: (id: string) => void
}

/* ── Synthetic demo data ────────────────────────────────────────────────── */

/** SYNTHETIC. Mirrors data/synthetic/ — not real personal information. */
export const mockEntity: Entity = {
  id: 'E-104',
  priority: 'HIGH',
  summary:
    'Potentially anomalous cross-source activity involving financial and communication relationships.',
  identifiers: [
    { label: 'Phone', value: '9999900104' },
    { label: 'Bank account', value: 'AXIS0004400104' },
    { label: 'UPI', value: 'subjectd@upi' },
    { label: 'IMEI', value: '356938035643104' },
    { label: 'IMSI', value: '404450123456104' },
    { label: 'IP address', value: '203.0.113.14' },
    { label: 'Social', value: '@subject_d' },
  ],
  activity: [
    { label: 'Call', count: 28 },
    { label: 'Internet session', count: 18 },
    { label: 'Financial transfer', count: 18 },
    { label: 'Social interaction', count: 18 },
  ],
  connections: [
    { entity: 'E-105', relationships: ['Call', 'Financial transfer'], sources: ['CDR', 'BANKING'] },
    { entity: 'E-106', relationships: ['Call'], sources: ['CDR'] },
  ],
  lastActivity: '2026-08-19 06:05:00',
  sources: ['CDR', 'Banking', 'IPDR', 'Social'],
  activityTrend: [4, 9, 12, 7, 14, 18, 11, 6, 3, 8, 15, 19, 10, 5],
}

/* ── Pieces ─────────────────────────────────────────────────────────────── */

const PRIORITY_STYLES: Record<Priority, string> = {
  HIGH: 'bg-red-50 text-red-700 border-red-200',
  MEDIUM: 'bg-amber-50 text-amber-700 border-amber-200',
  LOW: 'bg-zinc-100 text-zinc-600 border-zinc-200',
}

const ColumnHeading: FC<{ children: React.ReactNode }> = ({ children }) => (
  <h4 className="mb-4 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
    {children}
  </h4>
)

/**
 * A label/value row.
 *
 * The label column is a fixed width and the value sits directly beside it.
 * `justify-between` would push the two apart and strand whitespace across the
 * middle of the card, which is what makes a summary read like a spreadsheet.
 */
const Row: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-baseline py-1.5">
    <span className="w-32 flex-shrink-0 text-sm text-zinc-500">{label}</span>
    <span className="min-w-0 truncate">{children}</span>
  </div>
)

const Badge: FC<{ children: React.ReactNode; tone?: 'default' | 'source' }> = ({
  children,
  tone = 'default',
}) => (
  <span
    className={[
      'rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
      tone === 'source'
        ? 'border-blue-100 bg-blue-50 text-blue-700'
        : 'border-zinc-200 bg-zinc-100 text-zinc-500',
    ].join(' ')}
  >
    {children}
  </span>
)

/** Events per day. Captioned, so it reads as data rather than ornament. */
const Trend: FC<{ values: number[] }> = ({ values }) => {
  if (!values.length) return null
  const peak = Math.max(...values, 1)
  const step = values.length > 1 ? 72 / (values.length - 1) : 72
  const points = values.map((v, i) => `${i * step},${20 - (v / peak) * 18}`).join(' ')

  return (
    <div className="flex flex-col items-end gap-0.5">
      <svg
        width="72"
        height="20"
        viewBox="0 0 72 20"
        role="img"
        aria-label={`Activity trend across ${values.length} days, peak ${peak} events in a day`}
      >
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-blue-600"
        />
      </svg>
      <span className="text-[9px] text-zinc-400">{values.length}-day activity trend</span>
    </div>
  )
}

const FooterButton: FC<{ onClick?: () => void; children: React.ReactNode }> = ({
  onClick,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1"
  >
    {children}
  </button>
)

const MetaPair: FC<{ label: string; value: string; mono?: boolean }> = ({
  label,
  value,
  mono,
}) => (
  <span className="flex items-baseline gap-1.5">
    <span className="text-xs text-zinc-500">{label}:</span>
    <span className={`text-xs font-medium text-zinc-800 ${mono ? 'font-mono' : ''}`}>
      {value}
    </span>
  </span>
)

/* ── Card ───────────────────────────────────────────────────────────────── */

export const EntityCard: FC<EntityCardProps> = ({
  entity,
  onOpenInvestigation,
  onOpenNetwork,
  onOpenEntity,
}) => {
  const {
    id, priority, summary, identifiers, activity, connections, lastActivity, sources,
    activityTrend = [],
  } = entity

  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
      {/* Who, and how urgent — before anything else */}
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <h3 className="text-lg font-semibold text-zinc-900">Subject {id}</h3>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-600">
            {id}
          </span>
        </div>

        <div className="flex items-center gap-4">
          <Trend values={activityTrend} />
          {/* Worded, so priority is not carried by colour alone */}
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLES[priority]}`}
          >
            {priority} priority
          </span>
        </div>
      </header>

      {/* Why an investigator should care */}
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-zinc-600">
        {summary || 'No high-priority finding currently associated with this subject.'}
      </p>

      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-3">
        <section>
          <ColumnHeading>Identifiers</ColumnHeading>
          {identifiers.length ? (
            identifiers.map(i => (
              <Row key={`${i.label}-${i.value}`} label={i.label}>
                <span className="font-mono text-sm text-zinc-800">{i.value}</span>
              </Row>
            ))
          ) : (
            <p className="text-sm text-zinc-400">None resolved</p>
          )}
        </section>

        <section>
          <ColumnHeading>Activity summary</ColumnHeading>
          {activity.length ? (
            activity.map(a => (
              <Row key={a.label} label={a.label}>
                <span className="text-sm font-medium text-zinc-900">{a.count}</span>
              </Row>
            ))
          ) : (
            <p className="text-sm text-zinc-400">No recorded activity</p>
          )}
        </section>

        <section>
          <div className="mb-4 flex items-baseline justify-between gap-2">
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Key connections
            </h4>
            <span className="text-xs text-zinc-400">
              {connections.length
                ? `${connections.length} connected ${connections.length === 1 ? 'entity' : 'entities'}`
                : 'No connected entities'}
            </span>
          </div>

          {connections.map(c => (
            <div key={c.entity} className="py-1.5">
              <button
                type="button"
                onClick={() => onOpenEntity?.(c.entity)}
                className="text-sm font-semibold text-zinc-900 hover:text-blue-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                {c.entity}
              </button>
              <div className="mt-1 flex flex-wrap gap-1">
                {c.relationships.map(r => (
                  <Badge key={r}>{r}</Badge>
                ))}
                {c.sources.map(s => (
                  <Badge key={s} tone="source">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </section>
      </div>

      <footer className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-zinc-100 pt-4">
        <div className="flex gap-2">
          <FooterButton onClick={() => onOpenInvestigation?.(id)}>
            View investigation
          </FooterButton>
          <FooterButton onClick={() => onOpenNetwork?.(id)}>View network</FooterButton>
        </div>

        <div className="flex flex-wrap items-center">
          <MetaPair label="Last activity" value={lastActivity} mono />
          <span className="mx-3 h-3 border-l border-zinc-300" aria-hidden="true" />
          <MetaPair label="Sources" value={sources.join(' · ')} />
        </div>
      </footer>
    </article>
  )
}

export default function EntityCardDemo() {
  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <EntityCard entity={mockEntity} />
    </div>
  )
}
