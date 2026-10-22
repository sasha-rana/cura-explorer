import { offset, union } from '../geometry/clipper'
import type { ExtrusionLine, Polygon, Polyline } from '../geometry/types'
import { classifyAreas } from '../algorithms/areas'
import { generateInfill, type InfillPattern } from '../algorithms/infill'
import { computeMetrics } from '../algorithms/metrics'
import { orderLayerPaths } from '../algorithms/pathOrder'
import {
  PSEUDOCODE_STAGES,
  runStagePseudocode,
  type PseudocodeContext,
  type PseudocodeKey,
  type PseudocodeRunResult,
} from '../algorithms/pseudocode'
import { insertTravels } from '../algorithms/travel'
import type {
  FeaturePaths,
  LayerAreas,
  LayerMetrics,
  OrderedMove,
  SlicedLayer,
  WallResult,
} from '../algorithms/types'
import { computeArachneWalls, type ArachneResult } from '../algorithms/wallsArachne'
import { computeConstantWalls } from '../algorithms/wallsConstant'

/**
 * The whole single-layer pipeline as one pure, synchronous function. Clipper
 * must already be initialized (initClipper() at app start / test setup).
 */

export interface PipelineParams {
  layerHeight: number // default 200
  wallWidth: number // default 400
  wallCount: number // default 2
  topLayers: number // default 3
  bottomLayers: number // default 3
  wallStrategy: 'constant' | 'arachne'
  minBeadWidth: number // default 300 (arachne minWidth)
  beadingStrategy: 'constant' | 'distributed'
  infillPattern: InfillPattern // default 'grid'
  infillDensity: number // default 0.2
  infillAngle: number // default 45
  combing: boolean // default true
  combingInset: number // default 400
  avoidDistance: number // default 200
  retractionMinDistance: number // default 1500
  zHop: boolean // default false
  printSpeed: number // default 50000 um/s
  travelSpeed: number // default 150000 um/s
}

export const defaultPipelineParams: PipelineParams = {
  layerHeight: 200,
  wallWidth: 400,
  wallCount: 2,
  topLayers: 3,
  bottomLayers: 3,
  wallStrategy: 'arachne',
  minBeadWidth: 300,
  beadingStrategy: 'distributed',
  infillPattern: 'grid',
  infillDensity: 0.2,
  infillAngle: 45,
  combing: true,
  combingInset: 400,
  avoidDistance: 200,
  retractionMinDistance: 1500,
  zHop: false,
  printSpeed: 50000,
  travelSpeed: 150000,
}

export interface PipelineResult {
  outline: Polygon[]
  areas: LayerAreas
  walls: WallResult & Partial<ArachneResult> // walls + gaps; arachne adds skeleton + beads
  infillLines: ExtrusionLine[] // sparse infill in infillRegion
  skinLines: ExtrusionLine[] // 100% density zigzag in skin regions
  /** Unclipped infill pattern lines (teaching view). */
  infillRawLines: Polyline[]
  features: FeaturePaths[]
  moves: OrderedMove[] // extrusion + travel, final print order
  metrics: LayerMetrics
}

const emptyAreas: LayerAreas = { wallsRegion: [], skin: [], infillRegion: [], innerArea: [] }
const emptyMetrics: LayerMetrics = {
  extrusionLength: 0,
  travelLength: 0,
  travelOutsideLength: 0,
  gapArea: 0,
  estimatedTimeS: 0,
}

export function emptyPipelineResult(): PipelineResult {
  return {
    outline: [],
    areas: emptyAreas,
    walls: { walls: [], gaps: [] },
    infillLines: [],
    skinLines: [],
    infillRawLines: [],
    features: [],
    moves: [],
    metrics: emptyMetrics,
  }
}

/**
 * Number of wall lines belonging to the outermost inset level. Both wall
 * strategies emit the rings of the first inset (offset by wallWidth/2) before
 * anything deeper, so this splits "outer wall" from "inner walls".
 */
function outerWallCount(outline: Polygon[], wallWidth: number): number {
  const first = offset(outline, -wallWidth / 2)
  let n = 0
  for (const poly of first) n += 1 + poly.holes.length
  return n
}

