import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { initClipper } from './geometry/clipper'
import { parseStl } from './geometry/stl'
import type { Point, Polygon, Triangle } from './geometry/types'
import {
  PSEUDOCODE_STAGES,
  stagePseudocodeKey,
  type PseudocodeKey,
  type PseudocodeRunResult,
} from './algorithms/pseudocode'
import { sliceMesh } from './algorithms/slicing'
import type { SlicedLayer } from './algorithms/types'
import {
  presetLabels,
  presets,
  stlPresets,
  type PresetId,
  type StlPresetId,
} from './presets/shapes'
import {
  defaultPipelineParams,
  runPipelineWithPseudocode,
  type PipelineParams,
} from './state/pipeline'
import { AnimateControls } from './ui/AnimateControls'
import { CompareView } from './ui/CompareView'
import { ExplainerPanel } from './ui/ExplainerPanel'
import { LayerView } from './ui/LayerView'
import { PipelinePanel } from './ui/PipelinePanel'
import { View3D } from './ui/View3D'
import { defaultVis, type StageId, type VisState } from './ui/vis'
import './App.css'

type Source =
  | { kind: 'preset'; id: PresetId }
  | { kind: 'stl'; id: StlPresetId }
  | { kind: 'file'; name: string; triangles: Triangle[] }
  | { kind: 'custom' }

type Mode = 'normal' | 'compare' | 'animate'
type ViewMode = '2d' | '3d'

const sourceValue = (s: Source): string => {
  switch (s.kind) {
    case 'preset':
      return `preset:${s.id}`
    case 'stl':
      return `stl:${s.id}`
    case 'file':
      return 'file'
    case 'custom':
      return 'custom'
  }
}

