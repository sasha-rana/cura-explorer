import { difference, intersect, offset, offsetPolyline, pointInPolygons, pointInRing, union } from '../geometry/clipper'
import { dist, polygonArea, polygonsArea, polylineLength, signedArea } from '../geometry/polyUtils'
import { computeSkeleton, type Skeleton } from '../geometry/skeleton'
import type { ExtrusionLine, Point, Polygon, Polyline, Ring } from '../geometry/types'
import { generateInfill, type InfillPattern } from './infill'
import { isClosed, nearestVertex, rotateRing, weightedDistance } from './pathOrder'
import { ringsToPolygons, stitchSegments } from './slicing'
import { combAlongBoundary, lineEnd, lineStart, pathInsideArea, segmentInsideArea } from './travel'
import type {
  FeatureKind,
  FeaturePaths,
  LayerAreas,
  OrderedMove,
  SlicedLayer,
  StageDoc,
  WallResult,
} from './types'
import {
  arachneInsets,
  beadWidth,
  pruneSkeleton,
  skeletonPolylines,
  smoothWidths,
  type ArachneResult,
  type BeadingStrategy,
} from './wallsArachne'
import {
  computeGaps,
  extrusionLineSausages,
  ringToWallLine,
  unionAll,
  wallBandRegion,
} from './wallsConstant'

export const pseudocodeDoc: StageDoc = {
  title: 'Executable algorithm pseudocode',
  explanation: `## The idea
Each 2D stage is expressed as commented, high-level pseudocode backed by real geometry primitives (\`offset\`, \`difference\`, \`union\`, \`computeSkeleton\`, \`generateInfill\`, \`combAlongBoundary\`). Executing the pseudocode records intermediate \`step(label, geometry, note)\` checkpoints, links each step to the exact code block that computed it, and explains the algorithm, parameters, and significance of the resulting slice data.`,
  curaRef: 'src/FffGcodeWriter.cpp (2D layer pipeline)',
}

export type PseudocodeKey =
  | 'slicing'
  | 'areas'
  | 'walls-constant'
  | 'walls-arachne'
  | 'infill'
  | 'order'
  | 'travel'

export interface PseudocodeParams {
  layerHeight: number
  wallWidth: number
  wallCount: number
  topLayers: number
  bottomLayers: number
  wallStrategy: 'constant' | 'arachne'
  minBeadWidth: number
  beadingStrategy: BeadingStrategy
  infillPattern: InfillPattern
  infillDensity: number
  infillAngle: number
  combing: boolean
  combingInset: number
  avoidDistance: number
  retractionMinDistance: number
  zHop: boolean
  printSpeed: number
  travelSpeed: number
}

export interface StepGeometry {
  polygons: Polygon[]
  extrusionLines: ExtrusionLine[]
  polylines: Polyline[]
  moves: OrderedMove[]
  skeleton: Skeleton | null
  points: Point[]
  summary: string
}

export interface StepParamUsed {
  name: string
  value: string
}

export interface StepFunctionUsed {
  name: string
  description: string
}

export interface StepDetails {
  /** 1-based start and end line numbers of the code block that produces this step. */
  startLine: number
  endLine: number
  /** Name of the geometric/combinatorial algorithm used in this step. */
  algorithm: string
  /** Plain-English explanation of what the code block does with the current parameters. */
  whatItDoes: string
  /** Why the geometry produced in this step matters for downstream stages & the physical print. */
  significance: string
  /** Quantitative metrics of the intermediate geometry produced by this step. */
  dataMetrics: string
  /** Geometry/algorithm primitives called inside this step's code block. */
  functionsCalled: StepFunctionUsed[]
  /** Live pipeline parameters referenced in this step's code block. */
  paramsUsed: StepParamUsed[]
}

export interface PseudoStep {
  index: number
  label: string
  note: string
  line: number
  geometry: StepGeometry
  details: StepDetails
}

export interface PseudocodeStageSpec {
  key: PseudocodeKey
  title: string
  subtitle: string
  curaRef: string
  inputsNote: string
  returnsNote: string
  defaultCode: string
}

export interface PseudocodeContext {
  layers: SlicedLayer[]
  layerIndex: number
  layer: SlicedLayer
  outline: Polygon[]
  areas: LayerAreas
  walls: WallResult & Partial<ArachneResult>
  features: FeaturePaths[]
  orderedMoves: OrderedMove[]
  params: PseudocodeParams
}

export interface PseudocodeRunResult<T = unknown> {
  ok: boolean
  output: T | null
  steps: PseudoStep[]
  error: string | null
  runtimeMs: number
}

export function stagePseudocodeKey(
  stage: 'slicing' | 'areas' | 'walls' | 'infill' | 'order' | 'travel',
  wallStrategy: 'constant' | 'arachne',
): PseudocodeKey {
  if (stage === 'walls') {
    return wallStrategy === 'arachne' ? 'walls-arachne' : 'walls-constant'
  }
  return stage
}

// ---------------------------------------------------------------------------
// Stage pseudocode definitions (commented & directly executable)
// ---------------------------------------------------------------------------

