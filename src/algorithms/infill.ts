import { pointInPolygons, pointInRing } from '../geometry/clipper'
import {
  distToSegment,
  polygonsBounds,
  polygonsScanlineSegments,
  rotatePoint,
  rotatePolygon,
} from '../geometry/polyUtils'
import type { AABB, Point, Polygon, Polyline, Ring } from '../geometry/types'
import type { ExtrusionLine, InfillResult, StageDoc } from './types'

export const infillDoc: StageDoc = {
  title: 'Infill Patterns',
  explanation: `## The idea
Turn the hollow interior into a sparse scaffold, trading material and time for strength: generate pattern lines across the area, then clip them to the region so no plastic lands outside the part.

## Step by step
1. Rotate the area by \`-angle\` so pattern lines become horizontal scanlines — one intersection routine serves any angle.
2. Sweep scanlines \`spacing\` apart, pair up the polygon crossings into segments, rotate everything back.
3. **Grid** adds a second direction at +90°, **triangles** three at 60°, **cubic** adds a half-period-shifted copy of one direction on top of grid.
4. **Zigzag** chains consecutive lines end-to-end into one serpentine; a connector whose midpoint leaves the part breaks the chain.
5. **Honeycomb** tiles regular hexagons and keeps each shared edge only once.
6. **Gyroid** is the zero level-set of the 3D field \`sin(X)cos(Y) + sin(Y)cos(Z) + sin(Z)cos(X)\` sliced at \`Z = PI/4\`, extracted cell by cell with marching squares.
7. Every line is clipped against the region polygons (outer contour minus holes).

## Key formulas / rules
- \`spacing = n * lineWidth / density\` for an n-direction pattern, so combined density stays \`density\`
- zigzag: \`spacing = lineWidth / density\`
- honeycomb: \`side = 2 * lineWidth / (sqrt(3) * density)\`
- gyroid: \`period = 3 * lineWidth / density\`

## Edge cases & simplifications
- Zigzag connectors hug the boundary directly; Cura actually walks along the perimeter. The midpoint test is a close, readable simplification.
- The naive 2D gyroid reduction collapses to straight parallel lines, which is why the true 3D field is sliced instead.
- Raw (unclipped) pattern lines are decimated to 800 for the teaching view.

## Try it
- Washer preset → stage 4: switch \`pattern\` and watch clipping around the hole.
- Slide \`density\` and toggle **Raw pattern lines** to see the pattern before clipping.
- Skin always prints as 100% density zigzag, alternating 90° per layer like Cura.`,
  curaRef: 'src/infill.cpp, src/infill/GyroidInfill.cpp',
  refs: [
    {
      label: 'CuraEngine wiki — Generating Paths',
      url: 'https://github.com/Ultimaker/CuraEngine/wiki/Generating-Paths',
    },
  ],
}

export type InfillPattern =
  | 'lines'
  | 'zigzag'
  | 'grid'
  | 'triangles'
  | 'cubic'
  | 'honeycomb'
  | 'gyroid'

export interface InfillParams {
  pattern: InfillPattern
  /** 0..1 */
  density: number
  /** microns */
  lineWidth: number
  /** degrees, base pattern angle */
  angle: number
}

/** Cap on raw (unclipped) lines kept for the teaching view. */
const MAX_RAW_LINES = 800

/** Tolerance for treating a point as on the boundary, microns. */
const ON_BOUNDARY_EPS = 0.5

/**
 * Pattern period of the gyroid field relative to lineWidth / density.
 * Chosen so the zero level-set's length per unit area is density / lineWidth,
 * i.e. the extruded area matches the requested density like the line patterns.
 */
const GYROID_PERIOD_FACTOR = 3.0

// ---------------------------------------------------------------------------
// Clipping
// ---------------------------------------------------------------------------

function pointInPolygonsOrOn(p: Point, polys: Polygon[]): boolean {
  if (pointInPolygons(p, polys)) return true
  // A point strictly inside a hole is out, even if it sits within the
  // boundary epsilon of the hole edge (segments collinear with an edge can
  // wobble across it by less than float noise).
  for (const poly of polys) {
    for (const hole of poly.holes) {
      if (pointInRing(p, hole)) return false
    }
  }
  for (const poly of polys) {
    for (const ring of [poly.outer, ...poly.holes]) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if (distToSegment(p, ring[j], ring[i]) <= ON_BOUNDARY_EPS) return true
      }
    }
  }
  return false
}

