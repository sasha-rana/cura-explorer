import type { ExtrusionLine, Point } from '../geometry/types'

/**
 * Flat ribbon geometry for extrusion lines, ready to upload as a three.js
 * BufferGeometry. Pure and DOM-free so it can be unit-tested without WebGL.
 *
 * World mapping: the 2D layer plane is XY (microns), Z is up (layer height),
 * so positions are [x, y, z] and every vertex normal is +Z. Each junction of a
 * polyline produces two vertices offset ±w/2 along the 2D miter normal; the
 * miter length is clamped to 2×w to avoid spikes at sharp turns.
 */

export interface RibbonData {
  /** 3 floats per vertex: x, y, z (microns). */
  positions: Float32Array
  /** 3 floats per vertex, all (0, 0, 1). */
  normals: Float32Array
  /** 3 floats per vertex: r, g, b in 0..1. */
  colors: Float32Array
  indices: Uint32Array
}

/** The miter offset may not exceed this multiple of the line width. */
const MITER_LIMIT = 2

interface Miter {
  ox: number
  oy: number
}

/** Unit left normal of direction d. */
const normalOf = (dx: number, dy: number): Point => ({ x: -dy, y: dx })

/**
 * Offset vector (one side) at junction i: half the width along the miter
 * normal, clamped so the offset magnitude never exceeds MITER_LIMIT * w.
 */
function miterAt(pts: Point[], ws: number[], i: number): Miter {
  const p = pts[i]
  const w = ws[i]
  const seg = (a: Point, b: Point): Point | null => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    return len > 0 ? { x: dx / len, y: dy / len } : null
  }
  const dPrev = i > 0 ? seg(pts[i - 1], p) : null
  const dNext = i < pts.length - 1 ? seg(p, pts[i + 1]) : null

  let mx: number
  let my: number
  let cosHalf = 1
  if (dPrev && dNext) {
    const nPrev = normalOf(dPrev.x, dPrev.y)
    const nNext = normalOf(dNext.x, dNext.y)
    const sx = nPrev.x + nNext.x
    const sy = nPrev.y + nNext.y
    const slen = Math.hypot(sx, sy)
    if (slen < 1e-9) {
      // 180° reversal: fall back to the incoming normal.
      mx = nPrev.x
      my = nPrev.y
    } else {
      mx = sx / slen
      my = sy / slen
      cosHalf = mx * nPrev.x + my * nPrev.y
    }
  } else {
    const d = dNext ?? dPrev
    if (!d) return { ox: 0, oy: 0 }
    const n = normalOf(d.x, d.y)
    mx = n.x
    my = n.y
  }
  // offset = (w/2) / cos(half-angle); clamping cos >= 1/(2*MITER_LIMIT) bounds
  // the offset magnitude to MITER_LIMIT * w.
  const minCos = 1 / (2 * MITER_LIMIT)
  const c = Math.max(minCos, cosHalf)
  const len = w / 2 / c
  return { ox: mx * len, oy: my * len }
}

/**
 * Merge all lines into one ribbon mesh at height z (microns). Lines with fewer
 * than two junctions are skipped. Every vertex carries the given color.
 */
export function buildRibbons(
  lines: ExtrusionLine[],
  z: number,
  color: [number, number, number],
): RibbonData {
  const usable = lines.filter((l) => l.length >= 2)
  let vertCount = 0
  for (const l of usable) vertCount += l.length * 2

  const positions = new Float32Array(vertCount * 3)
  const normals = new Float32Array(vertCount * 3)
  const colors = new Float32Array(vertCount * 3)
  const indices = new Uint32Array(usable.reduce((s, l) => s + (l.length - 1) * 6, 0))

  let v = 0
  let k = 0
  for (const line of usable) {
    const pts = line.map((j) => j.p)
    const ws = line.map((j) => j.w)
    const base = v
    for (let i = 0; i < pts.length; i++) {
      const { ox, oy } = miterAt(pts, ws, i)
      for (const s of [1, -1]) {
        positions[v * 3] = pts[i].x + ox * s
        positions[v * 3 + 1] = pts[i].y + oy * s
        positions[v * 3 + 2] = z
        normals[v * 3 + 2] = 1
        colors[v * 3] = color[0]
        colors[v * 3 + 1] = color[1]
        colors[v * 3 + 2] = color[2]
        v++
      }
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = base + i * 2
      indices[k++] = a
      indices[k++] = a + 1
      indices[k++] = a + 2
      indices[k++] = a + 1
      indices[k++] = a + 3
      indices[k++] = a + 2
    }
  }
  return { positions, normals, colors, indices }
}
