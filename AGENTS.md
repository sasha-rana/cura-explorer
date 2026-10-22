# AGENTS.md

Interactive explorer for CuraEngine slicer algorithms. Vite + React 19 + TypeScript
(strict), Canvas 2D (layer view) + three.js (perspective 3D view for STL sources), vitest.

## Commands

- `npm run dev` — dev server
- `npm run test` — vitest (all tests must stay green)
- `npm run build` — `tsc -b` + vite build (must stay clean)
- `npx oxlint` — lint

## Conventions

- Coordinates are integer **microns** (1000 = 1 mm) everywhere, matching CuraEngine.
- `src/geometry/` and `src/algorithms/` are pure and DOM-free; all DOM/React code
  lives in `src/ui/` and `src/App.tsx`.
- Every algorithm module exports a `*Doc: StageDoc` (see `src/algorithms/types.ts`)
  with teaching text and the CuraEngine source file it mirrors — update it when you
  change the algorithm's behavior.
- Clipper access goes through `src/geometry/clipper.ts`; `initClipper()` must be
  awaited once before any boolean/offset call (tests do it in `beforeAll`).
- Style: no semicolons, single quotes, 2-space indent. Comments only where the
  algorithm needs explanation.
- When adding an algorithm stage: expose intermediate results for the teaching view,
  add vitest coverage with metric-based assertions, and wire it into
  `src/state/pipeline.ts` and the UI panels.

## Known simplifications (do not "fix" accidentally)

Medial axis is sampling+Delaunay based (not Boost segment-Voronoi); zigzag connection
is serpentine (not perimeter-walking); skin classification is simplified. These are
documented in the respective module docs and README.
