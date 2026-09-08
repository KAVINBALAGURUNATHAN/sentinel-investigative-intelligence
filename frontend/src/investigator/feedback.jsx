/*
  Two small pieces of interface furniture used across pages.

  Sparkline — activity per day for one subject, drawn from the real series the
  API returns. It is deliberately unlabelled and small: it answers "was this
  steady or a burst?" at a glance, and the Timeline answers everything else.

  Toasts — confirmation that an action happened. A rebuild or a save that
  changes nothing visible leaves the investigator unsure whether it worked;
  a line saying what happened is the cheapest possible fix.
*/

import { useEffect, useState } from 'react'

/* ── Sparkline ─────────────────────────────────────────────────────────── */

export function Sparkline({ series, width = 76, height = 22, tone = 'accent' }) {
  if (!series?.length) {
    return <span className="spark-empty t-dim" aria-hidden="true">—</span>
  }
  const values = series.map(p => p.events)
  const peak = Math.max(...values, 1)
  const step = series.length > 1 ? width / (series.length - 1) : width
  const y = v => height - 2 - (v / peak) * (height - 4)

  const line = values.map((v, i) => `${i * step},${y(v)}`).join(' ')
  const area = `0,${height} ${line} ${width},${height}`
  const total = values.reduce((s, v) => s + v, 0)

  return (
    <svg className={`spark spark-${tone}`} width={width} height={height}
      viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={`${total} events across ${series.length} days, peak ${peak} in a day`}>
      <polygon points={area} className="spark-area" />
      <polyline points={line} className="spark-line" fill="none" />
    </svg>
  )
}

/* ── Toasts ────────────────────────────────────────────────────────────── */

const TOAST_EVENT = 'sentinel:toast'

/** Fire from anywhere: toast('Graph rebuilt', 'ok'). */
export function toast(message, tone = 'ok') {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message, tone } }))
}

export function Toasts() {
  const [items, setItems] = useState([])

  useEffect(() => {
    const onToast = e => {
      const id = Date.now() + Math.random()
      setItems(prev => [...prev, { id, ...e.detail }])
      // Long enough to read a sentence, short enough not to sit in the way.
      setTimeout(() => setItems(prev => prev.filter(t => t.id !== id)), 6000)
    }
    window.addEventListener(TOAST_EVENT, onToast)
    return () => window.removeEventListener(TOAST_EVENT, onToast)
  }, [])

  if (!items.length) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map(t => (
        <div key={t.id} className={`toast tone-${t.tone}`}>
          <span>{t.message}</span>
          <button onClick={() => setItems(prev => prev.filter(x => x.id !== t.id))}
            aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  )
}
