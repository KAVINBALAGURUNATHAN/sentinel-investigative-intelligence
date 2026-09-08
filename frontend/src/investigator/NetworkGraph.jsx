/*
  Investigation network graph.

  Draws the Neo4j projection: Person nodes and the identifiers they own, plus
  the activity observed between those identifiers.

  Two edge families are drawn differently on purpose:
    OWNS / USES   dashed, muted — a CONCLUSION from entity resolution
    CALLED / TRANSFERRED / ...  solid, coloured by domain — an OBSERVATION

  An investigator must be able to see at a glance which links are facts from
  source records and which depend on the resolution being correct.
*/

import { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'

const NODE_STYLE = {
  Person: { r: 13, fill: '#46566a', label: 'Person' },
  Phone: { r: 8, fill: '#1f6fb2', label: 'Phone' },
  Device: { r: 8, fill: '#6a4b9c', label: 'Device' },
  Sim: { r: 7, fill: '#7a63b0', label: 'SIM' },
  BankAccount: { r: 8, fill: '#14663f', label: 'Bank account' },
  UpiHandle: { r: 7, fill: '#1a7a4a', label: 'UPI' },
  SocialAccount: { r: 8, fill: '#8a5a00', label: 'Social' },
  IpAddress: { r: 7, fill: '#66768a', label: 'IP address' },
  Identifier: { r: 6, fill: '#66768a', label: 'Other' },
}

const EDGE_STYLE = {
  OWNS: { stroke: '#b3c0cf', dash: '3,3', kind: 'resolution' },
  USES: { stroke: '#b3c0cf', dash: '3,3', kind: 'resolution' },
  IDENTIFIES: { stroke: '#b3c0cf', dash: '3,3', kind: 'resolution' },
  CALLED: { stroke: '#1f6fb2', dash: null, kind: 'observation' },
  MESSAGED: { stroke: '#1f6fb2', dash: null, kind: 'observation' },
  TRANSFERRED: { stroke: '#14663f', dash: null, kind: 'observation' },
  CONNECTED_FROM: { stroke: '#6a4b9c', dash: null, kind: 'observation' },
  LOGGED_IN_FROM: { stroke: '#6a4b9c', dash: null, kind: 'observation' },
  POSTED: { stroke: '#8a5a00', dash: null, kind: 'observation' },
  CONNECTED_TO: { stroke: '#8a5a00', dash: null, kind: 'observation' },
}

/* Technical relationship names are correct but not what a person reads first. */
export const EDGE_LABELS = {
  OWNS: 'Owns', USES: 'Uses', IDENTIFIES: 'Identifies',
  CALLED: 'Called', MESSAGED: 'Messaged', TRANSFERRED: 'Financial transfer',
  CONNECTED_FROM: 'Connected from', LOGGED_IN_FROM: 'Logged in from',
  POSTED: 'Posted', CONNECTED_TO: 'Connected to',
}
export const edgeLabel = rel => EDGE_LABELS[rel] || rel

const fmtGap = iso => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric',
                                  hour: '2-digit', minute: '2-digit' })
}

const PERSON_MARK =
  'M-3.2,-1.4a3.2,3.2 0 1,1 6.4,0a3.2,3.2 0 1,1 -6.4,0 M-4.6,4.4a4.8,4.8 0 0,1 9.2,0'

const OWNERSHIP_KINDS = new Set(['OWNS', 'USES', 'IDENTIFIES'])

const styleFor = label => NODE_STYLE[label] || NODE_STYLE.Identifier
const edgeStyleFor = rel => EDGE_STYLE[rel] || { stroke: '#b3c0cf', dash: null, kind: 'observation' }

