import { offset, pointInPolygons } from '../geometry/clipper'
import { dist, polylineLength } from '../geometry/polyUtils'
import type {
  ExtrusionLine,
  OrderedMove,
  Point,
  Polygon,
  Polyline,
  StageDoc,
  TravelInfo,
} from './types'

export const travelDoc: StageDoc = {
  title: 'Travel & combing',
  explanation: `## The idea
Between extrusions the nozzle travels without printing, and a moving nozzle always oozes a little. Combing keeps travel inside the model so ooze lands on already-printed plastic instead of scarring the visible surface.

## Step by step
1. Build the combing road: \`offset(outline, -(combingInset + avoidDistance))\` — the interior minus the wall band and nozzle clearance.
2. If the straight move stays inside the combing area, use it directly — the cheapest combed travel there is.
3. Otherwise find where the move exits and re-enters the combing boundary, and walk along that boundary between the crossings, picking the direction with fewer boundary vertices (ties broken by length).
4. Iteratively drop detour vertices whose shortcut chord stays inside the area.
5. When no inside route exists — for example between two separate parts — the travel simply crosses open air.
6. Decide retraction and Z-hop per move:

### Retraction & Z-hop rules
- \`retract = goesOutside || length > retractionMinDistance\`
- \`zHop = retract && zHopEnabled && goesOutside\` — hopping only makes sense when the nozzle actually leaves the model
- straight combed moves: \`retract = length > retractionMinDistance\`, never z-hop

## Edge cases & simplifications
- Boundary detours work only within a single ring; travel between separate parts always crosses the air.
- Inside/outside tests sample segments every ~\`combingInset / 2\` microns, with a 10 µm boundary tolerance.

## Try it
- C shape preset → stage 6: toggle **Combing** and watch the detour around the notch collapse into a straight ooze line.
- Two parts preset → enable **Z-hop**: triangle markers appear where the nozzle hops between parts.
- Lower \`retractionMinDistance\`: circle markers appear on more travels.`,
  curaRef: 'src/pathPlanning/Comb.cpp, src/LayerPlan.cpp',
  refs: [
    {
      label: 'CuraEngine wiki: Generating Paths',
      url: 'https://github.com/Ultimaker/CuraEngine/wiki/Generating-Paths',
    },
  ],
}

export interface TravelParams {
  combing: boolean
  combingInset: number // microns; boundary inset used as the combing "road" (Cura combs just inside the walls)
  avoidDistance: number // microns; nozzle clearance when avoiding walls
  retractionMinDistance: number // travels longer than this retract
  zHopEnabled: boolean
}

// Sampling tolerance: points sitting on the comb boundary still count as inside.
const BOUNDARY_TOLERANCE = 10

/** Sample a segment every ~spacing microns; true when every sample is inside `area`. */
function segmentInsideArea(a: Point, b: Point, area: Polygon[], spacing: number): boolean {
  const len = dist(a, b)
  const n = Math.max(1, Math.ceil(len / spacing))
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    if (!pointInPolygons(p, area)) return false
  }
  return true
}

function pathInsideArea(path: Polyline, area: Polygon[], spacing: number): boolean {
  for (let i = 1; i < path.length; i++) {
    if (!segmentInsideArea(path[i - 1], path[i], area, spacing)) return false
  }
  return true
}

interface Crossing {
  t: number // parameter along the from->to segment
  p: Point
  poly: number
  hole: number // -1 for the outer ring
  edge: number // index of the ring edge crossed
}

/** Intersections of the from->to segment with every ring of `polys`, sorted along the segment. */
function segmentRingCrossings(from: Point, to: Point, polys: Polygon[]): Crossing[] {
  const out: Crossing[] = []
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return out
  const crossRing = (ring: Point[], poly: number, hole: number) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      const ex = b.x - a.x
      const ey = b.y - a.y
      const denom = dx * ey - dy * ex
      if (denom === 0) continue // parallel
      const t = ((a.x - from.x) * ey - (a.y - from.y) * ex) / denom
      const u = ((a.x - from.x) * dy - (a.y - from.y) * dx) / denom
      if (t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u <= 1) {
        out.push({ t, p: { x: from.x + t * dx, y: from.y + t * dy }, poly, hole, edge: i })
      }
    }
  }
  polys.forEach((poly, pi) => {
    crossRing(poly.outer, pi, -1)
    poly.holes.forEach((h, hi) => crossRing(h, pi, hi))
  })
  return out.sort((p, q) => p.t - q.t)
}

/** Iteratively drop vertices whose shortcut chord stays inside `area`. */
function shortcut(path: Polyline, area: Polygon[], spacing: number): Polyline {
  let current = path
  for (let iter = 0; iter < 10; iter++) {
    let changed = false
    const out: Polyline = [current[0]]
    for (let i = 1; i < current.length - 1; i++) {
      if (segmentInsideArea(out[out.length - 1], current[i + 1], area, spacing)) {
        changed = true // skip current[i]
      } else {
        out.push(current[i])
      }
    }
    out.push(current[current.length - 1])
    current = out
    if (!changed) break
  }
  return current
}

