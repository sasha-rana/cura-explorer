import type { AABB, Point, Polygon, Polyline, Ring } from './types'

/** Signed area of a ring (shoelace). Positive = counter-clockwise. */
export function signedArea(ring: Ring): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j].x * ring[i].y - ring[i].x * ring[j].y
  }
  return a / 2
}

/** Absolute area of a polygon (outer minus holes). */
export function polygonArea(poly: Polygon): number {
  let a = Math.abs(signedArea(poly.outer))
  for (const hole of poly.holes) a -= Math.abs(signedArea(hole))
  return a
}

export function polygonsArea(polys: Polygon[]): number {
  return polys.reduce((s, p) => s + polygonArea(p), 0)
}

export function ringBounds(ring: Ring): AABB {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of ring) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

export function polygonsBounds(polys: Polygon[]): AABB {
  let b: AABB = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const poly of polys) {
    const pb = ringBounds(poly.outer)
    b = {
      minX: Math.min(b.minX, pb.minX),
      minY: Math.min(b.minY, pb.minY),
      maxX: Math.max(b.maxX, pb.maxX),
      maxY: Math.max(b.maxY, pb.maxY),
    }
  }
  return b
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function dist2(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

/** Distance from point p to segment ab. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return dist(p, a)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export function polylineLength(line: Polyline): number {
  let len = 0
  for (let i = 1; i < line.length; i++) len += dist(line[i - 1], line[i])
  return len
}

export function ringLength(ring: Ring): number {
  let len = 0
  for (let i = 0; i < ring.length; i++) len += dist(ring[i], ring[(i + 1) % ring.length])
  return len
}

/**
 * Densely sample the edges of a polygon's rings (outer + holes) at roughly
 * `spacing` microns. Returns sample points plus, for each point, the ring it
 * belongs to and its index along that ring (used to filter out Voronoi edges
 * between boundary neighbours when approximating the medial axis).
 */
export interface BoundarySample {
  p: Point
  ring: number
  index: number
}

export function samplePolygonEdges(polys: Polygon[], spacing: number): BoundarySample[] {
  const samples: BoundarySample[] = []
  let ringId = 0
  for (const poly of polys) {
    for (const ring of [poly.outer, ...poly.holes]) {
      let idx = 0
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        const len = dist(a, b)
        const n = Math.max(1, Math.round(len / spacing))
        for (let k = 0; k < n; k++) {
          const t = k / n
          samples.push({
            p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
            ring: ringId,
            index: idx++,
          })
        }
      }
      ringId++
    }
  }
  return samples
}

/**
 * Intersect a ring with the horizontal line y = scanY. Returns sorted x
 * coordinates of all crossings (pairs of crossings span the interior).
 */
export function ringScanlineCrossings(ring: Ring, scanY: number): number[] {
  const xs: number[] = []
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]
    const b = ring[i]
    if (a.y === b.y) continue // ignore horizontal edges
    if (a.y <= scanY === b.y <= scanY) continue // no crossing (half-open rule avoids double counting vertices)
    const t = (scanY - a.y) / (b.y - a.y)
    xs.push(a.x + t * (b.x - a.x))
  }
  xs.sort((p, q) => p - q)
  return xs
}

/** Intersect polygons with the horizontal line y = scanY. Returns [x0, x1] segment pairs. */
export function polygonsScanlineSegments(polys: Polygon[], scanY: number): [number, number][] {
  const xs: number[] = []
  for (const poly of polys) {
    for (const ring of [poly.outer, ...poly.holes]) {
      xs.push(...ringScanlineCrossings(ring, scanY))
    }
  }
  xs.sort((p, q) => p - q)
  const segments: [number, number][] = []
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] > xs[i]) segments.push([xs[i], xs[i + 1]])
  }
  return segments
}

export function rotatePoint(p: Point, cos: number, sin: number): Point {
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }
}

export function rotatePolygon(poly: Polygon, cos: number, sin: number): Polygon {
  const rot = (r: Ring) => r.map((p) => rotatePoint(p, cos, sin))
  return { outer: rot(poly.outer), holes: poly.holes.map(rot) }
}

export function centroid(ring: Ring): Point {
  let cx = 0
  let cy = 0
  for (const p of ring) {
    cx += p.x
    cy += p.y
  }
  return { x: cx / ring.length, y: cy / ring.length }
}