export default function NetworkGraph({ graph, onSelect, onEdgeSelect, selected,
                                      filters, focusId }) {
  const svgRef = useRef(null)
  const tipRef = useRef(null)
  const wrapRef = useRef(null)
  const [hidden, setHidden] = useState(() => new Set())

  const relationshipTypes = useMemo(
    () => [...new Set((graph?.edges || []).map(e => e.relationship))].sort(),
    [graph])

  const toggle = rel => setHidden(prev => {
    const next = new Set(prev)
    if (next.has(rel)) next.delete(rel)
    else next.add(rel)
    return next
  })

  useEffect(() => {
    const svgEl = svgRef.current
    if (!svgEl || !graph?.nodes?.length) return

    const wrap = wrapRef.current
    const W = wrap.clientWidth || 800
    const H = wrap.clientHeight || 520

    const visibleEdges = (graph.edges || [])
      .filter(e => !hidden.has(e.relationship))
      .filter(e => !filters?.query || [e.source, e.target].some(
        v => String(v).toLowerCase().includes(filters.query.toLowerCase())))

    const connected = new Set()
    visibleEdges.forEach(e => { connected.add(e.source); connected.add(e.target) })
    const nodes = graph.nodes
      .filter(n => connected.has(n.id) || !visibleEdges.length)
      .map(n => ({ ...n }))
    const byId = new Set(nodes.map(n => n.id))
    const links = visibleEdges
      .filter(e => byId.has(e.source) && byId.has(e.target))
      .map(e => ({ ...e }))

    const svg = d3.select(svgEl)
    svg.selectAll('*').remove()
    svg.attr('viewBox', `0 0 ${W} ${H}`)

    // arrowheads, one per edge colour
    const defs = svg.append('defs')
    const colours = [...new Set(links.map(l => edgeStyleFor(l.relationship).stroke))]
    colours.forEach((colour, i) => {
      defs.append('marker')
        .attr('id', `arrow-${i}`).attr('viewBox', '0 -5 10 10')
        .attr('refX', 26).attr('refY', 0)
        .attr('markerWidth', 3.4).attr('markerHeight', 3.4).attr('orient', 'auto')
        .append('path').attr('d', 'M0,-4L9,0L0,4').attr('fill', colour).attr('opacity', 0.75)
    })
    const markerFor = rel =>
      `url(#arrow-${colours.indexOf(edgeStyleFor(rel).stroke)})`

    const root = svg.append('g')
    const zoom = d3.zoom().scaleExtent([0.2, 4])
      .on('zoom', e => root.attr('transform', e.transform))
    svg.call(zoom)

    /*
      Distance from the focused subject, in hops. It drives three things: how
      large a node is drawn, how strongly it is coloured, and which ring the
      radial force pulls it to. Without it every node reads as equally
      important, which is what makes a graph look like a diagram rather than an
      investigation.
    */
    /*
      A person is drawn as a card, so the layout has to know how wide that card
      actually is. Sizing collision from the node radius alone let cards sit on
      top of edge labels and clip neighbouring text.
    */
    const CARD_H = 30
    const cardWidth = d => Math.max(74, 30 + String(d.id ?? '').length * 7.4)
    const footprint = d => (d.label === 'Person'
      ? cardWidth(d) / 2 + 14
      : styleFor(d.label).r + 22)

    const anchor = focusId && byId.has(focusId) ? focusId : null
    const hopOf = new Map(nodes.map(n => [n.id, anchor ? Infinity : 1]))

    /*
      Ownership costs nothing to cross; only a real interaction is a hop.

      Activity runs identifier to identifier — phone called phone — so a person
      reaches another person via own-identifier, their-identifier, them. Charging
      a hop for each would put a direct contact three rings out and draw them
      faded, which says the opposite of the truth: those are the people this
      subject actually deals with.
    */
    const ends = l => [l.source.id ?? l.source, l.target.id ?? l.target]
    const ownership = links.filter(l => OWNERSHIP_KINDS.has(l.relationship))
    const activity = links.filter(l => !OWNERSHIP_KINDS.has(l.relationship))

    if (anchor) {
      const settle = depth => {
        let grew = true
        while (grew) {
          grew = false
          ownership.forEach(l => {
            const [a, b] = ends(l)
            if (hopOf.get(a) === depth && hopOf.get(b) === Infinity) { hopOf.set(b, depth); grew = true }
            if (hopOf.get(b) === depth && hopOf.get(a) === Infinity) { hopOf.set(a, depth); grew = true }
          })
        }
      }

      hopOf.set(anchor, 0)
      settle(0)
      for (let depth = 1; depth <= 3; depth++) {
        const reached = []
        activity.forEach(l => {
          const [a, b] = ends(l)
          if (hopOf.get(a) === depth - 1 && hopOf.get(b) === Infinity) reached.push(b)
          if (hopOf.get(b) === depth - 1 && hopOf.get(a) === Infinity) reached.push(a)
        })
        if (!reached.length) break
        reached.forEach(id => hopOf.set(id, depth))
        settle(depth)
      }
    }
    const hop = d => {
      const value = hopOf.get(d.id)
      return value === undefined || value === Infinity ? 3 : value
    }

    // Selected subject largest, direct contacts medium, identifiers small,
    // anything further out smaller still.
    const radiusOf = d => {
      const base = styleFor(d.label).r
      if (d.id === anchor) return base + 9
      if (d.label === 'Person') return base + 2
      return hop(d) >= 2 ? base - 2 : base
    }
    const dimOf = d => (hop(d) >= 2 ? 0.55 : 1)

    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id)
        .distance(l => (edgeStyleFor(l.relationship).kind === 'resolution' ? 62 : 150))
        .strength(l => (edgeStyleFor(l.relationship).kind === 'resolution' ? 0.85 : 0.25)))
      .force('charge', d3.forceManyBody().strength(-320))
      .force('collide', d3.forceCollide(footprint).strength(0.95))
      .force('center', d3.forceCenter(W / 2, H / 2))
      // Rings rather than a blob: the subject sits centre, its contacts on the
      // first ring, their identifiers beyond. Uses the canvas instead of
      // huddling in the middle of it.
      .force('radial', anchor
        ? d3.forceRadial(d => (d.id === anchor ? 0 : hop(d) * Math.min(W, H) * 0.19),
                         W / 2, H / 2).strength(d => (d.id === anchor ? 1 : 0.55))
        : null)

    if (anchor) {
      const centre = nodes.find(n => n.id === anchor)
      if (centre) { centre.fx = W / 2; centre.fy = H / 2 }
    }

    const link = root.append('g').selectAll('line').data(links).join('line')
      .attr('stroke', d => edgeStyleFor(d.relationship).stroke)
      .attr('stroke-width', d => Math.min(4, 1 + Math.log1p(d.count || 1)))
      .attr('stroke-dasharray', d => edgeStyleFor(d.relationship).dash)
      .attr('stroke-opacity', d => (edgeStyleFor(d.relationship).kind === 'resolution' ? 0.5 : 0.85))
      .attr('marker-end', d => markerFor(d.relationship))
      .style('cursor', 'pointer')

    const node = root.append('g').selectAll('g').data(nodes).join('g')
      .style('cursor', 'pointer')
      .call(d3.drag()
        .on('start', (e, d) => {
          if (!e.active) simulation.alphaTarget(0.3).restart()
          d.fx = d.x; d.fy = d.y
        })
        .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y })
        .on('end', (e, d) => {
          if (!e.active) simulation.alphaTarget(0)
          d.fx = null; d.fy = null
        }))

    // A person is drawn as a card and an identifier as a smaller disc, so the
    // kind of thing is legible from shape before any colour is read.
    const person = node.filter(d => d.label === 'Person')
    person.append('rect')
      .attr('x', d => -cardWidth(d) / 2).attr('y', -CARD_H / 2)
      .attr('width', cardWidth).attr('height', CARD_H)
      .attr('rx', 7)
      .attr('fill', '#ffffff')
      .attr('stroke', d => (d.id === selected || d.id === anchor ? '#1f4e79' : '#c4d0dd'))
      .attr('stroke-width', d => (d.id === anchor ? 2.4 : d.id === selected ? 2 : 1.2))
      .attr('opacity', dimOf)

    // icon sits in its own gutter on the left of the card
    person.append('circle')
      .attr('cx', d => -cardWidth(d) / 2 + 13).attr('cy', 0).attr('r', 7)
      .attr('fill', d => styleFor(d.label).fill).attr('opacity', dimOf)
    person.append('path')
      .attr('d', PERSON_MARK)
      .attr('transform', d => `translate(${-cardWidth(d) / 2 + 13},-0.6)`)
      .attr('fill', 'none').attr('stroke', '#ffffff').attr('stroke-width', 1.3)
      .attr('stroke-linecap', 'round').attr('pointer-events', 'none')

    // text is centred in the space the icon leaves, not on the whole card
    const textCentre = d => (-cardWidth(d) / 2 + 26 + cardWidth(d) / 2) / 2 + 5
    person.append('text')
      .text(d => d.id ?? '')
      .attr('x', textCentre).attr('dy', -1)
      .attr('text-anchor', 'middle').attr('font-size', 11)
      .attr('font-family', 'ui-monospace, monospace').attr('font-weight', 600)
      .attr('fill', '#14202f').attr('opacity', dimOf).attr('pointer-events', 'none')
    person.append('text')
      .text('SUBJECT')
      .attr('x', textCentre).attr('dy', 10)
      .attr('text-anchor', 'middle').attr('font-size', 7)
      .attr('letter-spacing', 0.7).attr('fill', '#66768a')
      .attr('opacity', dimOf).attr('pointer-events', 'none')

    const other = node.filter(d => d.label !== 'Person')
    other.append('circle')
      .attr('r', radiusOf)
      .attr('fill', d => styleFor(d.label).fill)
      .attr('fill-opacity', d => 0.9 * dimOf(d))
      .attr('stroke', d => (d.id === selected ? '#1f4e79' : '#ffffff'))
      .attr('stroke-width', d => (d.id === selected ? 2.5 : 1.5))
    other.append('text')
      .text(d => styleFor(d.label).label.toUpperCase())
      .attr('text-anchor', 'middle').attr('dy', d => radiusOf(d) + 12)
      .attr('font-size', 7.5).attr('letter-spacing', 0.5)
      .attr('fill', '#66768a').attr('paint-order', 'stroke')
      .attr('stroke', '#f4f6f8').attr('stroke-width', 2.5)
      .attr('stroke-linejoin', 'round')
      .attr('opacity', dimOf).attr('pointer-events', 'none')

    /*
      The edge carries its own meaning. "Call x18" or an amount tells an
      investigator what the line is before they touch it; the full record stays
      on hover and click.
    */
    const edgeText = d => {
      const label = edgeLabel(d.relationship)
      if (edgeStyleFor(d.relationship).kind === 'resolution') return label
      if (d.total_amount) {
        return new Intl.NumberFormat('en-IN',
          { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
          .format(Number(d.total_amount))
      }
      return d.count > 1 ? `${label} x${d.count}` : label
    }

    /*
      Only observed activity is labelled. "Owns" and "Uses" repeated on every
      identifier was most of the clutter, and the dashed line plus the card
      already say the same thing.
    */
    const labelled = links.filter(l => edgeStyleFor(l.relationship).kind !== 'resolution')
    const edgeLabels = root.append('g').selectAll('g').data(labelled).join('g')
      .attr('pointer-events', 'none')
    edgeLabels.append('text')
      .text(edgeText)
      .attr('text-anchor', 'middle').attr('dy', -4)
      .attr('font-size', 9.5).attr('font-weight', 600)
      .attr('fill', d => edgeStyleFor(d.relationship).stroke)
      .attr('paint-order', 'stroke')
      .attr('stroke', '#f4f6f8').attr('stroke-width', 3.5)
      .attr('stroke-linejoin', 'round')

    // interactions
    const tip = d3.select(tipRef.current)
    const showTip = (event, html) => {
      const box = wrap.getBoundingClientRect()
      tip.style('opacity', 1).html(html)
        .style('left', `${event.clientX - box.left + 12}px`)
        .style('top', `${event.clientY - box.top + 12}px`)
    }
    const hideTip = () => tip.style('opacity', 0)

    node.on('mouseenter', (event, d) =>
      showTip(event, `${styleFor(d.label).label}<br>${d.id ?? 'unidentified'}`))
      .on('mousemove', event => {
        const box = wrap.getBoundingClientRect()
        tip.style('left', `${event.clientX - box.left + 12}px`)
          .style('top', `${event.clientY - box.top + 12}px`)
      })
      .on('mouseleave', hideTip)
      .on('click', (event, d) => { event.stopPropagation(); onSelect?.(d) })

    link.on('mouseenter', (event, d) => {
      const style = edgeStyleFor(d.relationship)
      const lines = [`<b>${edgeLabel(d.relationship)}</b>`,
                     `${d.source.id ?? d.source} → ${d.target.id ?? d.target}`]

      if (style.kind === 'resolution') {
        lines.push(`Attributed by entity resolution`)
        if (d.confidence != null) lines.push(`Confidence ${d.confidence}`)
        if (d.basis) lines.push(String(d.basis))
      } else {
        lines.push(`${d.count} event${d.count === 1 ? '' : 's'}`)
        if (d.total_amount) {
          lines.push(`Total ₹${Number(d.total_amount).toLocaleString('en-IN')}`)
        }
        if (d.total_duration) {
          lines.push(`Total duration ${Math.round(d.total_duration / 60)} min`)
        }
        const last = fmtGap(d.last_seen)
        if (last) lines.push(`Last event ${last}`)
      }
      showTip(event, lines.join('<br>'))
    }).on('mouseleave', hideTip)

    // Clicking an edge opens the relationship inspector.
    link.on('click', (event, d) => {
      event.stopPropagation()
      onEdgeSelect?.({
        source: d.source.id ?? d.source,
        target: d.target.id ?? d.target,
        relationship: d.relationship,
        count: d.count,
        total_amount: d.total_amount,
        total_duration: d.total_duration,
        first_seen: d.first_seen,
        last_seen: d.last_seen,
        confidence: d.confidence,
        basis: d.basis,
        kind: edgeStyleFor(d.relationship).kind,
      })
    })

    // dim everything not adjacent to the hovered node
    node.on('mouseover.highlight', (_e, d) => {
      const near = new Set([d.id])
      links.forEach(l => {
        const s = l.source.id ?? l.source, t = l.target.id ?? l.target
        if (s === d.id) near.add(t)
        if (t === d.id) near.add(s)
      })
      node.attr('opacity', n => (near.has(n.id) ? 1 : 0.18))
      link.attr('stroke-opacity', l => {
        const s = l.source.id ?? l.source, t = l.target.id ?? l.target
        return s === d.id || t === d.id ? 1 : 0.06
      })
    }).on('mouseout.highlight', () => {
      node.attr('opacity', 1)
      link.attr('stroke-opacity', l =>
        (edgeStyleFor(l.relationship).kind === 'resolution' ? 0.5 : 0.85))
    })

    simulation.on('tick', () => {
      link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y)
      node.attr('transform', d => `translate(${d.x},${d.y})`)
      edgeLabels.attr('transform',
        d => `translate(${(d.source.x + d.target.x) / 2},${(d.source.y + d.target.y) / 2})`)
    })

    // frame the settled layout so a sparse case does not float in a void
    simulation.on('end', () => {
      if (!nodes.length) return
      const xs = nodes.map(d => d.x), ys = nodes.map(d => d.y)
      const pad = 70
      const [x0, x1] = [Math.min(...xs) - pad, Math.max(...xs) + pad]
      const [y0, y1] = [Math.min(...ys) - pad, Math.max(...ys) + pad]
      const scale = Math.max(0.25, Math.min(1.6,
        0.94 * Math.min(W / Math.max(x1 - x0, 1), H / Math.max(y1 - y0, 1))))
      svg.transition().duration(500).ease(d3.easeCubicOut).call(
        zoom.transform,
        d3.zoomIdentity.translate(W / 2 - scale * (x0 + x1) / 2,
          H / 2 - scale * (y0 + y1) / 2).scale(scale))
    })

    return () => simulation.stop()
  }, [graph, hidden, filters, selected, onSelect, onEdgeSelect, focusId])

  if (!graph?.nodes?.length) return null

  return (
    <div className="graph-shell" ref={wrapRef}>
      <svg ref={svgRef} />
      <div className="graph-tip" ref={tipRef} />

      <div className="graph-overlay graph-controls">
        {relationshipTypes.map(rel => (
          <button key={rel}
            className="btn sm"
            onClick={() => toggle(rel)}
            style={{
              opacity: hidden.has(rel) ? 0.4 : 1,
              borderColor: edgeStyleFor(rel).stroke,
            }}
            title={`${hidden.has(rel) ? 'Show' : 'Hide'} ${rel} relationships`}>
            {rel}
          </button>
        ))}
      </div>

      <div className="graph-overlay graph-legend">
        <div style={{ fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase',
          color: '#66768a', marginBottom: 5 }}>Node types</div>
        {[...new Set(graph.nodes.map(n => n.label))].sort().map(label => (
          <div className="legend-row" key={label}>
            <span className="legend-swatch" style={{ background: styleFor(label).fill }} />
            {styleFor(label).label}
          </div>
        ))}
        <div style={{ borderTop: '1px solid #232d3b', margin: '6px 0 5px' }} />
        <div className="legend-row">
          <span className="legend-line" style={{ borderColor: '#1f6fb2' }} />
          Observed activity
        </div>
        <div className="legend-row">
          <span className="legend-line"
            style={{ borderColor: '#b3c0cf', borderTopStyle: 'dashed' }} />
          Resolution (inferred)
        </div>
      </div>
    </div>
  )
}