/** Sorted parameters in [0,1] where segment ab crosses any ring edge. */
function clipParameters(a: Point, b: Point, rings: Ring[]): number[] {
  const ts = [0, 1]
  const dx = b.x - a.x
  const dy = b.y - a.y
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const c = ring[j]
      const d = ring[i]
      const ex = d.x - c.x
      const ey = d.y - c.y
      const denom = dx * ey - dy * ex
      if (Math.abs(denom) < 1e-12) continue
      const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / denom
      const s = ((c.x - a.x) * dy - (c.y - a.y) * dx) / denom
      if (t > 1e-9 && t < 1 - 1e-9 && s >= -1e-9 && s <= 1 + 1e-9) ts.push(t)
    }
  }
  ts.sort((p, q) => p - q)
  return ts.filter((t, i) => i === 0 || t - ts[i - 1] > 1e-9)
}

/**
 * Clip polylines to polygons, segment by segment: intersect each segment with
 * all ring edges, sort the t-values, and keep the sub-segments whose midpoint
 * lies inside (or on) the area.
 */
export function clipPolylinesToPolygons(lines: Polyline[], area: Polygon[]): Polyline[] {
  const rings: Ring[] = []
  for (const poly of area) rings.push(poly.outer, ...poly.holes)
  const out: Polyline[] = []
  for (const line of lines) {
    let current: Polyline | null = null
    const flush = () => {
      if (current && current.length > 1) out.push(current)
      current = null
    }
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]
      const b = line[i]
      const ts = clipParameters(a, b, rings)
      for (let k = 1; k < ts.length; k++) {
        const t0 = ts[k - 1]
        const t1 = ts[k]
        if (t1 - t0 < 1e-12) continue
        const mid = {
          x: a.x + ((b.x - a.x) * (t0 + t1)) / 2,
          y: a.y + ((b.y - a.y) * (t0 + t1)) / 2,
        }
        if (!pointInPolygonsOrOn(mid, area)) {
          flush()
          continue
        }
        if (!current) {
          current = [{ x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 }]
        }
        current.push({ x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 })
      }
    }
    flush()
  }
  return out
}

// ---------------------------------------------------------------------------
// Lines-family engine (lines / grid / triangles / cubic)
// ---------------------------------------------------------------------------

interface LineSet {
  angleRad: number
  /** Perpendicular offset of the whole set, microns (used by cubic). */
  shift: number
}

/**
 * Scanline y positions: anchored to the shape bounds and offset by half a
 * spacing so the pattern stays centred and deterministic.
 */
function scanlineYs(minY: number, maxY: number, spacing: number, shift: number): number[] {
  const ys: number[] = []
  for (let y = minY + spacing / 2 + shift; y <= maxY; y += spacing) ys.push(y)
  return ys
}

function generateLines(
  area: Polygon[],
  spacing: number,
  sets: LineSet[],
): { clipped: Polyline[]; raw: Polyline[] } {
  const clipped: Polyline[] = []
  const raw: Polyline[] = []
  for (const set of sets) {
    const cos = Math.cos(set.angleRad)
    const sin = Math.sin(set.angleRad)
    // Rotate by -angle so the pattern lines become horizontal scanlines.
    const rotated = area.map((p) => rotatePolygon(p, cos, -sin))
    const b = polygonsBounds(rotated)
    for (const y of scanlineYs(b.minY, b.maxY, spacing, set.shift)) {
      raw.push([
        rotatePoint({ x: b.minX, y }, cos, sin),
        rotatePoint({ x: b.maxX, y }, cos, sin),
      ])
      for (const [x0, x1] of polygonsScanlineSegments(rotated, y)) {
        clipped.push([
          rotatePoint({ x: x0, y }, cos, sin),
          rotatePoint({ x: x1, y }, cos, sin),
        ])
      }
    }
  }
  return { clipped, raw }
}

/**
 * Lines connected end-to-end at alternating ends (serpentine). Connectors hug
 * the boundary; if a connector would leave the part (e.g. across a hole) the
 * chain is broken and a new polyline starts.
 */
