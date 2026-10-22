import { beforeAll, describe, expect, it } from 'vitest'
import { initClipper } from '../geometry/clipper'
import type { SlicedLayer } from '../algorithms/types'
import { makeCubeMesh, sliceMesh } from '../algorithms/slicing'
import { presets } from '../presets/shapes'
import { defaultPipelineParams, runPipeline, type PipelineParams } from './pipeline'

const singleLayer = (id: keyof typeof presets): SlicedLayer[] => [
  { z: 0, polygons: presets[id].map((p) => ({ outer: [...p.outer], holes: [...p.holes] })), rawSegments: [] },
]

const params = (over: Partial<PipelineParams> = {}): PipelineParams => ({
  ...defaultPipelineParams,
  ...over,
})

beforeAll(async () => {
  await initClipper()
})

describe('runPipeline', () => {
  it('fills the thin wedge better with arachne than with constant walls', () => {
    const layers = singleLayer('thin-wedge')
    const constant = runPipeline(layers, 0, params({ wallStrategy: 'constant' }))
    const arachne = runPipeline(layers, 0, params({ wallStrategy: 'arachne' }))
    expect(constant.metrics.gapArea).toBeGreaterThan(0)
    expect(arachne.metrics.gapArea).toBeLessThan(constant.metrics.gapArea)
    expect(arachne.walls.skeleton?.nodes.length).toBeGreaterThan(0)
  })

  it('produces travel moves and sane metrics on two parts', () => {
    const result = runPipeline(singleLayer('two-parts'), 0, params())
    expect(result.moves.some((m) => m.kind === 'travel')).toBe(true)
    expect(result.metrics.travelLength).toBeGreaterThan(0)
    expect(result.metrics.estimatedTimeS).toBeGreaterThan(0)
    expect(result.metrics.extrusionLength).toBeGreaterThan(0)
  })

  it('gives the cube middle layer infill and no skin, layer 0 all skin', () => {
    const layers = sliceMesh(makeCubeMesh(30000), { layerHeight: 200 }).layers
    const mid = runPipeline(layers, Math.floor(layers.length / 2), params())
    expect(mid.infillLines.length).toBeGreaterThan(0)
    expect(mid.skinLines).toHaveLength(0)
    const first = runPipeline(layers, 0, params())
    expect(first.skinLines.length).toBeGreaterThan(0)
  })

  it('returns an empty result for empty input instead of crashing', () => {
    const result = runPipeline([], 0, params())
    expect(result.moves).toHaveLength(0)
    expect(result.metrics.estimatedTimeS).toBe(0)
  })
})
