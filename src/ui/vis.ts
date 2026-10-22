/** Layer-visibility toggles for the viewer, one per pipeline stage output. */
export interface VisState {
  rawSegments: boolean
  outline: boolean
  wallsRegion: boolean
  skinFill: boolean
  infillRegion: boolean
  wallPaths: boolean
  gaps: boolean
  skeleton: boolean
  infillLines: boolean
  skinLines: boolean
  rawInfill: boolean
  orderNumbers: boolean
  travel: boolean
}

export const defaultVis: VisState = {
  rawSegments: false,
  outline: true,
  wallsRegion: true,
  skinFill: true,
  infillRegion: true,
  wallPaths: true,
  gaps: true,
  skeleton: false,
  infillLines: true,
  skinLines: true,
  rawInfill: false,
  orderNumbers: false,
  travel: true,
}

export type StageId = 'slicing' | 'areas' | 'walls' | 'infill' | 'order' | 'travel'

export interface ViewTransform {
  /** Screen pixels per micron. */
  scale: number
  /** World point (microns) at the canvas centre. */
  cx: number
  cy: number
}

/** Cura-style feature colors for extrusion lines. */
export const featureColors: Record<string, string> = {
  'outer-wall': '#e03e2d',
  'inner-wall': '#2da84f',
  infill: '#f5a623',
  skin: '#f0e13a',
  'gap-fill': '#ff3aff',
}