function generateZigzag(area: Polygon[], spacing: number, angleRad: number): Polyline[] {
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  const rotated = area.map((p) => rotatePolygon(p, cos, -sin))
  const b = polygonsBounds(rotated)
  const out: Polyline[] = []
  let current: Polyline = []
  let flip = false
  for (const y of scanlineYs(b.minY, b.maxY, spacing, 0)) {
    const segs = polygonsScanlineSegments(rotated, y)
    if (flip) segs.reverse()
    for (const [x0, x1] of segs) {
      const start = flip ? { x: x1, y } : { x: x0, y }
      const end = flip ? { x: x0, y } : { x: x1, y }
      if (current.length === 0) {
        current = [start]
      } else {
        const prev = current[current.length - 1]
        const mid = { x: (prev.x + start.x) / 2, y: (prev.y + start.y) / 2 }
        if (pointInPolygonsOrOn(mid, rotated)) current.push(start)
        else {
          out.push(current)
          current = [start]
        }
      }
      current.push(end)
    }
    if (segs.length > 0) flip = !flip
  }
  if (current.length > 0) out.push(current)
  return out.map((line) => line.map((p) => rotatePoint(p, cos, sin)))
}

// ---------------------------------------------------------------------------
// Honeycomb
// ---------------------------------------------------------------------------

/**
 * Regular hexagonal tiling clipped to the area. Shared edges are emitted only
 * once (deduplicated by quantized vertex keys).
 */
function generateHoneycomb(
  area: Polygon[],
  side: number,
  angleRad: number,
): { clipped: Polyline[]; raw: Polyline[] } {
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  const rotated = area.map((p) => rotatePolygon(p, cos, -sin))
  const b = polygonsBounds(rotated)
  const rowH = Math.sqrt(3) * side
  const colW = 1.5 * side
  const vkey = (p: Point) => `${Math.round(p.x * 1024)},${Math.round(p.y * 1024)}`
  const edges = new Map<string, [Point, Point]>()
  const minI = Math.floor((b.minX - 2 * side) / colW)
  const maxI = Math.ceil((b.maxX + 2 * side) / colW)
  const minJ = Math.floor((b.minY - 2 * side) / rowH)
  const maxJ = Math.ceil((b.maxY + 2 * side) / rowH)
  for (let i = minI; i <= maxI; i++) {
    for (let j = minJ; j <= maxJ; j++) {
      const cx = i * colW
      const cy = j * rowH + (i % 2 !== 0 ? rowH / 2 : 0)
      if (cx < b.minX - 2 * side || cx > b.maxX + 2 * side) continue
      if (cy < b.minY - 2 * side || cy > b.maxY + 2 * side) continue
      const verts: Point[] = []
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k
        verts.push({ x: cx + side * Math.cos(a), y: cy + side * Math.sin(a) })
      }
      for (let k = 0; k < 6; k++) {
        const p = verts[k]
        const q = verts[(k + 1) % 6]
        const key = [vkey(p), vkey(q)].sort().join('|')
        if (!edges.has(key)) edges.set(key, [p, q])
      }
    }
  }
  const rawRotated = [...edges.values()].map(([p, q]) => [p, q])
  const clippedRotated = clipPolylinesToPolygons(rawRotated, rotated)
  const back = (lines: Polyline[]) => lines.map((l) => l.map((p) => rotatePoint(p, cos, sin)))
  return { clipped: back(clippedRotated), raw: back(rawRotated) }
}

// ---------------------------------------------------------------------------
// Gyroid (implicit field + marching squares)
// ---------------------------------------------------------------------------

/**
 * Zero level-set of a gyroid field. The naive 2D reduction
 * sin(kx)cos(ky) + sin(ky)cos(kx) collapses to sin(k(x+y)) — straight parallel
 * lines — so instead we slice the true 3D gyroid field
 * sin(X)cos(Y) + sin(Y)cos(Z) + sin(Z)cos(X) at a fixed Z = PI/4.
 */
function gyroidField(k: number): (x: number, y: number) => number {
  const sz = Math.sin(Math.PI / 4)
  const cz = Math.cos(Math.PI / 4)
  return (x, y) =>
    Math.sin(k * x) * Math.cos(k * y) + cz * Math.sin(k * y) + sz * Math.cos(k * x)
}

