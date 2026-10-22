import { beforeAll, describe, expect, it } from 'vitest'
import { initClipper } from '../geometry/clipper'
import { presets } from '../presets/shapes'
import {
  defaultPipelineParams,
  runPipeline,
  runPipelineWithPseudocode,
  type PipelineParams,
} from '../state/pipeline'
import {
  instrumentPseudocode,
  PSEUDOCODE_STAGES,
  type PseudocodeKey,
} from './pseudocode'
import { makeCubeMesh, sliceMesh } from './slicing'
import type { SlicedLayer } from './types'

const singleLayer = (id: keyof typeof presets): SlicedLayer[] => [
  {
    z: 0,
    polygons: presets[id].map((p) => ({ outer: [...p.outer], holes: [...p.holes] })),
    rawSegments: [],
  },
]

const makeParams = (over: Partial<PipelineParams> = {}): PipelineParams => ({
  ...defaultPipelineParams,
  ...over,
})

beforeAll(async () => {
  await initClipper()
})

describe('pseudocode engine', () => {
  it('instruments step() calls with 1-based line numbers while preserving comments', () => {
    const src = [
      '// step(ignored in comment)',
      'const a = 1',
      "step('First', a)",
    ].join('\n')
    const out = instrumentPseudocode(src).split('\n')
    expect(out[0]).toBe('// step(ignored in comment)')
    expect(out[2]).toContain('__step(3, ')
  })

  it('executes every stage default pseudocode cleanly and matches native pipeline metrics', () => {
    const cubeLayers = sliceMesh(makeCubeMesh(20000), { layerHeight: 200 }).layers
    const midIdx = Math.floor(cubeLayers.length / 2)

    const keys: PseudocodeKey[] = [
      'slicing',
      'areas',
      'walls-constant',
      'walls-arachne',
      'infill',
      'order',
      'travel',
    ]

    for (const key of keys) {
      const strategy = key === 'walls-constant' ? 'constant' : 'arachne'
      const p = makeParams({ wallStrategy: strategy })
      const native = runPipeline(cubeLayers, midIdx, p)
      const { result, pseudoRun } = runPipelineWithPseudocode(cubeLayers, midIdx, p, {
        activeKey: key,
        driveLayer: true,
      })

      expect(pseudoRun.ok, `stage ${key} failed: ${pseudoRun.error}`).toBe(true)
      expect(pseudoRun.steps.length).toBeGreaterThan(1)
      expect(
        pseudoRun.steps.every(
          (s) =>
            s.line >= 1 &&
            s.details.startLine >= 1 &&
            s.details.endLine >= s.details.startLine &&
            s.details.algorithm.length > 0 &&
            s.details.whatItDoes.length > 0 &&
            s.details.significance.length > 0 &&
            s.details.dataMetrics.length > 0,
        ),
      ).toBe(true)
      expect(
        pseudoRun.steps.some(
          (s) => s.details.functionsCalled.length > 0 || s.details.paramsUsed.length > 0,
        ),
      ).toBe(true)
      expect(result.metrics.extrusionLength).toBeCloseTo(native.metrics.extrusionLength, 1)
      expect(result.metrics.travelLength).toBeCloseTo(native.metrics.travelLength, 1)
      expect(result.metrics.gapArea).toBeCloseTo(native.metrics.gapArea, 1)
    }
  })

  it('drives the layer slice data when edited pseudocode is executed', () => {
    const layers = singleLayer('thin-wedge')
    const p = makeParams({ wallStrategy: 'constant', wallCount: 2 })
    const baseline = runPipeline(layers, 0, p)

    // Edit the constant-walls pseudocode to force a single perimeter loop (wallCount = 1)
    const customCode = PSEUDOCODE_STAGES['walls-constant'].defaultCode.replace(
      'i < params.wallCount',
      'i < 1',
    )
    const { result, pseudoRun } = runPipelineWithPseudocode(layers, 0, p, {
      activeKey: 'walls-constant',
      codes: { 'walls-constant': customCode },
      driveLayer: true,
    })

    expect(pseudoRun.ok).toBe(true)
    expect(result.walls.walls.length).toBeLessThan(baseline.walls.walls.length)
    expect(result.metrics.extrusionLength).not.toBeCloseTo(baseline.metrics.extrusionLength, 0)
  })

  it('captures syntax or runtime errors gracefully without crashing the pipeline', () => {
    const layers = singleLayer('washer')
    const p = makeParams()
    const { result, pseudoRun } = runPipelineWithPseudocode(layers, 0, p, {
      activeKey: 'infill',
      codes: { infill: 'throw new Error("boom in user script")' },
      driveLayer: true,
    })

    expect(pseudoRun.ok).toBe(false)
    expect(pseudoRun.error).toContain('boom in user script')
    expect(result.outline.length).toBeGreaterThan(0)
  })
})
