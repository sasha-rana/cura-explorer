import { beforeAll, describe, expect, it } from 'vitest'
import { initClipper } from '../geometry/clipper'
import { polygonsArea, polylineLength } from '../geometry/polyUtils'
import type { ExtrusionLine, Polygon } from '../geometry/types'
import { computeConstantWalls } from './wallsConstant'
import {
  computeArachneWalls,
  type ArachneResult,
  type BeadingStrategy,
} from './wallsArachne'

const rect = (w: number, h: number): Polygon => ({
  outer: [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ],
  holes: [],
})

/** 20 mm base tapering to a point over 40 mm. */
const wedge: Polygon = {
  outer: [
    { x: 0, y: -10_000 },
    { x: 0, y: 10_000 },
    { x: 40_000, y: 0 },
  ],
  holes: [],
}

/** Trapezoid tapering from 1300 to 700 µm over 30 mm. */
const trapezoid: Polygon = {
  outer: [
    { x: 0, y: 0 },
    { x: 30_000, y: 300 },
    { x: 30_000, y: 1000 },
    { x: 0, y: 1300 },
  ],
  holes: [],
}

/** 40x40 mm plate with a centered 15 mm hole. */
const washer: Polygon = {
  outer: [
    { x: 0, y: 0 },
    { x: 40_000, y: 0 },
    { x: 40_000, y: 40_000 },
    { x: 0, y: 40_000 },
  ],
  holes: [
    [
      { x: 12_500, y: 12_500 },
      { x: 27_500, y: 12_500 },
      { x: 27_500, y: 27_500 },
      { x: 12_500, y: 27_500 },
    ],
  ],
}

const arachne = (
  outline: Polygon[],
  strategy: BeadingStrategy = 'constant',
  minWidth = 300,
): ArachneResult =>
  computeArachneWalls(outline, {
    wallWidth: 400,
    wallCount: 2,
    minWidth,
    strategy,
    skeletonSpacing: 50,
  })

const gapArea = (r: { gaps: Polygon[] }) => polygonsArea(r.gaps)

const extrusionLength = (walls: ExtrusionLine[]) =>
  walls.reduce((s, l) => s + polylineLength(l.map((j) => j.p)), 0)

/** Largest |Δw| between adjacent junctions over all centreline beads. */
const maxWidthJump = (r: ArachneResult) => {
  let jump = 0
  for (const b of r.beads) {
    if (b.kind !== 'centreline') continue
    for (let i = 1; i < b.line.length; i++) {
      jump = Math.max(jump, Math.abs(b.line[i].w - b.line[i - 1].w))
    }
  }
  return jump
}

beforeAll(async () => {
  await initClipper()
})

describe('constant walls', () => {
  it('generates one closed ring per wall, outermost first', () => {
    const r = computeConstantWalls([rect(10_000, 10_000)], { wallWidth: 400, wallCount: 2 })
    expect(r.walls).toHaveLength(2)
    for (const wall of r.walls) {
      expect(wall[0].p).toEqual(wall[wall.length - 1].p) // closed
      expect(wall.every((j) => j.w === 400)).toBe(true)
    }
    const outerSize = Math.max(...r.walls[0].map((j) => j.p.x))
    const innerSize = Math.max(...r.walls[1].map((j) => j.p.x))
    expect(outerSize).toBeCloseTo(9800, -1)
    expect(innerSize).toBeCloseTo(9400, -1)
  })

  it('leaves gaps at sharp corners of a square', () => {
    // 2 x 2 beads exactly tile this square, so only the corners stay uncovered.
    const r = computeConstantWalls([rect(1600, 1600)], { wallWidth: 400, wallCount: 2 })
    expect(r.gaps.length).toBeGreaterThan(0)
    expect(gapArea(r)).toBeLessThan(100_000)
  })

  it('does not report the infill interior as a gap', () => {
    // 10 mm square with 2 walls: the 8.4 mm core is infill's job, not a gap.
    const r = computeConstantWalls([rect(10_000, 10_000)], { wallWidth: 400, wallCount: 2 })
    expect(gapArea(r)).toBeLessThan(100_000)
  })

  it('cannot produce walls thinner than one line width', () => {
    const r = computeConstantWalls([rect(20_000, 350)], { wallWidth: 400, wallCount: 1 })
    expect(r.walls).toHaveLength(0)
    expect(gapArea(r)).toBeGreaterThan(6_000_000) // the whole 20 x 0.35 mm bar
  })
})

