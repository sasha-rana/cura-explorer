import type { ExtrusionJunction } from '../geometry/types'
import { dist, dist2 } from '../geometry/polyUtils'
import type {
  ExtrusionLine,
  FeatureKind,
  FeaturePaths,
  OrderedMove,
  Point,
  StageDoc,
} from './types'

export const pathOrderDoc: StageDoc = {
  title: 'Path ordering',
  explanation: `## The idea
Printing a layer's lines in the order that minimises travel is the Travelling Salesman Problem — NP-hard — so Cura uses a greedy nearest-neighbour heuristic constrained by a rigid feature order.

## Step by step
1. Features print in fixed order: infill → inner walls → outer wall → gap fill → skin. The outer wall defines the visible surface and must not be disturbed by later extrusions bumping into it.
2. Within a feature group, greedily pick the unprinted line whose nearest endpoint is closest to the current nozzle position — O(n^2).
3. Distance is acceleration-aware: a travel that continues in the direction of the just-printed segment keeps the toolhead's momentum, while doubling back forces a hard velocity reversal.
4. Open lines may be printed in either direction, so the greedy step reverses a line when its far end is nearer.
5. Closed rings (walls) are never reversed; the ring is rotated to start at the vertex nearest the nozzle — exactly how Cura chooses the seam position.
6. Every greedy decision is recorded as an OrderStep so the UI can step through the optimisation.

## Key formulas / rules
- \`effective = d * (1 - 0.5 * cos(θ))\` — θ is the angle between the last printed segment and the candidate travel; continuing straight halves the cost, a full reversal adds 50%.
- Feature order is never traded against distance; greedy runs only within a feature group.

## Edge cases & simplifications
- The decision trace stores only the 20 nearest remaining candidates per step.
- Lines whose endpoints are within 100 µm count as closed rings.

## Try it
- Any preset → stage 5 → toggle **Order numbers** and scrub **Step through** to watch the greedy choices move by move.
- Two parts preset: one part's walls finish before the nozzle travels to the other.`,
  curaRef: 'src/InsetOrderOptimizer.cpp, src/pathOrderOptimizer.h',
  refs: [
    {
      label: 'CuraEngine wiki: Generating Paths',
      url: 'https://github.com/Ultimaker/CuraEngine/wiki/Generating-Paths',
    },
  ],
}

export interface OrderStep {
  chosen: number // index into the flattened candidate list
  candidateDistances: number[] // weighted distance to each remaining candidate
  reason: 'nearest'
}

export interface OrderResult {
  moves: OrderedMove[] // extrusion moves only; travel is inserted by travel.ts
  steps: OrderStep[] // greedy decision trace for step-through visualization
}

// Cura's rigid feature order: infill, inner walls, outer wall, gap fill, skin.
const FEATURE_ORDER: FeatureKind[] = ['infill', 'inner-wall', 'outer-wall', 'gap-fill', 'skin']

// A line whose endpoints are this close (microns) is treated as a closed ring.
const CLOSED_EPSILON = 100

// The trace only stores the distances of the 20 nearest remaining candidates.
const MAX_TRACE_CANDIDATES = 20

interface Candidate {
  flatIndex: number
  feature: FeatureKind
  line: ExtrusionLine
  closed: boolean
}

export function isClosed(line: ExtrusionLine): boolean {
  return line.length > 2 && dist(line[0].p, line[line.length - 1].p) <= CLOSED_EPSILON
}

/**
 * Acceleration-aware distance: d * (1 - 0.5 * cos(theta)), where theta is the angle
 * between the last printed segment's direction and the travel move. Travel that
 * continues straight on (cos = 1) costs half; a full reversal (cos = -1) costs 1.5x.
 * This is our equivalent of Cura's |sin|-based smoothing preference.
 */