/** Standard 16-case marching squares with linear interpolation on the zero crossing. */
function marchingSquares(b: AABB, period: number, field: (x: number, y: number) => number): Polyline[] {
  const cell = period / 20
  const nx = Math.max(2, Math.ceil((b.maxX - b.minX) / cell) + 1)
  const ny = Math.max(2, Math.ceil((b.maxY - b.minY) / cell) + 1)
  const dx = (b.maxX - b.minX) / (nx - 1)
  const dy = (b.maxY - b.minY) / (ny - 1)
  const val = new Float64Array(nx * ny)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      val[j * nx + i] = field(b.minX + i * dx, b.minY + j * dy)
    }
  }

  // Each zero crossing lives on a grid edge and is shared by the two adjacent
  // cells, which lets segments stitch into polylines by node id.
  const nodePoint: Point[] = []
  const hId = new Int32Array((nx - 1) * ny).fill(-1) // edge (i,j)-(i+1,j)
  const vId = new Int32Array(nx * (ny - 1)).fill(-1) // edge (i,j)-(i,j+1)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const f0 = val[j * nx + i]
      const f1 = val[j * nx + i + 1]
      if (f0 > 0 === f1 > 0) continue
      const t = f0 / (f0 - f1)
      hId[j * (nx - 1) + i] = nodePoint.length
      nodePoint.push({ x: b.minX + (i + t) * dx, y: b.minY + j * dy })
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny - 1; j++) {
      const f0 = val[j * nx + i]
      const f1 = val[(j + 1) * nx + i]
      if (f0 > 0 === f1 > 0) continue
      const t = f0 / (f0 - f1)
      vId[i * (ny - 1) + j] = nodePoint.length
      nodePoint.push({ x: b.minX + i * dx, y: b.minY + (j + t) * dy })
    }
  }

  const segments: [number, number][] = []
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const fA = val[j * nx + i] // bottom-left
      const fB = val[j * nx + i + 1] // bottom-right
      const fC = val[(j + 1) * nx + i + 1] // top-right
      const fD = val[(j + 1) * nx + i] // top-left
      let idx = 0
      if (fA > 0) idx |= 1
      if (fB > 0) idx |= 2
      if (fC > 0) idx |= 4
      if (fD > 0) idx |= 8
      if (idx === 0 || idx === 15) continue
      const e0 = hId[j * (nx - 1) + i] // bottom
      const e1 = vId[(i + 1) * (ny - 1) + j] // right
      const e2 = hId[(j + 1) * (nx - 1) + i] // top
      const e3 = vId[i * (ny - 1) + j] // left
      const link = (u: number, v: number) => {
        if (u >= 0 && v >= 0) segments.push([u, v])
      }
      switch (idx) {
        case 1:
        case 14:
          link(e3, e0)
          break
        case 2:
        case 13:
          link(e0, e1)
          break
        case 3:
        case 12:
          link(e3, e1)
          break
        case 4:
        case 11:
          link(e1, e2)
          break
        case 6:
        case 9:
          link(e0, e2)
          break
        case 7:
        case 8:
          link(e3, e2)
          break
        case 5: {
          // Saddle: decide from the centre value which corners connect.
          const c = field(b.minX + (i + 0.5) * dx, b.minY + (j + 0.5) * dy)
          if (c > 0) {
            link(e0, e1)
            link(e2, e3)
          } else {
            link(e3, e0)
            link(e1, e2)
          }
          break
        }
        case 10: {
          const c = field(b.minX + (i + 0.5) * dx, b.minY + (j + 0.5) * dy)
          if (c > 0) {
            link(e0, e3)
            link(e1, e2)
          } else {
            link(e0, e1)
            link(e2, e3)
          }
          break
        }
      }
    }
  }

  // Stitch segments into polylines: open chains from degree-1 nodes, then cycles.
  const adj: number[][] = nodePoint.map(() => [])
  segments.forEach(([u, v], si) => {
    adj[u].push(si)
    adj[v].push(si)
  })
  const used = new Uint8Array(segments.length)
  const out: Polyline[] = []
  const walk = (si: number, from: number) => {
    const [u, v] = segments[si]
    let cur = from === u ? v : u
    const line: Polyline = [nodePoint[from], nodePoint[cur]]
    used[si] = 1
    for (;;) {
      const next = adj[cur].find((s) => !used[s])
      if (next === undefined) break
      used[next] = 1
      const [a, bb] = segments[next]
      cur = a === cur ? bb : a
      line.push(nodePoint[cur])
    }
    return line
  }
  for (let n = 0; n < adj.length; n++) {
    if (adj[n].length !== 1) continue
    const si = adj[n].find((s) => !used[s])
    if (si !== undefined) out.push(walk(si, n))
  }
  for (let si = 0; si < segments.length; si++) {
    if (!used[si]) out.push(walk(si, segments[si][0]))
  }
  return out
}

