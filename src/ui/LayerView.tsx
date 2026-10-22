import { useEffect, useMemo, useRef, useState } from 'react'
import type { Point, Polygon, Polyline } from '../geometry/types'
import type { PseudoStep } from '../algorithms/pseudocode'
import type { ExtrusionLine, FeatureKind, OrderedMove, SlicedLayer } from '../algorithms/types'
import { defaultPipelineParams, type PipelineParams, type PipelineResult } from '../state/pipeline'
import { StepDeepDive } from './StepDeepDive'
import type { ViewTransform, VisState } from './vis'
import { featureColors } from './vis'

const TRAVEL_COLOR = '#3a86ff'
const BED = 60000 // half-size of the virtual bed, microns

export interface DrawHandlers {
  active: boolean
  draft: Point[]
  editable: Polygon[]
  onDraft: (d: Point[]) => void
  onEditable: (p: Polygon[]) => void
  onCloseDraft: () => void
}

interface LayerViewProps {
  result: PipelineResult | null
  layer: SlicedLayer | null
  vis: VisState
  fitKey: number
  view?: ViewTransform | null
  onView?: (v: ViewTransform) => void
  /** Extrusion moves shown as printed so far; undefined = show all. */
  stepCount?: number
  /** Distance along the whole print path (animation); overrides stepCount. */
  animDist?: number | null
  showNozzle?: boolean
  draw?: DrawHandlers
  /** Highlighted intermediate step from pseudocode execution. */
  activeStep?: PseudoStep | null
  allSteps?: PseudoStep[]
  totalSteps?: number
  onSelectStep?: (stepIndex: number | null) => void
  params?: PipelineParams
  shapeName?: string
  detailedOpen?: boolean
  onToggleDetailed?: () => void
}

interface MoveSeg {
  move: OrderedMove
  pts: Polyline
  ws: number[] | null
  start: number
  len: number
  extIndex: number // index among extrusion moves, -1 for travel
}

function linePts(line: ExtrusionLine | Polyline): { pts: Polyline; ws: number[] | null } {
  if (line.length > 0 && 'p' in line[0]) {
    const ext = line as ExtrusionLine
    return { pts: ext.map((j) => j.p), ws: ext.map((j) => j.w) }
  }
  return { pts: line as Polyline, ws: null }
}

function polylineLen(pts: Polyline): number {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return s
}

/** Walk a polyline to arc length d; returns the point there. */
function pointAt(pts: Polyline, d: number): Point {
  if (pts.length === 0) return { x: 0, y: 0 }
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    if (d <= seg) {
      const t = seg > 0 ? d / seg : 0
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }
    }
    d -= seg
  }
  return pts[pts.length - 1]
}

/** Sub-polyline covering the first d microns of pts. */
function prefix(pts: Polyline, d: number): Polyline {
  const out: Polyline = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    if (d >= seg) {
      out.push(pts[i])
      d -= seg
    } else {
      const t = seg > 0 ? d / seg : 0
      out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t })
      return out
    }
  }
  return out
}

