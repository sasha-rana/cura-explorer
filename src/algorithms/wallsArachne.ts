import { difference, offset, pointInPolygons } from '../geometry/clipper'
import { dist, polygonsArea } from '../geometry/polyUtils'
import { computeSkeleton, type Skeleton } from '../geometry/skeleton'
import type { ExtrusionLine, Point, Polygon } from '../geometry/types'
import type { StageDoc, WallResult } from './types'
import { computeGaps, extrusionLineSausages, ringToWallLine, unionAll, wallBandRegion } from './wallsConstant'

export const arachneDoc: StageDoc = {
  title: 'Arachne: variable-width walls',
  explanation: `## The idea
Flip the classic wall strategy around: instead of asking where a fixed-width bead fits, ask how wide the part is locally and choose bead widths to match.

## Step by step
1. Compute an approximate medial axis: sample the boundary every \`skeletonSpacing = wallWidth / 8\`, Delaunay-triangulate the samples, connect circumcentres. Each skeleton node carries its radius r — the distance to the boundary.
2. Prune leaf branches shorter than \`2 * skeletonSpacing\` (sampling noise near corners).
3. Lay full-width insets (\`wallWidth / 2 + i * wallWidth\`), at most \`wallCount\` of them like Cura, dropping the last one when its ring is a degenerate sliver.
4. Walk the skeleton as polylines and keep only nodes inside the area the insets left uncovered, with local thickness at most \`2 * wallCount * wallWidth\` — anything thicker is genuinely interior and belongs to infill.
5. Bead width from local thickness \`d = 2r\`: \`n = round(d / wallWidth)\` beads (at least 1) of width \`d / n\`, so a 500 µm rib gets one 500 µm bead instead of a forced 400 µm bead plus slivers. Below \`minWidth\`, no bead.
6. Maximal runs of beadable nodes become one centreline bead; stubs shorter than \`wallWidth / 2\` are left as gap-fill candidates.
7. With **distributed** beading, widths are smoothed over \`transitionLength = 0.4 * wallWidth\` of arc, clamped to \`[min(d, minWidth), d]\`.

## Key formulas / rules
- \`d = 2r\` — local feature size from skeleton radius
- \`n = round(d / w)\`, bead width \`w_i = d / n\`
- \`skeletonSpacing = wallWidth / 8\`, \`transitionLength = 0.4 * wallWidth\`

## Edge cases & simplifications
- Medial axis is boundary sampling + Delaunay, not Boost's exact segment-Voronoi.
- A single centreline bead represents all n beads of a thin region rather than n parallel passes; full-width regions get the classic insets.
- Transitions are a moving average, not Arachne's trapezoidal transition regions anchored at skeleton sites.
- Gaps use the same wall-band semantics as constant walls, so the two strategies compare fairly.

## Try it
- Ribbon preset → strategy **Arachne**, toggle **Skeleton**: bead widths track the sinusoidal thickness.
- Thin-wall preset (0.5 mm): constant walls produce nothing, Arachne fills it with one bead.
- Thin wedge preset → **Compare**: the tip fills with a tapering centreline bead.`,
  curaRef: 'src/WallsComputation.cpp, src/utils/VoronoiUtils.cpp (Boost segment Voronoi)',
  refs: [
    {
      label: 'Kuipers et al., A framework for adaptive width control of dense contour-parallel toolpaths (arXiv)',
      url: 'https://arxiv.org/abs/2005.08840',
    },
    {
      label: 'CuraEngine wiki: Generating Paths',
      url: 'https://github.com/Ultimaker/CuraEngine/wiki/Generating-Paths',
    },
  ],
}

export type BeadingStrategy = 'constant' | 'distributed'

export interface ArachneParams {
  wallWidth: number
  /** Maximum number of full-width insets; also defines the nominal wall band. */
  wallCount: number
  /** Minimum bead width for thin features, microns. */
  minWidth: number
  strategy: BeadingStrategy
  /** Boundary sampling spacing for the skeleton, e.g. wallWidth / 8. */
  skeletonSpacing: number
  /** For 'distributed': length over which width changes spread. */
  transitionLength?: number
}

export interface ArachneResult extends WallResult {
  skeleton: Skeleton
  beads: { line: ExtrusionLine; kind: 'inset' | 'centreline' }[]
}

/**
 * Full-width insets, outermost first, at most wallCount of them (like Cura).
 * The final inset is dropped when its ring is a degenerate sliver (thinner
 * than half a bead): that region is better served by a single centreline bead
 * of adapted width.
 */
