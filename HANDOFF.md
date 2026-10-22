# Handoff — Cura Algorithm Explorer

Status as of 2026-10-21. Read `AGENTS.md` (conventions) and `README.md` (feature/architecture
overview) first; this file is the project-state brain dump for whoever picks up next.

## What this is

An interactive web app that reimplements CuraEngine's slicer algorithms as small,
readable, tested TypeScript modules and lets users explore them on 2D polygons or
sliced STL layers: slicing → area classification → walls (constant vs Arachne
variable-width) → infill patterns → path ordering → combing/travel → metrics.

- Repo: `/Users/rana/dev_sasha/cura_exploration` (no git history — never initialized)
- Live: https://curaexploration.vercel.app (Vercel project `ahad-5636s-projects/cura_exploration`,
  directory is linked; redeploy with `npx vercel --yes --prod`)
- Stack: Vite 8 + React 19 + TS strict; Canvas 2D layer view; three.js 3D view;
  `js-angusj-clipper` (WASM Clipper) for boolean/offset; `d3-delaunay` for the
  medial-axis approximation; vitest + oxlint.
- State: **80/80 tests green, `tsc -b` clean, `oxlint` clean, `npm run build` clean.**
  Verified repeatedly with headless-Chromium smoke runs (zero console errors).

## Architecture map

```
src/geometry/    types.ts (micron coords, Polygon/ExtrusionLine), clipper.ts (the ONLY
                 clipper access point; initClipper() must be awaited once),
                 polyUtils.ts, skeleton.ts (boundary sampling + Delaunay circumcentres
                 ≈ medial axis; node.r = distance to boundary), stl.ts
src/algorithms/  one pure module per stage. Each exports `*Doc: StageDoc`
                 (structured markdown: The idea / Step by step / Key formulas /
                 Edge cases & simplifications / Try it) rendered by src/ui/markdown.tsx.
                 slicing.ts, areas.ts, wallsConstant.ts, wallsArachne.ts, infill.ts,
                 pathOrder.ts, travel.ts, metrics.ts
src/state/       pipeline.ts (sync single-layer chain: outline → areas → walls →
                 infill → order → travel → metrics),
                 pipelineCache.ts (versioned lazy multi-layer cache for the 3D view;
                 computes 2 layers per setTimeout(0) tick; >60 layers + arachne ⇒
                 non-current layers silently fall back to constant walls)
src/ui/          App-level wiring in src/App.tsx; LayerView.tsx (Canvas 2D + draw mode),
                 View3D.tsx (three.js), ribbon3d.ts (pure ribbon builder),
                 CompareView, AnimateControls, PipelinePanel/ParamsPanel,
                 ExplainerPanel (+ markdown.tsx), MetricsTable, vis.ts (toggles/colors)
src/presets/     shapes.ts — 7 stress presets (thin-wedge is the Arachne showcase)
```

Key data contracts in `src/algorithms/types.ts`. Coordinates are integer **microns**
everywhere. Extrusion paths are `ExtrusionLine` = junctions `{p, w}` (per-junction
width supports Arachne); closed wall rings repeat the first junction at the end
(there is no closed flag).

## Non-obvious decisions & pitfalls (learned the hard way)

- **Gap semantics**: `walls*.ts` report gaps relative to `wallBandRegion(outline,
  wallWidth, wallCount)` = `difference(outline, offset(outline, -(wallCount*wallWidth)))`,
  NOT the whole outline — otherwise the infill interior counts as a "gap" (this was a
  real bug caught by the washer preset: 1199 mm² → 0.14 mm²). Thin features lie
  entirely inside the band, so wedge tips/0.35 mm walls still show as gaps.
- **Arachne respects `wallCount`**: insets are capped at wallCount (unlimited insets
  made Arachne tile thick interiors with walls — another real bug). Centreline beads
  only where local thickness `d = 2r ≤ 2 * wallCount * wallWidth`; bead runs shorter
  than `wallWidth / 2` are dropped (corner-stub suppression).
- **2D gyroid field**: `sin(kx)cos(ky) + sin(ky)cos(kx)` degenerates to straight
  diagonals (it's `sin(k(x+y))`). The code uses a fixed-Z slice of the true 3D gyroid
  field instead. Don't "fix" this back.
- **Infill density**: n-direction patterns space each direction `n * lineWidth /
  density` apart so combined density stays `density`. Gyroid period `3 * lineWidth /
  density` was numerically calibrated (ratio 0.99–1.01).
- **Path-order angle weighting** uses `d * (1 - 0.5 * cos θ)` (prefers continuing
  straight). The `|sin|` formula from the original brief prefers perpendicular travel —
  don't use it.
- **js-angusj-clipper**: `PolyNode.isHole` is a property, not a method; clip params
  need `subjectInputs: [{data, closed: true}]`.
- **3D view dimming** is done by scaling vertex colors ×0.65, not opacity (avoids
  transparency-sort artifacts with the translucent mesh). Scene is Z-up, root group
  scaled ×0.001 so the camera works in mm.
- Tests assert qualitative invariants (e.g. wedge: arachne gap < 0.5 × constant gap)
  rather than exact geometry where sampling noise matters.

## Workflow that worked well here

Geometry core written first by hand (defines contracts) → algorithm stages built by
parallel coder subagents against `src/algorithms/types.ts` → integration pass (tsc +
full vitest) → UI by one agent → **headless-browser smoke tests caught real semantic
bugs the unit tests missed** (the gap-semantics and wallCount bugs above). Keep doing
visual smoke checks after algorithm changes: `npm i -D playwright`, script against the
dev server, screenshot, then `npm rm playwright` (it's intentionally not a dependency).

## Known simplifications (documented in-module and in README — don't "fix" accidentally)

Sampled-Delaunay medial axis (not Boost segment-Voronoi); moving-average bead
transitions (not trapezoidal regions); serpentine zigzag (not perimeter-walk);
simplified up/down skin classification; metrics' outside-travel measured by 1 mm
sub-segment sampling.

## Natural next steps (not started)

Lightning infill (tree-based, the biggest missing pattern), G-code export, tree
supports, ironing, brim/raft/skirt, print-order step-through extended to travels,
web-worker pipeline for large STLs, code-splitting (bundle is ~1.4 MB with three.js).
