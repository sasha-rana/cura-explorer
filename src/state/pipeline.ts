import { offset, union } from '../geometry/clipper'
import type { ExtrusionLine, Polygon, Polyline } from '../geometry/types'
import { classifyAreas } from '../algorithms/areas'
import { generateInfill, type InfillPattern } from '../algorithms/infill'
import { computeMetrics } from '../algorithms/metrics'
import { orderLayerPaths } from '../algorithms/pathOrder'
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