export const PSEUDOCODE_STAGES: Record<PseudocodeKey, PseudocodeStageSpec> = {
  slicing: {
    key: 'slicing',
    title: '1 · Contour Stitching & Topology',
    subtitle: 'Chain raw intersection segments into closed loops & classify holes vs islands',
    curaRef: 'src/slicer.cpp',
    inputsNote: 'layer ({ z, rawSegments, polygons }), params',
    returnsNote: 'Polygon[] (clean outer contours + holes)',
    defaultCode: `// [Step 1] Collect raw plane–triangle intersection segments
// (For 2D presets without a 3D mesh, decompose preset rings into segments)
const rawSegs = layer.rawSegments.length > 0
  ? layer.rawSegments
  : ringsToSegments(layer.polygons)
step('Raw intersection segments', rawSegs, \`\${rawSegs.length} unstitched segments\`)

// [Step 2] Stitch segments end-to-end on a 10 µm grid & patch gaps <= 100 µm
const stitchedRings = layer.rawSegments.length > 0
  ? stitchRawSegments(layer.rawSegments)
  : ringsOf(layer.polygons)
step('Stitched closed rings', stitchedRings.map(closeRing), \`\${stitchedRings.length} closed loops\`)

// [Step 3] Classify rings into outer islands (CCW) vs interior holes (CW)
// Sorted by area: a ring inside an island is a hole; inside a hole starts a new island
const classified = ringsToPolygons(stitchedRings)
const outerOnly = classified.map((p) => ({ outer: p.outer, holes: [] }))
step('Classified outer islands', outerOnly, \`\${outerOnly.length} island contour(s)\`)

// [Step 4] Extract interior hole contours (if the cross-section has cavities)
const holesAsPolys = classified.flatMap((p) =>
  p.holes.map((h) => ({ outer: [...h].reverse(), holes: [] })),
)
if (holesAsPolys.length > 0) {
  step('Classified interior holes', holesAsPolys, \`\${holesAsPolys.length} hole contour(s)\`)
}

// [Step 5] Boolean union to merge overlapping/touching islands into clean polygons
const cleanOutline = union(classified)
step('Final layer outline', cleanOutline, \`\${cleanOutline.length} polygon(s)\`)

return cleanOutline`,
  },

  areas: {
    key: 'areas',
    title: '2 · Area Classification (Walls / Skin / Infill)',
    subtitle: 'Partition the 2D outline into perimeter band, exposed skin, and sparse infill core',
    curaRef: 'src/skin.cpp, src/WallsComputation.cpp',
    inputsNote: 'outline (Polygon[]), layers, layerIndex, params',
    returnsNote: 'LayerAreas ({ wallsRegion, skin, infillRegion, innerArea })',
    defaultCode: `// [Step 1] Erode outline inward by total wall thickness to isolate the interior core
const wallInset = params.wallCount * params.wallWidth
const interior = offset(outline, -wallInset)
step('Interior core (inside walls)', interior, \`inset = -\${(wallInset / 1000).toFixed(2)} mm\`)

// [Step 2] The perimeter wall band is outline minus the eroded interior
const wallsRegion = interior.length > 0
  ? difference(outline, interior)
  : outline
step('Perimeter walls band', wallsRegion, \`\${params.wallCount} walls × \${(params.wallWidth / 1000).toFixed(2)} mm\`)

// [Step 3] Inner combing boundary sits inside the outer wall centreline (-wallWidth / 2)
const innerArea = offset(outline, -params.wallWidth / 2)
step('Combing boundary (innerArea)', innerArea, 'Envelope inside outer wall centreline')

if (interior.length === 0) {
  return { wallsRegion, skin: [], infillRegion: [], innerArea }
}

// [Step 4] Bottom skin: interior regions NOT supported by the layer bottomLayers below
const belowIdx = layerIndex - params.bottomLayers
const downSkin = belowIdx < 0 || layers[belowIdx].polygons.length === 0
  ? interior
  : difference(interior, union(layers[belowIdx].polygons))
step('Bottom exposed skin', downSkin, \`checked \${params.bottomLayers} layers below\`)

// [Step 5] Top skin: interior regions NOT covered by the layer topLayers above
const aboveIdx = layerIndex + params.topLayers
const upSkin = aboveIdx >= layers.length || layers[aboveIdx].polygons.length === 0
  ? interior
  : difference(interior, union(layers[aboveIdx].polygons))
step('Top exposed skin', upSkin, \`checked \${params.topLayers} layers above\`)

// [Step 6] Union top + bottom skin; subtract from interior to get sparse infill region
const skin = unionAll([...downSkin, ...upSkin])
const infillRegion = skin.length > 0 ? difference(interior, skin) : interior
step('Sparse infill region', infillRegion, \`\${infillRegion.length} sheltered core region(s)\`)

return { wallsRegion, skin, infillRegion, innerArea }`,
  },

  'walls-constant': {
    key: 'walls-constant',
    title: '3 · Constant-Width Walls',
    subtitle: 'Inset the outline at fixed multiples of wallWidth and detect under-extrusion gaps',
    curaRef: 'src/WallsComputation.cpp',
    inputsNote: 'outline (Polygon[]), params ({ wallWidth, wallCount })',
    returnsNote: 'WallResult ({ walls, gaps })',
    defaultCode: `// [Step 1..N] Offset the outline inward for each perimeter loop (outermost first)
// Wall i centreline sits at -(wallWidth / 2 + i * wallWidth) from the boundary
const walls = []
for (let i = 0; i < params.wallCount; i++) {
  const insetDist = -(params.wallWidth / 2 + i * params.wallWidth)
  const insetPolys = offset(outline, insetDist)
  const levelWalls = []
  for (const ring of ringsOf(insetPolys)) {
    const line = ringToWallLine(ring, params.wallWidth)
    walls.push(line)
    levelWalls.push(line)
  }
  step(\`Wall #\${i + 1} (\${i === 0 ? 'outer' : 'inner'})\`, levelWalls, \`offset \${(insetDist / 1000).toFixed(2)} mm → \${levelWalls.length} loop(s)\`)
}

// [Step] Collect all constant-width wall perimeters across all inset levels
step('All constant-width wall paths', walls, \`\${walls.length} total wall loops\`)

// [Step] Compute the nominal wall band that perimeters are responsible for covering
const band = wallBandRegion(outline, params.wallWidth, params.wallCount)
step('Nominal wall band', band, 'Target region for wall coverage')

// [Step] Union the round-capped "sausage" footprints of every extruded wall line
const covered = unionAll(walls.flatMap(extrusionLineSausages))
step('Extruded bead coverage', covered, 'Union of wall line footprints')

// [Step] Subtract coverage from the wall band to reveal unfilled gaps (thin wedges/corners)
const gaps = computeGaps(band, covered, 10)
step('Unfilled wall gaps', gaps, \`\${gaps.length} gap region(s) left empty\`)

return { walls, gaps }`,
  },

  'walls-arachne': {
    key: 'walls-arachne',
    title: '3 · Arachne Variable-Width Walls',
    subtitle: 'Measure local thickness along the medial axis (d = 2r) and adapt bead width',
    curaRef: 'src/WallsComputation.cpp, src/utils/VoronoiUtils.cpp',
    inputsNote: 'outline (Polygon[]), params ({ wallWidth, wallCount, minBeadWidth, beadingStrategy })',
    returnsNote: 'ArachneResult ({ walls, gaps, skeleton, beads })',
    defaultCode: `// [Step 1] Lay standard full-width insets where the part is thick enough
// (Drops degenerate sliver rings thinner than half a bead)
const insetLines = arachneInsets(outline, params.wallWidth, params.wallCount)
step('Full-width inset perimeters', insetLines, \`\${insetLines.length} standard inset loop(s)\`)

// [Step 2] Subtract inset footprints from outline to isolate thin uncovered regions
const coveredByInsets = unionAll(insetLines.flatMap(extrusionLineSausages))
const remainder = coveredByInsets.length === 0
  ? outline
  : difference(outline, coveredByInsets)
step('Uncovered thin remainder', remainder, 'Thin features where fixed insets vanished')

// [Step 3] Build & prune the medial-axis skeleton (boundary sampling + Delaunay circumcentres)
// Each skeleton node stores radius r = clearance distance to boundary
const spacing = params.wallWidth / 8
const rawSkeleton = computeSkeleton(outline, spacing)
const skeleton = pruneSkeleton(rawSkeleton, 2 * spacing)
step('Medial-axis skeleton (r = local radius)', skeleton, \`\${skeleton.nodes.length} nodes, \${skeleton.edges.length} edges\`)

// [Step 4] Walk skeleton chains inside the thin remainder and adapt bead width:
// local thickness d = 2r, bead count n = round(d / wallWidth), width w = d / n
const maxBeadThickness = 2 * params.wallCount * params.wallWidth
const transitionLength = 0.4 * params.wallWidth
const centrelines = []

for (const chain of skeletonPolylines(skeleton)) {
  const widths = chain.map((idx) => {
    const node = skeleton.nodes[idx]
    const d = 2 * node.r
    if (d > maxBeadThickness) return null
    if (!pointInPolygons(node.p, remainder)) return null
    return beadWidth(d, params.wallWidth, params.minBeadWidth)
  })

  for (const run of extractBeadRuns(chain, widths, skeleton, params.wallWidth / 2)) {
    const ws = params.beadingStrategy === 'distributed'
      ? smoothWidths(run.pts, run.widths, run.thicknesses, params.minBeadWidth, transitionLength)
      : run.widths
    centrelines.push(run.pts.map((p, i) => ({ p, w: ws[i] })))
  }
}
step('Adaptive variable-width centrelines', centrelines, \`\${centrelines.length} tapering medial bead(s)\`)

// [Step 5] Merge standard insets + variable-width centrelines & measure remaining gaps
const beads = [
  ...insetLines.map((line) => ({ line, kind: 'inset' })),
  ...centrelines.map((line) => ({ line, kind: 'centreline' })),
]
const walls = beads.map((b) => b.line)
const covered = unionAll(walls.flatMap(extrusionLineSausages))
const band = wallBandRegion(outline, params.wallWidth, params.wallCount)
const gaps = computeGaps(band, covered, 10)
step('Final Arachne walls & remaining gaps', { walls, gaps }, \`\${walls.length} beads, \${gaps.length} gap(s)\`)

return { walls, gaps, skeleton, beads }`,
  },

  infill: {
    key: 'infill',
    title: '4 · Sparse Infill & Solid Skin',
    subtitle: 'Generate pattern lattice across the bounding box and clip to infill/skin regions',
    curaRef: 'src/infill.cpp, src/infill/GyroidInfill.cpp',
    inputsNote: 'areas (LayerAreas), layerIndex, params ({ infillPattern, infillDensity, wallWidth, infillAngle })',
    returnsNote: '{ infillLines, skinLines, rawLines }',
    defaultCode: `// [Step 1] Compute line spacing from pattern direction count so total density stays constant:
// nDir = 1 (lines/zigzag), 2 (grid), 3 (triangles/cubic)
const nDir = params.infillPattern === 'lines' || params.infillPattern === 'zigzag'
  ? 1
  : params.infillPattern === 'grid'
    ? 2
    : 3
const spacingUm = params.infillDensity > 0
  ? (params.wallWidth * nDir) / params.infillDensity
  : 0
step('Target infill & skin regions', [...areas.infillRegion, ...areas.skin], \`pattern: \${params.infillPattern}, spacing: \${(spacingUm / 1000).toFixed(2)} mm\`)

// [Step 2] Generate unclipped pattern lattice across the rotated bounding box
const sparse = generateInfill(areas.infillRegion, {
  pattern: params.infillPattern,
  density: params.infillDensity,
  lineWidth: params.wallWidth,
  angle: params.infillAngle,
})
const rawLines = sparse.rawLines ?? []
step('Unclipped pattern lattice (rawLines)', rawLines, \`\${rawLines.length} unclipped lattice lines\`)

// [Step 3] Clip pattern lines against the infill region boundary (outer contour minus holes)
const infillLines = sparse.lines
step('Clipped sparse infill extrusions', infillLines, \`\${infillLines.length} clipped infill lines\`)

// [Step 4] Generate 100%-density zigzag in exposed top/bottom skin (alternating 90° per layer)
const skinAngle = params.infillAngle + (layerIndex % 2) * 90
const skinLines = generateInfill(areas.skin, {
  pattern: 'zigzag',
  density: 1,
  lineWidth: params.wallWidth,
  angle: skinAngle,
}).lines
step('Solid skin zigzag extrusions', skinLines, \`\${skinLines.length} skin lines at \${skinAngle}°\`)

return { infillLines, skinLines, rawLines }`,
  },

  order: {
    key: 'order',
    title: '5 · Constrained Greedy Path Ordering',
    subtitle: 'Order paths within each feature group using momentum-weighted nearest neighbour',
    curaRef: 'src/InsetOrderOptimizer.cpp, src/pathOrderOptimizer.h',
    inputsNote: 'features (FeaturePaths[]), params',
    returnsNote: '{ moves: OrderedMove[] }',
    defaultCode: `// [Step 1..K] Enforce Cura's strict feature sequence so later lines never blemish outer walls:
// infill -> inner-wall -> outer-wall -> gap-fill -> skin
const featurePriority = ['infill', 'inner-wall', 'outer-wall', 'gap-fill', 'skin']
const groups = groupFeaturesByOrder(features, featurePriority)

const moves = []
let nozzle = { x: 0, y: 0 }
let lastDir = undefined

for (const group of groups) {
  const groupMoves = []
  const remaining = [...group.candidates]

  while (remaining.length > 0) {
    let bestIdx = 0
    let bestCost = Infinity
    let bestReverse = false
    let bestVertex = 0

    // Momentum-weighted travel distance: d * (1 - 0.5 * cos(theta))
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]
      if (c.closed) {
        const v = nearestVertex(nozzle, c.line)
        const cost = weightedDistance(dist(nozzle, c.line[v].p), lastDir, nozzle, c.line[v].p)
        if (cost < bestCost) {
          bestCost = cost
          bestIdx = i
          bestVertex = v
          bestReverse = false
        }
      } else {
        const first = c.line[0].p
        const last = c.line[c.line.length - 1].p
        const dFirst = weightedDistance(dist(nozzle, first), lastDir, nozzle, first)
        const dLast = weightedDistance(dist(nozzle, last), lastDir, nozzle, last)
        const cost = Math.min(dFirst, dLast)
        if (cost < bestCost) {
          bestCost = cost
          bestIdx = i
          bestReverse = dLast < dFirst
        }
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0]
    const printed = chosen.closed
      ? rotateRing(chosen.line, bestVertex)
      : bestReverse
        ? [...chosen.line].reverse()
        : chosen.line

    const move = { kind: 'extrusion', feature: chosen.feature, line: printed }
    moves.push(move)
    groupMoves.push(move)

    nozzle = printed[printed.length - 1].p
    lastDir = endingDirection(printed)
  }

  step(\`Ordered \${group.kind}\`, groupMoves, \`\${groupMoves.length} extrusion path(s)\`)
}

// [Final Step] Emit the complete ordered extrusion sequence ready for travel insertion
step('Complete ordered extrusion sequence', moves, \`\${moves.length} total extrusions\`)
return { moves }`,
  },

  travel: {
    key: 'travel',
    title: '6 · Combing, Travel & Retraction',
    subtitle: 'Route non-printing moves inside the combing boundary or retract across open air',
    curaRef: 'src/pathPlanning/Comb.cpp, src/LayerPlan.cpp',
    inputsNote: 'orderedMoves (OrderedMove[]), outline (Polygon[]), params',
    returnsNote: 'OrderedMove[] (interleaved extrusions + travels)',
    defaultCode: `// [Step 1] Build the safe combing road: outline eroded by (combingInset + avoidDistance)
const combOffset = -(params.combingInset + params.avoidDistance)
const combArea = params.combing ? offset(outline, combOffset) : []
step('Safe combing envelope', combArea, params.combing ? \`inset \${(-combOffset / 1000).toFixed(2)} mm\` : 'Combing disabled')

// [Step 2] Route travel moves between consecutive extrusions (straight inside vs boundary detour)
const spacing = Math.max(params.combingInset / 2, 1)
const outlineTol = offset(outline, 10)
const combTol = combArea.length > 0 ? offset(combArea, 10) : []

const moves = []
const combedTravels = []
const airTravels = []

for (const move of orderedMoves) {
  const prev = moves[moves.length - 1]
  if (prev && prev.kind === 'extrusion' && move.kind === 'extrusion') {
    const from = lineEnd(prev.line)
    const to = lineStart(move.line)

    let path = [from, to]
    let combed = false

    if (params.combing && combTol.length > 0) {
      if (segmentInsideArea(from, to, combTol, spacing)) {
        combed = true
      } else {
        const detour = combAlongBoundary(from, to, combArea, combTol, spacing)
        if (detour) {
          path = detour
          combed = true
        }
      }
    }

    const goesOutside = !combed && !pathInsideArea(path, outlineTol, spacing)
    const len = polylineLength(path)
    const retract = goesOutside || len > params.retractionMinDistance
    const zHop = retract && params.zHop && goesOutside

    const travelMove = {
      kind: 'travel',
      feature: 'travel',
      line: path,
      travel: { combed, goesOutside, retract, zHop },
    }
    moves.push(travelMove)
    if (combed) combedTravels.push(travelMove)
    else airTravels.push(travelMove)
  }
  moves.push(move)
}
step('Combed interior travels', combedTravels, \`\${combedTravels.length} inside-part travel(s)\`)

// [Step 3] Isolate travels that cross boundaries or open air and require retraction / Z-hop
step('Uncombed / retract travels', airTravels, \`\${airTravels.length} boundary-crossing travel(s)\`)

// [Step 4] Final interleaved sequence of extrusion and travel moves for the layer
step('Final interleaved layer moves', moves, \`\${moves.length} total moves (extrusions + travels)\`)

return moves`,
  },
}