export function weightedDistance(d: number, lastDir: Point | undefined, from: Point, to: Point): number {
  if (!lastDir) return d
  const tx = to.x - from.x
  const ty = to.y - from.y
  const len = Math.hypot(tx, ty)
  if (len === 0) return d
  const cos = (lastDir.x * tx + lastDir.y * ty) / len
  return d * (1 - 0.5 * cos)
}

/** Rotate a closed ring so it starts (and ends) at vertex `vertex`; never reversed. */
export function rotateRing(line: ExtrusionLine, vertex: number): ExtrusionLine {
  const n = line.length - 1 // last point repeats the first
  const out: ExtrusionLine = []
  for (let k = 0; k < n; k++) out.push(line[(vertex + k) % n])
  out.push(line[vertex])
  return out
}

export function nearestVertex(pos: Point, line: ExtrusionLine): number {
  let best = 0
  let bestD2 = Infinity
  const n = line.length - 1
  for (let i = 0; i < n; i++) {
    const d2 = dist2(pos, line[i].p)
    if (d2 < bestD2) {
      bestD2 = d2
      best = i
    }
  }
  return best
}

export function orderLayerPaths(features: FeaturePaths[], startPoint: Point): OrderResult {
  // Flatten candidates in Cura's rigid feature order, keeping per-feature groups:
  // the feature order is never traded against distance; greedy runs within a group.
  const candidates: Candidate[] = []
  const groups: number[][] = []
  for (const kind of FEATURE_ORDER) {
    const group: number[] = []
    for (const feature of features) {
      if (feature.kind !== kind) continue
      for (const line of feature.lines) {
        if (line.length === 0) continue
        group.push(candidates.length)
        candidates.push({ flatIndex: candidates.length, feature: kind, line, closed: isClosed(line) })
      }
    }
    if (group.length > 0) groups.push(group)
  }

  const moves: OrderedMove[] = []
  const steps: OrderStep[] = []
  let pos = startPoint
  let lastDir: Point | undefined

  for (const group of groups) {
    const remaining = new Set(group)
    while (remaining.size > 0) {
      let best = -1
      let bestCost = Infinity
      let bestReverse = false
      let bestVertex = 0
      const costs: number[] = []

      for (const ci of remaining) {
        const c = candidates[ci]
        if (c.closed) {
          const v = nearestVertex(pos, c.line)
          const cost = weightedDistance(dist(pos, c.line[v].p), lastDir, pos, c.line[v].p)
          costs.push(cost)
          if (cost < bestCost) {
            bestCost = cost
            best = ci
            bestVertex = v
            bestReverse = false
          }
        } else {
          const first = c.line[0].p
          const last = c.line[c.line.length - 1].p
          const dFirst = weightedDistance(dist(pos, first), lastDir, pos, first)
          const dLast = weightedDistance(dist(pos, last), lastDir, pos, last)
          const cost = Math.min(dFirst, dLast)
          costs.push(cost)
          if (cost < bestCost) {
            bestCost = cost
            best = ci
            bestReverse = dLast < dFirst
            bestVertex = 0
          }
        }
      }

      const chosen = candidates[best]
      remaining.delete(best)
      let printed: ExtrusionLine
      if (chosen.closed) {
        printed = rotateRing(chosen.line, bestVertex)
      } else if (bestReverse) {
        printed = [...chosen.line].reverse()
      } else {
        printed = chosen.line
      }
      moves.push({ kind: 'extrusion', feature: chosen.feature, line: printed })
      steps.push({
        chosen: chosen.flatIndex,
        candidateDistances: costs.sort((a, b) => a - b).slice(0, MAX_TRACE_CANDIDATES),
        reason: 'nearest',
      })

      pos = printed[printed.length - 1].p
      if (printed.length > 1) {
        const prev: ExtrusionJunction = printed[printed.length - 2]
        const len = dist(prev.p, pos)
        lastDir = len > 0 ? { x: (pos.x - prev.p.x) / len, y: (pos.y - prev.p.y) / len } : undefined
      }
    }
  }

  return { moves, steps }
}
