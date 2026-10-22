import type { Point, Point3, Polyline, Ring, Triangle } from '../geometry/types'
import type { Polygon } from '../geometry/types'
import { pointInRing } from '../geometry/clipper'
import { dist, signedArea } from '../geometry/polyUtils'
import { zBounds } from '../geometry/stl'
import type { SlicedLayer, SlicingParams, StageDoc } from './types'

export const slicingDoc: StageDoc = {
  title: 'Slicing',
  explanation: `## The idea
Turn a 3D triangle mesh into a stack of 2D layer outlines: cut the mesh with one horizontal plane per layer, then stitch the intersection segments into closed polygons.

## Step by step
1. Slice planes sit at layer midpoints (z = \`layerHeight\` / 2, then + \`layerHeight\` per layer); planes at exact layer boundaries would constantly hit triangle vertices.
2. Each triangle straddling the plane contributes one segment: its two crossing edges are interpolated onto the plane and projected to XY.
3. A vertex exactly on the plane counts as **above** it (half-open rule), so two triangles sharing an on-plane edge contribute that edge exactly once instead of twice or never.
4. Segments are chained into loops by snapping endpoints onto a 10 µm grid.
5. Open chains whose loose ends lie within 100 µm are joined and snapped shut — small-gap patching for meshes that are not watertight.
6. Loops are classified into polygons-with-holes purely by containment: sorted by area, a loop becomes a hole of the smallest loop containing it, and a loop inside a hole starts a new island.
7. Loops with fewer than three points are discarded as noise.

## Edge cases & simplifications
- Winding is unreliable after stitching, so hole classification ignores ring orientation entirely.
- Real CuraEngine stitches via its face adjacency graph; we use endpoint hashing plus gap patching.
- \`rawSegments\` keeps the unstitched intersection segments on every layer for the teaching view.

## Try it
- Cube STL demo → stage 1 → toggle **Raw segments** vs **Stitched outline** to compare steps 2 and 4.
- Lower \`layerHeight\` and scrub the layer slider: outlines track the mesh cross-section.`,
  curaRef: 'src/slicer.cpp',
  refs: [
    { label: 'CuraEngine wiki: Slicing', url: 'https://github.com/Ultimaker/CuraEngine/wiki/Slicing' },
    { label: 'CuraEngine wiki: Internals', url: 'https://github.com/Ultimaker/CuraEngine/wiki/Internals' },
  ],
}

export interface SliceResult {
  layers: SlicedLayer[]
}

/** Endpoints are quantized to this grid (microns) when chaining segments. */
const ENDPOINT_GRID = 10
/** Open chains whose ends are closer than this are snapped shut (gap patching). */
const GAP_PATCH_UM = 100

interface Segment {
  a: Point
  b: Point
}

const keyOf = (p: Point): string =>
  `${Math.round(p.x / ENDPOINT_GRID)},${Math.round(p.y / ENDPOINT_GRID)}`

/**
 * Intersect a triangle with the horizontal plane at z. Returns the 2D segment
 * in XY, or null when the plane misses the triangle or only grazes it.
 * Half-open rule: vertices with z === plane count as "above" the plane.
 */
function intersectTrianglePlane(tri: Triangle, z: number): Segment | null {
  const pts = [tri.a, tri.b, tri.c]
  const crossings: Point[] = []
  for (let e = 0; e < 3; e++) {
    const p = pts[e]
    const q = pts[(e + 1) % 3]
    if (p.z < z === q.z < z) continue
    const t = (z - p.z) / (q.z - p.z)
    crossings.push({ x: Math.round(p.x + t * (q.x - p.x)), y: Math.round(p.y + t * (q.y - p.y)) })
  }
  const uniq: Point[] = []
  for (const c of crossings) {
    if (!uniq.some((u) => u.x === c.x && u.y === c.y)) uniq.push(c)
  }
  if (uniq.length !== 2) return null
  return { a: uniq[0], b: uniq[1] }
}

/** Chain segments end-to-end into closed rings, patching small gaps. */
export function stitchSegments(segments: Segment[]): Ring[] {
  const byKey = new Map<string, number[]>()
  segments.forEach((s, i) => {
    for (const p of [s.a, s.b]) {
      const k = keyOf(p)
      const list = byKey.get(k)
      if (list) list.push(i)
      else byKey.set(k, [i])
    }
  })
  const used = new Array<boolean>(segments.length).fill(false)
  const closed: Ring[] = []
  const open: Point[][] = []

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue
    used[i] = true
    const chain: Point[] = [segments[i].a, segments[i].b]
    // Grow the chain from the tail, then from the head.
    for (const tail of [true, false]) {
      for (;;) {
        const k = keyOf(tail ? chain[chain.length - 1] : chain[0])
        const j = byKey.get(k)?.find((idx) => !used[idx])
        if (j === undefined) break
        used[j] = true
        const s = segments[j]
        const next = keyOf(s.a) === k ? s.b : s.a
        if (tail) chain.push(next)
        else chain.unshift(next)
      }
    }
    if (keyOf(chain[0]) === keyOf(chain[chain.length - 1])) {
      closed.push(cleanRing(chain, true))
    } else {
      open.push(chain)
    }
  }

  // Gap patching: join open chains whose loose ends nearly touch.
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) {
        const joined = tryJoin(open[i], open[j])
        if (joined) {
          open.splice(j, 1)
          open[i] = joined
          merged = true
          break outer
        }
      }
    }
  }
  for (const chain of open) {
    if (dist(chain[0], chain[chain.length - 1]) <= GAP_PATCH_UM) {
      closed.push(cleanRing(chain, false))
    }
  }
  return closed.filter((r) => r.length >= 3)
}