export function arachneInsets(
  outline: Polygon[],
  wallWidth: number,
  wallCount: number,
): ExtrusionLine[] {
  const lines: ExtrusionLine[] = []
  const areaEps = Math.max(100, (wallWidth * 0.05) ** 2)
  for (let i = 0; i < wallCount; i++) {
    const inset = offset(outline, -(wallWidth / 2 + i * wallWidth))
    if (polygonsArea(inset) < areaEps) break
    const ringCore = offset(outline, -(wallWidth / 2 + i * wallWidth + wallWidth / 4))
    if (polygonsArea(ringCore) < areaEps) break
    for (const poly of inset) {
      for (const ring of [poly.outer, ...poly.holes]) {
        lines.push(ringToWallLine(ring, wallWidth))
      }
    }
  }
  return lines
}

/**
 * Remove short leaf branches (sampling noise near corners) by repeatedly
 * cutting leaf chains shorter than minBranchLength. Returns a re-indexed
 * skeleton containing only nodes that still have an edge.
 */
export function pruneSkeleton(skel: Skeleton, minBranchLength: number): Skeleton {
  let edges = skel.edges
  for (let pass = 0; pass < 20; pass++) {
    const adj: { to: number; e: number }[][] = skel.nodes.map(() => [])
    edges.forEach(([a, b], e) => {
      adj[a].push({ to: b, e })
      adj[b].push({ to: a, e })
    })
    const drop = new Set<number>()
    for (let n = 0; n < skel.nodes.length; n++) {
      if (adj[n].length !== 1) continue
      // Walk from the leaf along degree-2 nodes, accumulating length.
      let len = 0
      let prev = n
      let cur = adj[n][0].to
      const chain = [adj[n][0].e]
      while (adj[cur].length === 2) {
        const next = adj[cur].find((x) => x.to !== prev)
        if (!next) break
        len += dist(skel.nodes[prev].p, skel.nodes[cur].p)
        chain.push(next.e)
        prev = cur
        cur = next.to
      }
      len += dist(skel.nodes[prev].p, skel.nodes[cur].p)
      if (len < minBranchLength) chain.forEach((e) => drop.add(e))
    }
    if (drop.size === 0) break
    edges = edges.filter((_, e) => !drop.has(e))
  }
  const remap = new Map<number, number>()
  const nodes: Skeleton['nodes'] = []
  const outEdges: [number, number][] = []
  for (const [a, b] of edges) {
    for (const old of [a, b]) {
      if (!remap.has(old)) {
        remap.set(old, nodes.length)
        nodes.push(skel.nodes[old])
      }
    }
    outEdges.push([remap.get(a)!, remap.get(b)!])
  }
  return { nodes, edges: outEdges }
}

/** Decompose the skeleton graph into polylines of node indices. */
export function skeletonPolylines(skel: Skeleton): number[][] {
  const adj: { to: number; e: number }[][] = skel.nodes.map(() => [])
  skel.edges.forEach(([a, b], e) => {
    adj[a].push({ to: b, e })
    adj[b].push({ to: a, e })
  })
  const used = new Uint8Array(skel.edges.length)
  const lines: number[][] = []
  const walk = (start: number, firstTo: number, firstE: number): number[] => {
    const line = [start, firstTo]
    used[firstE] = 1
    let cur = firstTo
    while (adj[cur].length === 2 && cur !== start) {
      const next = adj[cur].find((x) => !used[x.e])
      if (!next) break
      used[next.e] = 1
      line.push(next.to)
      cur = next.to
    }
    return line
  }
  // Chains anchored at leaves and junctions.
  for (let n = 0; n < skel.nodes.length; n++) {
    if (adj[n].length === 2) continue
    for (const { to, e } of adj[n]) {
      if (!used[e]) lines.push(walk(n, to, e))
    }
  }
  // Pure loops (every node degree 2), e.g. the medial axis of a ring.
  for (let e = 0; e < skel.edges.length; e++) {
    if (used[e]) continue
    const [a, b] = skel.edges[e]
    lines.push(walk(a, b, e))
  }
  return lines
}

/**
 * Bead width for local thickness d: n = round(d / w) beads of width d / n.
 * A single centreline bead represents them, so for d < 1.5w the bead takes the
 * full local thickness. Returns null where the feature is below minWidth.
 */