export interface PseudocodePipelineOptions {
  activeKey: PseudocodeKey
  codes?: Partial<Record<PseudocodeKey, string>>
  driveLayer: boolean
}

export interface PipelineWithPseudocodeResult {
  result: PipelineResult
  pseudoRun: PseudocodeRunResult
}

export function runPipelineWithPseudocode(
  layers: SlicedLayer[],
  layerIndex: number,
  params: PipelineParams,
  pseudo: PseudocodePipelineOptions,
): PipelineWithPseudocodeResult {
  const emptyRun: PseudocodeRunResult = {
    ok: true,
    output: null,
    steps: [],
    error: null,
    runtimeMs: 0,
  }
  const layer = layers[layerIndex]
  if (!layer || layer.polygons.length === 0) {
    return { result: emptyPipelineResult(), pseudoRun: emptyRun }
  }

  let outline = union(layer.polygons)
  if (outline.length === 0) {
    return { result: emptyPipelineResult(), pseudoRun: emptyRun }
  }

  let activeRun: PseudocodeRunResult = emptyRun
  const codeFor = (key: PseudocodeKey) => pseudo.codes?.[key] ?? PSEUDOCODE_STAGES[key].defaultCode
  const shouldRunKey = (key: PseudocodeKey) =>
    pseudo.activeKey === key || (pseudo.driveLayer && pseudo.codes?.[key] !== undefined)

  const makeCtx = (
    areas: LayerAreas,
    walls: WallResult & Partial<ArachneResult>,
    features: FeaturePaths[],
    orderedMoves: OrderedMove[],
  ): PseudocodeContext => ({
    layers,
    layerIndex,
    layer,
    outline,
    areas,
    walls,
    features,
    orderedMoves,
    params,
  })

  // 1. Slicing / contour stitching
  if (shouldRunKey('slicing')) {
    const run = runStagePseudocode<Polygon[]>(
      'slicing',
      codeFor('slicing'),
      makeCtx(emptyAreas, { walls: [], gaps: [] }, [], []),
    )
    if (pseudo.activeKey === 'slicing') activeRun = run
    if (pseudo.driveLayer && run.ok && Array.isArray(run.output) && run.output.length > 0) {
      outline = run.output
    }
  }

  // 2. Area classification
  const computeNativeAreas = () =>
    classifyAreas(layers, layerIndex, {
      wallWidth: params.wallWidth,
      wallCount: params.wallCount,
      topLayers: params.topLayers,
      bottomLayers: params.bottomLayers,
    })

  let areas: LayerAreas
  if (shouldRunKey('areas')) {
    const run = runStagePseudocode<LayerAreas>(
      'areas',
      codeFor('areas'),
      makeCtx(emptyAreas, { walls: [], gaps: [] }, [], []),
    )
    if (pseudo.activeKey === 'areas') activeRun = run
    if (
      (pseudo.driveLayer || pseudo.codes?.areas === undefined) &&
      run.ok &&
      run.output &&
      typeof run.output === 'object' &&
      'wallsRegion' in run.output
    ) {
      areas = run.output
    } else {
      areas = computeNativeAreas()
    }
  } else {
    areas = computeNativeAreas()
  }

  // 3. Walls (constant or Arachne)
  const wallKey: PseudocodeKey =
    params.wallStrategy === 'arachne' ? 'walls-arachne' : 'walls-constant'
  const computeNativeWalls = (): WallResult & Partial<ArachneResult> =>
    params.wallStrategy === 'arachne'
      ? computeArachneWalls(outline, {
          wallWidth: params.wallWidth,
          wallCount: params.wallCount,
          minWidth: params.minBeadWidth,
          strategy: params.beadingStrategy,
          skeletonSpacing: params.wallWidth / 8,
        })
      : computeConstantWalls(outline, {
          wallWidth: params.wallWidth,
          wallCount: params.wallCount,
        })

  let walls: WallResult & Partial<ArachneResult>
  if (shouldRunKey(wallKey)) {
    const run = runStagePseudocode<WallResult & Partial<ArachneResult>>(
      wallKey,
      codeFor(wallKey),
      makeCtx(areas, { walls: [], gaps: [] }, [], []),
    )
    if (pseudo.activeKey === wallKey) activeRun = run
    if (
      (pseudo.driveLayer || pseudo.codes?.[wallKey] === undefined) &&
      run.ok &&
      run.output &&
      typeof run.output === 'object' &&
      Array.isArray(run.output.walls)
    ) {
      walls = {
        walls: run.output.walls,
        gaps: Array.isArray(run.output.gaps) ? run.output.gaps : [],
        skeleton: run.output.skeleton,
        beads: run.output.beads,
      }
    } else {
      walls = computeNativeWalls()
    }
  } else {
    walls = computeNativeWalls()
  }

  // 4. Infill & skin
  const computeNativeInfill = () => {
    const inf = generateInfill(areas.infillRegion, {
      pattern: params.infillPattern,
      density: params.infillDensity,
      lineWidth: params.wallWidth,
      angle: params.infillAngle,
    })
    const sk = generateInfill(areas.skin, {
      pattern: 'zigzag',
      density: 1,
      lineWidth: params.wallWidth,
      angle: params.infillAngle + (layerIndex % 2) * 90,
    }).lines
    return { infillLines: inf.lines, infillRawLines: inf.rawLines ?? [], skinLines: sk }
  }

  let infillLines: ExtrusionLine[]
  let infillRawLines: Polyline[]
  let skinLines: ExtrusionLine[]

  if (shouldRunKey('infill')) {
    const run = runStagePseudocode<{
      infillLines: ExtrusionLine[]
      skinLines?: ExtrusionLine[]
      rawLines?: Polyline[]
    }>('infill', codeFor('infill'), makeCtx(areas, walls, [], []))
    if (pseudo.activeKey === 'infill') activeRun = run
    if (
      (pseudo.driveLayer || pseudo.codes?.infill === undefined) &&
      run.ok &&
      run.output &&
      typeof run.output === 'object' &&
      Array.isArray(run.output.infillLines)
    ) {
      infillLines = run.output.infillLines
      skinLines = Array.isArray(run.output.skinLines) ? run.output.skinLines : []
      infillRawLines = Array.isArray(run.output.rawLines) ? run.output.rawLines : []
    } else {
      const nat = computeNativeInfill()
      infillLines = nat.infillLines
      infillRawLines = nat.infillRawLines
      skinLines = nat.skinLines
    }
  } else {
    const nat = computeNativeInfill()
    infillLines = nat.infillLines
    infillRawLines = nat.infillRawLines
    skinLines = nat.skinLines
  }

  // 5. Path ordering
  const nOuter = outerWallCount(outline, params.wallWidth)
  const outerLines = walls.walls.slice(0, nOuter)
  const innerLines = walls.walls.slice(nOuter)

  const features: FeaturePaths[] = [
    { kind: 'infill', lines: infillLines },
    { kind: 'inner-wall', lines: innerLines },
    { kind: 'outer-wall', lines: outerLines },
    { kind: 'skin', lines: skinLines },
  ]

  let orderedMoves: OrderedMove[]
  if (shouldRunKey('order')) {
    const run = runStagePseudocode<{ moves: OrderedMove[] } | OrderedMove[]>(
      'order',
      codeFor('order'),
      makeCtx(areas, walls, features, []),
    )
    if (pseudo.activeKey === 'order') activeRun = run
    if ((pseudo.driveLayer || pseudo.codes?.order === undefined) && run.ok && run.output) {
      if (Array.isArray(run.output)) {
        orderedMoves = run.output
      } else if ('moves' in run.output && Array.isArray(run.output.moves)) {
        orderedMoves = run.output.moves
      } else {
        orderedMoves = orderLayerPaths(features, { x: 0, y: 0 }).moves
      }
    } else {
      orderedMoves = orderLayerPaths(features, { x: 0, y: 0 }).moves
    }
  } else {
    orderedMoves = orderLayerPaths(features, { x: 0, y: 0 }).moves
  }

  // 6. Travel & combing
  const computeNativeTravels = () =>
    insertTravels(orderedMoves, outline, {
      combing: params.combing,
      combingInset: params.combingInset,
      avoidDistance: params.avoidDistance,
      retractionMinDistance: params.retractionMinDistance,
      zHopEnabled: params.zHop,
    })

  let moves: OrderedMove[]
  if (shouldRunKey('travel')) {
    const run = runStagePseudocode<OrderedMove[]>(
      'travel',
      codeFor('travel'),
      makeCtx(areas, walls, features, orderedMoves),
    )
    if (pseudo.activeKey === 'travel') activeRun = run
    if (
      (pseudo.driveLayer || pseudo.codes?.travel === undefined) &&
      run.ok &&
      Array.isArray(run.output)
    ) {
      moves = run.output
    } else {
      moves = computeNativeTravels()
    }
  } else {
    moves = computeNativeTravels()
  }

  const metrics = computeMetrics(moves, walls.gaps, outline, {
    printSpeed: params.printSpeed,
    travelSpeed: params.travelSpeed,
  })

  return {
    result: {
      outline,
      areas,
      walls,
      infillLines,
      skinLines,
      infillRawLines,
      features,
      moves,
      metrics,
    },
    pseudoRun: activeRun,
  }
}

