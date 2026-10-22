import { pointInPolygons } from '../geometry/clipper'
import { dist, polygonArea, polylineLength } from '../geometry/polyUtils'
import type {
  ExtrusionLine,
  LayerMetrics,
  OrderedMove,
  Polygon,
  Polyline,
  StageDoc,
} from './types'

export const metricsDoc: StageDoc = {
  title: 'Layer metrics',
  explanation: `## The idea
Turn a planned layer into numbers that explain print quality and cost — how much plastic, how much travel overhead, how long it takes — precise enough to compare two plannings of the same layer.

## Step by step
1. Walk the ordered moves: extrusion moves add their polyline length to \`extrusionLength\`, travel moves to \`travelLength\`.
2. Each travel segment is split into ~1 mm sub-segments; every sub-segment whose midpoint lies outside the outline adds its length to \`travelOutsideLength\`.
3. \`gapArea\` sums the area of the regions the wall generator could not fill.
4. The time estimate combines the lengths with the configured speeds.

## The metrics
- \`extrusionLength\` — total printed length; with line width and layer height it sets how much filament the layer consumes.
- \`travelLength\` — total non-printing motion: pure overhead that adds time and oozing risk without laying down plastic.
- \`travelOutsideLength\` — travel spent outside the model outline, where a leaking nozzle leaves strings and blobs on the visible surface.
- \`gapArea\` — unfilled area inside the wall band; flags where gap fill or a thinner line width is needed.
- \`estimatedTimeS\` — rough duration estimate in seconds.

## Key formulas / rules
- \`estimatedTimeS = extrusionLength / printSpeed + travelLength / travelSpeed\`
- \`travelOutsideLength\`: ~1 mm midpoint sampling instead of exact segment/polygon clipping

## Edge cases & simplifications
- No acceleration or jerk limits: real firmware slows far below nominal speed in corners, so the estimate is optimistic.
- Outside-travel measurement is a sampling approximation, accurate to about the 1 mm sample length.

## Try it
- Thin wedge preset → **Compare**: gap area collapses under Arachne.
- Stage 6: raise \`travelSpeed\` and watch the estimated time drop; toggle **Combing** on the C shape and watch outside travel change.`,
  curaRef: 'src/LayerPlan.cpp',
  refs: [
    {
      label: 'CuraEngine wiki: Generating Paths',
      url: 'https://github.com/Ultimaker/CuraEngine/wiki/Generating-Paths',
    },
  ],
}

export interface MetricsParams {
  printSpeed: number // microns/s
  travelSpeed: number // microns/s
}

// Travel segments are split into sub-segments of roughly this length (microns)
// and each sub-segment's midpoint is tested against the outline.
const OUTSIDE_SAMPLE = 1000

function linePoints(line: ExtrusionLine | Polyline): Polyline {
  if (line.length === 0) return []
  return 'p' in line[0] ? (line as ExtrusionLine).map((j) => j.p) : (line as Polyline)
}

/** Length of the parts of a path whose ~1 mm sub-segment midpoints lie outside the outline. */
function outsideLength(points: Polyline, outline: Polygon[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const len = dist(a, b)
    if (len === 0) continue
    const n = Math.max(1, Math.round(len / OUTSIDE_SAMPLE))
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n
      const mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      if (!pointInPolygons(mid, outline)) total += len / n
    }
  }
  return total
}

export function computeMetrics(
  moves: OrderedMove[],
  gaps: Polygon[],
  modelOutline: Polygon[],
  params: MetricsParams,
): LayerMetrics {
  let extrusionLength = 0
  let travelLength = 0
  let travelOutsideLength = 0
  for (const move of moves) {
    const points = linePoints(move.line)
    if (move.kind === 'extrusion') {
      extrusionLength += polylineLength(points)
    } else {
      travelLength += polylineLength(points)
      travelOutsideLength += outsideLength(points, modelOutline)
    }
  }
  const gapArea = gaps.reduce((s, g) => s + polygonArea(g), 0)
  return {
    extrusionLength,
    travelLength,
    travelOutsideLength,
    gapArea,
    estimatedTimeS: extrusionLength / params.printSpeed + travelLength / params.travelSpeed,
  }
}