// ---------------------------------------------------------------------------
// Function & parameter metadata catalog for automatic code-block analysis
// ---------------------------------------------------------------------------

const FUNCTION_CATALOG: Record<string, string> = {
  offset: 'Clipper inward/outward polygon erosion or dilation by delta microns',
  difference: 'Clipper boolean subtraction (A − B) clipping away covered regions',
  union: 'Clipper boolean union merging overlapping or touching polygons',
  unionAll: 'Boolean union across an array of polygons into clean disjoint contours',
  intersect: 'Clipper boolean intersection keeping only overlapping area',
  ringsOf: 'Extracts outer boundary ring and hole rings from each polygon',
  ringsToSegments: 'Decomposes closed polygon rings into individual 2-point line segments',
  stitchRawSegments: 'Chains unsorted triangle-plane segments via 10 µm endpoint grid hashing + 100 µm gap patching',
  ringsToPolygons: 'Sorts closed rings by area and classifies CCW islands vs CW holes by point-in-ring containment',
  ringToWallLine: 'Converts a closed polygon ring into a closed ExtrusionLine of width w',
  extrusionLineSausages: 'Offsets each extrusion segment by w/2 to model the physical plastic bead footprint',
  wallBandRegion: 'Computes the outer perimeter shell (outline − offset(outline, −wallCount × wallWidth))',
  computeGaps: 'Subtracts extruded bead footprints from the wall band and filters out slivers < 10 µm',
  arachneInsets: 'Generates up to wallCount full-width perimeter insets, dropping degenerate sliver rings',
  computeSkeleton: 'Samples boundary every wallWidth/8 and connects Delaunay circumcentres into a medial-axis graph with clearance radius r',
  pruneSkeleton: 'Iteratively trims noisy leaf branches shorter than 2 × skeletonSpacing near sharp corners',
  skeletonPolylines: 'Decomposes the medial-axis graph into maximal degree-2 chains between junctions and leaves',
  beadWidth: 'Computes adaptive Arachne width w = d / round(d / wallWidth) from local thickness d = 2r',
  smoothWidths: 'Moving-average smoothing of bead widths over transitionLength (0.4 × wallWidth) clamped to local thickness d',
  extractBeadRuns: 'Splits a skeleton chain into contiguous beadable runs longer than wallWidth / 2',
  generateInfill: 'Generates pattern lattice (scanlines, honeycomb, or marching-squares 3D gyroid) and clips to region polygons',
  groupFeaturesByOrder: 'Buckets extrusion paths into Cura’s surface-quality order (infill → inner-wall → outer-wall → gap-fill → skin)',
  nearestVertex: 'Finds the vertex on a closed wall ring closest to the current nozzle position (places the Z-seam)',
  rotateRing: 'Cyclicly shifts a closed wall loop to start and end at the chosen Z-seam vertex without reversing winding',
  weightedDistance: 'Momentum-aware travel cost d × (1 − 0.5 cos θ) penalizing sharp direction reversals',
  endingDirection: 'Computes the unit tangent vector at the end of a printed extrusion line',
  segmentInsideArea: 'Samples a straight travel segment every combingInset/2 µm to verify it never exits the combing zone',
  combAlongBoundary: 'Finds ring exit/entry crossings, walks the shorter boundary arc, and shortcuts chords with line-of-sight',
  pathInsideArea: 'Checks whether an entire multi-segment travel path stays inside the model boundary',
  polylineLength: 'Accumulates Euclidean arc length across a polyline in microns',
}