function generateGyroid(
  area: Polygon[],
  params: InfillParams,
  density: number,
): { clipped: Polyline[]; raw: Polyline[] } {
  const angleRad = (params.angle * Math.PI) / 180
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  const rotated = area.map((p) => rotatePolygon(p, cos, -sin))
  const b = polygonsBounds(rotated)
  const period = (GYROID_PERIOD_FACTOR * params.lineWidth) / density
  const padded: AABB = {
    minX: b.minX - period,
    minY: b.minY - period,
    maxX: b.maxX + period,
    maxY: b.maxY + period,
  }
  const field = gyroidField((2 * Math.PI) / period)
  const rawRotated = marchingSquares(padded, period, field)
  const clippedRotated = clipPolylinesToPolygons(rawRotated, rotated)
  const back = (lines: Polyline[]) => lines.map((l) => l.map((p) => rotatePoint(p, cos, sin)))
  return { clipped: back(clippedRotated), raw: back(rawRotated) }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function decimate(lines: Polyline[]): Polyline[] {
  if (lines.length <= MAX_RAW_LINES) return lines
  const stride = Math.ceil(lines.length / MAX_RAW_LINES)
  return lines.filter((_, i) => i % stride === 0)
}

export function generateInfill(area: Polygon[], params: InfillParams): InfillResult {
  const { pattern, lineWidth } = params
  const density = Math.min(1, Math.max(0, params.density))
  if (area.length === 0 || density <= 0 || lineWidth <= 0) return { lines: [], rawLines: [] }
  const angleRad = (params.angle * Math.PI) / 180
  const toExtrusion = (lines: Polyline[]): ExtrusionLine[] =>
    lines.map((line) => line.map((p) => ({ p, w: lineWidth })))

  let clipped: Polyline[]
  let raw: Polyline[]
  switch (pattern) {
    case 'lines':
    case 'grid':
    case 'triangles':
    case 'cubic': {
      // n directions each spaced n * lineWidth / density apart, so the
      // combined density stays `density` regardless of the pattern.
      const nDir = pattern === 'lines' ? 1 : pattern === 'grid' ? 2 : 3
      const spacing = (lineWidth * nDir) / density
      const sets: LineSet[] = [{ angleRad, shift: 0 }]
      if (pattern === 'grid' || pattern === 'cubic') {
        sets.push({ angleRad: angleRad + Math.PI / 2, shift: 0 })
      }
      if (pattern === 'triangles') {
        sets.push({ angleRad: angleRad + Math.PI / 3, shift: 0 })
        sets.push({ angleRad: angleRad + (2 * Math.PI) / 3, shift: 0 })
      }
      if (pattern === 'cubic') sets.push({ angleRad, shift: spacing / 2 })
      const r = generateLines(area, spacing, sets)
      clipped = r.clipped
      raw = r.raw
      break
    }
    case 'zigzag': {
      const spacing = lineWidth / density
      clipped = generateZigzag(area, spacing, angleRad)
      raw = generateLines(area, spacing, [{ angleRad, shift: 0 }]).raw
      break
    }
    case 'honeycomb': {
      // A hex tiling carries 2/(sqrt(3)*side) line length per unit area;
      // pick the side so extruded area matches the requested density.
      const side = (2 * lineWidth) / (Math.sqrt(3) * density)
      const r = generateHoneycomb(area, side, angleRad)
      clipped = r.clipped
      raw = r.raw
      break
    }
    case 'gyroid': {
      const r = generateGyroid(area, params, density)
      clipped = r.clipped
      raw = r.raw
      break
    }
  }
  return { lines: toExtrusion(clipped), rawLines: decimate(raw) }
}
