import type { ExtrusionLine, Point, Polygon, Polyline } from '../geometry/types'

/**
 * Shared contracts between slicer stages. Every stage module is pure and
 * DOM-free; every module also exports a `*Doc: StageDoc` with teaching notes
 * and a pointer to the CuraEngine source file it mirrors.
 */

export interface StageDoc {
  title: string
  /** Markdown shown in the explainer panel. */
  explanation: string
  /** CuraEngine source file(s) this module mirrors, e.g. "src/slicer.cpp". */
  curaRef: string
  refs?: { label: string; url: string }[]
}

// --- Slicing (mesh -> layers) -------------------------------------------------

export interface SlicingParams {
  /** Layer height in microns. */
  layerHeight: number
}

/** One horizontal slice through the mesh. */
export interface SlicedLayer {
  /** Z of the slice plane, microns. */
  z: number
  /** Closed polygons (LayerParts), stitched from triangle intersection segments. */
  polygons: Polygon[]
  /** The raw plane–triangle intersection segments before stitching (teaching view). */
  rawSegments: Polyline[]
}

// --- Area classification -------------------------------------------------------

export interface LayerAreas {
  /** Ring region covered by the walls (between outline and innermost inset). */
  wallsRegion: Polygon[]
  /** Fully-filled top/bottom skin regions. */
  skin: Polygon[]
  /** Remaining region to be filled with sparse infill. */
  infillRegion: Polygon[]
  /** Area enclosed by the outer wall centreline (used by combing/travel). */
  innerArea: Polygon[]
}

// --- Walls ---------------------------------------------------------------------

export interface WallResult {
  /** Extrusion lines; index 0 of each group is the outermost wall. */
  walls: ExtrusionLine[]
  /** Regions the walls could not fill (gap-fill candidates), highlighted in the UI. */
  gaps: Polygon[]
}

// --- Infill --------------------------------------------------------------------

export interface InfillResult {
  lines: ExtrusionLine[]
  /** Unclipped pattern lines before clipping to the area (teaching view). */
  rawLines?: Polyline[]
}

// --- Path planning -------------------------------------------------------------

export type FeatureKind =
  | 'infill'
  | 'inner-wall'
  | 'outer-wall'
  | 'gap-fill'
  | 'skin'

export interface FeaturePaths {
  kind: FeatureKind
  lines: ExtrusionLine[]
}

export interface OrderedMove {
  kind: 'extrusion' | 'travel'
  feature: FeatureKind | 'travel'
  /** For extrusion moves: the extrusion line. For travel: the path followed. */
  line: ExtrusionLine | Polyline
  /** Travel only: details for visualization. */
  travel?: TravelInfo
}

export interface TravelInfo {
  combed: boolean
  /** True when any part of the travel leaves the model outline. */
  goesOutside: boolean
  retract: boolean
  zHop: boolean
}

// --- Metrics -------------------------------------------------------------------

export interface LayerMetrics {
  extrusionLength: number
  travelLength: number
  travelOutsideLength: number
  gapArea: number
  /** Rough estimate in seconds from print/travel speeds. */
  estimatedTimeS: number
}

export type { ExtrusionLine, Point, Polygon, Polyline }
