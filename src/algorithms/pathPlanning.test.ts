import { beforeAll, describe, expect, it } from 'vitest'
import { initClipper, pointInPolygons } from '../geometry/clipper'
import { dist, polylineLength } from '../geometry/polyUtils'
import type { Point, Polygon, Polyline } from '../geometry/types'
import { computeMetrics } from './metrics'
import { orderLayerPaths } from './pathOrder'
import { computeTravel, insertTravels, type TravelParams } from './travel'
import type { ExtrusionLine, FeaturePaths, OrderedMove } from './types'

const square = (cx: number, cy: number, size: number): Polygon => ({
  outer: [
    { x: cx - size / 2, y: cy - size / 2 },
    { x: cx + size / 2, y: cy - size / 2 },
    { x: cx + size / 2, y: cy + size / 2 },
    { x: cx - size / 2, y: cy + size / 2 },
  ],
  holes: [],
})

const line = (pts: [number, number][], w = 400): ExtrusionLine =>
  pts.map(([x, y]) => ({ p: { x, y }, w }))

const junctions = (move: OrderedMove): ExtrusionLine => move.line as ExtrusionLine

const travelOf = (moves: OrderedMove[], start: Point): number => {
  let total = 0
  let pos = start
  for (const m of moves) {
    const pts = junctions(m)
    total += dist(pos, pts[0].p)
    pos = pts[pts.length - 1].p
  }
  return total
}

beforeAll(async () => {
  await initClipper()
})

describe('orderLayerPaths', () => {
  it('greedily picks the nearest line first and beats the naive given order', () => {
    // 5 parallel 10 mm lines, 2 mm apart, all drawn left-to-right.
    const features: FeaturePaths[] = [
      {
        kind: 'infill',
        lines: [0, 1, 2, 3, 4].map((i) => line([[0, i * 2000], [10000, i * 2000]])),
      },
    ]
    const start = { x: 5000, y: -5000 }
    const result = orderLayerPaths(features, start)
    expect(result.moves).toHaveLength(5)
    // Nearest candidate to the start point is the y = 0 line.
    expect(junctions(result.moves[0])[0].p.y).toBe(0)
    // Greedy travel never exceeds printing the lines in the order given.
    const naive: OrderedMove[] = features[0].lines.map((l) => ({
      kind: 'extrusion',
      feature: 'infill',
      line: l,
    }))
    expect(travelOf(result.moves, start)).toBeLessThanOrEqual(travelOf(naive, start))
    // One OrderStep per choice, tracing the candidates that remained.
    expect(result.steps).toHaveLength(5)
    expect(result.steps[0].candidateDistances).toHaveLength(5)
    expect(result.steps[4].candidateDistances).toHaveLength(1)
  })

  it('reverses an open line when its far end is nearer', () => {
    const features: FeaturePaths[] = [
      {
        kind: 'infill',
        lines: [line([[0, 0], [10000, 0]]), line([[0, 5000], [10000, 5000]])],
      },
    ]
    const result = orderLayerPaths(features, { x: 10000, y: 1000 })
    const first = junctions(result.moves[0])
    expect(first[0].p).toEqual({ x: 10000, y: 0 })
    expect(first[first.length - 1].p).toEqual({ x: 0, y: 0 })
  })

  it('prints infill before the outer wall even when the wall is nearer', () => {
    const features: FeaturePaths[] = [
      { kind: 'outer-wall', lines: [line([[1000, 0], [2000, 0]])] },
      { kind: 'infill', lines: [line([[50000, 0], [60000, 0]])] },
    ]
    const result = orderLayerPaths(features, { x: 0, y: 0 })
    expect(result.moves[0].feature).toBe('infill')
    expect(result.moves[1].feature).toBe('outer-wall')
  })

  it('rotates a closed ring to start at the nearest vertex instead of reversing', () => {
    const ring = line([
      [10000, 10000],
      [10000, 0],
      [0, 0],
      [0, 10000],
      [10000, 10000], // closed: first point repeated
    ])
    const result = orderLayerPaths([{ kind: 'outer-wall', lines: [ring] }], { x: -1000, y: -1000 })
    const printed = junctions(result.moves[0])
    expect(printed[0].p).toEqual({ x: 0, y: 0 })
    expect(printed[printed.length - 1].p).toEqual({ x: 0, y: 0 })
    // Ring direction preserved: the vertex after (0,0) is (0,10000), not (10000,0).
    expect(printed[1].p).toEqual({ x: 0, y: 10000 })
  })
})

