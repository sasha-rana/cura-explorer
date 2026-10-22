import { difference, offset, offsetPolyline, union } from '../geometry/clipper'
import { polygonArea } from '../geometry/polyUtils'
import type { ExtrusionLine, Polygon, Ring } from '../geometry/types'
import type { StageDoc, WallResult } from './types'

export const constantWallsDoc: StageDoc = {
  title: 'Constant-width walls',
  explanation: `## The idea
Extrude every wall at the same fixed line width: place each centreline by insetting the outline, and accept whatever geometry that produces — including the gaps.

## Step by step
1. Wall i's centreline is \`offset(outline, -(wallWidth / 2 + i * wallWidth))\`, for i = 0 .. \`wallCount\` - 1, outermost first.
2. Every ring of every inset (outer rings and hole rings) becomes one closed extrusion line of width \`wallWidth\`.
3. The **wall band** — outline minus outline eroded by \`wallCount * wallWidth\` — is the region walls are responsible for; anything deeper is infill's job.
4. Coverage is measured by unioning a "sausage" (round offset of half the width) around every wall line.
5. \`gaps = band - covered\`, with slivers thinner than \`minGapWidth\` (10 µm by default) dropped as noise. Where the part is thinner than the full band, the erosion vanishes and the whole thin feature lies inside the band.

## Key formulas / rules
- \`centreline i distance from boundary = (i + 1/2) * wallWidth\`
- \`wall band = outline - offset(outline, -(wallCount * wallWidth))\`

## Edge cases & simplifications
- A region thinner than one line width produces **no** toolpath at all: erosion deletes the ring, even though a slightly narrower bead would fit.
- Sharp convex corners are never fully covered — the bead is round around the centreline corner while the outline corner is square, leaving unfilled wedges.
- Where a wall doubles back on itself the two passes overlap heavily; Cura compensates by reducing flow, we just show it.
- This is the limitation Arachne removes: width is fixed first and geometry has to adapt, instead of the other way around.

## Try it
- Thin wedge preset → stage 3, strategy **Constant width**, toggle **Gap regions**: the tip stays empty.
- Sharp-corner star preset: gaps light up at every point.
- Press **Compare** to see the same layer planned by Arachne.`,
  curaRef: 'src/WallsComputation.cpp',
  refs: [
    {
      label: 'CuraEngine wiki: Generating Paths',
      url: 'https://github.com/Ultimaker/CuraEngine/wiki/Generating-Paths',
    },
  ],
}

export interface ConstantWallParams {
  wallWidth: number
  wallCount: number
  /** Gaps thinner than this are ignored, microns. */
  minGapWidth?: number
}

/** Gap polygons smaller than this area (µm²) are dropped as discretization noise. */
const GAP_AREA_EPSILON = 100

/** Closed ring -> closed ExtrusionLine; the last junction repeats the first. */
export function ringToWallLine(ring: Ring, w: number): ExtrusionLine {
  const line: ExtrusionLine = ring.map((p) => ({ p: { x: p.x, y: p.y }, w }))
  if (line.length > 0) line.push({ p: { ...line[0].p }, w })
  return line
}

/**
 * Area covered by extruding a (possibly variable-width) line: the union of
 * "sausages" around near-constant-width chunks of the path. Splitting at width
 * jumps keeps a tapering bead from being over-approximated by its widest part.
 */
export function extrusionLineSausages(line: ExtrusionLine): Polygon[] {
  const out: Polygon[] = []
  let start = 0
  let minW = line.length > 0 ? line[0].w : 0
  for (let k = 1; k < line.length; k++) {
    if (Math.abs(line[k].w - line[k - 1].w) > Math.max(5, line[k - 1].w * 0.02)) {
      if (k - start >= 2) {
        out.push(...offsetPolyline(line.slice(start, k).map((j) => j.p), minW / 2))
      }
      start = k - 1
      minW = Math.min(line[k - 1].w, line[k].w)
    } else {
      minW = Math.min(minW, line[k].w)
    }
  }
  if (line.length - start >= 2) {
    out.push(...offsetPolyline(line.slice(start).map((j) => j.p), minW / 2))
  }
  return out
}

export function unionAll(polys: Polygon[]): Polygon[] {
  return polys.length === 0 ? [] : union(polys)
}

/** Region the walls are responsible for, minus slivers below minGapWidth. */
export function computeGaps(
  region: Polygon[],
  covered: Polygon[],
  minGapWidth: number,
): Polygon[] {
  const raw = covered.length === 0 ? region : difference(region, covered)
  return raw.filter(
    (g) => polygonArea(g) > GAP_AREA_EPSILON && offset([g], -minGapWidth / 2).length > 0,
  )
}

/**
 * The wall band: the area the walls are supposed to cover, between the outline
 * and the innermost inset. Where the part is thinner than wallCount *
 * wallWidth the erosion vanishes, so a thin feature lies entirely in the band.
 * Anything deeper is infill's job, not a wall gap.
 */
export function wallBandRegion(
  outline: Polygon[],
  wallWidth: number,
  wallCount: number,
): Polygon[] {
  const inner = offset(outline, -(wallCount * wallWidth))
  return inner.length === 0 ? outline : difference(outline, inner)
}

export function computeConstantWalls(
  outline: Polygon[],
  params: ConstantWallParams,
): WallResult {
  const minGapWidth = params.minGapWidth ?? 10
  const walls: ExtrusionLine[] = []
  // Outermost-first: every ring of every inset level becomes one closed wall.
  for (let i = 0; i < params.wallCount; i++) {
    const inset = offset(outline, -(params.wallWidth / 2 + i * params.wallWidth))
    for (const poly of inset) {
      for (const ring of [poly.outer, ...poly.holes]) {
        walls.push(ringToWallLine(ring, params.wallWidth))
      }
    }
  }
  const covered = unionAll(walls.flatMap(extrusionLineSausages))
  const band = wallBandRegion(outline, params.wallWidth, params.wallCount)
  return { walls, gaps: computeGaps(band, covered, minGapWidth) }
}
