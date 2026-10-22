# Cura Algorithm Explorer

An interactive web app for exploring the computational-geometry algorithms inside
[CuraEngine](https://github.com/Ultimaker/CuraEngine), the slicer that turns 3D models
into G-code. Take a shape — draw a 2D polygon, pick a stress-test preset, or load an
STL file — and step through each stage of the slicing pipeline, tweak its parameters,
compare strategies side by side, and watch the nozzle execute the resulting toolpath.

The algorithms are reimplemented from scratch as small, readable, tested TypeScript
modules, each mapped to the CuraEngine source file and paper it mirrors.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run test       # vitest, 54 tests
npm run build      # type-check + production build
```

## What you can explore

| Stage | Module | Mirrors | Highlights |
|---|---|---|---|
| Slicing | `src/algorithms/slicing.ts` | `src/slicer.cpp` | plane–triangle intersection, segment stitching, small-hole patching; raw segments vs stitched outline |
| Areas | `src/algorithms/areas.ts` | `src/skin.cpp`, `src/WallsComputation.cpp` | wall band / top-bottom skin / sparse infill classification via offsets & booleans |
| Walls (constant) | `src/algorithms/wallsConstant.ts` | `src/WallsComputation.cpp` | Clipper insets, gap detection in sharp corners and thin features |
| Walls (Arachne) | `src/algorithms/wallsArachne.ts` | `src/WallsComputation.cpp` + [Kuipers et al. 2020](https://arxiv.org/abs/2005.08840) | medial axis, local feature size `d = 2r`, bead count `n = round(d/w)`, variable-width centrelines |
| Infill | `src/algorithms/infill.ts` | `src/infill.cpp` | scanline engine; lines, zigzag, grid, triangles, cubic, honeycomb, gyroid (marching squares); density → spacing rule |
| Path order | `src/algorithms/pathOrder.ts` | `src/InsetOrderOptimizer.cpp` | rigid feature order, nearest-neighbour TSP heuristic with acceleration-aware angle weighting, decision trace |
| Travel | `src/algorithms/travel.ts` | `src/pathPlanning/Comb.cpp` | combing along the boundary (fewest-vertices detour), collision avoidance, retract / Z-hop decisions |
| Metrics | `src/algorithms/metrics.ts` | — | extrusion/travel length, outside travel, gap area, estimated time |

Every module exports a `*Doc` object (shown in the app's explainer panel) with teaching
notes, the CuraEngine file it mirrors, and paper/wiki references.

## App features

- **Pipeline sidebar** — one collapsible section per stage with its parameters and
  toggles for intermediate results (raw scanlines, insets, the medial-axis skeleton,
  gap regions, unordered vs ordered paths).
- **Compare mode** — constant-width vs Arachne walls side by side with metrics.
  Try the *Thin wedge* and *Thin wall* presets.
- **Animate mode** — virtual nozzle plays back the print at real print/travel speeds,
  with retraction and Z-hop markers.
- **Path-order step-through** — scrub the greedy nearest-neighbour sequence move by move.
- **Draw mode** — draw and edit your own polygons.
- **STL input** — built-in cube/pyramid demos or open any `.stl`; scrub through layers.
  Skin direction alternates per layer like Cura.

## Presets and what they stress

`thin-wedge` (Arachne's showcase), `thin-wall` (sub-line-width feature), `sharp-corner`
(gap generation), `c-shape` (combing detours), `two-parts` (travel between parts),
`washer` (holes), `ribbon` (varying local thickness).

## Architecture

```
src/geometry/     pure geometry core (micron integer coordinates, like CuraEngine)
  clipper.ts        boolean ops + offsetting via js-angusj-clipper (WASM Clipper)
  polyUtils.ts      areas, scanline crossings, edge sampling, distances
  skeleton.ts       medial-axis approximation (boundary sampling + Delaunay/Voronoi)
  stl.ts            binary/ASCII STL parsing, mesh adjacency
src/algorithms/   one pure, DOM-free module per slicer stage (see table above)
src/state/        pipeline.ts — chains the stages into a full layer plan
src/ui/           React components: canvas viewer, panels, compare & animate modes
src/presets/      stress-test shapes
```

Key conventions: all coordinates are integer **microns** (1000 = 1 mm) so they feed
directly into Clipper; everything under `geometry/` and `algorithms/` is pure and
unit-tested; intermediate results are always exposed for visualization.

### Honest simplifications

- The medial axis is approximated by densely sampling the boundary and connecting
  circumcentres of a Delaunay triangulation; CuraEngine uses Boost's exact
  segment-Voronoi. Bead-count transitions are smoothed with a moving average instead
  of Arachne's trapezoidal transition regions.
- Zigzag infill connects scanlines serpentine-style; CuraEngine walks the perimeter.
- Skin classification uses a simplified up/down-layer boolean.

Out of scope (v1): supports, lightning infill, ironing, multi-extruder, brim/raft,
G-code export, adaptive layers.

## References

- CuraEngine wiki: [Slicing](https://github.com/Ultimaker/CuraEngine/wiki/Slicing),
  [Generating Areas](https://github.com/Ultimaker/CuraEngine/wiki/Generating-Areas),
  [Generating Paths](https://github.com/Ultimaker/CuraEngine/wiki/Generating-Paths),
  [Internals](https://github.com/Ultimaker/CuraEngine/wiki/Internals)
- Kuipers, Doubrovski, Wu, Wang — *A framework for adaptive width control of dense
  contour-parallel toolpaths*, Computer-Aided Design 2020
  ([arXiv:2005.08840](https://arxiv.org/abs/2005.08840))
- Hornus et al. — *Variable-width contouring for additive manufacturing*, ACM SIGGRAPH 2020
