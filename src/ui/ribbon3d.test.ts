import { describe, expect, it } from 'vitest'
import type { ExtrusionLine } from '../geometry/types'
import { buildRibbons } from './ribbon3d'

const line = (pts: { x: number; y: number }[], w: number | number[]): ExtrusionLine =>
  pts.map((p, i) => ({ p, w: Array.isArray(w) ? w[i] : w }))

const RED: [number, number, number] = [0.875, 0.242, 0.176]

describe('buildRibbons', () => {
  it('builds a 4-vertex, 2-triangle ribbon for a straight 2-junction line', () => {
    const r = buildRibbons([line([{ x: 0, y: 0 }, { x: 1000, y: 0 }], 400)], 1000, RED)
    expect(r.positions.length).toBe(4 * 3)
    expect(r.indices.length).toBe(6)
    // ±200 offsets along ±Y for a line running along +X.
    expect([...r.positions.slice(0, 12)]).toEqual([
      0, 200, 1000,
      0, -200, 1000,
      1000, 200, 1000,
      1000, -200, 1000,
    ])
    for (let i = 0; i < 4; i++) {
      expect(r.positions[i * 3 + 2]).toBe(1000) // flat at z
      expect([r.normals[i * 3], r.normals[i * 3 + 1], r.normals[i * 3 + 2]]).toEqual([0, 0, 1])
      // Float32 rounding: compare colors approximately.
      expect(r.colors[i * 3]).toBeCloseTo(RED[0], 6)
      expect(r.colors[i * 3 + 1]).toBeCloseTo(RED[1], 6)
      expect(r.colors[i * 3 + 2]).toBeCloseTo(RED[2], 6)
    }
  })

  it('miters the middle junction of a 90° turn', () => {
    const r = buildRibbons(
      [line([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }], 400)],
      0,
      RED,
    )
    expect(r.positions.length).toBe(6 * 3)
    expect(r.indices.length).toBe(12)
    // At the corner the miter direction is normalize(nPrev + nNext) = (-1,1)/√2
    // and its length is (w/2)/cos(45°) = 200·√2, giving integer offsets (-200,+200).
    const mx = r.positions[2 * 3]
    const my = r.positions[2 * 3 + 1]
    expect(mx).toBeCloseTo(800, 3)
    expect(my).toBeCloseTo(200, 3)
    expect(r.positions[3 * 3]).toBeCloseTo(1200, 3)
    expect(r.positions[3 * 3 + 1]).toBeCloseTo(-200, 3)
  })

  it('offsets each junction by its own width', () => {
    const r = buildRibbons(
      [line([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 2000, y: 0 }], [400, 600, 200])],
      0,
      RED,
    )
    expect(r.positions[1]).toBeCloseTo(200, 3) // junction 0: +w0/2
    expect(r.positions[2 * 3 + 1]).toBeCloseTo(300, 3) // junction 1: +w1/2
    expect(r.positions[4 * 3 + 1]).toBeCloseTo(100, 3) // junction 2: +w2/2
    expect(r.positions[3 * 3 + 1]).toBeCloseTo(-300, 3) // negative side follows too
  })

  it('clamps the miter at a hairpin turn instead of spiking', () => {
    const r = buildRibbons(
      [line([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 100, y: 10 }], 400)],
      0,
      RED,
    )
    const dx = r.positions[2 * 3] - 1000
    const dy = r.positions[2 * 3 + 1]
    expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(2 * 400 + 1e-3)
  })

  it('merges several lines and skips degenerate ones', () => {
    const r = buildRibbons(
      [
        line([{ x: 0, y: 0 }, { x: 100, y: 0 }], 400),
        line([{ x: 5, y: 5 }], 400), // single junction: skipped
        line([{ x: 0, y: 100 }, { x: 100, y: 100 }], 400),
      ],
      0,
      RED,
    )
    expect(r.positions.length).toBe(8 * 3)
    expect(r.indices.length).toBe(12)
  })

  it('returns empty arrays for no lines', () => {
    const r = buildRibbons([], 0, RED)
    expect(r.positions.length).toBe(0)
    expect(r.indices.length).toBe(0)
  })
})
