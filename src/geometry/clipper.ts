import {
  ClipType,
  EndType,
  JoinType,
  PolyFillType,
  NativeClipperLibRequestedFormat,
  loadNativeClipperLibInstanceAsync,
  type ClipperLibWrapper,
  type Paths,
  type PolyNode,
  type PolyTree,
  type ReadonlyPaths,
} from 'js-angusj-clipper'
import type { Point, Polygon, Polyline, Ring } from './types'
import { signedArea } from './polyUtils'

let lib: ClipperLibWrapper | undefined

/** Must be awaited once before any boolean/offset operation. */
export async function initClipper(): Promise<void> {
  if (!lib) {
    lib = await loadNativeClipperLibInstanceAsync(
      NativeClipperLibRequestedFormat.WasmWithAsmJsFallback,
    )
  }
}

function requireLib(): ClipperLibWrapper {
  if (!lib) throw new Error('initClipper() must be awaited before using clipper operations')
  return lib
}

// ---------------------------------------------------------------------------
// Conversion between our Polygon type and Clipper Paths.
// Clipper wants outer rings and hole rings in opposite orientations; with
// consistent orientation + NonZero fill the hierarchy is preserved.
// ---------------------------------------------------------------------------

function ringToPath(ring: Ring): { x: number; y: number }[] {
  return ring.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
}

function polygonsToPaths(polys: Polygon[]): ReadonlyPaths {
  const paths: { x: number; y: number }[][] = []
  for (const poly of polys) {
    const outer = signedArea(poly.outer) > 0 ? poly.outer : [...poly.outer].reverse()
    paths.push(ringToPath(outer))
    for (const hole of poly.holes) {
      const h = signedArea(hole) < 0 ? hole : [...hole].reverse()
      paths.push(ringToPath(h))
    }
  }
  return paths
}

function polyTreeToPolygons(tree: PolyTree): Polygon[] {
  const out: Polygon[] = []
  const contour = (node: PolyNode): Ring => node.contour.map((p: Point) => ({ x: p.x, y: p.y }))
  const addOuter = (node: PolyNode) => {
    const poly: Polygon = { outer: contour(node), holes: [] }
    out.push(poly)
    for (const holeNode of node.childs) {
      if (!holeNode.isHole) continue
      poly.holes.push(contour(holeNode))
      // Children of a hole are outers again (islands inside holes).
      for (const island of holeNode.childs) {
        if (!island.isHole) addOuter(island)
      }
    }
  }
  for (const child of tree.childs) {
    if (!child.isHole) addOuter(child)
  }
  return out
}

function booleanOp(clipType: ClipType, subject: Polygon[], clip?: Polygon[]): Polygon[] {
  const c = requireLib()
  const tree: PolyTree | undefined = c.clipToPolyTree({
    clipType,
    subjectFillType: PolyFillType.NonZero,
    subjectInputs: [{ data: polygonsToPaths(subject), closed: true }],
    clipInputs: clip ? [{ data: polygonsToPaths(clip) }] : undefined,
  })
  if (!tree) return []
  return polyTreeToPolygons(tree)
}

export function union(subject: Polygon[], clip?: Polygon[]): Polygon[] {
  return booleanOp(ClipType.Union, subject, clip)
}

export function difference(subject: Polygon[], clip: Polygon[]): Polygon[] {
  return booleanOp(ClipType.Difference, subject, clip)
}

export function intersect(subject: Polygon[], clip: Polygon[]): Polygon[] {
  return booleanOp(ClipType.Intersection, subject, clip)
}

export interface OffsetOptions {
  joinType?: JoinType
  miterLimit?: number
  roundPrecision?: number
}

/** Offset closed polygons. Negative delta shrinks (inset), positive grows. */
export function offset(polys: Polygon[], delta: number, opts: OffsetOptions = {}): Polygon[] {
  const c = requireLib()
  const result = c.offsetToPaths({
    delta,
    miterLimit: opts.miterLimit ?? 2,
    offsetInputs: [
      {
        data: polygonsToPaths(polys),
        joinType: opts.joinType ?? JoinType.Miter,
        endType: EndType.ClosedPolygon,
      },
    ],
  })
  return pathsToPolygons(result)
}

/** Offset an open polyline into a closed "sausage" region (used for line-width areas). */
export function offsetPolyline(line: Polyline, delta: number, opts: OffsetOptions = {}): Polygon[] {
  const c = requireLib()
  const result = c.offsetToPaths({
    delta,
    miterLimit: opts.miterLimit ?? 2,
    offsetInputs: [
      {
        data: line.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
        joinType: opts.joinType ?? JoinType.Round,
        endType: EndType.OpenRound,
      },
    ],
  })
  return pathsToPolygons(result)
}

/**
 * Convert a flat Paths result (from offsetting, where orientation encodes
 * hole-ness) into our Polygon type by containment testing.
 */
function pathsToPolygons(paths: Paths | undefined): Polygon[] {
  if (!paths) return []
  const rings: Ring[] = (paths as ReadonlyPaths as { x: number; y: number }[][]).map((path) =>
    path.map((p) => ({ x: p.x, y: p.y })),
  )
  const outers: { ring: Ring; area: number }[] = []
  const holes: Ring[] = []
  for (const ring of rings) {
    const a = signedArea(ring)
    if (a > 0) outers.push({ ring, area: a })
    else if (a < 0) holes.push(ring)
  }
  const polys: Polygon[] = outers.map((o) => ({ outer: o.ring, holes: [] }))
  for (const hole of holes) {
    // Attach each hole to the smallest outer that contains it.
    let best = -1
    let bestArea = Infinity
    const hp = hole[0]
    for (let i = 0; i < polys.length; i++) {
      if (pointInRing(hp, polys[i].outer) && Math.abs(signedArea(polys[i].outer)) < bestArea) {
        best = i
        bestArea = Math.abs(signedArea(polys[i].outer))
      }
    }
    if (best >= 0) polys[best].holes.push(hole)
  }
  return polys
}

/** Ray-casting point-in-ring test. */
export function pointInRing(p: Point, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

/** Point-in-polygon (outer minus holes). */
export function pointInPolygon(p: Point, poly: Polygon): boolean {
  if (!pointInRing(p, poly.outer)) return false
  for (const hole of poly.holes) {
    if (pointInRing(p, hole)) return false
  }
  return true
}

/** Point-in-any-of-polygons. */
export function pointInPolygons(p: Point, polys: Polygon[]): boolean {
  return polys.some((poly) => pointInPolygon(p, poly))
}
