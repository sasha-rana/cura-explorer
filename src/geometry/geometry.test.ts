import { beforeAll, describe, expect, it } from 'vitest'
import {
  difference,
  initClipper,
  intersect,
  offset,
  pointInPolygon,
  union,
} from './clipper'
import { polygonArea, polygonsArea, samplePolygonEdges, signedArea } from './polyUtils'
import { computeSkeleton } from './skeleton'
import { parseStl, buildAdjacency, zBounds } from './stl'
import type { Polygon } from './types'

const square = (cx: number, cy: number, size: number): Polygon => ({
  outer: [
    { x: cx - size / 2, y: cy - size / 2 },
    { x: cx + size / 2, y: cy - size / 2 },
    { x: cx + size / 2, y: cy + size / 2 },
    { x: cx - size / 2, y: cy + size / 2 },
  ],
  holes: [],
})

beforeAll(async () => {
  await initClipper()
})

describe('polyUtils', () => {
  it('signedArea is positive for CCW and negative for CW', () => {
    const ccw = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ]
    expect(signedArea(ccw)).toBeCloseTo(1_000_000)
    expect(signedArea([...ccw].reverse())).toBeCloseTo(-1_000_000)
  })

  it('samples polygon edges densely', () => {
    const samples = samplePolygonEdges([square(0, 0, 10_000)], 1000)
    expect(samples.length).toBeGreaterThanOrEqual(40)
  })
})

describe('clipper wrapper', () => {
  it('unions overlapping squares', () => {
    const result = union([square(0, 0, 10_000), square(5000, 0, 10_000)])
    expect(polygonsArea(result)).toBeCloseTo(150_000_000, -3)
  })

  it('subtracts with holes preserved', () => {
    const result = difference([square(0, 0, 20_000)], [square(0, 0, 10_000)])
    expect(result).toHaveLength(1)
    expect(result[0].holes.length).toBeGreaterThan(0)
    expect(polygonArea(result[0])).toBeCloseTo(300_000_000, -3)
    expect(pointInPolygon({ x: 0, y: 0 }, result[0])).toBe(false)
    expect(pointInPolygon({ x: 8000, y: 0 }, result[0])).toBe(true)
  })

  it('intersects', () => {
    const result = intersect([square(0, 0, 10_000)], [square(5000, 0, 10_000)])
    expect(polygonsArea(result)).toBeCloseTo(50_000_000, -3)
  })

  it('insets by a negative delta and offsets by a positive delta', () => {
    const inset = offset([square(0, 0, 20_000)], -5000)
    expect(polygonsArea(inset)).toBeCloseTo(100_000_000, -3)
    const grown = offset([square(0, 0, 20_000)], 5000)
    // round joins would give more; miter joins on a square give exactly 30x30
    expect(polygonsArea(grown)).toBeCloseTo(900_000_000, -3)
  })
})

describe('skeleton', () => {
  it('produces a medial-axis graph inside a rectangle', () => {
    const rect: Polygon = {
      outer: [
        { x: 0, y: 0 },
        { x: 40_000, y: 0 },
        { x: 40_000, y: 10_000 },
        { x: 0, y: 10_000 },
      ],
      holes: [],
    }
    const skel = computeSkeleton([rect], 1000)
    expect(skel.nodes.length).toBeGreaterThan(10)
    expect(skel.edges.length).toBeGreaterThan(5)
    // Nodes along the centre of a 10 mm wide bar sit ~5 mm from the boundary.
    const central = skel.nodes.filter((n) => n.p.x > 15_000 && n.p.x < 25_000)
    expect(central.length).toBeGreaterThan(0)
    for (const n of central) {
      expect(n.r).toBeGreaterThan(3500)
      expect(n.r).toBeLessThan(5600)
    }
  })
})

describe('stl', () => {
  it('parses a binary STL cube', () => {
    // 12 triangles of a 10 mm cube with a corner at the origin.
    const buffer = new ArrayBuffer(84 + 12 * 50)
    const view = new DataView(buffer)
    view.setUint32(80, 12, true)
    const v = (x: number, y: number, z: number) => [x, y, z]
    const V = [
      v(0, 0, 0), v(10, 0, 0), v(10, 10, 0), v(0, 10, 0),
      v(0, 0, 10), v(10, 0, 10), v(10, 10, 10), v(0, 10, 10),
    ]
    const faces = [
      [0, 2, 1], [0, 3, 2], // bottom
      [4, 5, 6], [4, 6, 7], // top
      [0, 1, 5], [0, 5, 4],
      [1, 2, 6], [1, 6, 5],
      [2, 3, 7], [2, 7, 6],
      [3, 0, 4], [3, 4, 7],
    ]
    let offset = 84
    for (const f of faces) {
      offset += 12 // normal = 0
      for (const vi of f) {
        view.setFloat32(offset, V[vi][0], true)
        view.setFloat32(offset + 4, V[vi][1], true)
        view.setFloat32(offset + 8, V[vi][2], true)
        offset += 12
      }
      offset += 2
    }
    const triangles = parseStl(buffer)
    expect(triangles).toHaveLength(12)
    expect(triangles[0].a.x).toBeCloseTo(0)
    expect(zBounds(triangles)).toEqual({ minZ: 0, maxZ: 10_000 })
    const adj = buildAdjacency(triangles)
    expect(adj.neighbours.every((n) => n.length === 3)).toBe(true)
  })
})