function App() {
  const [ready, setReady] = useState(false)
  const [source, setSource] = useState<Source>({ kind: 'preset', id: 'thin-wedge' })
  const [customPolys, setCustomPolys] = useState<Polygon[]>([])
  const [params, setParams] = useState<PipelineParams>(defaultPipelineParams)
  const [dParams, setDParams] = useState<PipelineParams>(defaultPipelineParams)
  const [vis, setVis] = useState<VisState>(defaultVis)
  const [stage, setStage] = useState<StageId>('walls')
  const [layerIndex, setLayerIndex] = useState(0)
  const [mode, setMode] = useState<Mode>('normal')
  const [viewMode, setViewMode] = useState<ViewMode>('2d')
  const [drawMode, setDrawMode] = useState(false)
  const [draft, setDraft] = useState<Point[]>([])
  const [step, setStep] = useState<number | null>(null)
  const [animDist, setAnimDist] = useState<number | null>(null)
  const [fitKey, setFitKey] = useState(0)
  const [customCodes, setCustomCodes] = useState<Partial<Record<PseudocodeKey, string>>>({})
  const [driveLayer, setDriveLayer] = useState(true)
  const [selectedStep, setSelectedStep] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    initClipper().then(() => {
      if (live) setReady(true)
    })
    return () => {
      live = false
    }
  }, [])

  // Debounce parameter changes; the pipeline is memoized on the debounced copy.
  useEffect(() => {
    const id = setTimeout(() => setDParams(params), 150)
    return () => clearTimeout(id)
  }, [params])

  // Fit the canvas whenever the input source changes.
  useEffect(() => {
    setFitKey((k) => k + 1)
    setLayerIndex(0)
    setStep(null)
    setSelectedStep(null)
  }, [source])

  const stageKey = stagePseudocodeKey(stage, params.wallStrategy)

  // Clear isolated step checkpoint when switching stages or wall strategies.
  useEffect(() => {
    setSelectedStep(null)
  }, [stageKey])

  const layers = useMemo<SlicedLayer[]>(() => {
    if (!ready) return []
    switch (source.kind) {
      case 'preset':
        return [{ z: 0, polygons: presets[source.id], rawSegments: [] }]
      case 'custom':
        return [{ z: 0, polygons: customPolys, rawSegments: [] }]
      case 'stl':
        return sliceMesh(stlPresets[source.id], { layerHeight: dParams.layerHeight }).layers
      case 'file':
        return source.triangles.length === 0
          ? []
          : sliceMesh(source.triangles, { layerHeight: dParams.layerHeight }).layers
    }
  }, [ready, source, customPolys, dParams.layerHeight])

  const li = Math.min(layerIndex, Math.max(0, layers.length - 1))
  const dLi = useDeferredValue(li)
  const layer = layers[dLi] ?? null

  const dStageKey = stagePseudocodeKey(stage, dParams.wallStrategy)

  const pipelineOut = useMemo(
    () =>
      ready && layer
        ? runPipelineWithPseudocode(layers, dLi, dParams, {
            activeKey: dStageKey,
            codes: customCodes,
            driveLayer,
          })
        : null,
    [ready, layers, dLi, layer, dParams, dStageKey, customCodes, driveLayer],
  )

  const result = pipelineOut?.result ?? null
  const pseudoRun: PseudocodeRunResult = useMemo(
    () =>
      pipelineOut?.pseudoRun ?? {
        ok: true,
        output: null,
        steps: [],
        error: null,
        runtimeMs: 0,
      },
    [pipelineOut],
  )
  const activeStepObj =
    selectedStep !== null ? (pseudoRun.steps[selectedStep] ?? null) : null

  const extrusionCount = useMemo(
    () => (result ? result.moves.filter((m) => m.kind === 'extrusion').length : 0),
    [result],
  )

  const patchParams = (p: Partial<PipelineParams>) => setParams((prev) => ({ ...prev, ...p }))
  const patchVis = (p: Partial<VisState>) => setVis((prev) => ({ ...prev, ...p }))

  const closeDraft = () => {
    if (draft.length >= 3) {
      setCustomPolys((prev) => [...prev, { outer: draft, holes: [] }])
      setSource({ kind: 'custom' })
    }
    setDraft([])
  }

  // Draw-mode keyboard: Enter closes the polygon, Esc cancels the draft.
  useEffect(() => {
    if (!drawMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') closeDraft()
      else if (e.key === 'Escape') setDraft([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawMode, draft])

  const onSelectSource = (value: string) => {
    if (value === 'custom') {
      setSource({ kind: 'custom' })
      setViewMode('2d') // 3D only applies to multi-layer STL sources
    } else if (value.startsWith('preset:')) {
      setSource({ kind: 'preset', id: value.slice(7) as PresetId })
      setViewMode('2d')
    } else if (value.startsWith('stl:')) {
      setSource({ kind: 'stl', id: value.slice(4) as StlPresetId })
    }
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const buf = await f.arrayBuffer()
      const triangles = parseStl(buf)
      if (triangles.length === 0) return
      setSource({ kind: 'file', name: f.name, triangles })
    } catch {
      // A malformed STL simply does not load; the current source stays active.
    }
  }

  if (!ready) {
    return (
      <div className="loading">
        <div>Loading Cura Algorithm Explorer…</div>
        <div className="loading-sub">initializing clipper (wasm)</div>
      </div>
    )
  }

  const isStlSource = source.kind === 'stl' || source.kind === 'file'
  const stlTriangles: Triangle[] =
    source.kind === 'stl' ? stlPresets[source.id] : source.kind === 'file' ? source.triangles : []
  const shapeName =
    source.kind === 'preset'
      ? presetLabels[source.id]
      : source.kind === 'stl'
        ? `${source.id === 'cube' ? 'Cube 30 mm' : 'Pyramid 40 mm'} (layer ${li + 1})`
        : source.kind === 'file'
          ? `${source.name} (layer ${li + 1})`
          : 'Custom drawing'
  // Compare, animate and draw are 2D-only views.
  const show3d =
    viewMode === '3d' && isStlSource && mode === 'normal' && !drawMode && layers.length > 1

  const modeButton = (m: Mode, label: string) => (
    <button
      type="button"
      className={`btn${mode === m ? ' active' : ''}`}
      onClick={() => {
        setMode(mode === m ? 'normal' : m)
        setViewMode('2d')
      }}
    >
      {label}
    </button>
  )

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">Cura Algorithm Explorer</span>
        <select
          className="source-select"
          value={sourceValue(source)}
          onChange={(e) => onSelectSource(e.target.value)}
        >
          <optgroup label="2D presets">
            {(Object.keys(presets) as PresetId[]).map((id) => (
              <option key={id} value={`preset:${id}`}>
                {presetLabels[id]}
              </option>
            ))}
          </optgroup>
          <optgroup label="STL demos">
            <option value="stl:cube">Cube 30 mm</option>
            <option value="stl:pyramid">Pyramid 40 mm</option>
          </optgroup>
          {source.kind === 'file' && <option value="file">{source.name}</option>}
          {customPolys.length > 0 && <option value="custom">Custom drawing</option>}
        </select>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          Open .stl file…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".stl"
          style={{ display: 'none' }}
          onChange={onFile}
        />
        {layers.length > 1 && (
          <span className="layer-scrubber">
            <button
              type="button"
              className="btn btn-xs layer-step-btn"
              disabled={li <= 0}
              onClick={() => setLayerIndex(Math.max(0, li - 1))}
              title="Previous layer"
              aria-label="Previous layer"
            >
              ◀
            </button>
            <input
              type="range"
              min={0}
              max={layers.length - 1}
              value={li}
              onChange={(e) => setLayerIndex(Number(e.target.value))}
            />
            <button
              type="button"
              className="btn btn-xs layer-step-btn"
              disabled={li >= layers.length - 1}
              onClick={() => setLayerIndex(Math.min(layers.length - 1, li + 1))}
              title="Next layer"
              aria-label="Next layer"
            >
              ▶
            </button>
            <span className="layer-label">
              layer {li + 1} / {layers.length}
            </span>
          </span>
        )}
        <span className="toolbar-spacer" />
        {isStlSource && mode === 'normal' && !drawMode && (
          <span className="seg">
            <button
              type="button"
              className={viewMode === '2d' ? 'active' : ''}
              onClick={() => setViewMode('2d')}
            >
              2D
            </button>
            <button
              type="button"
              className={viewMode === '3d' ? 'active' : ''}
              disabled={layers.length < 2}
              title={layers.length < 2 ? 'Needs a multi-layer source' : undefined}
              onClick={() => setViewMode('3d')}
            >
              3D
            </button>
          </span>
        )}
        {modeButton('compare', 'Compare')}
        {modeButton('animate', 'Animate')}
        <button
          type="button"
          className={`btn${drawMode ? ' active' : ''}`}
          onClick={() => {
            setDrawMode(!drawMode)
            if (drawMode) setDraft([])
            else setViewMode('2d') // draw mode is 2D-only
          }}
        >
          Draw
        </button>
      </header>

      <div className="main">
        <aside className="sidebar left">
          <PipelinePanel
            params={params}
            onParams={patchParams}
            vis={vis}
            onVis={patchVis}
            stage={stage}
            onStage={setStage}
            step={step ?? extrusionCount}
            stepMax={extrusionCount}
            onStep={(n) => setStep(n >= extrusionCount ? null : n)}
          />
        </aside>

        <div className="center">
          {show3d ? (
            <View3D
              triangles={stlTriangles}
              layers={layers}
              layerIndex={li}
              params={dParams}
              vis={vis}
              fitKey={fitKey}
            />
          ) : mode === 'compare' ? (
            <CompareView layers={layers} layerIndex={li} params={dParams} vis={vis} fitKey={fitKey} />
          ) : (
            <>
              <LayerView
                result={result}
                layer={layer}
                vis={vis}
                fitKey={fitKey}
                stepCount={mode === 'animate' ? undefined : (step ?? undefined)}
                animDist={mode === 'animate' ? animDist : null}
                showNozzle={mode === 'animate'}
                activeStep={activeStepObj}
                allSteps={pseudoRun.steps}
                totalSteps={pseudoRun.steps.length}
                onSelectStep={setSelectedStep}
                params={dParams}
                shapeName={shapeName}
                draw={{
                  active: drawMode,
                  draft,
                  editable: source.kind === 'custom' ? customPolys : [],
                  onDraft: setDraft,
                  onEditable: setCustomPolys,
                  onCloseDraft: closeDraft,
                }}
              />
              {mode === 'animate' && result && (
                <AnimateControls
                  moves={result.moves}
                  printSpeed={dParams.printSpeed}
                  travelSpeed={dParams.travelSpeed}
                  onProgress={setAnimDist}
                />
              )}
            </>
          )}
        </div>

        <aside className="sidebar right">
          <ExplainerPanel
            stage={stage}
            wallStrategy={params.wallStrategy}
            result={result}
            compareHint={source.kind === 'preset' && source.id === 'thin-wedge' && mode !== 'compare'}
            onCompare={() => setMode('compare')}
            stageKey={stageKey}
            code={customCodes[stageKey] ?? PSEUDOCODE_STAGES[stageKey].defaultCode}
            isCustomCode={customCodes[stageKey] !== undefined}
            driveLayer={driveLayer}
            pseudoRun={pseudoRun}
            selectedStep={selectedStep}
            onChangeCode={(nextCode) =>
              setCustomCodes((prev) => ({ ...prev, [stageKey]: nextCode }))
            }
            onResetCode={() =>
              setCustomCodes((prev) => {
                const copy = { ...prev }
                delete copy[stageKey]
                return copy
              })
            }
            onToggleDriveLayer={setDriveLayer}
            onSelectStep={setSelectedStep}
          />
        </aside>
      </div>
    </div>
  )
}

export default App