function formatParamValue(name: keyof PseudocodeParams, p: PseudocodeParams): string {
  const v = p[name]
  switch (name) {
    case 'layerHeight':
    case 'wallWidth':
    case 'minBeadWidth':
    case 'combingInset':
    case 'avoidDistance':
    case 'retractionMinDistance':
      return `${(Number(v) / 1000).toFixed(2)} mm (${v} µm)`
    case 'infillDensity':
      return `${Math.round(Number(v) * 100)}% (${v})`
    case 'infillAngle':
      return `${v}°`
    case 'printSpeed':
    case 'travelSpeed':
      return `${(Number(v) / 1000).toFixed(0)} mm/s`
    default:
      return String(v)
  }
}

/**
 * Compute quantitative metrics string for a step's geometry in physical mm / mm².
 */
function computeDataMetrics(g: StepGeometry): string {
  const metrics: string[] = []
  if (g.polygons.length > 0) {
    const areaMm2 = polygonsArea(g.polygons) / 1e6
    const holes = g.polygons.reduce((acc, p) => acc + p.holes.length, 0)
    const verts = g.polygons.reduce(
      (acc, p) => acc + p.outer.length + p.holes.reduce((s, h) => s + h.length, 0),
      0,
    )
    metrics.push(
      `${g.polygons.length} polygon${g.polygons.length === 1 ? '' : 's'} (${holes} hole${holes === 1 ? '' : 's'}, ${verts} pts) · Area: ${areaMm2.toFixed(2)} mm²`,
    )
  }
  if (g.skeleton) {
    const nodes = g.skeleton.nodes
    if (nodes.length > 0) {
      let minD = Infinity
      let maxD = 0
      for (const n of nodes) {
        const d = (2 * n.r) / 1000
        if (d < minD) minD = d
        if (d > maxD) maxD = d
      }
      metrics.push(
        `${nodes.length} medial nodes, ${g.skeleton.edges.length} edges · Local thickness 2r: ${minD.toFixed(2)}–${maxD.toFixed(2)} mm`,
      )
    } else {
      metrics.push('Empty skeleton')
    }
  }
  if (g.extrusionLines.length > 0) {
    let totalLenUm = 0
    let minW = Infinity
    let maxW = 0
    for (const line of g.extrusionLines) {
      for (let i = 0; i < line.length; i++) {
        if (line[i].w < minW) minW = line[i].w
        if (line[i].w > maxW) maxW = line[i].w
        if (i > 0) totalLenUm += dist(line[i - 1].p, line[i].p)
      }
    }
    const widthStr =
      Math.abs(maxW - minW) < 2
        ? `width ${(minW / 1000).toFixed(2)} mm`
        : `adaptive width ${(minW / 1000).toFixed(2)}–${(maxW / 1000).toFixed(2)} mm`
    metrics.push(
      `${g.extrusionLines.length} extrusion path${g.extrusionLines.length === 1 ? '' : 's'} · Length: ${(totalLenUm / 1000).toFixed(1)} mm · ${widthStr}`,
    )
  }
  if (g.polylines.length > 0) {
    let totalLenUm = 0
    for (const pl of g.polylines) totalLenUm += polylineLength(pl)
    metrics.push(
      `${g.polylines.length} polyline${g.polylines.length === 1 ? '' : 's'} · Total length: ${(totalLenUm / 1000).toFixed(1)} mm`,
    )
  }
  if (g.moves.length > 0) {
    let extCount = 0
    let travCount = 0
    let retractCount = 0
    let extLenUm = 0
    let travLenUm = 0
    for (const m of g.moves) {
      if (m.kind === 'extrusion') {
        extCount++
        const l = m.line as ExtrusionLine
        for (let i = 1; i < l.length; i++) extLenUm += dist(l[i - 1].p, l[i].p)
      } else {
        travCount++
        if (m.travel?.retract) retractCount++
        travLenUm += polylineLength(m.line as Polyline)
      }
    }
    const parts: string[] = []
    if (extCount > 0) parts.push(`${extCount} extrusions (${(extLenUm / 1000).toFixed(1)} mm)`)
    if (travCount > 0) {
      parts.push(
        `${travCount} travels (${(travLenUm / 1000).toFixed(1)} mm, ${retractCount} retract${retractCount === 1 ? '' : 's'})`,
      )
    }
    metrics.push(parts.join(' · '))
  }
  return metrics.join(' | ') || '0 geometric elements (empty region on this layer)'
}