/** Join two open chains if any pair of endpoints is within the patch distance. */
function tryJoin(a: Point[], b: Point[]): Point[] | null {
  const combos: [Point[], Point[]][] = [
    [a, b],
    [a, [...b].reverse()],
    [[...a].reverse(), b],
    [[...a].reverse(), [...b].reverse()],
  ]
  for (const [x, y] of combos) {
    if (dist(x[x.length - 1], y[0]) <= GAP_PATCH_UM) return [...x, ...y]
  }
  return null
}

/** Drop consecutive duplicate points; when closed, also drop a repeated first point. */
function cleanRing(chain: Point[], closed: boolean): Ring {
  const pts = closed ? chain.slice(0, -1) : chain
  const out: Point[] = []
  for (const p of pts) {
    if (out.length === 0 || keyOf(out[out.length - 1]) !== keyOf(p)) out.push(p)
  }
  if (out.length > 1 && keyOf(out[0]) === keyOf(out[out.length - 1])) out.pop()
  return out
}

/**
 * Turn stitched rings into polygons with holes. Winding is unreliable after
 * stitching, so classification is purely by containment: sorted by area
 * descending, a ring is a hole of the smallest earlier ring that contains it;
 * if that container is itself a hole, the ring is an island and starts a new
 * polygon.
 */
export function ringsToPolygons(rings: Ring[]): Polygon[] {
  const sorted = rings
    .map((ring) => ({ ring, area: Math.abs(signedArea(ring)) }))
    .filter((r) => r.area > 0)
    .sort((a, b) => b.area - a.area)
  const polys: Polygon[] = []
  const placed: { ring: Ring; area: number; polyIndex: number; isHole: boolean }[] = []
  for (const { ring, area } of sorted) {
    let container = -1
    for (let i = 0; i < placed.length; i++) {
      if (
        placed[i].area > area &&
        pointInRing(ring[0], placed[i].ring) &&
        (container === -1 || placed[i].area < placed[container].area)
      ) {
        container = i
      }
    }
    if (container === -1 || placed[container].isHole) {
      polys.push({ outer: signedArea(ring) > 0 ? ring : [...ring].reverse(), holes: [] })
      placed.push({ ring, area, polyIndex: polys.length - 1, isHole: false })
    } else {
      const hole = signedArea(ring) < 0 ? ring : [...ring].reverse()
      polys[placed[container].polyIndex].holes.push(hole)
      placed.push({ ring, area, polyIndex: placed[container].polyIndex, isHole: true })
    }
  }
  return polys
}

export function sliceMesh(triangles: Triangle[], params: SlicingParams): SliceResult {
  const { maxZ } = zBounds(triangles)
  const ranges = triangles.map((t) => ({
    lo: Math.min(t.a.z, t.b.z, t.c.z),
    hi: Math.max(t.a.z, t.b.z, t.c.z),
  }))
  const layers: SlicedLayer[] = []
  for (let z = params.layerHeight / 2; z < maxZ; z += params.layerHeight) {
    const segments: Segment[] = []
    triangles.forEach((tri, i) => {
      if (ranges[i].lo >= z || ranges[i].hi < z) return
      const seg = intersectTrianglePlane(tri, z)
      if (seg) segments.push(seg)
    })
    const rawSegments: Polyline[] = segments.map((s) => [s.a, s.b])
    layers.push({ z, polygons: ringsToPolygons(stitchSegments(segments)), rawSegments })
  }
  return { layers }
}

// --- Fixtures -----------------------------------------------------------------

/** 12-triangle cube with one corner at the origin, edges along the axes. */
export function makeCubeMesh(sizeUm: number): Triangle[] {
  const s = sizeUm
  const V: Point3[] = [
    { x: 0, y: 0, z: 0 }, { x: s, y: 0, z: 0 }, { x: s, y: s, z: 0 }, { x: 0, y: s, z: 0 },
    { x: 0, y: 0, z: s }, { x: s, y: 0, z: s }, { x: s, y: s, z: s }, { x: 0, y: s, z: s },
  ]
  const faces = [
    [0, 2, 1], [0, 3, 2], // bottom
    [4, 5, 6], [4, 6, 7], // top
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
  ]
  // Clone vertices per triangle so callers can mutate one triangle in isolation.
  return faces.map(([i, j, k]) => ({ a: { ...V[i] }, b: { ...V[j] }, c: { ...V[k] } }))
}

/** Square-based pyramid: base in the z=0 plane, apex centred above it. */
export function makePyramidMesh(baseUm: number, heightUm: number): Triangle[] {
  const b = baseUm
  const base: Point3[] = [
    { x: 0, y: 0, z: 0 },
    { x: b, y: 0, z: 0 },
    { x: b, y: b, z: 0 },
    { x: 0, y: b, z: 0 },
  ]
  const apex: Point3 = { x: b / 2, y: b / 2, z: heightUm }
  const tri = (a: Point3, c: Point3, d: Point3): Triangle => ({ a: { ...a }, b: { ...c }, c: { ...d } })
  return [
    tri(base[0], base[2], base[1]), // bottom (facing down)
    tri(base[0], base[3], base[2]),
    tri(base[0], base[1], apex),
    tri(base[1], base[2], apex),
    tri(base[2], base[3], apex),
    tri(base[3], base[0], apex),
  ]
}
