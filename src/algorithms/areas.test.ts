import { beforeAll, describe, expect, it } from 'vitest'
import { initClipper } from '../geometry/clipper'
import { polygonsArea } from '../geometry/polyUtils'
import { makeCubeMesh, sliceMesh } from './slicing'
import { classifyAreas, type AreaParams } from './areas'

const MM2 = 1_000_000

const params: AreaParams = { wallWidth: 400, wallCount: 2, topLayers: 3, bottomLayers: 3 }

beforeAll(async () => {
  await initClipper()
})

describe('classifyAreas', () => {
  // 20 mm cube, 1 mm layers; 2 walls x 0.4 mm -> interior inset by 0.8 mm.
  const layers = sliceMesh(makeCubeMesh(20_000), { layerHeight: 1000 }).layers
  const OUTLINE = 400 * MM2 // 20 mm square
  const INTERIOR = 338.56 * MM2 // 18.4 mm square
  const WALL_BAND = OUTLINE - INTERIOR
  const INNER = 384.16 * MM2 // 19.6 mm square (0.2 mm inset)

  it('computes the wall band and inner area on a middle layer', () => {
    const areas = classifyAreas(layers, 10, params)
    expect(polygonsArea(areas.wallsRegion)).toBeCloseTo(WALL_BAND, -5)
    expect(polygonsArea(areas.innerArea)).toBeCloseTo(INNER, -5)
  })

  it('gives middle layers no skin and a full infill region', () => {
    const areas = classifyAreas(layers, 10, params)
    expect(areas.skin).toHaveLength(0)
    expect(polygonsArea(areas.infillRegion)).toBeCloseTo(INTERIOR, -5)
  })

  it('classifies the first layer as all skin', () => {
    const areas = classifyAreas(layers, 0, params)
    expect(polygonsArea(areas.skin)).toBeCloseTo(INTERIOR, -5)
    expect(polygonsArea(areas.infillRegion)).toBeCloseTo(0, -5)
  })

  it('classifies the last layer as all skin', () => {
    const areas = classifyAreas(layers, layers.length - 1, params)
    expect(polygonsArea(areas.skin)).toBeCloseTo(INTERIOR, -5)
    expect(polygonsArea(areas.infillRegion)).toBeCloseTo(0, -5)
  })

  it('treats a single-layer input as fully exposed (all interior is skin)', () => {
    const areas = classifyAreas([layers[10]], 0, params)
    expect(polygonsArea(areas.skin)).toBeCloseTo(INTERIOR, -5)
    expect(areas.infillRegion).toHaveLength(0)
  })
})
