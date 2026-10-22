import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Delaunay } from 'd3-delaunay'
import { pointInPolygons } from '../geometry/clipper'
import { dist, polygonsArea, polygonsBounds, polylineLength } from '../geometry/polyUtils'
import { computeSkeleton, type Skeleton, type SkeletonNode } from '../geometry/skeleton'
import type { AABB, ExtrusionLine, Point, Polygon, Polyline } from '../geometry/types'
import { pruneSkeleton } from '../algorithms/wallsArachne'
import type { PseudocodeParams, PseudoStep, StepGeometry } from '../algorithms/pseudocode'
import type { PipelineResult } from '../state/pipeline'
import { featureColors } from './vis'

interface ZoomableSvgProps {
  width: number
  height: number
  children: ReactNode
}

function ZoomableSvg({ width, height, children }: ZoomableSvgProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{
    startClientX: number
    startClientY: number
    startX: number
    startY: number
  } | null>(null)

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = svg.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const sx = ((e.clientX - rect.left) / rect.width) * width
      const sy = ((e.clientY - rect.top) / rect.height) * height
      setTransform((prev) => {
        const nextK = Math.min(24, Math.max(0.5, prev.k * Math.exp(-e.deltaY * 0.0018)))
        const wx = (sx - prev.x) / prev.k
        const wy = (sy - prev.y) / prev.k
        return {
          k: nextK,
          x: sx - wx * nextK,
          y: sy - wy * nextK,
        }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [width, height])

  const zoomBy = (factor: number, cx = width / 2, cy = height / 2) => {
    setTransform((prev) => {
      const nextK = Math.min(24, Math.max(0.5, prev.k * factor))
      const wx = (cx - prev.x) / prev.k
      const wy = (cy - prev.y) / prev.k
      return {
        k: nextK,
        x: cx - wx * nextK,
        y: cy - wy * nextK,
      }
    })
  }

  const resetView = () => setTransform({ x: 0, y: 0, k: 1 })

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.button !== 1) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: transform.x,
      startY: transform.y,
    }
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    const svg = svgRef.current
    if (!drag || !svg) return
    const rect = svg.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const dx = ((e.clientX - drag.startClientX) / rect.width) * width
    const dy = ((e.clientY - drag.startClientY) / rect.height) * height
    setTransform((prev) => ({
      ...prev,
      x: drag.startX + dx,
      y: drag.startY + dy,
    }))
  }

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (dragRef.current) {
      dragRef.current = null
      setDragging(false)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    }
  }

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    e.stopPropagation()
    const isModified =
      Math.abs(transform.k - 1) > 0.01 ||
      Math.abs(transform.x) > 0.5 ||
      Math.abs(transform.y) > 0.5
    if (isModified) {
      resetView()
    } else {
      const rect = e.currentTarget.getBoundingClientRect()
      const sx = ((e.clientX - rect.left) / rect.width) * width
      const sy = ((e.clientY - rect.top) / rect.height) * height
      zoomBy(2, sx, sy)
    }
  }

  const isModified =
    Math.abs(transform.k - 1) > 0.01 ||
    Math.abs(transform.x) > 0.5 ||
    Math.abs(transform.y) > 0.5

  return (
    <div className="dd-svg-interactive">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        className={`dd-zoom-svg${dragging ? ' dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
          {children}
        </g>
      </svg>
      <div className="dd-svg-controls" onPointerDown={(e) => e.stopPropagation()}>
        <span className="dd-svg-hint">drag · wheel</span>
        <span className="dd-svg-zoom-badge">{transform.k.toFixed(1)}×</span>
        <button
          type="button"
          className="dd-svg-btn"
          onClick={() => zoomBy(1.35)}
          title="Zoom in (or scroll wheel)"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="dd-svg-btn"
          onClick={() => zoomBy(1 / 1.35)}
          title="Zoom out (or scroll wheel)"
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          className="dd-svg-btn"
          disabled={!isModified}
          onClick={resetView}
          title="Reset zoom & pan (or double-click)"
          aria-label="Reset zoom and pan"
        >
          ⟲
        </button>
      </div>
    </div>
  )
}

interface StepDeepDiveProps {
  step: PseudoStep
  allSteps: PseudoStep[]
  params: PseudocodeParams
  result: PipelineResult | null
  shapeName: string
}

interface Projector {
  w: number
  h: number
  pt: (p: Point) => { x: number; y: number }
  r: (um: number) => number
  polyPath: (polys: Polygon[]) => string
  ringPath: (ring: Point[]) => string
  linePath: (pts: Polyline) => string
}

function makeProjectorFromBounds(b: AABB, w: number, h: number, pad = 16): Projector {
  const bw = Math.max(100, b.maxX - b.minX)
  const bh = Math.max(100, b.maxY - b.minY)
  const scale = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh)
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  const pt = (p: Point) => ({
    x: Number((w / 2 + (p.x - cx) * scale).toFixed(2)),
    y: Number((h / 2 - (p.y - cy) * scale).toFixed(2)),
  })
  const r = (um: number) => Math.max(0.5, Number((um * scale).toFixed(2)))
  const ringPath = (ring: Point[]) => {
    if (ring.length === 0) return ''
    const first = pt(ring[0])
    let d = `M${first.x} ${first.y}`
    for (let i = 1; i < ring.length; i++) {
      const q = pt(ring[i])
      d += ` L${q.x} ${q.y}`
    }
    return `${d} Z`
  }
  const polyPath = (polys: Polygon[]) =>
    polys
      .map((p) => [ringPath(p.outer), ...p.holes.map(ringPath)].join(' '))
      .join(' ')
  const linePath = (pts: Polyline) => {
    if (pts.length === 0) return ''
    const first = pt(pts[0])
    let d = `M${first.x} ${first.y}`
    for (let i = 1; i < pts.length; i++) {
      const q = pt(pts[i])
      d += ` L${q.x} ${q.y}`
    }
    return d
  }
  return { w, h, pt, r, polyPath, ringPath, linePath }
}

function totalPerimeterUm(polys: Polygon[]): number {
  let len = 0
  for (const poly of polys) {
    for (const ring of [poly.outer, ...poly.holes]) {
      for (let i = 0; i < ring.length; i++) {
        len += dist(ring[i], ring[(i + 1) % ring.length])
      }
    }
  }
  return len
}

function StatGrid({ items }: { items: { value: string; label: string }[] }) {
  return (
    <div className="dd-stat-grid">
      {items.map((it) => (
        <div key={it.label} className="dd-stat-card">
          <div className="dd-stat-value">{it.value}</div>
          <div className="dd-stat-label">{it.label}</div>
        </div>
      ))}
    </div>
  )
}

function FlowSteps({ steps }: { steps: string[] }) {
  return (
    <div className="dd-flow">
      {steps.map((s, i) => (
        <div key={s} className="dd-flow-group">
          <div className={`dd-flow-box${i === steps.length - 1 ? ' highlight' : ''}`}>{s}</div>
          {i < steps.length - 1 && <div className="dd-flow-arrow">↓</div>}
        </div>
      ))}
    </div>
  )
}

/** Render arbitrary StepGeometry onto an SVG projector over the current shape's outline. */
function StepGeometrySvgLayers({
  proj,
  geom,
  color = '#00e5ff',
}: {
  proj: Projector
  geom: StepGeometry
  color?: string
}) {
  return (
    <>
      {geom.polygons.length > 0 && (
        <path
          d={proj.polyPath(geom.polygons)}
          fill={color}
          fillOpacity="0.24"
          fillRule="evenodd"
          stroke={color}
          strokeWidth="1.8"
        />
      )}
      {geom.skeleton && (
        <g>
          {geom.skeleton.edges.map(([a, b], idx) => {
            const pa = proj.pt(geom.skeleton!.nodes[a].p)
            const pb = proj.pt(geom.skeleton!.nodes[b].p)
            return (
              <line
                key={idx}
                x1={pa.x}
                y1={pa.y}
                x2={pb.x}
                y2={pb.y}
                stroke={color}
                strokeWidth="1.6"
              />
            )
          })}
        </g>
      )}
      {geom.polylines.map((pl, idx) => (
        <path
          key={idx}
          d={proj.linePath(pl)}
          fill="none"
          stroke="#f59e0b"
          strokeWidth="1.5"
        />
      ))}
      {geom.extrusionLines.map((line, idx) => {
        const pts = line.map((j) => j.p)
        const avgW =
          line.reduce((s, j) => s + j.w, 0) / Math.max(1, line.length)
        return (
          <g key={idx}>
            <path
              className="dd-scale-stroke"
              d={proj.linePath(pts)}
              fill="none"
              stroke={color}
              strokeWidth={Math.max(1.6, proj.r(avgW))}
              strokeOpacity="0.55"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d={proj.linePath(pts)}
              fill="none"
              stroke="#ffffff"
              strokeWidth="0.9"
            />
          </g>
        )
      })}
      {geom.moves.map((mv, idx) => {
        if (mv.kind === 'extrusion') {
          const line = mv.line as ExtrusionLine
          const pts = line.map((j) => j.p)
          const col = featureColors[mv.feature] ?? color
          return (
            <path
              key={idx}
              className="dd-scale-stroke"
              d={proj.linePath(pts)}
              fill="none"
              stroke={col}
              strokeWidth={Math.max(1.5, proj.r(line[0]?.w ?? 400))}
              strokeOpacity="0.8"
              strokeLinecap="round"
            />
          )
        }
        const pts = mv.line as Polyline
        return (
          <path
            key={idx}
            d={proj.linePath(pts)}
            fill="none"
            stroke={mv.travel?.goesOutside ? '#ef4444' : '#3b82f6'}
            strokeWidth="1.6"
            strokeDasharray="4 3"
          />
        )
      })}
    </>
  )
}

function SkeletonDeepDive({ step, params, result, shapeName }: StepDeepDiveProps): ReactNode {
  const outline = useMemo(
    () => (result && result.outline.length > 0 ? result.outline : []),
    [result],
  )
  const wMm = (params.wallWidth / 1000).toFixed(2)
  const spacingUm = params.wallWidth / 8
  const spacingMm = (spacingUm / 1000).toFixed(3)
  const pruneMm = ((2 * spacingUm) / 1000).toFixed(2)

  const analysis = useMemo(() => {
    if (outline.length === 0) return null
    const bounds = polygonsBounds(outline)
    const proj = makeProjectorFromBounds(bounds, 340, 155, 18)
    const projSmall = makeProjectorFromBounds(bounds, 160, 118, 12)
    const perimUm = totalPerimeterUm(outline)
    const areaMm2 = polygonsArea(outline) / 1e6
    const bwMm = (bounds.maxX - bounds.minX) / 1000
    const bhMm = (bounds.maxY - bounds.minY) / 1000
    const realSampleCount = Math.round(perimUm / spacingUm)

    // Visual boundary samples (~52 points around the actual shape so individual dots & triangles are legible)
    const visSpacing = Math.max(spacingUm, perimUm / 52)
    const visSamples: Point[] = []
    for (const poly of outline) {
      for (const ring of [poly.outer, ...poly.holes]) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]
          const b = ring[(i + 1) % ring.length]
          const n = Math.max(1, Math.round(dist(a, b) / visSpacing))
          for (let k = 0; k < n; k++) {
            const t = k / n
            visSamples.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
          }
        }
      }
    }

    // Actual Delaunay triangulation of the current shape's visual samples
    const interiorTris: [Point, Point, Point][] = []
    let featuredTri: { a: Point; b: Point; c: Point; cc: Point; r: number } | null = null
    if (visSamples.length >= 3) {
      const del = Delaunay.from(
        visSamples,
        (p) => p.x,
        (p) => p.y,
      )
      const vor = del.voronoi([bounds.minX - 1000, bounds.minY - 1000, bounds.maxX + 1000, bounds.maxY + 1000])
      for (let t = 0; t < del.triangles.length / 3; t++) {
        const p0 = visSamples[del.triangles[t * 3]]
        const p1 = visSamples[del.triangles[t * 3 + 1]]
        const p2 = visSamples[del.triangles[t * 3 + 2]]
        const centroid = { x: (p0.x + p1.x + p2.x) / 3, y: (p0.y + p1.y + p2.y) / 3 }
        if (!pointInPolygons(centroid, outline)) continue
        interiorTris.push([p0, p1, p2])
        const cx = vor.circumcenters[t * 2]
        const cy = vor.circumcenters[t * 2 + 1]
        if (Number.isFinite(cx) && Number.isFinite(cy) && pointInPolygons({ x: cx, y: cy }, outline)) {
          const r = Math.hypot(cx - p0.x, cy - p0.y)
          if (!featuredTri || r > featuredTri.r) {
            featuredTri = { a: p0, b: p1, c: p2, cc: { x: cx, y: cy }, r }
          }
        }
      }
    }

    // Compare unpruned rawSkeleton (at fast visual spacing) vs pruned skeleton on THIS shape
    const prunedSkel: Skeleton =
      step.geometry.skeleton ?? pruneSkeleton(computeSkeleton(outline, visSpacing / 2), visSpacing)
    const rawSkel: Skeleton = computeSkeleton(outline, Math.max(spacingUm * 4, visSpacing / 2))

    // Find widest and narrowest nodes on the pruned skeleton of THIS shape
    let widest: SkeletonNode | null = null
    let narrowest: SkeletonNode | null = null
    for (const n of prunedSkel.nodes) {
      if (n.r <= 0) continue
      if (!widest || n.r > widest.r) widest = n
      if (!narrowest || n.r < narrowest.r) narrowest = n
    }

    // Build zoomed-in projectors around widest and narrowest nodes on THIS shape
    const makeZoomProj = (node: SkeletonNode | null) => {
      if (!node) return projSmall
      const span = Math.max(node.r * 2.8, params.wallWidth * 4)
      return makeProjectorFromBounds(
        {
          minX: node.p.x - span,
          minY: node.p.y - span * 0.74,
          maxX: node.p.x + span,
          maxY: node.p.y + span * 0.74,
        },
        160,
        118,
        6,
      )
    }

    return {
      bounds,
      proj,
      projSmall,
      perimMm: perimUm / 1000,
      areaMm2,
      bwMm,
      bhMm,
      realSampleCount,
      visSamples,
      interiorTris,
      featuredTri,
      rawSkel,
      prunedSkel,
      widest,
      narrowest,
      wideZoomProj: makeZoomProj(widest),
      narrowZoomProj: makeZoomProj(narrowest),
    }
  }, [outline, spacingUm, step.geometry.skeleton, params.wallWidth])

  if (!analysis) {
    return <div className="dd-content">No shape outline loaded on this layer.</div>
  }

  const {
    proj,
    projSmall,
    perimMm,
    areaMm2,
    bwMm,
    bhMm,
    realSampleCount,
    visSamples,
    interiorTris,
    featuredTri,
    rawSkel,
    prunedSkel,
    widest,
    narrowest,
    wideZoomProj,
    narrowZoomProj,
  } = analysis

  const minWidthMm = narrowest ? ((2 * narrowest.r) / 1000).toFixed(2) : '0.00'
  const maxWidthMm = widest ? ((2 * widest.r) / 1000).toFixed(2) : '0.00'
  const prunedNodeDiff = Math.max(0, rawSkel.nodes.length - prunedSkel.nodes.length)
  const prunedEdgeDiff = Math.max(0, rawSkel.edges.length - prunedSkel.edges.length)
  const outlinePath = proj.polyPath(outline)
  const outlinePathSmall = projSmall.polyPath(outline)

  return (
    <div className="dd-content">
      <h2 className="dd-main-title">
        How the Slicer Finds the Medial Axis of &ldquo;{shapeName}&rdquo;
      </h2>
      <p className="dd-subtitle">
        Boundary sampling, Delaunay triangulation, Voronoi circumcentres, and leaf pruning — applied live to your current {bwMm.toFixed(1)} × {bhMm.toFixed(1)} mm cross-section.
      </p>

      <p>
        You are currently inspecting <strong>{shapeName}</strong> (area <strong>{areaMm2.toFixed(1)} mm²</strong>, perimeter <strong>{perimMm.toFixed(1)} mm</strong>). The nozzle prints with a nominal bead width of <strong>{wMm} mm</strong>, and across this specific shape the local interior thickness (<code>2r</code>) ranges from <strong>{minWidthMm} mm</strong> at its narrowest feature up to <strong>{maxWidthMm} mm</strong> at its widest region.
      </p>
      <p>
        To decide where fixed-width perimeters fit and where variable-width Arachne beads are needed on <strong>{shapeName}</strong>, we need to know not just <em>where the boundary is</em>, but <strong>how much room exists inside this shape at every location</strong>.
      </p>

      <h3>1. Start with the outline of {shapeName}</h3>
      <div className="dd-figure">
        <ZoomableSvg width={340} height={155}>
          <path
            d={outlinePath}
            fill="#94a3b8"
            fillOpacity=".14"
            fillRule="evenodd"
            stroke="#3b82f6"
            strokeWidth="2.4"
          />
          {widest && (
            <g>
              <circle
                cx={proj.pt(widest.p).x}
                cy={proj.pt(widest.p).y}
                r="4"
                fill="#22c55e"
              />
              <text
                x={Math.min(265, Math.max(12, proj.pt(widest.p).x + 7))}
                y={Math.max(16, proj.pt(widest.p).y - 6)}
                fontSize="11"
                fill="#86efac"
                fontWeight="600"
              >
                Widest: {maxWidthMm} mm
              </text>
            </g>
          )}
          {narrowest && (
            <g>
              <circle
                cx={proj.pt(narrowest.p).x}
                cy={proj.pt(narrowest.p).y}
                r="4"
                fill="#f59e0b"
              />
              <text
                x={Math.min(255, Math.max(12, proj.pt(narrowest.p).x - 30))}
                y={Math.min(148, proj.pt(narrowest.p).y + 15)}
                fontSize="11"
                fill="#fcd34d"
                fontWeight="600"
              >
                Thinnest: {minWidthMm} mm
              </text>
            </g>
          )}
        </ZoomableSvg>
        <div className="dd-caption">
          Live outline of {shapeName} ({outline.length} island{outline.length === 1 ? '' : 's'}, {outline.reduce((s, p) => s + p.holes.length, 0)} hole{outline.reduce((s, p) => s + p.holes.length, 0) === 1 ? '' : 's'}) with its actual widest ({maxWidthMm} mm) and narrowest ({minWidthMm} mm) interior points marked.
        </div>
      </div>

      <h3>2. Find the centerline — the medial axis of {shapeName}</h3>
      <p>
        Imagine walking through the interior of <strong>{shapeName}</strong> while staying equidistant from the nearest walls. The path you trace is the <strong>medial axis</strong>: the locus of centers of maximal circles that fit inside the shape and touch at least two boundary edges.
      </p>
      <div className="dd-figure">
        <ZoomableSvg width={340} height={155}>
          <path
            d={outlinePath}
            fill="#94a3b8"
            fillOpacity=".12"
            fillRule="evenodd"
            stroke="#64748b"
            strokeWidth="1.8"
          />
          {prunedSkel.edges.map(([a, b], i) => {
            const pa = proj.pt(prunedSkel.nodes[a].p)
            const pb = proj.pt(prunedSkel.nodes[b].p)
            return (
              <line
                key={i}
                x1={pa.x}
                y1={pa.y}
                x2={pb.x}
                y2={pb.y}
                stroke="#3b82f6"
                strokeWidth="2"
              />
            )
          })}
          {widest && (
            <g>
              <circle
                cx={proj.pt(widest.p).x}
                cy={proj.pt(widest.p).y}
                r={proj.r(widest.r)}
                stroke="#f59e0b"
                strokeWidth="1.8"
                strokeDasharray="4 3"
                fill="#f59e0b"
                fillOpacity="0.1"
              />
              <circle
                cx={proj.pt(widest.p).x}
                cy={proj.pt(widest.p).y}
                r="3.5"
                fill="#f59e0b"
              />
              <line
                x1={proj.pt(widest.p).x}
                y1={proj.pt(widest.p).y}
                x2={proj.pt(widest.p).x}
                y2={proj.pt(widest.p).y - proj.r(widest.r)}
                stroke="#f59e0b"
                strokeWidth="1.8"
              />
              <text
                x={proj.pt(widest.p).x + 5}
                y={proj.pt(widest.p).y - proj.r(widest.r) / 2}
                fontSize="11"
                fill="#fcd34d"
                fontWeight="600"
              >
                r = {(widest.r / 1000).toFixed(2)} mm
              </text>
            </g>
          )}
        </ZoomableSvg>
        <div className="dd-caption">
          The actual medial-axis skeleton of {shapeName} ({prunedSkel.nodes.length.toLocaleString()} nodes). The orange maximal inscribed circle has radius r = {widest ? (widest.r / 1000).toFixed(2) : '0'} mm.
        </div>
      </div>

      <h3>3. How the computer constructs {shapeName}&apos;s skeleton</h3>
      <p>
        Our code approximates the medial axis of <strong>{shapeName}</strong> in three geometric stages using <strong>Delaunay triangulation</strong>:
      </p>

      <h4>Stage A: Sample points around {shapeName}&apos;s boundary</h4>
      <p>
        We sample points along all outer and hole rings at <code>spacing = params.wallWidth / 8 = {spacingMm} mm</code>. Across <strong>{shapeName}</strong>&apos;s <code>{perimMm.toFixed(1)} mm</code> perimeter, that places <strong>{realSampleCount.toLocaleString()} sample points</strong>:
      </p>
      <div className="dd-figure">
        <ZoomableSvg width={340} height={155}>
          <path d={outlinePath} fill="#94a3b8" fillOpacity=".10" fillRule="evenodd" stroke="#64748b" strokeWidth="1.2" />
          {visSamples.map((p, i) => {
            const sp = proj.pt(p)
            return <circle key={i} cx={sp.x} cy={sp.y} r="2.6" fill="#3b82f6" />
          })}
        </ZoomableSvg>
        <div className="dd-caption">
          Boundary sample points around {shapeName} (decimated for visual clarity; the live algorithm uses {realSampleCount.toLocaleString()} points at {spacingMm} mm spacing).
        </div>
      </div>

      <h4>Stage B: Connect {shapeName}&apos;s boundary samples into Delaunay triangles</h4>
      <p>
        Next, <code>Delaunay.from(samples)</code> triangulates the boundary points so that <strong>no sample point lies inside the circumcircle of any triangle</strong>:
      </p>
      <div className="dd-figure">
        <ZoomableSvg width={340} height={155}>
          <path d={outlinePath} fill="#94a3b8" fillOpacity=".08" fillRule="evenodd" stroke="#475569" strokeWidth="1.2" />
          {interiorTris.map(([a, b, c], i) => {
            const pa = proj.pt(a)
            const pb = proj.pt(b)
            const pc = proj.pt(c)
            return (
              <polygon
                key={i}
                points={`${pa.x},${pa.y} ${pb.x},${pb.y} ${pc.x},${pc.y}`}
                fill="none"
                stroke="#64748b"
                strokeWidth="0.9"
              />
            )
          })}
          {visSamples.map((p, i) => {
            const sp = proj.pt(p)
            return <circle key={i} cx={sp.x} cy={sp.y} r="2.2" fill="#3b82f6" />
          })}
        </ZoomableSvg>
        <div className="dd-caption">
          Actual interior Delaunay triangulation spanning across {shapeName}.
        </div>
      </div>

      <h4>Stage C: Connect triangle circumcentres inside {shapeName}</h4>
      <p>
        Every Delaunay triangle has a <strong>circumcentre</strong> equidistant from its three boundary vertices. Connecting the circumcentres of adjacent triangles gives the <strong>Voronoi diagram</strong>, whose interior edges trace the medial axis of <strong>{shapeName}</strong>:
      </p>
      <div className="dd-figure">
        <ZoomableSvg width={340} height={155}>
          <path d={outlinePath} fill="#94a3b8" fillOpacity=".10" fillRule="evenodd" stroke="#64748b" strokeWidth="1.5" />
          {featuredTri && (
            <g>
              <polygon
                points={`${proj.pt(featuredTri.a).x},${proj.pt(featuredTri.a).y} ${proj.pt(featuredTri.b).x},${proj.pt(featuredTri.b).y} ${proj.pt(featuredTri.c).x},${proj.pt(featuredTri.c).y}`}
                fill="#3b82f6"
                fillOpacity="0.18"
                stroke="#60a5fa"
                strokeWidth="1.8"
              />
              <circle
                cx={proj.pt(featuredTri.cc).x}
                cy={proj.pt(featuredTri.cc).y}
                r={proj.r(featuredTri.r)}
                stroke="#f59e0b"
                strokeWidth="1.8"
                fill="none"
              />
              <circle
                cx={proj.pt(featuredTri.cc).x}
                cy={proj.pt(featuredTri.cc).y}
                r="4"
                fill="#f59e0b"
              />
              {[featuredTri.a, featuredTri.b, featuredTri.c].map((v, idx) => (
                <circle key={idx} cx={proj.pt(v).x} cy={proj.pt(v).y} r="3.5" fill="#3b82f6" />
              ))}
              <line
                x1={proj.pt(featuredTri.cc).x}
                y1={proj.pt(featuredTri.cc).y}
                x2={proj.pt(featuredTri.a).x}
                y2={proj.pt(featuredTri.a).y}
                stroke="#f59e0b"
                strokeWidth="1.4"
                strokeDasharray="3 3"
              />
            </g>
          )}
        </ZoomableSvg>
        <div className="dd-caption">
          A real Delaunay triangle inside {shapeName} (blue) with its circumcircle and circumcentre (orange) lying right on the medial axis.
        </div>
      </div>

      <FlowSteps
        steps={[
          `${shapeName} outline (${perimMm.toFixed(1)} mm perimeter)`,
          `${realSampleCount.toLocaleString()} boundary sample points (every ${spacingMm} mm)`,
          'Delaunay triangulation across interior',
          `Connect interior circumcentres (${rawSkel.nodes.length.toLocaleString()} raw nodes)`,
          `Pruned medial-axis skeleton (${prunedSkel.nodes.length.toLocaleString()} nodes)`,
        ]}
      />

      <h3>4. Local thickness (2r) on {shapeName}: Wide vs. Narrow regions</h3>
      <p>
        Below are zoomed-in views of the <strong>actual widest node</strong> and <strong>actual narrowest node</strong> computed on <strong>{shapeName}</strong>:
      </p>
      <div className="dd-grid-2">
        <div className="dd-figure">
          <ZoomableSvg width={160} height={118}>
            <path d={wideZoomProj.polyPath(outline)} fill="#94a3b8" fillOpacity=".14" fillRule="evenodd" stroke="#64748b" strokeWidth="1.8" />
            {widest && (
              <g>
                <circle
                  cx={wideZoomProj.pt(widest.p).x}
                  cy={wideZoomProj.pt(widest.p).y}
                  r={wideZoomProj.r(widest.r)}
                  fill="#3b82f6"
                  fillOpacity=".15"
                  stroke="#3b82f6"
                  strokeWidth="1.8"
                />
                <circle cx={wideZoomProj.pt(widest.p).x} cy={wideZoomProj.pt(widest.p).y} r="3.5" fill="#3b82f6" />
                <line
                  x1={wideZoomProj.pt(widest.p).x}
                  y1={wideZoomProj.pt(widest.p).y}
                  x2={wideZoomProj.pt(widest.p).x}
                  y2={wideZoomProj.pt(widest.p).y - wideZoomProj.r(widest.r)}
                  stroke="#f59e0b"
                  strokeWidth="2"
                />
                <text x={wideZoomProj.pt(widest.p).x + 5} y={wideZoomProj.pt(widest.p).y - 4} fontSize="11" fill="#fcd34d" fontWeight="600">
                  r = {(widest.r / 1000).toFixed(2)} mm
                </text>
              </g>
            )}
          </ZoomableSvg>
          <div className="dd-card-title">Widest point on {shapeName}</div>
          <div className="dd-caption">Local width 2r = {maxWidthMm} mm</div>
        </div>
        <div className="dd-figure">
          <ZoomableSvg width={160} height={118}>
            <path d={narrowZoomProj.polyPath(outline)} fill="#94a3b8" fillOpacity=".14" fillRule="evenodd" stroke="#64748b" strokeWidth="1.8" />
            {narrowest && (
              <g>
                <circle
                  cx={narrowZoomProj.pt(narrowest.p).x}
                  cy={narrowZoomProj.pt(narrowest.p).y}
                  r={Math.max(4, narrowZoomProj.r(narrowest.r))}
                  fill="#f59e0b"
                  fillOpacity=".2"
                  stroke="#f59e0b"
                  strokeWidth="1.8"
                />
                <circle cx={narrowZoomProj.pt(narrowest.p).x} cy={narrowZoomProj.pt(narrowest.p).y} r="3" fill="#f59e0b" />
                <text x={narrowZoomProj.pt(narrowest.p).x + 6} y={narrowZoomProj.pt(narrowest.p).y - 6} fontSize="11" fill="#fcd34d" fontWeight="600">
                  r = {(narrowest.r / 1000).toFixed(2)} mm
                </text>
              </g>
            )}
          </ZoomableSvg>
          <div className="dd-card-title">Thinnest point on {shapeName}</div>
          <div className="dd-caption">Local width 2r = {minWidthMm} mm</div>
        </div>
      </div>

      <h3>5. Pruning corner noise on {shapeName}: Before vs. After</h3>
      <p>
        On <strong>{shapeName}</strong>, raw Delaunay triangulation produces <strong>{rawSkel.nodes.length.toLocaleString()} nodes</strong> and <strong>{rawSkel.edges.length.toLocaleString()} edges</strong>, including short terminal twigs near corners. Calling <code>pruneSkeleton(rawSkeleton, {pruneMm} mm)</code> removes <strong>{prunedEdgeDiff.toLocaleString()} noisy branch edges</strong> ({prunedNodeDiff.toLocaleString()} nodes):
      </p>
      <div className="dd-grid-2">
        <div className="dd-figure">
          <ZoomableSvg width={160} height={118}>
            <path d={outlinePathSmall} fill="#94a3b8" fillOpacity=".1" fillRule="evenodd" stroke="#475569" strokeWidth="1.2" />
            {rawSkel.edges.map(([a, b], i) => {
              const pa = projSmall.pt(rawSkel.nodes[a].p)
              const pb = projSmall.pt(rawSkel.nodes[b].p)
              return <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="#f59e0b" strokeWidth="1.3" />
            })}
          </ZoomableSvg>
          <div className="dd-card-title">Before pruning ({rawSkel.nodes.length} nodes)</div>
          <div className="dd-caption">Includes {prunedEdgeDiff} short corner artifact edges</div>
        </div>
        <div className="dd-figure">
          <ZoomableSvg width={160} height={118}>
            <path d={outlinePathSmall} fill="#94a3b8" fillOpacity=".1" fillRule="evenodd" stroke="#475569" strokeWidth="1.2" />
            {prunedSkel.edges.map(([a, b], i) => {
              const pa = projSmall.pt(prunedSkel.nodes[a].p)
              const pb = projSmall.pt(prunedSkel.nodes[b].p)
              return <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="#3b82f6" strokeWidth="1.6" />
            })}
          </ZoomableSvg>
          <div className="dd-card-title">After pruning ({prunedSkel.nodes.length} nodes)</div>
          <div className="dd-caption">Clean centerline network ready for beading</div>
        </div>
      </div>

      <h3>6. Putting the code together on {shapeName}</h3>
      <pre className="dd-code">{`// 1. Sample ${shapeName}'s ${perimMm.toFixed(1)} mm boundary every ${spacingMm} mm (${realSampleCount.toLocaleString()} samples)
const spacing = params.wallWidth / 8

// 2. Triangulate samples & connect interior circumcentres → ${rawSkel.nodes.length} raw nodes
const rawSkeleton = computeSkeleton(outline, spacing)

// 3. Prune leaf twigs shorter than ${pruneMm} mm → ${prunedSkel.nodes.length} clean nodes
const skeleton = pruneSkeleton(rawSkeleton, 2 * spacing)`}</pre>

      <StatGrid
        items={[
          { value: prunedSkel.nodes.length.toLocaleString(), label: 'Pruned Nodes' },
          { value: prunedSkel.edges.length.toLocaleString(), label: 'Pruned Edges' },
          { value: `${minWidthMm}–${maxWidthMm}`, label: 'Width 2r (mm)' },
        ]}
      />

      <h3>7. Why Step 4 needs this skeleton for {shapeName}</h3>
      <p>
        In the very next step (<strong>Step S4: Adaptive variable-width centrelines</strong>), Arachne walks this skeleton inside the thin uncovered regions of <strong>{shapeName}</strong> where local thickness <code>2r ≤ {((2 * params.wallCount * params.wallWidth) / 1000).toFixed(2)} mm</code> and assigns each node an adaptive bead width <code>w = 2r / round(2r / {wMm})</code>.
      </p>
      <div className="dd-takeaway">
        <strong>The central idea for {shapeName}:</strong> By sampling its <code>{perimMm.toFixed(1)} mm</code> boundary into <code>{realSampleCount.toLocaleString()}</code> points, connecting Delaunay circumcentres, and pruning <code>{prunedEdgeDiff}</code> noisy twigs, we turn <strong>{shapeName}</strong> into a <strong>width-annotated centerline graph</strong> spanning <code>{minWidthMm} mm</code> to <code>{maxWidthMm} mm</code>.
      </div>
    </div>
  )
}

function ContextualStepDeepDive({
  step,
  allSteps,
  params,
  result,
  shapeName,
}: StepDeepDiveProps): ReactNode {
  const outline = useMemo(
    () => (result && result.outline.length > 0 ? result.outline : []),
    [result],
  )
  const g = step.geometry
  const d = step.details
  const prevStep = step.index > 0 ? (allSteps[step.index - 1] ?? null) : null
  const wMm = (params.wallWidth / 1000).toFixed(2)
  const totalWallMm = ((params.wallCount * params.wallWidth) / 1000).toFixed(2)

  const shapeStats = useMemo(() => {
    const polys = outline.length > 0 ? outline : g.polygons
    if (polys.length === 0) return null
    const bounds = polygonsBounds(polys)
    const proj = makeProjectorFromBounds(bounds, 340, 155, 16)
    const projSmall = makeProjectorFromBounds(bounds, 160, 118, 12)
    const outlineAreaMm2 = polygonsArea(polys) / 1e6
    const bwMm = (bounds.maxX - bounds.minX) / 1000
    const bhMm = (bounds.maxY - bounds.minY) / 1000

    // Compute a zoomed-in projector focused on the step's active output geometry
    let focusBounds: AABB | null = null
    if (g.polygons.length > 0) {
      focusBounds = polygonsBounds(g.polygons)
    } else if (g.extrusionLines.length > 0) {
      const targetLine = g.extrusionLines[g.extrusionLines.length - 1]
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const j of targetLine) {
        if (j.p.x < minX) minX = j.p.x
        if (j.p.y < minY) minY = j.p.y
        if (j.p.x > maxX) maxX = j.p.x
        if (j.p.y > maxY) maxY = j.p.y
      }
      if (minX <= maxX) {
        const pad = Math.max(2000, params.wallWidth * 4)
        focusBounds = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
      }
    }
    const zoomProj = focusBounds
      ? makeProjectorFromBounds(focusBounds, 340, 145, 18)
      : proj

    return {
      polys,
      bounds,
      proj,
      projSmall,
      zoomProj,
      outlineAreaMm2,
      bwMm,
      bhMm,
    }
  }, [outline, g.polygons, g.extrusionLines, params.wallWidth])

  // Compute live 3-column stat cards for this step on THIS shape
  const statItems: { value: string; label: string }[] = []
  if (g.polygons.length > 0) {
    const areaMm2 = polygonsArea(g.polygons) / 1e6
    const pct =
      shapeStats && shapeStats.outlineAreaMm2 > 0
        ? `${Math.min(100, (areaMm2 / shapeStats.outlineAreaMm2) * 100).toFixed(1)}%`
        : '100%'
    statItems.push(
      { value: String(g.polygons.length), label: 'Polygons' },
      { value: `${areaMm2.toFixed(2)}`, label: 'Step Area (mm²)' },
      { value: pct, label: `Of ${shapeName}` },
    )
  } else if (g.extrusionLines.length > 0) {
    let lenUm = 0
    let minW = Infinity
    let maxW = 0
    for (const l of g.extrusionLines) {
      for (let i = 0; i < l.length; i++) {
        if (l[i].w < minW) minW = l[i].w
        if (l[i].w > maxW) maxW = l[i].w
        if (i > 0) lenUm += dist(l[i - 1].p, l[i].p)
      }
    }
    const wLabel =
      Math.abs(maxW - minW) < 2
        ? `${(minW / 1000).toFixed(2)}`
        : `${(minW / 1000).toFixed(2)}–${(maxW / 1000).toFixed(2)}`
    statItems.push(
      { value: String(g.extrusionLines.length), label: 'Extrusion Paths' },
      { value: `${(lenUm / 1000).toFixed(1)}`, label: 'Length (mm)' },
      { value: wLabel, label: 'Bead Width (mm)' },
    )
  } else if (g.polylines.length > 0) {
    let lenUm = 0
    for (const pl of g.polylines) lenUm += polylineLength(pl)
    statItems.push(
      { value: String(g.polylines.length), label: 'Lines / Loops' },
      { value: `${(lenUm / 1000).toFixed(1)}`, label: 'Total Length (mm)' },
      { value: wMm, label: 'Nozzle Width (mm)' },
    )
  } else if (g.moves.length > 0) {
    const ext = g.moves.filter((m) => m.kind === 'extrusion').length
    const trav = g.moves.filter((m) => m.kind === 'travel').length
    const retr = g.moves.filter((m) => m.travel?.retract).length
    statItems.push(
      { value: String(ext), label: 'Extrusion Moves' },
      { value: String(trav), label: 'Travel Moves' },
      { value: String(retr), label: 'Retractions' },
    )
  } else {
    statItems.push(
      { value: '0', label: 'Output Elements' },
      { value: `L${d.startLine}–${d.endLine}`, label: 'Code Lines' },
      { value: wMm, label: 'Nozzle Width (mm)' },
    )
  }

  return (
    <div className="dd-content">
      <h2 className="dd-main-title">
        Step S{step.index + 1} on &ldquo;{shapeName}&rdquo;: {step.label}
      </h2>
      <p className="dd-subtitle">
        {d.algorithm} — Applied live to {shapeName} (Lines {d.startLine}–{d.endLine})
      </p>

      <h3>1. Starting geometry on {shapeName}</h3>
      <p>
        We are slicing <strong>{shapeName}</strong>
        {shapeStats
          ? ` (${shapeStats.bwMm.toFixed(1)} × ${shapeStats.bhMm.toFixed(1)} mm, total layer area ${shapeStats.outlineAreaMm2.toFixed(1)} mm²)`
          : ''}{' '}
        with a <strong>{wMm} mm</strong> nozzle and <strong>{params.wallCount} perimeters</strong> (nominal wall band = <strong>{totalWallMm} mm</strong>).
      </p>

      {shapeStats && (
        <div className="dd-grid-2">
          <div className="dd-figure">
            <ZoomableSvg width={160} height={118}>
              <path
                d={shapeStats.projSmall.polyPath(shapeStats.polys)}
                fill="#94a3b8"
                fillOpacity=".12"
                fillRule="evenodd"
                stroke="#64748b"
                strokeWidth="1.5"
              />
              {prevStep && (
                <StepGeometrySvgLayers
                  proj={shapeStats.projSmall}
                  geom={prevStep.geometry}
                  color="#3b82f6"
                />
              )}
            </ZoomableSvg>
            <div className="dd-card-title">
              {prevStep ? `Before: S${prevStep.index + 1} (${prevStep.label})` : `Input outline of ${shapeName}`}
            </div>
            <div className="dd-caption">
              {prevStep ? prevStep.note : `${shapeStats.outlineAreaMm2.toFixed(1)} mm² layer boundary`}
            </div>
          </div>
          <div className="dd-figure">
            <ZoomableSvg width={160} height={118}>
              <path
                d={shapeStats.projSmall.polyPath(shapeStats.polys)}
                fill="#94a3b8"
                fillOpacity=".10"
                fillRule="evenodd"
                stroke="#475569"
                strokeWidth="1.2"
              />
              <StepGeometrySvgLayers
                proj={shapeStats.projSmall}
                geom={g}
                color="#00e5ff"
              />
            </ZoomableSvg>
            <div className="dd-card-title">
              After Step S{step.index + 1}: {step.label}
            </div>
            <div className="dd-caption">{step.note}</div>
          </div>
        </div>
      )}

      <h3>2. How {d.algorithm} works on {shapeName}</h3>
      <p>{d.whatItDoes}</p>

      {shapeStats && (
        <div className="dd-figure">
          <ZoomableSvg width={340} height={145}>
            <path
              d={shapeStats.zoomProj.polyPath(shapeStats.polys)}
              fill="#94a3b8"
              fillOpacity=".12"
              fillRule="evenodd"
              stroke="#64748b"
              strokeWidth="1.6"
            />
            <StepGeometrySvgLayers
              proj={shapeStats.zoomProj}
              geom={g}
              color="#00e5ff"
            />
          </ZoomableSvg>
          <div className="dd-caption">
            Live geometry produced by Step S{step.index + 1} ({step.label}) inside {shapeName}: {d.dataMetrics}.
          </div>
        </div>
      )}

      <h3>3. Parameters &amp; functions executed in Lines {d.startLine}–{d.endLine}</h3>
      {d.paramsUsed.length > 0 ? (
        <div className="step-param-chips" style={{ marginBottom: 8 }}>
          {d.paramsUsed.map((p) => (
            <span key={p.name} className="step-param-chip">
              <code>{p.name}</code> = <strong>{p.value}</strong>
            </span>
          ))}
        </div>
      ) : (
        <p>Operates directly on the intermediate geometry computed in Step S{step.index}.</p>
      )}
      {d.functionsCalled.length > 0 && (
        <ul className="step-fn-list">
          {d.functionsCalled.map((fn) => (
            <li key={fn.name}>
              <code>{fn.name}</code> — {fn.description}
            </li>
          ))}
        </ul>
      )}

      <h3>4. Live output metrics on {shapeName}</h3>
      <StatGrid items={statItems} />
      <div className="step-data-metrics" style={{ marginTop: 6 }}>{d.dataMetrics}</div>

      <h3>5. Why the next step needs this for {shapeName}</h3>
      <p>{d.significance}</p>

      <div className="dd-takeaway">
        <strong>The central idea for {shapeName}:</strong> Step S{step.index + 1} (<code>{step.label}</code>) transforms <strong>{shapeName}</strong> using <em>{d.algorithm}</em>, producing <code>{step.note}</code> for the subsequent stage of the slicer pipeline.
      </div>
    </div>
  )
}

export function StepDeepDive(props: StepDeepDiveProps) {
  const lower = props.step.label.toLowerCase()
  if (lower.includes('medial-axis skeleton')) {
    return <SkeletonDeepDive {...props} />
  }
  return <ContextualStepDeepDive {...props} />
}
