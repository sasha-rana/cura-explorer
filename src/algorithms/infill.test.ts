import { beforeAll, describe, expect, it } from 'vitest'
import { initClipper, pointInRing } from '../geometry/clipper'
import { polygonArea, polylineLength } from '../geometry/polyUtils'
import type { Point, Polygon } from '../geometry/types'
import {
  clipPolylinesToPolygons,
  generateInfill,
  type InfillParams,
  type InfillPattern,
} from './infill'
import type { InfillResult } from './types'

const squareRing = (cx: number, cy: number, size: number): Point[] => [
  { x: cx - size / 2, y: cy - size / 2 },
  { x: cx + size / 2, y: cy - size / 2 },
  { x: cx + size / 2, y: cy + size / 2 },
  { x: cx - size / 2, y: cy + size / 2 },
]

const SQUARE: Polygon = { outer: squareRing(0, 0, 20_000), holes: [] }
const SQUARE_WITH_HOLE: Polygon = { outer: squareRing(0, 0, 20_000), holes: [squareRing(0, 0, 8000)] }

const ALL_PATTERNS: InfillPattern[] = [
  'lines',
  'zigzag',
  'grid',
  'triangles',
  'cubic',
  'honeycomb',
  'gyroid',
]

const params = (pattern: InfillPattern, density = 0.2, angle = 0): InfillParams => ({
  pattern,
  density,
  lineWidth: 400,
  angle,
})

function extrusionLength(result: InfillResult): number {
  let total = 0
  for (const line of result.lines) total += polylineLength(line.map((j) => j.p))
  return total
}

beforeAll(async () => {
  await initClipper()
})

describe('lines engine', () => {
  it('spacing follows lineWidth / density', () => {
    // density 0.2, lineWidth 400 -> spacing 2000 -> 10 scanlines on 20 mm
    const res = generateInfill([SQUARE], params('lines'))
    expect(res.lines.length).toBe(10)
    const ys = res.lines.map((l) => l[0].p.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i] - ys[i - 1]).toBeCloseTo(2000, 6)
    }
  })

  it('rotates the pattern by the requested angle', () => {
    const res = generateInfill([SQUARE], params('lines', 0.2, 45))
    expect(res.lines.length).toBeGreaterThan(5)
    for (const line of res.lines) {
      const dx = line[1].p.x - line[0].p.x
      const dy = line[1].p.y - line[0].p.y
      expect(Math.abs(Math.atan2(dy, dx))).toBeCloseTo(Math.PI / 4, 6)
    }
  })

  it('every junction carries the line width', () => {
    for (const pattern of ALL_PATTERNS) {
      const res = generateInfill([SQUARE], params(pattern))
      for (const line of res.lines) {
        for (const j of line) expect(j.w).toBe(400)
      }
    }
  })

  it('returns raw unclipped lines for the teaching view', () => {
    for (const pattern of ALL_PATTERNS) {
      const res = generateInfill([SQUARE], params(pattern))
      expect(res.rawLines, pattern).toBeDefined()
      expect(res.rawLines!.length, pattern).toBeGreaterThan(0)
    }
  })

  it('returns empty result for zero density or empty area', () => {
    expect(generateInfill([SQUARE], params('lines', 0)).lines).toHaveLength(0)
    expect(generateInfill([], params('lines')).lines).toHaveLength(0)
  })
})

describe('density invariant', () => {
  it('extruded area ≈ density × region area for every pattern', () => {
    const area = polygonArea(SQUARE)
    // zigzag adds short boundary connectors, composite patterns accumulate
    // scanline-rounding error, gyroid is a marching-squares approximation.
    const tolerances: Record<InfillPattern, number> = {
      lines: 0.15,
      zigzag: 0.2,
      grid: 0.15,
      triangles: 0.2,
      cubic: 0.2,
      honeycomb: 0.2,
      gyroid: 0.2,
    }
    for (const pattern of ALL_PATTERNS) {
      const res = generateInfill([SQUARE], params(pattern))
      const ratio = (extrusionLength(res) * 400) / (0.2 * area)
      expect(ratio, pattern).toBeGreaterThan(1 - tolerances[pattern])
      expect(ratio, pattern).toBeLessThan(1 + tolerances[pattern])
    }
  })
})

describe('zigzag', () => {
  it('connects the scanlines into one serpentine polyline on a convex shape', () => {
    const res = generateInfill([SQUARE], params('zigzag'))
    expect(res.lines.length).toBe(1)
    // 10 scanline segments + 9 connectors = 19 segments, 20 junctions
    expect(res.lines[0].length).toBe(20)
    const expected = 10 * 20_000 + 9 * 2000
    expect(extrusionLength(res)).toBeCloseTo(expected, -3)
  })
})

describe('clipping', () => {
  it('clipPolylinesToPolygons keeps only the inside sub-segments', () => {
    const clipped = clipPolylinesToPolygons(
      [[{ x: -15_000, y: 0 }, { x: 15_000, y: 0 }]],
      [SQUARE_WITH_HOLE],
    )
    expect(clipped).toHaveLength(2)
    const sorted = [...clipped].sort((a, b) => a[0].x - b[0].x)
    expect(sorted[0][0].x).toBeCloseTo(-10_000, 6)
    expect(sorted[0][1].x).toBeCloseTo(-4000, 6)
    expect(sorted[1][0].x).toBeCloseTo(4000, 6)
    expect(sorted[1][1].x).toBeCloseTo(10_000, 6)
  })

  it('no extrusion segment midpoint lies inside the hole, for any pattern', () => {
    const hole = SQUARE_WITH_HOLE.holes[0]
    for (const pattern of ALL_PATTERNS) {
      const res = generateInfill([SQUARE_WITH_HOLE], params(pattern))
      expect(res.lines.length, pattern).toBeGreaterThan(0)
      for (const line of res.lines) {
        for (let i = 1; i < line.length; i++) {
          const mid = {
            x: (line[i - 1].p.x + line[i].p.x) / 2,
            y: (line[i - 1].p.y + line[i].p.y) / 2,
          }
          expect(pointInRing(mid, hole), pattern).toBe(false)
        }
      }
    }
  })
})

describe('gyroid', () => {
  it('produces multiple connected polylines, not fragments', () => {
    const res = generateInfill([SQUARE], params('gyroid'))
    expect(res.lines.length).toBeGreaterThan(3)
    const junctionCounts = res.lines.map((l) => l.length)
    expect(Math.max(...junctionCounts)).toBeGreaterThanOrEqual(6)
    // Most of the extrusion length lives in long polylines (>= 5 segments).
    let longLength = 0
    for (const line of res.lines) {
      if (line.length >= 6) longLength += polylineLength(line.map((j) => j.p))
    }
    expect(longLength / extrusionLength(res)).toBeGreaterThan(0.5)
  })

  it('is deterministic across runs', () => {
    const a = generateInfill([SQUARE], params('gyroid', 0.2, 30))
    const b = generateInfill([SQUARE], params('gyroid', 0.2, 30))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
