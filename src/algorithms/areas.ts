import { difference, offset, union } from '../geometry/clipper'
import type { Polygon } from '../geometry/types'
import type { LayerAreas, SlicedLayer, StageDoc } from './types'

export const areasDoc: StageDoc = {
  title: 'Area classification',
  explanation: `## The idea
Decide what every region of a layer is for: perimeter walls near the boundary, solid skin where the layer is exposed above or below, and sparse infill everywhere else.

## Step by step
1. Union the layer's polygons so touching parts merge into clean outlines before any inset is computed.
2. The walls region is \`outline - offset(outline, -(wallCount * wallWidth))\` — the band the perimeters will cover.
3. \`innerArea = offset(outline, -wallWidth / 2)\`: the area enclosed by the outer wall centreline, later used by combing to keep travel inside the print.
4. The interior — outline inset by \`wallCount * wallWidth\` — is what remains to be filled.
5. Bottom skin is the interior NOT covered by the layer \`bottomLayers\` below; top skin is symmetric, using the layer \`topLayers\` above. A missing or empty neighbour means fully exposed.
6. \`skin = union(bottomSkin, topSkin)\`; \`infillRegion = interior - skin\`.

## Key formulas / rules
- \`wall band inset = wallCount * wallWidth\`
- \`innerArea inset = wallWidth / 2\`

## Edge cases & simplifications
- Skin coverage checks only the single layer exactly \`topLayers\` / \`bottomLayers\` away — a single-layer-neighbourhood simplification of CuraEngine's skin computation.
- A single-layer input counts as fully exposed on both sides: its whole interior becomes skin.

## Try it
- Cube STL demo → stage 2: middle layers show a sparse \`infillRegion\`, the first and last layers are all skin.
- Raise \`wallCount\` and watch the walls band eat into the infill region.`,
  curaRef: 'src/skin.cpp, src/WallsComputation.cpp',
  refs: [
    { label: 'CuraEngine wiki: Generating Areas', url: 'https://github.com/Ultimaker/CuraEngine/wiki/Generating-Areas' },
  ],
}

export interface AreaParams {
  /** Extrusion width of one wall line, microns. */
  wallWidth: number
  /** Number of wall perimeters. */
  wallCount: number
  /** Layers of solid skin at the top. */
  topLayers: number
  /** Layers of solid skin at the bottom. */
  bottomLayers: number
}

export function classifyAreas(
  layers: SlicedLayer[],
  layerIndex: number,
  params: AreaParams,
): LayerAreas {
  const empty: LayerAreas = { wallsRegion: [], skin: [], infillRegion: [], innerArea: [] }
  const layer = layers[layerIndex]
  if (!layer || layer.polygons.length === 0) return empty

  const outline = union(layer.polygons)
  const wallInset = params.wallCount * params.wallWidth
  const interior = offset(outline, -wallInset)
  const wallsRegion = interior.length > 0 ? difference(outline, interior) : outline
  const innerArea = offset(outline, -params.wallWidth / 2)
  if (interior.length === 0) return { wallsRegion, skin: [], infillRegion: [], innerArea }

  // Skin coverage by the layer bottomLayers below / topLayers above. A missing
  // or empty neighbour means the interior is fully exposed from that side.
  const outlineOf = (idx: number): Polygon[] => union(layers[idx].polygons)

  const belowIdx = layerIndex - params.bottomLayers
  const downSkin =
    belowIdx < 0 || layers[belowIdx].polygons.length === 0
      ? interior
      : difference(interior, outlineOf(belowIdx))

  const aboveIdx = layerIndex + params.topLayers
  const upSkin =
    aboveIdx >= layers.length || layers[aboveIdx].polygons.length === 0
      ? interior
      : difference(interior, outlineOf(aboveIdx))

  const skinAll = [...downSkin, ...upSkin]
  const skin = skinAll.length > 0 ? union(skinAll) : []
  const infillRegion = skin.length > 0 ? difference(interior, skin) : interior

  return { wallsRegion, skin, infillRegion, innerArea }
}