/**
 * Curated algorithmic and physical-print significance explanations keyed by step label pattern.
 */
function describeStepSemantics(
  label: string,
  params: PseudocodeParams,
  g: StepGeometry,
): { algorithm: string; whatItDoes: string; significance: string } {
  const lower = label.toLowerCase()
  const wMm = (params.wallWidth / 1000).toFixed(2)
  const totalWallMm = ((params.wallCount * params.wallWidth) / 1000).toFixed(2)

  if (lower.includes('raw intersection')) {
    return {
      algorithm: 'Plane–Triangle Intersection (Half-Open Interval Rule)',
      whatItDoes:
        'Collects the unsorted 2D line segments where the horizontal slice plane cuts across mesh triangles (or decomposes 2D preset polygons into raw edges).',
      significance:
        'Raw segments have no topological order or inside/outside orientation yet; nozzles cannot print disconnected segments without stitching them into continuous loops first.',
    }
  }
  if (lower.includes('stitched closed')) {
    return {
      algorithm: 'Spatial Endpoint Hashing (10 µm Grid) + Gap Patching (100 µm)',
      whatItDoes:
        'Chains segment endpoints that snap to the same 10 µm grid cell into continuous closed loops, bridging micro-gaps up to 100 µm from non-watertight STL meshes.',
      significance:
        'Produces closed topological rings required by Clipper boolean/offset operations in every subsequent stage.',
    }
  }
  if (lower.includes('outer islands')) {
    return {
      algorithm: 'Even-Odd Containment & Shoelace Signed Area Winding',
      whatItDoes:
        'Sorts stitched loops by area descending and identifies top-level outer boundaries (oriented counter-clockwise, positive signed area).',
      significance:
        'Defines the solid exterior boundary of each disconnected part on the build plate where outer walls will be placed.',
    }
  }
  if (lower.includes('interior holes')) {
    return {
      algorithm: 'Point-in-Polygon Depth Classification',
      whatItDoes:
        'Identifies rings enclosed inside an outer island and orients them clockwise (negative signed area) so Clipper treats them as subtracted cavities.',
      significance:
        'Ensures bolt holes and internal cutouts receive inner perimeter walls and are excluded from infill and combing.',
    }
  }
  if (lower.includes('final layer outline')) {
    return {
      algorithm: 'Clipper Vatti Boolean Union',
      whatItDoes:
        'Runs a full boolean union across all classified polygons to resolve self-intersections and merge touching mesh shells.',
      significance:
        'Forms the canonical 2D layer boundary (`outline`) consumed by Areas, Walls, Combing, and Metrics.',
    }
  }
  if (lower.includes('interior core')) {
    return {
      algorithm: 'Clipper Polygon Erosion (Inward Offset)',
      whatItDoes: `Erodes the layer outline inward by wallCount × wallWidth (${params.wallCount} × ${wMm} mm = −${totalWallMm} mm) to find the core region past all perimeters.`,
      significance:
        'Any part feature thinner than 2 × wallInset disappears here, telling the slicer that region is 100% walls and has no room for infill or skin.',
    }
  }
  if (lower.includes('perimeter walls band')) {
    return {
      algorithm: 'Clipper Boolean Difference (Outline − Interior)',
      whatItDoes: `Subtracts the eroded interior core from the outer outline, leaving a ${totalWallMm} mm wide outer shell reserved for perimeter loops.`,
      significance:
        'Defines the exact target zone that wall extrusions must fill; any area in this band left uncovered by wall beads becomes an under-extrusion gap.',
    }
  }
  if (lower.includes('combing boundary')) {
    return {
      algorithm: 'Half-Bead Inward Offset (−wallWidth / 2)',
      whatItDoes: `Insets the outline by half a nozzle width (−${(params.wallWidth / 2000).toFixed(2)} mm) to match the centreline of the outermost wall.`,
      significance:
        'Provides the outer envelope inside which travel moves can safely comb without dragging the hot nozzle across the visible outer surface.',
    }
  }
  if (lower.includes('bottom exposed skin')) {
    return {
      algorithm: 'Cross-Layer Boolean Difference (Interior − Layer[i − bottomLayers])',
      whatItDoes: `Compares this layer’s interior against the layer ${params.bottomLayers} steps below; any unsupported interior region becomes bottom solid skin.`,
      significance:
        'Seals downward-facing surfaces and overhangs with 100% dense plastic so sparse infill is never exposed on the bottom of the print.',
    }
  }
  if (lower.includes('top exposed skin')) {
    return {
      algorithm: 'Cross-Layer Boolean Difference (Interior − Layer[i + topLayers])',
      whatItDoes: `Compares this layer’s interior against the layer ${params.topLayers} steps above; any region that will be exposed to air within ${params.topLayers} layers becomes top solid skin.`,
      significance:
        'Builds a multi-layer solid roof over sparse infill so the top surface of the print is smooth and pillow-free.',
    }
  }
  if (lower.includes('sparse infill region')) {
    return {
      algorithm: 'Boolean Subtraction (Interior − Union(DownSkin, UpSkin))',
      whatItDoes:
        'Subtracts both top and bottom solid skin regions from the interior core, leaving only the deeply buried interior volume.',
      significance:
        'Saves print time and filament by restricting low-density lattice infill (${Math.round(params.infillDensity * 100)}%) to regions hidden inside the part.',
    }
  }
  if (lower.startsWith('wall #')) {
    return {
      algorithm: 'Iterative Contour-Parallel Inward Offsetting',
      whatItDoes: `Offsets the outline inward by (i + 0.5) × ${wMm} mm and converts every resulting outer and hole ring into a closed ${wMm} mm extrusion path.`,
      significance:
        'Creates the concentric perimeter shells that give the print its dimensional accuracy and mechanical skin strength.',
    }
  }
  if (lower.includes('all constant-width wall')) {
    return {
      algorithm: 'Perimeter Loop Aggregation (Outermost-First)',
      whatItDoes: `Collects all ${g.extrusionLines.length} closed constant-width perimeter loops across ${params.wallCount} inset levels.`,
      significance:
        'Because width is fixed at ${wMm} mm, regions narrower than ${wMm} mm cannot fit an inset loop and are left empty.',
    }
  }
  if (lower.includes('nominal wall band')) {
    return {
      algorithm: 'Shell Band Difference (outline − offset(outline, −wallCount × wallWidth))',
      whatItDoes: `Computes the ${totalWallMm} mm boundary band that the ${params.wallCount} walls are responsible for filling.`,
      significance:
        'Serves as the reference ground-truth region for gap detection so the hollow infill interior is not falsely counted as a wall gap.',
    }
  }
  if (lower.includes('extruded bead coverage')) {
    return {
      algorithm: 'Round Polyline Dilation (Minkowski Sum with Disc of Radius w/2)',
      whatItDoes: `Expands every wall centreline by half its extrusion width (${(params.wallWidth / 2000).toFixed(2)} mm) and unions the resulting "sausage" footprints.`,
      significance:
        'Models the actual 2D area covered by flattened molten plastic from the nozzle.',
    }
  }
  if (lower.includes('unfilled wall gaps')) {
    return {
      algorithm: 'Boolean Difference + Minimum Sliver Erosion Filter (10 µm)',
      whatItDoes:
        'Subtracts the extruded bead footprints from the nominal wall band and filters out discretization slivers thinner than 10 µm.',
      significance:
        'Highlights sharp corners, thin wedge tips, and narrow ribs where constant-width walls leave voids that weaken the part.',
    }
  }
  if (lower.includes('full-width inset perimeters')) {
    return {
      algorithm: 'Sliver-Guarded Contour Offsetting',
      whatItDoes: `Places up to ${params.wallCount} standard ${wMm} mm insets, automatically dropping the innermost loop if its core collapses into a degenerate sliver.`,
      significance:
        'Uses fast, smooth constant-width loops where the geometry is thick, leaving thin regions for Arachne’s medial-axis beads.',
    }
  }
  if (lower.includes('uncovered thin remainder')) {
    return {
      algorithm: 'Boolean Difference (Outline − Inset Coverage)',
      whatItDoes:
        'Subtracts the footprint of the standard full-width insets from the part outline to isolate narrow wedges and thin walls.',
      significance:
        'Pinpoints the exact sub-regions where constant-width slicing would fail and where variable-width medial beads are needed.',
    }
  }
  if (lower.includes('medial-axis skeleton')) {
    return {
      algorithm: 'Boundary Sampling + Delaunay Circumcentre Voronoi Graph + Leaf Pruning',
      whatItDoes: `Samples the outline every ${(params.wallWidth / 8000).toFixed(3)} mm, connects interior Delaunay circumcentres, and prunes noisy corner branches shorter than ${(params.wallWidth / 4000).toFixed(2)} mm.`,
      significance:
        'Every skeleton node carries clearance radius r to the nearest boundary, giving exact local part thickness d = 2r along thin features.',
    }
  }
  if (lower.includes('adaptive variable-width centrelines')) {
    return {
      algorithm: `Arachne Beading (n = round(2r / w), w_bead = 2r / n, ${params.beadingStrategy} smoothing)`,
      whatItDoes: `Walks skeleton chains inside the thin remainder where 2r ≤ ${(2 * params.wallCount * params.wallWidth / 1000).toFixed(2)} mm and assigns bead widths down to minBeadWidth = ${(params.minBeadWidth / 1000).toFixed(2)} mm.`,
      significance:
        'Fills tapering wedges and thin walls with a single continuously varying extrusion bead instead of leaving empty gaps or over-extruding.',
    }
  }
  if (lower.includes('final arachne walls')) {
    return {
      algorithm: 'Hybrid Toolpath Merge + Wall-Band Gap Verification',
      whatItDoes:
        'Combines the standard full-width insets with the variable-width medial centreline beads and measures any residual uncovered area.',
      significance:
        'Dramatically reduces unfilled gap area on thin wedges and fine details compared to constant-width perimeters.',
    }
  }
  if (lower.includes('target infill & skin regions')) {
    return {
      algorithm: 'Multi-Direction Density Scaling (spacing = nDir × lineWidth / density)',
      whatItDoes: `Calculates scanline spacing so that ${params.infillPattern} infill at ${Math.round(params.infillDensity * 100)}% density deposits the exact target volume fraction.`,
      significance:
        'Prevents multi-directional patterns (grid = 2×, triangles/cubic = 3×) from multiplying plastic density.',
    }
  }
  if (lower.includes('unclipped pattern lattice')) {
    return {
      algorithm:
        params.infillPattern === 'gyroid'
          ? '3D Gyroid Implicit Field Slice (Z = π/4) + 16-Case Marching Squares'
          : params.infillPattern === 'honeycomb'
            ? 'Deduplicated Hexagonal Lattice Tiling'
            : `Rotated Bounding-Box Scanline Generation (${params.infillAngle}°)`,
      whatItDoes: `Generates the continuous ${params.infillPattern} lattice across the rotated bounding box of the infill region before boundary clipping.`,
      significance:
        'Keeps the infill phase-aligned across separate islands and layers so internal struts stack vertically into rigid 3D walls.',
    }
  }
  if (lower.includes('clipped sparse infill')) {
    return {
      algorithm: 'Parametric Line–Polygon Intersection & Midpoint Containment Clipping',
      whatItDoes:
        'Intersects every raw lattice line with outer and hole rings, keeping only sub-segments whose midpoints lie inside infillRegion.',
      significance:
        'Produces the actual sparse internal scaffold extrusions that support top layers while minimizing weight and print time.',
    }
  }
  if (lower.includes('solid skin zigzag')) {
    return {
      algorithm: '100% Density Serpentine Scanline Chaining (+90° Alternating Layer Angle)',
      whatItDoes:
        'Fills exposed top and bottom skin regions with side-by-side lines at 100% density, chaining adjacent scanlines along the boundary where safe.',
      significance:
        'Creates air-tight, visually solid top and bottom floors; alternating the angle by 90° each layer bridges across sparse infill without sagging.',
    }
  }
  if (lower.startsWith('ordered ')) {
    return {
      algorithm: 'Momentum-Weighted Greedy Nearest-Neighbour TSP + Z-Seam Vertex Rotation',
      whatItDoes:
        'Greedily selects the next path in this feature bucket using effective cost d × (1 − 0.5 cos θ), flipping open lines or rotating closed wall rings to the nearest vertex.',
      significance:
        'Minimizes non-printing travel time, avoids sudden 180° toolhead jerk, and tucks wall Z-seams near the nozzle’s arrival point.',
    }
  }
  if (lower.includes('complete ordered extrusion')) {
    return {
      algorithm: 'Constrained Feature-Order Concatenation (Infill → Inner Wall → Outer Wall → Skin)',
      whatItDoes:
        'Combines all ordered feature groups into the final extrusion sequence for the layer.',
      significance:
        'Printing infill and inner walls before the outer wall ensures the visible outer perimeter is laid against stable plastic and never bumped afterward.',
    }
  }
  if (lower.includes('safe combing envelope')) {
    return {
      algorithm: 'Clearance-Adjusted Inward Erosion (−(combingInset + avoidDistance))',
      whatItDoes: params.combing
        ? `Erodes the layer outline inward by combingInset + avoidDistance (${((params.combingInset + params.avoidDistance) / 1000).toFixed(2)} mm) to define the safe interior travel road.`
        : 'Combing is disabled; all travels will move in straight point-to-point lines.',
      significance:
        'Keeps the hot nozzle away from the outer cosmetic wall during non-printing travel moves so oozed filament stays hidden inside the infill.',
    }
  }
  if (lower.includes('combed interior travels')) {
    return {
      algorithm: 'Boundary-Walking Detour + Iterative Line-of-Sight Chord Shortcutting',
      whatItDoes:
        'Routes travels that stay inside the combing envelope (either straight across or by detouring around concave notches and holes along the comb boundary).',
      significance:
        'Eliminates stringing across holes and concave gaps without needing a slow filament retraction or Z-hop.',
    }
  }
  if (lower.includes('uncombed / retract travels')) {
    return {
      algorithm: 'Boundary-Crossing Detection + Retraction & Z-Hop Policy',
      whatItDoes: `Identifies travels that must cross open air between separate islands (or exceed ${(params.retractionMinDistance / 1000).toFixed(1)} mm) and flags them for filament retraction${params.zHop ? ' and Z-hop' : ''}.`,
      significance:
        'Prevents stringing scars on exterior surfaces and nozzle collisions when jumping across open air between disconnected parts.',
    }
  }
  if (lower.includes('final interleaved layer moves')) {
    return {
      algorithm: 'Full Layer Toolpath Assembly (Extrusions + Travels)',
      whatItDoes:
        'Interleaves every ordered extrusion path with its computed travel move to form the complete layer G-code motion plan.',
      significance:
        'Directly drives the print-head animation, 3D toolpath ribbon view, and layer time/length metrics.',
    }
  }

  return {
    algorithm: 'Custom Pseudocode Checkpoint',
    whatItDoes: `Executes the code block up to "${label}" and captures the intermediate geometry for inspection.`,
    significance:
      'Allows inspecting custom intermediate polygons, polylines, skeletons, or toolpath moves on the 2D canvas.',
  }
}