describe('arachne walls', () => {
  it('matches constant walls on a 40x10 rectangle, with no centrelines', () => {
    const outline = [rect(40_000, 10_000)]
    const c = computeConstantWalls(outline, { wallWidth: 400, wallCount: 2 })
    const a = arachne(outline)
    expect(a.beads.filter((b) => b.kind === 'inset')).toHaveLength(2)
    expect(a.beads.filter((b) => b.kind === 'centreline')).toHaveLength(0)
    expect(gapArea(c)).toBeLessThan(1_000_000) // < 0.25 % of the 400 mm² outline
    expect(gapArea(a)).toBeLessThan(1_000_000)
  })

  it('matches constant walls on a washer and stays bead-free in the thick ring', () => {
    const c = computeConstantWalls([washer], { wallWidth: 400, wallCount: 2 })
    const a = arachne([washer])
    expect(c.walls).toHaveLength(4) // two inset levels x (outer ring + hole ring)
    expect(gapArea(c)).toBeLessThan(5_000_000) // 5 mm²; corner slivers only
    expect(gapArea(a)).toBeLessThan(Math.max(gapArea(c) * 2, 5_000_000))
    const lengthC = extrusionLength(c.walls)
    const lengthA = extrusionLength(a.walls)
    expect(Math.abs(lengthA - lengthC)).toBeLessThan(lengthC * 0.15)
    // No centreline beads in the thick interior; corner stubs are gap-fill size.
    const centrelines = a.beads.filter((b) => b.kind === 'centreline')
    expect(extrusionLength(centrelines.map((b) => b.line))).toBeLessThan(lengthC * 0.01)
  })

  it('fills the thin wedge much better than constant walls', () => {
    const c = computeConstantWalls([wedge], { wallWidth: 400, wallCount: 2 })
    // minWidth 100 so the centreline bead can follow the taper close to the tip.
    const a = arachne([wedge], 'constant', 100)
    const gapC = gapArea(c)
    const gapA = gapArea(a)
    expect(gapC).toBeGreaterThan(100_000) // the uncovered tip band
    expect(gapA).toBeLessThan(gapC * 0.5)

    const centrelines = a.beads.filter((b) => b.kind === 'centreline').map((b) => b.line)
    expect(centrelines.length).toBeGreaterThan(0)

    // The bead reaching furthest toward the tip out-reaches any constant wall.
    const maxX = (l: ExtrusionLine) => Math.max(...l.map((j) => j.p.x))
    const tipBead = centrelines.reduce((p, q) => (maxX(p) > maxX(q) ? p : q))
    const maxXConstant = Math.max(...c.walls.flatMap((w) => w.map((j) => j.p.x)))
    expect(maxX(tipBead)).toBeGreaterThan(maxXConstant + 100)

    // In the sub-line-width regime the bead width tapers monotonically-ish
    // toward the tip, staying >= minWidth.
    const pts = [...tipBead].sort((p, q) => p.p.x - q.p.x)
    const last = pts[pts.length - 1]
    expect(last.w).toBeLessThan(400)
    expect(last.w).toBeGreaterThanOrEqual(100 - 1)
    expect(pts[0].w).toBeGreaterThan(last.w)
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].w).toBeLessThanOrEqual(pts[i - 1].w * 1.1 + 5)
    }
  })

  it('fills a 0.7 mm wall with one inset, like constant walls', () => {
    const c = computeConstantWalls([rect(20_000, 700)], { wallWidth: 400, wallCount: 1 })
    expect(c.walls).toHaveLength(1)
    expect(gapArea(c)).toBeLessThan(50_000)
    const a = arachne([rect(20_000, 700)])
    expect(a.beads.filter((b) => b.kind === 'inset')).toHaveLength(1)
    expect(gapArea(a)).toBeLessThan(50_000)
  })

  it('matches the exact width of a 0.5 mm wall with a single centreline bead', () => {
    const a = arachne([rect(20_000, 500)])
    expect(a.beads.filter((b) => b.kind === 'inset')).toHaveLength(0)
    const centrelines = a.beads.filter((b) => b.kind === 'centreline').map((b) => b.line)
    expect(centrelines.length).toBeGreaterThan(0)
    const longest = centrelines.reduce((p, q) => (p.length > q.length ? p : q))
    for (const j of longest) {
      expect(j.w).toBeGreaterThan(480)
      expect(j.w).toBeLessThan(520)
    }
    expect(gapArea(a)).toBeLessThan(200_000)
  })

  it('produces a bead where constant walls produce nothing (0.35 mm wall)', () => {
    const c = computeConstantWalls([rect(20_000, 350)], { wallWidth: 400, wallCount: 2 })
    expect(c.walls).toHaveLength(0)
    expect(gapArea(c)).toBeGreaterThan(6_000_000)
    const a = arachne([rect(20_000, 350)])
    const centrelines = a.beads.filter((b) => b.kind === 'centreline').map((b) => b.line)
    expect(centrelines.length).toBeGreaterThan(0)
    const longest = centrelines.reduce((p, q) => (p.length > q.length ? p : q))
    for (const j of longest) {
      expect(j.w).toBeGreaterThan(325)
      expect(j.w).toBeLessThan(375)
    }
    expect(gapArea(a)).toBeLessThan(100_000)
  })

  it('spreads width jumps with the distributed strategy', () => {
    const c = computeConstantWalls([trapezoid], { wallWidth: 400, wallCount: 2 })
    const constant = arachne([trapezoid], 'constant')
    const distributed = arachne([trapezoid], 'distributed')
    expect(gapArea(distributed)).toBeLessThan(gapArea(c) * 0.5)
    expect(maxWidthJump(distributed)).toBeLessThan(maxWidthJump(constant) * 0.75)
  })

  it('handles shapes with holes and is deterministic', () => {
    const donut: Polygon = {
      outer: [
        { x: 0, y: 0 },
        { x: 20_000, y: 0 },
        { x: 20_000, y: 20_000 },
        { x: 0, y: 20_000 },
      ],
      holes: [
        [
          { x: 500, y: 500 },
          { x: 19_500, y: 500 },
          { x: 19_500, y: 19_500 },
          { x: 500, y: 19_500 },
        ],
      ],
    }
    const a1 = arachne([donut])
    const a2 = arachne([donut])
    expect(a1.beads.filter((b) => b.kind === 'centreline').length).toBeGreaterThan(0)
    expect(JSON.stringify(a1.walls)).toBe(JSON.stringify(a2.walls))
    expect(JSON.stringify(a1.gaps)).toBe(JSON.stringify(a2.gaps))
  })
})
