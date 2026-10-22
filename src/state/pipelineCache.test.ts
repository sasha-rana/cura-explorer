import { beforeAll, describe, expect, it } from 'vitest'
import { initClipper } from '../geometry/clipper'
import { makeCubeMesh, sliceMesh } from '../algorithms/slicing'
import type { SlicedLayer } from '../algorithms/types'
import { presets } from '../presets/shapes'
import { defaultPipelineParams } from './pipeline'
import { PipelineCache } from './pipelineCache'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitForDone(cache: PipelineCache, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  let done = false
  const prev = cache.onProgress
  cache.onProgress = (d, t) => {
    prev?.(d, t)
    if (d >= t) done = true
  }
  while (!done && Date.now() - start < timeoutMs) await sleep(5)
  if (!done) throw new Error('cache did not finish in time')
}

const presetLayer = (id: keyof typeof presets): SlicedLayer => ({
  z: 0,
  polygons: presets[id],
  rawSegments: [],
})

beforeAll(async () => {
  await initClipper()
})

describe('PipelineCache', () => {
  it('fills progressively in ascending order', async () => {
    const cache = new PipelineCache(1) // one layer per tick
    const layers: SlicedLayer[] = Array.from({ length: 5 }, () => presetLayer('two-parts'))
    const progress: [number, number][] = []
    cache.onProgress = (d, t) => progress.push([d, t])
    cache.ensureRange(layers, 0, 4, defaultPipelineParams)
    // Not synchronous: nothing cached immediately after scheduling.
    expect(cache.get(4)).toBeUndefined()
    await sleep(30)
    expect(cache.get(0)).toBeDefined()
    await waitForDone(cache)
    for (let i = 0; i < 5; i++) expect(cache.get(i)).toBeDefined()
    expect(progress[progress.length - 1]).toEqual([5, 5])
  })

  it('invalidate() clears results and drops the pending job', async () => {
    const cache = new PipelineCache(1)
    const layers: SlicedLayer[] = Array.from({ length: 4 }, () => presetLayer('two-parts'))
    cache.ensureRange(layers, 0, 3, defaultPipelineParams)
    await waitForDone(cache)
    expect(cache.get(0)).toBeDefined()
    cache.invalidate()
    expect(cache.get(0)).toBeUndefined()
    expect(cache.size).toBe(0)
    // A new job after invalidation works fine.
    cache.ensureRange(layers, 0, 1, defaultPipelineParams)
    await waitForDone(cache)
    expect(cache.get(0)).toBeDefined()
  })

  it('skips empty layers cheaply and marks them done', async () => {
    const cache = new PipelineCache(1)
    const empty: SlicedLayer = { z: 0, polygons: [], rawSegments: [] }
    const layers: SlicedLayer[] = [empty, presetLayer('two-parts'), empty]
    cache.ensureRange(layers, 0, 2, defaultPipelineParams)
    await waitForDone(cache)
    expect(cache.get(0)?.moves).toHaveLength(0)
    expect(cache.get(2)?.moves).toHaveLength(0)
    expect(cache.get(1)!.moves.length).toBeGreaterThan(0)
  })

  it('falls back to constant walls for non-current layers on tall arachne stacks', async () => {
    const cache = new PipelineCache(4)
    const layers = sliceMesh(makeCubeMesh(30000), { layerHeight: 400 }).layers
    expect(layers.length).toBeGreaterThan(60)
    const last = layers.length - 1
    cache.ensureRange(layers, 0, last, {
      ...defaultPipelineParams,
      layerHeight: 400,
      wallStrategy: 'arachne',
    })
    await waitForDone(cache, 30000)
    const bg = cache.get(0)
    const current = cache.get(last)
    expect(bg).toBeDefined()
    expect(current).toBeDefined()
    // Constant-width results carry no skeleton; arachne results do.
    expect(bg!.walls.skeleton).toBeUndefined()
    expect(current!.walls.skeleton).toBeDefined()
  })

  it('uses real arachne on every layer of short stacks', async () => {
    const cache = new PipelineCache(2)
    const layers = sliceMesh(makeCubeMesh(6000), { layerHeight: 1000 }).layers
    expect(layers.length).toBeLessThanOrEqual(60)
    cache.ensureRange(layers, 0, layers.length - 1, {
      ...defaultPipelineParams,
      wallStrategy: 'arachne',
    })
    await waitForDone(cache)
    expect(cache.get(0)!.walls.skeleton).toBeDefined()
  })
})