/**
 * Determine the 1-based [startLine, endLine] code block for each `step(` call in `code`,
 * plus extract the functions and `params.*` referenced in that code block.
 */
function analyzeCodeBlocks(
  code: string,
  params: PseudocodeParams,
): Map<
  number,
  {
    startLine: number
    endLine: number
    functionsCalled: StepFunctionUsed[]
    paramsUsed: StepParamUsed[]
  }
> {
  const lines = code.split('\n')
  const stepLines: number[] = []
  lines.forEach((line, idx) => {
    const commentIdx = line.indexOf('//')
    const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line
    if (/(?<![.\w$])step\s*\(/.test(codePart)) {
      stepLines.push(idx + 1)
    }
  })

  const result = new Map<
    number,
    {
      startLine: number
      endLine: number
      functionsCalled: StepFunctionUsed[]
      paramsUsed: StepParamUsed[]
    }
  >()

  let prevEnd = 0
  for (let i = 0; i < stepLines.length; i++) {
    const stepLine = stepLines[i]
    let startLine = prevEnd + 1
    // Advance past blank lines and standalone closing braces from the previous block
    while (startLine < stepLine) {
      const trimmed = lines[startLine - 1].trim()
      if (trimmed === '' || trimmed === '}') {
        startLine++
      } else {
        break
      }
    }

    let endLine = stepLine
    // Include multiline step(...) arguments if the call spans multiple lines
    let openParens = 0
    for (let l = stepLine; l <= lines.length; l++) {
      const commentIdx = lines[l - 1].indexOf('//')
      const codePart = commentIdx >= 0 ? lines[l - 1].slice(0, commentIdx) : lines[l - 1]
      for (const ch of codePart) {
        if (ch === '(') openParens++
        else if (ch === ')') openParens--
      }
      endLine = l
      if (openParens <= 0) break
    }
    // If the immediately following line closes a loop that contains this step, include it
    if (endLine < lines.length && lines[endLine].trim() === '}') {
      endLine++
    }
    prevEnd = endLine

    const blockText = lines
      .slice(startLine - 1, endLine)
      .map((l) => {
        const c = l.indexOf('//')
        return c >= 0 ? l.slice(0, c) : l
      })
      .join('\n')

    const functionsCalled: StepFunctionUsed[] = []
    for (const [fnName, desc] of Object.entries(FUNCTION_CATALOG)) {
      const re = new RegExp(`\\b${fnName}\\s*\\(`)
      if (re.test(blockText) || new RegExp(`\\(${fnName}\\)`).test(blockText)) {
        functionsCalled.push({ name: `${fnName}()`, description: desc })
      }
    }

    const paramsUsed: StepParamUsed[] = []
    const seenParams = new Set<string>()
    const paramRegex = /\bparams\.([A-Za-z_]\w*)\b/g
    let m: RegExpExecArray | null
    while ((m = paramRegex.exec(blockText)) !== null) {
      const pName = m[1] as keyof PseudocodeParams
      if (pName in params && !seenParams.has(pName)) {
        seenParams.add(pName)
        paramsUsed.push({
          name: `params.${pName}`,
          value: formatParamValue(pName, params),
        })
      }
    }

    result.set(stepLine, { startLine, endLine, functionsCalled, paramsUsed })
  }

  return result
}

// ---------------------------------------------------------------------------
// High-level domain helpers exposed to pseudocode scripts
// ---------------------------------------------------------------------------

function ringsOf(polys: Polygon[]): Ring[] {
  const out: Ring[] = []
  for (const poly of polys) {
    out.push(poly.outer, ...poly.holes)
  }
  return out
}

function closeRing(ring: Ring): Polyline {
  return ring.length > 0 ? [...ring, ring[0]] : []
}

function ringsToSegments(polys: Polygon[]): Polyline[] {
  const segs: Polyline[] = []
  for (const ring of ringsOf(polys)) {
    for (let i = 0; i < ring.length; i++) {
      segs.push([ring[i], ring[(i + 1) % ring.length]])
    }
  }
  return segs
}

function stitchRawSegments(rawSegments: Polyline[]): Ring[] {
  const segs = rawSegments
    .filter((s) => s.length >= 2)
    .map((s) => ({ a: s[0], b: s[s.length - 1] }))
  return stitchSegments(segs)
}

interface BeadRun {
  pts: Point[]
  widths: number[]
  thicknesses: number[]
}

function extractBeadRuns(
  chain: number[],
  widths: (number | null)[],
  skeleton: Skeleton,
  minRunLength: number,
): BeadRun[] {
  const runs: BeadRun[] = []
  let runStart = -1
  const flush = (end: number) => {
    if (runStart < 0 || end - runStart < 2) {
      runStart = -1
      return
    }
    const idxs = chain.slice(runStart, end)
    const pts = idxs.map((i) => skeleton.nodes[i].p)
    const thicknesses = idxs.map((i) => 2 * skeleton.nodes[i].r)
    const raw = widths.slice(runStart, end) as number[]
    let len = 0
    for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i])
    if (len >= minRunLength) {
      runs.push({ pts, widths: raw, thicknesses })
    }
    runStart = -1
  }
  for (let k = 0; k < chain.length; k++) {
    if (widths[k] !== null) {
      if (runStart < 0) runStart = k
    } else {
      flush(k)
    }
  }
  flush(chain.length)
  return runs
}

