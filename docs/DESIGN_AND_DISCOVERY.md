# Cura Algorithm Explorer: What We Are Trying to Discover & How We Built It

## 1. What We Are Trying to Discover

When you design a mechanical part in CAD (such as the wearable voice-recorder enclosure, `case_bottom.stl`) and send it to a 3D printer, the **slicer** sits in the middle as a black box: a triangle mesh goes in, and thousands of G-code motion commands come out. When a thin snap-fit lip disappears, a corner bulges, a seam leaves a scar, or stringing appears across a pocket, a standard slicer preview only shows you the *final* toolpath — not **why** the algorithm made that geometric decision.

**Cura Algorithm Explorer** was built to open up that black box and let you discover five core computational-geometry trade-offs on real parts:

1. **Why Thin Features Fail Under Constant-Width Offsetting vs. How Arachne Solves It**
   - *Constant-width walls* (`src/algorithms/wallsConstant.ts`) erode the polygon inward by fixed multiples of nozzle width (`(i + 0.5) × w`). Any ridge or wedge narrower than `2w` either leaves an unprinted center void (**gap region**) or collapses and vanishes completely when eroded by `w / 2`.
   - *Arachne variable-width walls* (`src/algorithms/wallsArachne.ts`) construct the **medial-axis skeleton** (`src/geometry/skeleton.ts`) of the shape so every interior centerline point knows its exact clearance radius $r$ to the nearest boundary (local thickness $d = 2r$). Where fixed perimeters cannot fit, Arachne walks the skeleton and continuously adapts the nozzle flow width $w = d / \text{round}(d / w_{\text{nom}})$ so thin wedges and ribs print solid in a single pass.

2. **How Mesh Imperfections & Slice-Plane Intersections Become Clean 2D Polygons**
   - In `sliceMesh` (`src/algorithms/slicing.ts`), slicing at exact layer boundaries (`z = k × h`) hits triangle vertices and horizontal faces head-on. Slicing at **layer midpoints** (`z = (k + 0.5) × h`) with a **half-open vertex rule** (`z_vertex >= z_plane` counts as above) ensures shared triangle edges are crossed once, while 10 µm endpoint snapping and 100 µm gap patching (`stitchSegments`) recover closed contours from imperfect STL meshes.

3. **How Multi-Layer Boolean Set Algebra Separates Walls, Skin, and Sparse Infill**
   - A layer doesn't know on its own whether its interior is a solid floor/roof (**skin**) or hollow core (**infill**). `classifyAreas` (`src/algorithms/areas.ts`) intersects the current layer's interior with the outlines $N$ layers above and below (`topLayers` / `bottomLayers`): any region exposed to air within $N$ layers becomes 100% dense skin, and only the shielded core (`inner − skin`) receives sparse infill.

4. **How 2D Analytic Lattices & 3D Implicit Surfaces (Gyroid TPMS) Become Clipped Toolpaths**
   - In `generateInfill` (`src/algorithms/infill.ts`), patterns like **Gyroid** evaluate the 3D implicit surface $\sin x \cos y + \sin y \cos z + \sin z \cos x = 0$ at the current layer's $Z$ height, extract iso-contours via **Marching Squares**, and clip them against the irregular `infill` polygon boundary using Clipper2.

5. **How Path Ordering & Combing Trade Travel Time Against Surface Scars**
   - `orderLayerPaths` (`src/algorithms/pathOrder.ts`) uses nearest-neighbor + **2-opt local search** and corner-seam alignment (`rotateRing` to convex/concave vertices) to minimize non-printing travel and hide Z-seams.
   - `insertTravels` (`src/algorithms/travel.ts`) tests whether a straight move crosses outside an inset **combing envelope**; if it stays inside, it routes around holes along the polygon boundary so the nozzle doesn't ooze across visible outer walls.

---

## 2. How We Went About Creating the Application

We built the explorer iteratively in four layers so that the math, the code, and the visuals stay 100% locked together:

### Step 1: Pure Integer-Micron Computational Geometry Core
- Following real **CuraEngine** (`src/slicer.cpp`, `src/LayerPlan.cpp`, `src/wallOverlap.cpp`), all coordinates in `src/geometry/` and `src/algorithms/` use **integer microns** (`1000 µm = 1 mm`).
- Polygon boolean algebra (`union`, `difference`, `intersection`) and miter/round offsetting go through **Clipper2 WASM** (`src/geometry/clipper.ts`) to avoid floating-point self-intersection bugs.
- For the medial-axis skeleton (`src/geometry/skeleton.ts`), we implemented a transparent, step-inspectable approximation of Boost's segment-Voronoi: dense boundary sampling (`wallWidth / 8`), **Delaunay triangulation** (`d3-delaunay`), interior circumcentre Voronoi dual extraction, and iterative leaf-twig pruning (`pruneSkeleton` in `src/algorithms/wallsArachne.ts`).

### Step 2: Turning Static Explanations into Live, Executable Pseudocode
- Early on, static text panels on the right didn't show *how* the code produced the geometry on screen.
- We created `src/algorithms/pseudocode.ts` with 7 commented, readable algorithm scripts (`PSEUDOCODE_STAGES`) that call the real geometric primitives (`offset`, `difference`, `computeSkeleton`, `pruneSkeleton`, `extractBeadRuns`, `combAlongBoundary`) and emit intermediate checkpoints via `step(label, geometry, note)`.
- `instrumentPseudocode` rewrites `step(...)` calls at runtime to capture the exact source line range (`Lstart–end`), live parameter values, and output metrics (`computeDataMetrics`).
- Because **Drive layer slice data** is enabled by default in `runPipelineWithPseudocode` (`src/state/pipeline.ts`), editing a formula or threshold in the pseudocode editor immediately recomputes the 2D layer toolpaths and layer metrics table.

### Step 3: Explicit Code-to-Canvas Correlation (`S1..Sn`)
- In `src/ui/PseudocodePanel.tsx`, we linked every `step(...)` checkpoint (`S1..Sn`) to the contiguous code block that computed it (`analyzeCodeBlocks`).
- Clicking any step `S1..Sn` (or clicking directly on a code block) highlights those lines in cyan, dims the full layer on the canvas, and renders **only that step's intermediate geometry** (`step.geometry`) alongside a **Step Inspector** card explaining the algorithm used, live parameter values, and why the next step needs that output.

### Step 4: Shape-Contextual First-Principles Walkthroughs (`StepDeepDive`)
- Finally, we added the expandable **Detailed Explanation** popup (`src/ui/StepDeepDive.tsx`) under the canvas HUD.
- Rather than showing canned textbook illustrations, `SkeletonDeepDive` and `ContextualStepDeepDive` run live geometric analysis on **whatever shape and layer is currently loaded** (e.g., `case_bottom.stl` layer 16), locating its actual widest and thinnest interior points, plotting its real Delaunay triangles and circumcircles, comparing its unpruned vs. pruned skeleton, and wrapping every illustration in `ZoomableSvg` so you can pan and zoom into any feature.
