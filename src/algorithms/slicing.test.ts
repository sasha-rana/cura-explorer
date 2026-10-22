import { beforeAll, describe, expect, it } from 'vitest'
import { initClipper } from '../geometry/clipper'
import { polygonsArea } from '../geometry/polyUtils'
import { makeCubeMesh, makePyramidMesh, sliceMesh } from './slicing'

const MM2 = 1_000_000 // square microns per mm²

beforeAll(async () => {
  await initClipper()
})

describe('sliceMesh', () => {
  it('slices a 20 mm cube into 20 square layers', () => {
    const { layers } = sliceMesh(makeCubeMesh(20_000), { layerHeight: 1000 })
    expect(layers).toHaveLength(20)
    expect(layers[0].z).toBeCloseTo(500)
    expect(layers[19].z).toBeCloseTo(19_500)
    for (const layer of layers) {
      expect(layer.polygons).toHaveLength(1)
      expect(layer.polygons[0].holes).toHaveLength(0)
      // 20 mm x 20 mm = 400 mm²
      expect(polygonsArea(layer.polygons)).toBeCloseTo(400 * MM2, -3)
      // 8 segments per layer: 2 triangles per side face x 4 faces
      expect(layer.rawSegments).toHaveLength(8)
    }
  })

  it('slices a pyramid into layers of decreasing area', () => {
    const { layers } = sliceMesh(makePyramidMesh(20_000, 20_000), { layerHeight: 1000 })
    expect(layers).toHaveLength(20)
    for (const layer of layers) {
      expect(layer.polygons.length).toBeGreaterThan(0)
      expect(layer.rawSegments.length).toBeGreaterThan(0)
    }
    for (let i = 1; i < layers.length; i++) {
      expect(polygonsArea(layers[i].polygons)).toBeLessThan(polygonsArea(layers[i - 1].polygons))
    }
    // Linear taper: layer at z=500 spans 19.5 mm -> ~380.25 mm²
    expect(polygonsArea(layers[0].polygons)).toBeCloseTo(380.25 * MM2, -3)
  })

  it('patches small gaps in a non-watertight mesh', () => {
    const mesh = makeCubeMesh(20_000)
    // Nudge one vertex of a side-face triangle by 50 microns, opening a small
    // gap between its segments and the neighbouring triangles' segments.
    mesh[4] = { ...mesh[4], c: { ...mesh[4].c, x: mesh[4].c.x + 50 } }
    const { layers } = sliceMesh(mesh, { layerHeight: 1000 })
    expect(layers).toHaveLength(20)
    for (const layer of layers) {
      expect(layer.polygons.length).toBeGreaterThanOrEqual(1)
      expect(Math.abs(polygonsArea(layer.polygons) - 400 * MM2)).toBeLessThan(2 * MM2)
    }
  })
})

describe('mesh fixtures', () => {
  it('makeCubeMesh produces 12 triangles with per-triangle vertices', () => {
    const mesh = makeCubeMesh(10_000)
    expect(mesh).toHaveLength(12)
    mesh[0].a.x = -1
    expect(mesh[1].a.x).not.toBe(-1)
  })

  it('makePyramidMesh produces 6 triangles', () => {
    expect(makePyramidMesh(20_000, 10_000)).toHaveLength(6)
  })
})