export function beadWidth(d: number, wallWidth: number, minWidth: number): number | null {
  if (d < minWidth) return null
  const n = Math.max(1, Math.round(d / wallWidth))
  const w = d / n
  return w < minWidth ? minWidth : w
}

/** Moving average of widths over transitionLength of arc, clamped to [min(d, minW), d]. */
export function smoothWidths(
  pts: Point[],
  ws: number[],
  ds: number[],
  minWidth: number,
  transitionLength: number,
): number[] {
  const s = [0]
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + dist(pts[i - 1], pts[i]))
  return ws.map((_, k) => {
    let sum = 0
    let count = 0
    for (let j = 0; j < ws.length; j++) {
      if (Math.abs(s[j] - s[k]) <= transitionLength / 2) {
        sum += ws[j]
        count++
      }
    }
    const smoothed = sum / count
    const lower = Math.min(ds[k], minWidth)
    return Math.max(lower, Math.min(smoothed, ds[k]))
  })
}

export function computeArachneWalls(outline: Polygon[], params: ArachneParams): ArachneResult {
  const transitionLength = params.transitionLength ?? 0.4 * params.wallWidth
  const empty: ArachneResult = {
    walls: [],
    gaps: computeGaps(outline, [], 10),
    skeleton: { nodes: [], edges: [] },
    beads: [],
  }
  if (outline.length === 0 || params.wallWidth <= 0) return empty

  const insetLines = arachneInsets(outline, params.wallWidth, params.wallCount)
  const coveredByInsets = unionAll(insetLines.flatMap(extrusionLineSausages))
  const remainder =
    coveredByInsets.length === 0 ? outline : difference(outline, coveredByInsets)

  const skeleton = pruneSkeleton(
    computeSkeleton(outline, params.skeletonSpacing),
    2 * params.skeletonSpacing,
  )

  // Centreline beads only patch up the nominal wall band: where the local
  // thickness exceeds 2 * wallCount * wallWidth the region is genuinely thick
  // interior and belongs to infill, so it must stay bead-free.
  const maxBeadThickness = 2 * params.wallCount * params.wallWidth
  const centrelines: ExtrusionLine[] = []
  for (const line of skeletonPolylines(skeleton)) {
    // Node -> bead width, only where the node lies in the uncovered remainder.
    const widths = line.map((idx) => {
      const node = skeleton.nodes[idx]
      if (2 * node.r > maxBeadThickness) return null
      if (!pointInPolygons(node.p, remainder)) return null
      return beadWidth(2 * node.r, params.wallWidth, params.minWidth)
    })
    // Maximal runs of consecutive beadable nodes become one centreline bead.
    let runStart = -1
    const flush = (end: number) => {
      if (runStart < 0 || end - runStart < 2) {
        runStart = -1
        return
      }
      const idxs = line.slice(runStart, end)
      const pts = idxs.map((i) => skeleton.nodes[i].p)
      const ds = idxs.map((i) => 2 * skeleton.nodes[i].r)
      const raw = widths.slice(runStart, end) as number[]
      let len = 0
      for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i])
      // Shorter stubs are gap-fill candidates, not walls.
      if (len < params.wallWidth / 2) {
        runStart = -1
        return
      }
      const ws =
        params.strategy === 'distributed'
          ? smoothWidths(pts, raw, ds, params.minWidth, transitionLength)
          : raw
      centrelines.push(pts.map((p, i) => ({ p, w: ws[i] })))
      runStart = -1
    }
    for (let k = 0; k < line.length; k++) {
      if (widths[k] !== null) {
        if (runStart < 0) runStart = k
      } else {
        flush(k)
      }
    }
    flush(line.length)
  }

  const beads: ArachneResult['beads'] = [
    ...insetLines.map((line) => ({ line, kind: 'inset' as const })),
    ...centrelines.map((line) => ({ line, kind: 'centreline' as const })),
  ]
  const walls = beads.map((b) => b.line)
  const covered = unionAll(beads.flatMap((b) => extrusionLineSausages(b.line)))
  // Same band-region gap semantics as constant walls. Regions thinner than
  // 2 * wallWidth lie entirely inside the band, so an explicit thin-remainder
  // term would be redundant; beads (or their absence below minWidth) decide.
  const band = wallBandRegion(outline, params.wallWidth, params.wallCount)
  return { walls, gaps: computeGaps(band, covered, 10), skeleton, beads }
}