describe('computeTravel', () => {
  const params: TravelParams = {
    combing: true,
    combingInset: 1000,
    avoidDistance: 500,
    retractionMinDistance: 15000,
    zHopEnabled: true,
  }

  it('travels straight inside a square, combed, without retracting a short move', () => {
    const outline = [square(10000, 10000, 20000)]
    const t = computeTravel({ x: 5000, y: 5000 }, { x: 15000, y: 5000 }, outline, params)
    expect(t.path).toHaveLength(2)
    expect(t.combed).toBe(true)
    expect(t.goesOutside).toBe(false)
    expect(t.retract).toBe(false) // 10 mm < 15 mm retractionMinDistance
    expect(t.zHop).toBe(false)
  })

  it('crosses open air between separate parts, with or without combing', () => {
    // Two 10 mm squares, 10 mm apart.
    const outline = [square(5000, 5000, 10000), square(25000, 5000, 10000)]
    const from = { x: 5000, y: 5000 }
    const to = { x: 25000, y: 5000 }

    const off = computeTravel(from, to, outline, { ...params, combing: false })
    expect(off.path).toEqual([from, to])
    expect(off.combed).toBe(false)
    expect(off.goesOutside).toBe(true)
    expect(off.retract).toBe(true)
    expect(off.zHop).toBe(true)

    // Combing cannot help across air between parts; the nozzle still goes outside.
    const on = computeTravel(from, to, outline, params)
    expect(on.goesOutside).toBe(true)
    expect(on.retract).toBe(true)
  })

  it('combs around the notch of a concave C-shape, staying inside the outline', () => {
    // C opening to the right: spine x in [0,8000], arms y in [0,8000] and [12000,20000].
    const cShape: Polygon = {
      outer: [
        { x: 0, y: 0 },
        { x: 20000, y: 0 },
        { x: 20000, y: 8000 },
        { x: 8000, y: 8000 },
        { x: 8000, y: 12000 },
        { x: 20000, y: 12000 },
        { x: 20000, y: 20000 },
        { x: 0, y: 20000 },
      ],
      holes: [],
    }
    const from = { x: 16000, y: 16000 } // top tip
    const to = { x: 16000, y: 4000 } // bottom tip

    // The straight line between the tips exits the outline through the notch.
    const straight = computeTravel(from, to, [cShape], { ...params, combing: false })
    expect(straight.goesOutside).toBe(true)

    const combed = computeTravel(from, to, [cShape], { ...params, retractionMinDistance: 100000 })
    expect(combed.combed).toBe(true)
    expect(combed.goesOutside).toBe(false)
    expect(combed.retract).toBe(false)
    expect(polylineLength(combed.path)).toBeGreaterThan(dist(from, to))

    // Densely sample the returned path: every point must stay inside the outline.
    const sampled: Polyline = []
    for (let i = 1; i < combed.path.length; i++) {
      const a = combed.path[i - 1]
      const b = combed.path[i]
      const n = Math.max(1, Math.ceil(dist(a, b) / 250))
      for (let k = 0; k <= n; k++) {
        sampled.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n })
      }
    }
    for (const p of sampled) {
      expect(pointInPolygons(p, [cShape])).toBe(true)
    }
  })
})

describe('insertTravels', () => {
  const params: TravelParams = {
    combing: true,
    combingInset: 400,
    avoidDistance: 200,
    retractionMinDistance: 1500,
    zHopEnabled: false,
  }

  it('inserts a travel move between extrusions, never before the first move', () => {
    const outline = [square(10000, 10000, 20000)]
    const moves: OrderedMove[] = [
      { kind: 'extrusion', feature: 'infill', line: line([[2000, 2000], [8000, 2000]]) },
      { kind: 'extrusion', feature: 'infill', line: line([[8000, 4000], [2000, 4000]]) },
      { kind: 'extrusion', feature: 'infill', line: line([[2000, 6000], [8000, 6000]]) },
    ]
    const out = insertTravels(moves, outline, params)
    expect(out).toHaveLength(5)
    expect(out[0].kind).toBe('extrusion')
    expect(out[1].kind).toBe('travel')
    expect(out[3].kind).toBe('travel')
    const travel = out[1].line as Polyline
    expect(travel[0]).toEqual({ x: 8000, y: 2000 })
    expect(travel[travel.length - 1]).toEqual({ x: 8000, y: 4000 })
    expect(out[1].travel).toEqual({ combed: true, goesOutside: false, retract: true, zHop: false })
  })
})

describe('computeMetrics', () => {
  it('computes exact lengths for a known toolpath', () => {
    const outline = [square(5000, 5000, 10000)] // [0, 10000]^2
    const moves: OrderedMove[] = [
      // Extrusion: 3000 + 4000 = 7000 microns.
      { kind: 'extrusion', feature: 'infill', line: line([[0, 0], [3000, 0], [3000, 4000]]) },
      // Travel: 10000 microns along x = 3000; y > 10000 is outside the outline (4000 microns).
      {
        kind: 'travel',
        feature: 'travel',
        line: [
          { x: 3000, y: 4000 },
          { x: 3000, y: 14000 },
        ],
        travel: { combed: false, goesOutside: true, retract: true, zHop: false },
      },
    ]
    const gaps = [square(1000, 1000, 2000)] // 4 mm^2
    const m = computeMetrics(moves, gaps, outline, { printSpeed: 5000, travelSpeed: 10000 })
    expect(m.extrusionLength).toBeCloseTo(7000)
    expect(m.travelLength).toBeCloseTo(10000)
    expect(m.travelOutsideLength).toBeCloseTo(4000)
    expect(m.gapArea).toBeCloseTo(4_000_000)
    expect(m.estimatedTimeS).toBeCloseTo(7000 / 5000 + 10000 / 10000) // 2.4 s
  })
})