function boundsOfPolygons(polys: Polygon[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const poly of polys) {
    for (const p of poly.outer) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  return minX <= maxX ? { minX, minY, maxX, maxY } : null
}

export function LayerView(props: LayerViewProps) {
  const { result, layer, vis, draw } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [inner, setInner] = useState<ViewTransform | null>(null)
  const [cursor, setCursor] = useState<Point | null>(null)
  const [localDetailed, setLocalDetailed] = useState(false)
  const detailedOpen = props.detailedOpen ?? localDetailed
  const toggleDetailed = props.onToggleDetailed ?? (() => setLocalDetailed((v) => !v))
  const view = props.view !== undefined ? props.view : inner
  const setViewRef = useRef<(v: ViewTransform) => void>(() => {})
  setViewRef.current = props.onView ?? setInner
  const dragRef = useRef<
    | { type: 'pan'; sx: number; sy: number; view: ViewTransform }
    | { type: 'draft-vertex'; index: number }
    | { type: 'poly-vertex'; poly: number; index: number }
    | null
  >(null)

  // Canvas resize via ResizeObserver, with devicePixelRatio scaling.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const contentBounds = useMemo(() => {
    const polys = layer && layer.polygons.length > 0 ? layer.polygons : (result?.outline ?? [])
    return boundsOfPolygons(polys)
  }, [layer, result])

  // Fit to content on source change / first size.
  const fitRef = useRef(-1)
  useEffect(() => {
    if (size.w === 0 || size.h === 0) return
    if (fitRef.current === props.fitKey && view) return
    if (contentBounds) {
      fitRef.current = props.fitKey
    }
    const b = contentBounds ?? { minX: -BED, minY: -BED, maxX: BED, maxY: BED }
    const w = Math.max(1000, b.maxX - b.minX)
    const h = Math.max(1000, b.maxY - b.minY)
    const scale = Math.min(size.w / w, size.h / h) * 0.75
    setViewRef.current({ scale, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitKey, size.w, size.h, contentBounds])

  // Flattened print path with cumulative distances.
  const pathData = useMemo(() => {
    const segs: MoveSeg[] = []
    let d = 0
    let ext = 0
    let extTotal = 0
    for (const move of props.result?.moves ?? []) {
      const { pts, ws } = linePts(move.line)
      const len = polylineLen(pts)
      const isExt = move.kind === 'extrusion'
      segs.push({ move, pts, ws, start: d, len, extIndex: isExt ? ext : -1 })
      if (isExt) ext++
      d += len
    }
    extTotal = ext
    return { segs, total: d, extTotal }
  }, [props.result])

  // Cutoff distance: everything beyond is drawn dimmed.
  let cutoff = Infinity
  if (props.animDist != null) {
    cutoff = props.animDist
  } else if (props.stepCount !== undefined && props.stepCount < pathData.extTotal) {
    const n = props.stepCount
    cutoff = n <= 0 ? 0 : (() => {
      const seg = pathData.segs.find((s) => s.extIndex === n - 1)
      return seg ? seg.start + seg.len : Infinity
    })()
  }

  const nozzle =
    props.showNozzle && props.animDist != null && pathData.total > 0
      ? (() => {
          const d = Math.min(props.animDist, pathData.total)
          const seg = pathData.segs.find((s) => d <= s.start + s.len) ?? pathData.segs[pathData.segs.length - 1]
          return pointAt(seg.pts, Math.max(0, d - seg.start))
        })()
      : null

  // ---------------------------------------------------------------- drawing
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !view || size.w === 0 || size.h === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { w, h } = size
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#16181d'
    ctx.fillRect(0, 0, w, h)

    const toScreen = (p: Point): Point => ({
      x: w / 2 + (p.x - view.cx) * view.scale,
      y: h / 2 - (p.y - view.cy) * view.scale,
    })

    // World-space transform with Y flipped (micron Y up).
    const world = () => {
      ctx.save()
      ctx.translate(w / 2, h / 2)
      ctx.scale(view.scale, -view.scale)
      ctx.translate(-view.cx, -view.cy)
    }
    const px = (n: number) => n / view.scale // n screen px in world units

    const tracePolygon = (poly: Polygon) => {
      const ring = (r: Polyline) => {
        if (r.length === 0) return
        ctx.moveTo(r[0].x, r[0].y)
        for (let i = 1; i < r.length; i++) ctx.lineTo(r[i].x, r[i].y)
        ctx.closePath()
      }
      ring(poly.outer)
      poly.holes.forEach(ring)
    }
    const fillPolys = (polys: Polygon[], fill: string, stroke?: string) => {
      if (polys.length === 0) return
      ctx.beginPath()
      polys.forEach(tracePolygon)
      ctx.fillStyle = fill
      ctx.fill('evenodd')
      if (stroke) {
        ctx.strokeStyle = stroke
        ctx.lineWidth = px(1)
        ctx.stroke()
      }
    }
    const strokeLines = (lines: Polyline[], color: string, widthPx: number, dash?: number[]) => {
      ctx.strokeStyle = color
      ctx.lineWidth = px(widthPx)
      ctx.setLineDash(dash ? dash.map(px) : [])
      ctx.beginPath()
      for (const line of lines) {
        if (line.length === 0) continue
        ctx.moveTo(line[0].x, line[0].y)
        for (let i = 1; i < line.length; i++) ctx.lineTo(line[i].x, line[i].y)
      }
      ctx.stroke()
      ctx.setLineDash([])
    }

    world()

    // Bed grid (10 mm) and axes.
    ctx.strokeStyle = '#22262e'
    ctx.lineWidth = px(1)
    ctx.beginPath()
    for (let g = -BED; g <= BED; g += 10000) {
      ctx.moveTo(g, -BED)
      ctx.lineTo(g, BED)
      ctx.moveTo(-BED, g)
      ctx.lineTo(BED, g)
    }
    ctx.stroke()
    ctx.strokeStyle = '#2f3540'
    ctx.strokeRect(-BED, -BED, 2 * BED, 2 * BED)
    ctx.beginPath()
    ctx.moveTo(-BED, 0)
    ctx.lineTo(BED, 0)
    ctx.moveTo(0, -BED)
    ctx.lineTo(0, BED)
    ctx.stroke()

    // Region fills.
    const stepInspect = props.activeStep ?? null
    const baseAlpha = stepInspect ? 0.18 : 1
    ctx.globalAlpha = baseAlpha
    if (result) {
      if (vis.wallsRegion) fillPolys(result.areas.wallsRegion, 'rgba(150,170,200,0.13)')
      if (vis.infillRegion) fillPolys(result.areas.infillRegion, 'rgba(245,166,35,0.07)')
      if (vis.skinFill) fillPolys(result.areas.skin, 'rgba(240,225,58,0.16)')
      if (vis.gaps) fillPolys(result.walls.gaps, 'rgba(255,70,70,0.30)', 'rgba(255,70,70,0.75)')
    }

    // Skeleton (arachne).
    const skel = result?.walls.skeleton
    if (vis.skeleton && skel) {
      ctx.strokeStyle = '#4dd0e1'
      ctx.lineWidth = px(1)
      ctx.beginPath()
      for (const [a, b] of skel.edges) {
        ctx.moveTo(skel.nodes[a].p.x, skel.nodes[a].p.y)
        ctx.lineTo(skel.nodes[b].p.x, skel.nodes[b].p.y)
      }
      ctx.stroke()
      ctx.fillStyle = '#4dd0e1'
      for (const n of skel.nodes) {
        ctx.beginPath()
        ctx.arc(n.p.x, n.p.y, px(1.6), 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // Raw segments / stitched outline.
    if (vis.rawSegments && layer) strokeLines(layer.rawSegments, '#6a7078', 1)
    if (vis.outline && result) {
      ctx.globalAlpha = stepInspect ? 0.45 : 1
      ctx.strokeStyle = '#9aa4b2'
      ctx.lineWidth = px(1)
      ctx.beginPath()
      result.outline.forEach(tracePolygon)
      ctx.stroke()
      ctx.globalAlpha = baseAlpha
    }

    // Raw infill pattern lines (pre-clip teaching view).
    if (vis.rawInfill && result) strokeLines(result.infillRawLines, 'rgba(245,166,35,0.25)', 1)

    // Extrusion + travel moves in print order.
    if (result) {
      const featureVisible = (f: OrderedMove['feature']): boolean => {
        if (f === 'outer-wall' || f === 'inner-wall') return vis.wallPaths
        if (f === 'infill') return vis.infillLines
        if (f === 'skin') return vis.skinLines
        return true
      }
      const drawExtrusion = (seg: MoveSeg, pts: Polyline, alpha: number) => {
        if (pts.length < 2 || !featureVisible(seg.move.feature)) return
        ctx.globalAlpha = alpha * baseAlpha
        ctx.strokeStyle = featureColors[seg.move.feature as FeatureKind] ?? '#fff'
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        for (let i = 1; i < pts.length; i++) {
          ctx.lineWidth = Math.max(seg.ws?.[i] ?? 400, px(0.8))
          ctx.beginPath()
          ctx.moveTo(pts[i - 1].x, pts[i - 1].y)
          ctx.lineTo(pts[i].x, pts[i].y)
          ctx.stroke()
        }
        ctx.globalAlpha = baseAlpha
      }
      const drawTravel = (pts: Polyline, alpha: number) => {
        if (!vis.travel || pts.length < 2) return
        ctx.globalAlpha = alpha * baseAlpha
        ctx.strokeStyle = TRAVEL_COLOR
        ctx.lineWidth = px(1)
        ctx.setLineDash([px(4), px(3)])
        ctx.beginPath()
        ctx.moveTo(pts[0].x, pts[0].y)
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = baseAlpha
      }
      const partialIdx = pathData.segs.findIndex((s) => cutoff > s.start && cutoff < s.start + s.len)
      pathData.segs.forEach((seg, i) => {
        if (seg.pts.length < 2) return
        const printed = seg.start + seg.len <= cutoff
        const isPartial = i === partialIdx
        const alpha = printed || isPartial ? 1 : 0.3
        if (isPartial) {
          const sub = prefix(seg.pts, cutoff - seg.start)
          if (seg.move.kind === 'extrusion') {
            drawExtrusion(seg, sub, 1)
            drawExtrusion(seg, seg.pts, 0.3)
          } else {
            drawTravel(sub, 1)
            drawTravel(seg.pts, 0.3)
          }
        } else if (seg.move.kind === 'extrusion') {
          drawExtrusion(seg, seg.pts, alpha)
        } else {
          drawTravel(seg.pts, alpha)
        }
      })
    }
    ctx.globalAlpha = 1

    // Highlighted pseudocode step geometry overlay.
    if (stepInspect) {
      const g = stepInspect.geometry
      // 1. Highlighted polygons (outer in bright cyan, holes in dashed coral)
      if (g.polygons.length > 0) {
        fillPolys(g.polygons, 'rgba(0, 229, 255, 0.22)')
        ctx.strokeStyle = '#00e5ff'
        ctx.lineWidth = px(2)
        ctx.beginPath()
        for (const poly of g.polygons) {
          if (poly.outer.length === 0) continue
          ctx.moveTo(poly.outer[0].x, poly.outer[0].y)
          for (let i = 1; i < poly.outer.length; i++) ctx.lineTo(poly.outer[i].x, poly.outer[i].y)
          ctx.closePath()
        }
        ctx.stroke()

        const holes = g.polygons.flatMap((p) => p.holes)
        if (holes.length > 0) {
          ctx.strokeStyle = '#ff6b9d'
          ctx.lineWidth = px(1.8)
          ctx.setLineDash([px(4), px(3)])
          ctx.beginPath()
          for (const h of holes) {
            if (h.length === 0) continue
            ctx.moveTo(h[0].x, h[0].y)
            for (let i = 1; i < h.length; i++) ctx.lineTo(h[i].x, h[i].y)
            ctx.closePath()
          }
          ctx.stroke()
          ctx.setLineDash([])
        }
      }

      // 2. Highlighted skeleton (edges, nodes, and clearance radius circles)
      if (g.skeleton) {
        const sk = g.skeleton
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.22)'
        ctx.lineWidth = px(1)
        const stride = Math.max(1, Math.floor(sk.nodes.length / 24))
        for (let i = 0; i < sk.nodes.length; i += stride) {
          const n = sk.nodes[i]
          if (n.r > 0) {
            ctx.beginPath()
            ctx.arc(n.p.x, n.p.y, n.r, 0, Math.PI * 2)
            ctx.stroke()
          }
        }
        ctx.strokeStyle = '#00e5ff'
        ctx.lineWidth = px(2)
        ctx.beginPath()
        for (const [a, b] of sk.edges) {
          ctx.moveTo(sk.nodes[a].p.x, sk.nodes[a].p.y)
          ctx.lineTo(sk.nodes[b].p.x, sk.nodes[b].p.y)
        }
        ctx.stroke()
        ctx.fillStyle = '#00e5ff'
        for (const n of sk.nodes) {
          ctx.beginPath()
          ctx.arc(n.p.x, n.p.y, px(2.2), 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // 3. Highlighted polylines
      if (g.polylines.length > 0) {
        strokeLines(g.polylines, '#ffb703', 1.8)
      }

      // 4. Highlighted extrusion lines (bead width + bright spine)
      const drawBeadLine = (line: ExtrusionLine, color: string) => {
        if (line.length < 2) return
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.globalAlpha = 0.65
        ctx.strokeStyle = color
        for (let i = 1; i < line.length; i++) {
          ctx.lineWidth = Math.max(line[i].w, px(1.5))
          ctx.beginPath()
          ctx.moveTo(line[i - 1].p.x, line[i - 1].p.y)
          ctx.lineTo(line[i].p.x, line[i].p.y)
          ctx.stroke()
        }
        ctx.globalAlpha = 1
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = px(1.3)
        ctx.beginPath()
        ctx.moveTo(line[0].p.x, line[0].p.y)
        for (let i = 1; i < line.length; i++) ctx.lineTo(line[i].p.x, line[i].p.y)
        ctx.stroke()
      }

      for (const line of g.extrusionLines) {
        drawBeadLine(line, '#00e5ff')
      }

      // 5. Highlighted ordered moves
      for (const mv of g.moves) {
        if (mv.kind === 'extrusion') {
          const col = featureColors[mv.feature as FeatureKind] ?? '#00e5ff'
          drawBeadLine(mv.line as ExtrusionLine, col)
        } else {
          const pts = mv.line as Polyline
          strokeLines([pts], '#3a86ff', 2, [5, 3])
        }
      }
    }

    // Draft polygon (draw mode).
    if (draw?.active) {
      const pts = cursor && draw.draft.length > 0 ? [...draw.draft, cursor] : draw.draft
      if (pts.length > 0) {
        ctx.strokeStyle = '#f5a623'
        ctx.lineWidth = px(1.5)
        ctx.setLineDash([px(5), px(4)])
        ctx.beginPath()
        ctx.moveTo(pts[0].x, pts[0].y)
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
        if (pts.length > 2 && !cursor) ctx.closePath()
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    ctx.restore()

    // ---- screen-space overlays (markers, text, handles) ----
    if (result && vis.travel) {
      for (const seg of pathData.segs) {
        const t = seg.move.travel
        if (!t || seg.pts.length === 0) continue
        const s = toScreen(seg.pts[0])
        if (t.retract) {
          ctx.strokeStyle = '#cfd6e0'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2)
          ctx.stroke()
        }
        if (t.zHop) {
          ctx.fillStyle = '#cfd6e0'
          ctx.beginPath()
          ctx.moveTo(s.x, s.y - 7)
          ctx.lineTo(s.x - 4, s.y - 1)
          ctx.lineTo(s.x + 4, s.y - 1)
          ctx.closePath()
          ctx.fill()
        }
      }
    }

    if (result && vis.orderNumbers) {
      ctx.font = '10px ui-monospace, monospace'
      ctx.fillStyle = '#cfd6e0'
      ctx.textBaseline = 'middle'
      for (const seg of pathData.segs) {
        if (seg.extIndex < 0 || seg.pts.length === 0) continue
        const s = toScreen(seg.pts[0])
        ctx.fillText(String(seg.extIndex + 1), s.x + 4, s.y - 4)
      }
    }

    if (nozzle) {
      const s = toScreen(nozzle)
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(s.x, s.y, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#16181d'
      ctx.lineWidth = 2
      ctx.stroke()
    }

    if (draw?.active) {
      const handles: Point[] = []
      draw.editable.forEach((poly) => poly.outer.forEach((p) => handles.push(p)))
      draw.draft.forEach((p) => handles.push(p))
      ctx.fillStyle = '#f5a623'
      for (const p of handles) {
        const s = toScreen(p)
        ctx.fillRect(s.x - 3, s.y - 3, 6, 6)
      }
    }
  })

  // ---------------------------------------------------------------- input
  const toWorld = (sx: number, sy: number): Point => {
    if (!view) return { x: 0, y: 0 }
    return {
      x: view.cx + (sx - size.w / 2) / view.scale,
      y: view.cy - (sy - size.h / 2) / view.scale,
    }
  }

  const localPos = (e: React.PointerEvent | React.MouseEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  /** Hit-test draft + editable vertices in screen space. */
  const hitVertex = (sp: Point): { type: 'draft-vertex'; index: number } | { type: 'poly-vertex'; poly: number; index: number } | null => {
    if (!draw?.active || !view) return null
    const dist2 = (p: Point) => {
      const s = {
        x: size.w / 2 + (p.x - view.cx) * view.scale,
        y: size.h / 2 - (p.y - view.cy) * view.scale,
      }
      return (s.x - sp.x) ** 2 + (s.y - sp.y) ** 2
    }
    for (let i = 0; i < draw.draft.length; i++) {
      if (dist2(draw.draft[i]) < 49) return { type: 'draft-vertex', index: i }
    }
    for (let pi = 0; pi < draw.editable.length; pi++) {
      const ring = draw.editable[pi].outer
      for (let i = 0; i < ring.length; i++) {
        if (dist2(ring[i]) < 49) return { type: 'poly-vertex', poly: pi, index: i }
      }
    }
    return null
  }

  // Wheel zoom to cursor; native listener so preventDefault works.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!view) return
      const rect = canvas.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const scale = Math.min(2, Math.max(0.0002, view.scale * Math.exp(-e.deltaY * 0.0012)))
      const wx = view.cx + (sx - size.w / 2) / view.scale
      const wy = view.cy - (sy - size.h / 2) / view.scale
      setViewRef.current({
        scale,
        cx: wx - (sx - size.w / 2) / scale,
        cy: wy + (sy - size.h / 2) / scale,
      })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [view, size])

  const onPointerDown = (e: React.PointerEvent) => {
    if (!view) return
    canvasRef.current?.setPointerCapture(e.pointerId)
    const sp = localPos(e)
    if (draw?.active && e.button === 0) {
      const hit = hitVertex(sp)
      if (hit) {
        dragRef.current = hit
      } else {
        const p = toWorld(sp.x, sp.y)
        draw.onDraft([...draw.draft, { x: Math.round(p.x), y: Math.round(p.y) }])
      }
      return
    }
    if (e.button === 0 || e.button === 1) {
      dragRef.current = { type: 'pan', sx: sp.x, sy: sp.y, view }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const sp = localPos(e)
    if (draw?.active) setCursor(toWorld(sp.x, sp.y))
    const drag = dragRef.current
    if (!drag || !view) return
    if (drag.type === 'pan') {
      setViewRef.current({
        scale: drag.view.scale,
        cx: drag.view.cx - (sp.x - drag.sx) / drag.view.scale,
        cy: drag.view.cy + (sp.y - drag.sy) / drag.view.scale,
      })
    } else if (drag.type === 'draft-vertex' && draw) {
      const p = toWorld(sp.x, sp.y)
      const next = [...draw.draft]
      next[drag.index] = { x: Math.round(p.x), y: Math.round(p.y) }
      draw.onDraft(next)
    } else if (drag.type === 'poly-vertex' && draw) {
      const p = toWorld(sp.x, sp.y)
      const next = draw.editable.map((poly, pi) =>
        pi === drag.poly
          ? {
              ...poly,
              outer: poly.outer.map((q, qi) =>
                qi === drag.index ? { x: Math.round(p.x), y: Math.round(p.y) } : q,
              ),
            }
          : poly,
      )
      draw.onEditable(next)
    }
  }

  const onPointerUp = () => {
    dragRef.current = null
  }

  const onDoubleClick = () => {
    if (draw?.active) draw.onCloseDraft()
  }

  const onContextMenu = (e: React.MouseEvent) => {
    if (!draw?.active) return
    e.preventDefault()
    const hit = hitVertex(localPos(e))
    if (!hit) return
    if (hit.type === 'draft-vertex') {
      draw.onDraft(draw.draft.filter((_, i) => i !== hit.index))
    } else {
      const next = draw.editable
        .map((poly, pi) =>
          pi === hit.poly ? { ...poly, outer: poly.outer.filter((_, i) => i !== hit.index) } : poly,
        )
        .filter((poly) => poly.outer.length >= 3)
      draw.onEditable(next)
    }
  }

  return (
    <div ref={wrapRef} className="layer-view">
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor: draw?.active ? 'crosshair' : 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
      {props.activeStep && (
        <div className={`step-hud-wrap${detailedOpen ? ' expanded' : ''}`}>
          <div className="step-hud">
            <div className="step-hud-top">
              <span className="step-hud-badge">
                S{props.activeStep.index + 1}
                {props.totalSteps ? `/${props.totalSteps}` : ''} · Lines{' '}
                {props.activeStep.details.startLine}–{props.activeStep.details.endLine}
              </span>
              <span className="step-hud-title">{props.activeStep.label}</span>
              <span className="step-hud-note">{props.activeStep.details.dataMetrics}</span>
              {props.onSelectStep && (
                <span className="step-hud-controls">
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={props.activeStep.index <= 0}
                    onClick={() => props.onSelectStep!(props.activeStep!.index - 1)}
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={
                      props.totalSteps !== undefined &&
                      props.activeStep.index >= props.totalSteps - 1
                    }
                    onClick={() => props.onSelectStep!(props.activeStep!.index + 1)}
                  >
                    ▶
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() => props.onSelectStep!(null)}
                  >
                    ✕ Full layer
                  </button>
                </span>
              )}
            </div>
            <div className="step-hud-sub">
              <strong>{props.activeStep.details.algorithm}:</strong>{' '}
              {props.activeStep.details.whatItDoes}
            </div>
            {detailedOpen && (
              <div className="step-hud-deepdive">
                <StepDeepDive
                  step={props.activeStep}
                  allSteps={props.allSteps ?? []}
                  params={props.params ?? defaultPipelineParams}
                  result={result}
                  shapeName={props.shapeName ?? 'Current shape'}
                />
              </div>
            )}
          </div>
          <button
            type="button"
            className={`step-detail-btn${detailedOpen ? ' active' : ''}`}
            onClick={toggleDetailed}
          >
            {detailedOpen
              ? '▴ Hide Detailed Explanation'
              : '▾ Detailed Explanation (First-Principles Step 1–7 Walkthrough & Diagrams)'}
          </button>
        </div>
      )}
    </div>
  )
}