interface CandidateItem {
  flatIndex: number
  feature: FeatureKind
  line: ExtrusionLine
  closed: boolean
}

function groupFeaturesByOrder(
  features: FeaturePaths[],
  order: FeatureKind[],
): { kind: FeatureKind; candidates: CandidateItem[] }[] {
  const groups: { kind: FeatureKind; candidates: CandidateItem[] }[] = []
  let flatIndex = 0
  for (const kind of order) {
    const candidates: CandidateItem[] = []
    for (const f of features) {
      if (f.kind !== kind) continue
      for (const line of f.lines) {
        if (line.length === 0) continue
        candidates.push({ flatIndex: flatIndex++, feature: kind, line, closed: isClosed(line) })
      }
    }
    if (candidates.length > 0) groups.push({ kind, candidates })
  }
  return groups
}

function endingDirection(line: ExtrusionLine): Point | undefined {
  if (line.length < 2) return undefined
  const prev = line[line.length - 2].p
  const last = line[line.length - 1].p
  const len = dist(prev, last)
  return len > 0 ? { x: (last.x - prev.x) / len, y: (last.y - prev.y) / len } : undefined
}

// ---------------------------------------------------------------------------
// Step geometry normalization (for canvas overlay & summary badges)
// ---------------------------------------------------------------------------

function isPoint(v: unknown): v is Point {
  return typeof v === 'object' && v !== null && 'x' in v && 'y' in v && typeof (v as Point).x === 'number'
}

function isPolygon(v: unknown): v is Polygon {
  return (
    typeof v === 'object' &&
    v !== null &&
    'outer' in v &&
    'holes' in v &&
    Array.isArray((v as Polygon).outer)
  )
}

function isSkeleton(v: unknown): v is Skeleton {
  return (
    typeof v === 'object' &&
    v !== null &&
    'nodes' in v &&
    'edges' in v &&
    Array.isArray((v as Skeleton).nodes) &&
    Array.isArray((v as Skeleton).edges)
  )
}

