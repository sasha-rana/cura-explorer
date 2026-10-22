import type { SlicedLayer } from '../algorithms/types'
import {
  emptyPipelineResult,
  runPipeline,
  type PipelineParams,
  type PipelineResult,
} from './pipeline'

/**
 * Background, versioned cache for per-layer pipeline results.
 *
 * Running runPipeline() for every layer of a 150-layer STL slice is far too
 * slow to do synchronously — especially with Arachne skeletons — so the 3D
 * view fills this cache in small setTimeout chunks, keeping the UI responsive
 * and letting layers appear progressively as they finish.
 *
 * Performance fallback: with an 'arachne' strategy and more than
 * ARACHNE_FALLBACK_LAYERS layers, background layers are computed with the
 * 'constant' strategy; only the current layer (the range end) uses real
 * Arachne. At stack scale the visual difference is negligible and interaction
 * stays snappy.
 */

export const ARACHNE_FALLBACK_LAYERS = 60

interface Job {
  layers: SlicedLayer[]
  from: number
  to: number
  params: PipelineParams
  version: number
  next: number
}

export class PipelineCache {
  private cache = new Map<number, PipelineResult>()
  private job: Job | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private version = 0
  private chunkSize: number

  /** Called after each chunk and once at completion with (total, total). */
  onProgress: ((done: number, total: number) => void) | null = null
  /** Called whenever a layer result lands in the cache. */
  onLayerDone: (() => void) | null = null

  constructor(chunkSize = 2) {
    this.chunkSize = chunkSize
  }

  /** Sync cache lookup; undefined while a layer is pending or absent. */
  get(layerIndex: number): PipelineResult | undefined {
    return this.cache.get(layerIndex)
  }

  get size(): number {
    return this.cache.size
  }

  /** Params or source changed: drop everything, including any running job. */
  invalidate(): void {
    this.version++
    this.cache.clear()
    this.job = null
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * Schedule computation of layers [from, to] (inclusive, ascending).
   * Already-cached layers are skipped. Replaces any pending job.
   */
  ensureRange(layers: SlicedLayer[], from: number, to: number, params: PipelineParams): void {
    const hi = Math.min(to, layers.length - 1)
    const lo = Math.max(0, from)
    if (hi < lo || layers.length === 0) return
    this.job = { layers, from: lo, to: hi, params, version: this.version, next: lo }
    this.schedule()
  }

  /** Params actually used for layer i: the arachne fallback applies here. */
  private paramsFor(job: Job, i: number): PipelineParams {
    if (
      job.params.wallStrategy === 'arachne' &&
      job.layers.length > ARACHNE_FALLBACK_LAYERS &&
      i !== job.to
    ) {
      return { ...job.params, wallStrategy: 'constant' }
    }
    return job.params
  }

  private schedule(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.pump()
    }, 0)
  }

  private pump(): void {
    const job = this.job
    if (!job || job.version !== this.version) return
    const total = job.to - job.from + 1
    let computed = 0
    while (job.next <= job.to && computed < this.chunkSize) {
      const i = job.next++
      if (this.cache.has(i)) continue
      const layer = job.layers[i]
      // Empty slices cost nothing.
      if (!layer || layer.polygons.length === 0) {
        this.cache.set(i, emptyPipelineResult())
        this.onLayerDone?.()
        continue
      }
      let result: PipelineResult
      try {
        result = runPipeline(job.layers, i, this.paramsFor(job, i))
      } catch {
        result = emptyPipelineResult()
      }
      // A long compute may have been invalidated while running.
      if (job.version !== this.version) return
      this.cache.set(i, result)
      computed++
      this.onLayerDone?.()
    }
    const done = Math.min(job.next - job.from, total)
    this.onProgress?.(done, total)
    if (job.next <= job.to) {
      this.schedule()
    } else {
      this.job = null
      this.onProgress?.(total, total)
    }
  }
}
