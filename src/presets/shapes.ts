import type { Point, Polygon, Ring, Triangle } from '../geometry/types'
import { makeCubeMesh, makePyramidMesh } from '../algorithms/slicing'

/**
 * 2D layer presets, in integer microns, centred on the origin and sized to fit
 * a ~120x120 mm virtual bed. Each preset is a ready-made single layer chosen to
 * stress one stage of the pipeline.
 */

const rect = (minX: number, minY: number, maxX: number, maxY: number): Ring => [
  { x: minX, y: minY },
  { x: maxX, y: minY },
  { x: maxX, y: maxY },
  { x: minX, y: maxY },
]

const poly = (outer: Ring, holes: Ring[] = []): Polygon => ({ outer, holes })

/** Long isoceles triangle: 20 mm base tapering to a point over 40 mm. */
const thinWedge: Polygon[] = [
  poly([
    { x: -20000, y: -10000 },
    { x: 20000, y: 0 },
    { x: -20000, y: 10000 },
  ]),
]

/** 40 x 0.5 mm bar — below 2x wall width. */
const thinWall: Polygon[] = [poly(rect(-20000, -250, 20000, 250))]

/** 5-pointed star, ~40 mm across: sharp convex corners everywhere. */
const sharpCorner: Polygon[] = [
  poly(
    Array.from({ length: 10 }, (_, i) => {
      const r = i % 2 === 0 ? 20000 : 20000 * 0.42
      const a = Math.PI / 2 + (i * Math.PI) / 5
      const p: Point = { x: Math.round(r * Math.cos(a)), y: Math.round(r * Math.sin(a)) }
      return p
    }),
  ),
]

/** C-shaped concave polygon, ~40 mm across: combing has to detour the notch. */
const cShape: Polygon[] = [
  poly(
    [
      { x: 0, y: 0 },
      { x: 40000, y: 0 },
      { x: 40000, y: 12000 },
      { x: 16000, y: 12000 },
      { x: 16000, y: 28000 },
      { x: 40000, y: 28000 },
      { x: 40000, y: 40000 },
      { x: 0, y: 40000 },
    ].map((p) => ({ x: p.x - 20000, y: p.y - 20000 })),
  ),
]

/** Two 15 mm squares 12 mm apart. */
const twoParts: Polygon[] = [
  poly(rect(-21000, -7500, -6000, 7500)),
  poly(rect(6000, -7500, 21000, 7500)),
]

/** 40 mm square with a centred 15 mm square hole. */
const washer: Polygon[] = [
  poly(rect(-20000, -20000, 20000, 20000), [rect(-7500, -7500, 7500, 7500).reverse()]),
]

/** 60 mm horizontal band whose thickness swings sinusoidally between 0.6 and 6 mm. */
const ribbon: Polygon[] = [
  (() => {
    const half = 30000
    const step = 500
    const thickness = (x: number) => 3300 + 2700 * Math.sin((2 * Math.PI * x) / 30000)
    const top: Ring = []
    for (let x = -half; x <= half; x += step) top.push({ x, y: Math.round(thickness(x) / 2) })
    const bottom: Ring = []
    for (let x = half; x >= -half; x -= step) bottom.push({ x, y: -Math.round(thickness(x) / 2) })
    return poly([...top, ...bottom])
  })(),
]

export const presets = {
  'thin-wedge': thinWedge,
  'thin-wall': thinWall,
  'sharp-corner': sharpCorner,
  'c-shape': cShape,
  'two-parts': twoParts,
  washer,
  ribbon,
} as const satisfies Record<string, Polygon[]>

export type PresetId = keyof typeof presets

export const presetLabels: Record<PresetId, string> = {
  'thin-wedge': 'Thin wedge (Arachne)',
  'thin-wall': 'Thin wall 0.5 mm',
  'sharp-corner': 'Sharp-corner star',
  'c-shape': 'C shape (combing)',
  'two-parts': 'Two parts (travel)',
  washer: 'Washer (hole)',
  ribbon: 'Ribbon (variable width)',
}

/** Built-in STL demos: 30 mm cube and 40 mm base / 30 mm tall pyramid. */
export const stlPresets: Record<'cube' | 'pyramid', Triangle[]> = {
  cube: makeCubeMesh(30000),
  pyramid: makePyramidMesh(40000, 30000),
}

export type StlPresetId = keyof typeof stlPresets
