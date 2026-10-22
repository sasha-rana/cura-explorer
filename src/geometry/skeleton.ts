import { Delaunay } from 'd3-delaunay'
import { pointInPolygons } from './clipper'
import { dist } from './polyUtils'
import type { Point, Polygon } from './types'

/**
 * Approximation of the medial axis of a set of polygons.
 *
 * A full segment-Voronoi medial axis (what CuraEngine's Arachne gets from
 * Boost.Polygon) is out of scope; instead we densely sample the boundary and
 * use the Delaunay triangulation of the samples: connecting the circumcentres
 * of adjacent triangles yields the Voronoi diagram of the samples, whose
 * interior part approximates the medial axis. Each node carries its radius
 * (distance to the boundary), which Arachne-style beading needs.
 */

export interface SkeletonNode {
  p: Point
  /** Distance to the nearest boundary, in microns. */
  r: number
}

export interface Skeleton {
  nodes: SkeletonNode[]
  /** Pairs of node indices. */
  edges: [number, number][]
}

export function computeSkeleton(polys: Polygon[], spacing: number): Skeleton {
  // Sample every ring, tracking ring id and index so we can detect samples
  // that are adjacent along the same boundary ring.
  interface Sample {
    x: number
    y: number
    ring: number
    index: number
  }
  const samples: Sample[] = []
  const ringSizes: number[] = []
  {
    let ringId = 0
    for (const poly of polys) {
      for (const ring of [poly.outer, ...poly.holes]) {
        let idx = 0
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]
          const b = ring[(i + 1) % ring.length]
          const n = Math.max(1, Math.round(dist(a, b) / spacing))
          for (let k = 0; k < n; k++) {
            const t = k / n
            samples.push({
              x: a.x + (b.x - a.x) * t,
              y: a.y + (b.y - a.y) * t,
              ring: ringId,
              index: idx++,
            })
          }
        }
        ringSizes.push(idx)
        ringId++
      }
    }
  }
  if (samples.length < 3) return { nodes: [], edges: [] }

  const adjacentOnBoundary = (sa: Sample, sb: Sample): boolean => {
    if (sa.ring !== sb.ring) return false
    const size = ringSizes[sa.ring]
    const d = Math.abs(sa.index - sb.index)
    return d <= 1 || d === size - 1 // wrap-around neighbours
  }

  const delaunay = Delaunay.from(
    samples,
    (s) => s.x,
    (s) => s.y,
  )
  const { triangles, halfedges } = delaunay
  const voronoi = delaunay.voronoi(delaunayBounds(samples))
  const circumcenters = voronoi.circumcenters

  const triCount = triangles.length / 3
  const nodes: SkeletonNode[] = []
  const nodeForTriangle = new Int32Array(triCount).fill(-1)

  const nodeFor = (t: number): number => {
    if (nodeForTriangle[t] >= 0) return nodeForTriangle[t]
    const cx = circumcenters[t * 2]
    const cy = circumcenters[t * 2 + 1]
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return -1
    const s = samples[triangles[t * 3]]
    const r = Math.hypot(cx - s.x, cy - s.y)
    const idx = nodes.length
    nodes.push({ p: { x: cx, y: cy }, r })
    nodeForTriangle[t] = idx
    return idx
  }

  const edges: [number, number][] = []
  for (let e = 0; e < halfedges.length; e++) {
    const opposite = halfedges[e]
    if (opposite < 0 || opposite < e) continue // hull edge or already visited

    // Delaunay edge endpoints: triangles[e] and triangles[next(e)].
    const next = e % 3 === 2 ? e - 2 : e + 1
    const sa = samples[triangles[e]]
    const sb = samples[triangles[next]]

    // Voronoi edges between boundary neighbours hug the outline; drop them.
    if (adjacentOnBoundary(sa, sb)) continue

    const tA = Math.floor(e / 3)
    const tB = Math.floor(opposite / 3)
    const na = nodeFor(tA)
    const nb = nodeFor(tB)
    if (na < 0 || nb < 0) continue

    // Keep only the interior part of the Voronoi diagram.
    if (!pointInPolygons(nodes[na].p, polys) || !pointInPolygons(nodes[nb].p, polys)) continue

    edges.push([na, nb])
  }
  return { nodes, edges }
}

function delaunayBounds(samples: { x: number; y: number }[]): [number, number, number, number] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of samples) {
    if (s.x < minX) minX = s.x
    if (s.y < minY) minY = s.y
    if (s.x > maxX) maxX = s.x
    if (s.y > maxY) maxY = s.y
  }
  const pad = Math.max(maxX - minX, maxY - minY) * 0.1 + 1000
  return [minX - pad, minY - pad, maxX + pad, maxY + pad]
}