export function runPipeline(
  layers: SlicedLayer[],
  layerIndex: number,
  params: PipelineParams,
): PipelineResult {
  const layer = layers[layerIndex]
  if (!layer || layer.polygons.length === 0) return emptyPipelineResult()

  const outline = union(layer.polygons)
  if (outline.length === 0) return emptyPipelineResult()

  const areas = classifyAreas(layers, layerIndex, {
    wallWidth: params.wallWidth,
    wallCount: params.wallCount,
    topLayers: params.topLayers,
    bottomLayers: params.bottomLayers,
  })

  const walls: WallResult & Partial<ArachneResult> =
    params.wallStrategy === 'arachne'
      ? computeArachneWalls(outline, {
          wallWidth: params.wallWidth,
          wallCount: params.wallCount,
          minWidth: params.minBeadWidth,
          strategy: params.beadingStrategy,
          skeletonSpacing: params.wallWidth / 8,
        })
      : computeConstantWalls(outline, {
          wallWidth: params.wallWidth,
          wallCount: params.wallCount,
        })

  const infill = generateInfill(areas.infillRegion, {
    pattern: params.infillPattern,
    density: params.infillDensity,
    lineWidth: params.wallWidth,
    angle: params.infillAngle,
  })
  const infillLines = infill.lines

  // Skin is fully dense zigzag; like Cura, the angle alternates by 90° per layer.
  const skinLines = generateInfill(areas.skin, {
    pattern: 'zigzag',
    density: 1,
    lineWidth: params.wallWidth,
    angle: params.infillAngle + (layerIndex % 2) * 90,
  }).lines

  // Outermost-first ordering is guaranteed by both wall generators.
  const nOuter = outerWallCount(outline, params.wallWidth)
  const outerLines = walls.walls.slice(0, nOuter)
  const innerLines = walls.walls.slice(nOuter)

  const features: FeaturePaths[] = [
    { kind: 'infill', lines: infillLines },
    { kind: 'inner-wall', lines: innerLines },
    { kind: 'outer-wall', lines: outerLines },
    { kind: 'skin', lines: skinLines },
  ]

  const ordered = orderLayerPaths(features, { x: 0, y: 0 })
  const moves = insertTravels(ordered.moves, outline, {
    combing: params.combing,
    combingInset: params.combingInset,
    avoidDistance: params.avoidDistance,
    retractionMinDistance: params.retractionMinDistance,
    zHopEnabled: params.zHop,
  })

  const metrics = computeMetrics(moves, walls.gaps, outline, {
    printSpeed: params.printSpeed,
    travelSpeed: params.travelSpeed,
  })

  return {
    outline,
    areas,
    walls,
    infillLines,
    skinLines,
    infillRawLines: infill.rawLines ?? [],
    features,
    moves,
    metrics,
  }
}
