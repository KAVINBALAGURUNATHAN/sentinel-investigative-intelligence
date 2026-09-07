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

const styleFor = label => NODE_STYLE[label] || NODE_STYLE.Identifier
const edgeStyleFor = rel => EDGE_STYLE[rel] || { stroke: '#b3c0cf', dash: null, kind: 'observation' }

export default function NetworkGraph({ graph, onSelect, selected, filters }) {
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
        .attr('refX', 22).attr('refY', 0)
        .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
        .append('path').attr('d', 'M0,-4L9,0L0,4').attr('fill', colour).attr('opacity', 0.75)
    })
    const markerFor = rel =>
      `url(#arrow-${colours.indexOf(edgeStyleFor(rel).stroke)})`

    const root = svg.append('g')
    const zoom = d3.zoom().scaleExtent([0.2, 4])
      .on('zoom', e => root.attr('transform', e.transform))
    svg.call(zoom)

    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id)
        .distance(l => (edgeStyleFor(l.relationship).kind === 'resolution' ? 46 : 110))
        .strength(l => (edgeStyleFor(l.relationship).kind === 'resolution' ? 0.85 : 0.25)))
      .force('charge', d3.forceManyBody().strength(-260))
      .force('collide', d3.forceCollide(d => styleFor(d.label).r + 11))
      .force('center', d3.forceCenter(W / 2, H / 2))

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

    node.append('circle')
      .attr('r', d => styleFor(d.label).r)
      .attr('fill', d => styleFor(d.label).fill)
      .attr('fill-opacity', 0.9)
      .attr('stroke', d => (d.id === selected ? '#1f4e79' : '#ffffff'))
      .attr('stroke-width', d => (d.id === selected ? 2.5 : 1.5))

    node.filter(d => d.label === 'Person').append('text')
      .text(d => d.id)
      .attr('text-anchor', 'middle').attr('dy', 26)
      .attr('font-size', 10).attr('font-family', 'ui-monospace, monospace')
      .attr('fill', '#14202f').attr('pointer-events', 'none')

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
      showTip(event, `${styleFor(d.label).label}<br>${d.id}`))
      .on('mousemove', event => {
        const box = wrap.getBoundingClientRect()
        tip.style('left', `${event.clientX - box.left + 12}px`)
          .style('top', `${event.clientY - box.top + 12}px`)
      })
      .on('mouseleave', hideTip)
      .on('click', (event, d) => { event.stopPropagation(); onSelect?.(d) })

    link.on('mouseenter', (event, d) => {
      const style = edgeStyleFor(d.relationship)
      const extra = style.kind === 'resolution'
        ? `confidence ${d.confidence ?? '—'}`
        : `${d.count} event${d.count === 1 ? '' : 's'}` +
          (d.total_amount ? ` · ₹${Number(d.total_amount).toLocaleString('en-IN')}` : '')
      showTip(event,
        `${d.source} → ${d.target}<br>${d.relationship} · ${extra}<br>` +
        `<span style="color:#6b7d92">${style.kind}</span>`)
    }).on('mouseleave', hideTip)

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
  }, [graph, hidden, filters, selected, onSelect])

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