function dedupe(path: Polyline): Polyline {
  const out: Polyline = []
  for (const p of path) {
    if (out.length === 0 || dist(out[out.length - 1], p) > 1) out.push(p)
  }
  return out
}

/**
 * Detour along the comb-area boundary between the points where the straight move
 * exits and re-enters it. Returns undefined when no single-ring detour exists
 * (endpoints outside the comb area, or crossings on different rings/parts).
 */
function combAlongBoundary(
  from: Point,
  to: Point,
  combArea: Polygon[],
  combTol: Polygon[],
  spacing: number,
): Polyline | undefined {
  const crossings = segmentRingCrossings(from, to, combArea)
  if (crossings.length < 2) return undefined

  // Locate the outside intervals along the segment by midpoint sampling.
  const bounds = [0, ...crossings.map((c) => c.t), 1]
  let firstOut = -1
  let lastOut = -1
  for (let i = 0; i < bounds.length - 1; i++) {
    const tm = (bounds[i] + bounds[i + 1]) / 2
    const p = { x: from.x + (to.x - from.x) * tm, y: from.y + (to.y - from.y) * tm }
    if (!pointInPolygons(p, combTol)) {
      if (firstOut < 0) firstOut = i
      lastOut = i
    }
  }
  if (firstOut < 0) return [from, to]
  // An endpoint outside the comb area means there is no boundary crossing to start from.
  if (firstOut === 0 || lastOut === bounds.length - 2) return undefined

  const exit = crossings[firstOut - 1]
  const enter = crossings[lastOut]
  if (exit.poly !== enter.poly || exit.hole !== enter.hole) return undefined // different parts

  const ring =
    exit.hole < 0 ? combArea[exit.poly].outer : combArea[exit.poly].holes[exit.hole]
  const n = ring.length

  // Two arcs connect the crossings; Cura walks the one with fewer boundary vertices.
  const fwdCount = (enter.edge - exit.edge + n) % n
  const bwdCount = (exit.edge - enter.edge + n) % n
  const fwd: Point[] = []
  for (let k = 1; k <= fwdCount; k++) fwd.push(ring[(exit.edge + k) % n])
  const bwd: Point[] = []
  for (let k = 0; k < bwdCount; k++) bwd.push(ring[(exit.edge - k + n) % n])
  let verts = fwd
  if (bwdCount < fwdCount) {
    verts = bwd
  } else if (bwdCount === fwdCount) {
    const lenOf = (v: Point[]) =>
      polylineLength([exit.p, ...v, enter.p])
    if (lenOf(bwd) < lenOf(fwd)) verts = bwd
  }

  const path = dedupe([from, exit.p, ...verts, enter.p, to])
  return shortcut(path, combTol, spacing)
}

export function computeTravel(
  from: Point,
  to: Point,
  outline: Polygon[],
  params: TravelParams,
): TravelInfo & { path: Polyline } {
  const spacing = Math.max(params.combingInset / 2, 1)
  const outlineTol = offset(outline, BOUNDARY_TOLERANCE)

  const finish = (path: Polyline, combed: boolean): TravelInfo & { path: Polyline } => {
    const goesOutside = !pathInsideArea(path, outlineTol, spacing)
    const retract = goesOutside || polylineLength(path) > params.retractionMinDistance
    return { path, combed, goesOutside, retract, zHop: retract && params.zHopEnabled && goesOutside }
  }

  if (!params.combing) {
    return finish([from, to], false)
  }

  // The combing road: model interior minus the wall band and the avoid clearance.
  const combArea = offset(outline, -(params.combingInset + params.avoidDistance))
  if (combArea.length > 0) {
    const combTol = offset(combArea, BOUNDARY_TOLERANCE)
    if (segmentInsideArea(from, to, combTol, spacing)) {
      // Straight move stays inside: the cheapest combed travel there is.
      const path: Polyline = [from, to]
      const retract = polylineLength(path) > params.retractionMinDistance
      return { path, combed: true, goesOutside: false, retract, zHop: false }
    }
    const detour = combAlongBoundary(from, to, combArea, combTol, spacing)
    if (detour) return finish(detour, true)
  }

  // No inside route (combing impossible or separate parts): cross the air.
  return finish([from, to], false)
}

function lineStart(line: ExtrusionLine | Polyline): Point {
  const first = line[0]
  return 'p' in first ? first.p : first
}

function lineEnd(line: ExtrusionLine | Polyline): Point {
  const last = line[line.length - 1]
  return 'p' in last ? last.p : last
}

/**
 * Insert travel moves between consecutive extrusion moves. No travel is emitted
 * before the first move; the input is expected to be extrusion moves as produced
 * by orderLayerPaths.
 */
export function insertTravels(
  moves: OrderedMove[],
  outline: Polygon[],
  params: TravelParams,
): OrderedMove[] {
  const out: OrderedMove[] = []
  for (const move of moves) {
    const prev = out[out.length - 1]
    if (prev && prev.kind === 'extrusion' && move.kind === 'extrusion') {
      const info = computeTravel(lineEnd(prev.line), lineStart(move.line), outline, params)
      const { path, ...travel } = info
      out.push({ kind: 'travel', feature: 'travel', line: path, travel })
    }
    out.push(move)
  }
  return out
}