function isOrderedMove(v: unknown): v is OrderedMove {
  return (
    typeof v === 'object' &&
    v !== null &&
    'kind' in v &&
    'feature' in v &&
    'line' in v &&
    ((v as OrderedMove).kind === 'extrusion' || (v as OrderedMove).kind === 'travel')
  )
}

export function normalizeStepGeometry(data: unknown): StepGeometry {
  const geom: StepGeometry = {
    polygons: [],
    extrusionLines: [],
    polylines: [],
    moves: [],
    skeleton: null,
    points: [],
    summary: '',
  }

  const visit = (val: unknown) => {
    if (!val) return
    if (isSkeleton(val)) {
      geom.skeleton = val
      return
    }
    if (isPolygon(val)) {
      geom.polygons.push(val)
      return
    }
    if (isOrderedMove(val)) {
      geom.moves.push(val)
      return
    }
    if (isPoint(val)) {
      geom.points.push(val)
      return
    }
    if (Array.isArray(val)) {
      if (val.length === 0) return
      const first = val[0]
      if (isPolygon(first)) {
        geom.polygons.push(...(val as Polygon[]))
      } else if (isOrderedMove(first)) {
        geom.moves.push(...(val as OrderedMove[]))
      } else if (isPoint(first)) {
        geom.points.push(...(val as Point[]))
      } else if (Array.isArray(first)) {
        for (const line of val as unknown[][]) {
          if (line.length === 0) continue
          const elem = line[0]
          if (typeof elem === 'object' && elem !== null && 'p' in elem && 'w' in elem) {
            geom.extrusionLines.push(line as ExtrusionLine)
          } else if (isPoint(elem)) {
            geom.polylines.push(line as Polyline)
          }
        }
      } else if (typeof first === 'object' && first !== null && 'line' in first) {
        for (const item of val as { line: unknown }[]) visit(item.line)
      }
      return
    }
    if (typeof val === 'object') {
      const rec = val as Record<string, unknown>
      for (const k of ['polygons', 'wallsRegion', 'skin', 'infillRegion', 'innerArea', 'gaps', 'walls', 'infillLines', 'skinLines', 'rawLines', 'moves', 'skeleton']) {
        if (k in rec) visit(rec[k])
      }
    }
  }

  visit(data)

  const parts: string[] = []
  if (geom.polygons.length > 0) parts.push(`${geom.polygons.length} poly`)
  if (geom.extrusionLines.length > 0) parts.push(`${geom.extrusionLines.length} bead`)
  if (geom.polylines.length > 0) parts.push(`${geom.polylines.length} line`)
  if (geom.moves.length > 0) parts.push(`${geom.moves.length} move`)
  if (geom.skeleton) parts.push(`${geom.skeleton.nodes.length} skel nodes`)
  if (geom.points.length > 0) parts.push(`${geom.points.length} pt`)
  geom.summary = parts.join(' · ') || 'empty'

  return geom
}

// ---------------------------------------------------------------------------
// Line-preserving instrumentation & execution
// ---------------------------------------------------------------------------

/**
 * Replace `step(` calls outside comments with `__step(<1-based line>, ` so every
 * recorded step knows the exact source line that produced it without shifting
 * line numbers.
 */
export function instrumentPseudocode(code: string): string {
  return code
    .split('\n')
    .map((line, idx) => {
      const commentIdx = line.indexOf('//')
      const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line
      const commentPart = commentIdx >= 0 ? line.slice(commentIdx) : ''
      const replaced = codePart.replace(/(?<![.\w$])step\s*\(/g, `__step(${idx + 1}, `)
      return replaced + commentPart
    })
    .join('\n')
}

const compiledFnCache = new Map<string, { paramKey: string; fn: (...args: unknown[]) => unknown }>()

export function runStagePseudocode<T = unknown>(
  _key: PseudocodeKey,
  code: string,
  ctx: PseudocodeContext,
): PseudocodeRunResult<T> {
  const steps: PseudoStep[] = []
  const t0 = performance.now()
  const blockMap = analyzeCodeBlocks(code, ctx.params)

  const recordStep = (line: number, label: unknown, data: unknown, note?: unknown) => {
    const geometry = normalizeStepGeometry(data)
    const labelStr = String(label ?? `Step ${steps.length + 1}`)
    const blockInfo = blockMap.get(line) ?? {
      startLine: line,
      endLine: line,
      functionsCalled: [],
      paramsUsed: [],
    }
    const sem = describeStepSemantics(labelStr, ctx.params, geometry)
    const dataMetrics = computeDataMetrics(geometry)

    steps.push({
      index: steps.length,
      label: labelStr,
      note: note !== undefined ? String(note) : geometry.summary,
      line,
      geometry,
      details: {
        startLine: blockInfo.startLine,
        endLine: blockInfo.endLine,
        algorithm: sem.algorithm,
        whatItDoes: sem.whatItDoes,
        significance: sem.significance,
        dataMetrics,
        functionsCalled: blockInfo.functionsCalled,
        paramsUsed: blockInfo.paramsUsed,
      },
    })
  }

  const stepFallback = (label: unknown, data: unknown, note?: unknown) => {
    recordStep(1, label, data, note)
  }

  const scope = {
    // Stage context inputs
    layers: ctx.layers,
    layerIndex: ctx.layerIndex,
    layer: ctx.layer,
    outline: ctx.outline,
    areas: ctx.areas,
    walls: ctx.walls,
    features: ctx.features,
    orderedMoves: ctx.orderedMoves,
    params: ctx.params,

    // Step checkpoint recorders
    __step: recordStep,
    step: stepFallback,

    // Clipper & polygon primitives
    union,
    difference,
    intersect,
    intersection: intersect,
    offset,
    offsetPolyline,
    pointInPolygons,
    pointInRing,
    unionAll,
    ringsOf,
    closeRing,
    ringsToSegments,
    stitchRawSegments,
    ringsToPolygons,
    polygonArea,
    polygonsArea,
    signedArea,
    dist,
    polylineLength,

    // Wall & Arachne primitives
    ringToWallLine,
    extrusionLineSausages,
    wallBandRegion,
    computeGaps,
    arachneInsets,
    computeSkeleton,
    pruneSkeleton,
    skeletonPolylines,
    beadWidth,
    smoothWidths,
    extractBeadRuns,

    // Infill primitives
    generateInfill,

    // Path order primitives
    groupFeaturesByOrder,
    isClosed,
    nearestVertex,
    rotateRing,
    weightedDistance,
    endingDirection,

    // Travel & combing primitives
    segmentInsideArea,
    pathInsideArea,
    combAlongBoundary,
    lineStart,
    lineEnd,
  }

  const paramNames = Object.keys(scope)
  const paramValues = paramNames.map((k) => scope[k as keyof typeof scope])
  const paramKey = paramNames.join(',')

  try {
    let cached = compiledFnCache.get(code)
    if (!cached || cached.paramKey !== paramKey) {
      const instrumented = instrumentPseudocode(code)
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function(...paramNames, `"use strict";{\n${instrumented}\n}`) as (
        ...args: unknown[]
      ) => unknown
      cached = { paramKey, fn }
      compiledFnCache.set(code, cached)
    }
    const output = cached.fn(...paramValues) as T
    return {
      ok: true,
      output,
      steps,
      error: null,
      runtimeMs: Math.max(0, performance.now() - t0),
    }
  } catch (err) {
    return {
      ok: false,
      output: null,
      steps,
      error: err instanceof Error ? err.message : String(err),
      runtimeMs: Math.max(0, performance.now() - t0),
    }
  }
}
