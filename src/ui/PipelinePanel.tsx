import type { InfillPattern } from '../algorithms/infill'
import type { PipelineParams } from '../state/pipeline'
import type { StageId, VisState } from './vis'
import { MmField, NumField, Section, SelectField, SpeedField, Toggle } from './ParamsPanel'

interface PipelinePanelProps {
  params: PipelineParams
  onParams: (patch: Partial<PipelineParams>) => void
  vis: VisState
  onVis: (patch: Partial<VisState>) => void
  stage: StageId
  onStage: (s: StageId) => void
  /** Step-through: number of extrusion moves shown as printed. */
  step: number
  stepMax: number
  onStep: (n: number) => void
}

const patterns: { value: InfillPattern; label: string }[] = [
  { value: 'lines', label: 'Lines' },
  { value: 'zigzag', label: 'Zigzag' },
  { value: 'grid', label: 'Grid' },
  { value: 'triangles', label: 'Triangles' },
  { value: 'cubic', label: 'Cubic' },
  { value: 'honeycomb', label: 'Honeycomb' },
  { value: 'gyroid', label: 'Gyroid' },
]

export function PipelinePanel(props: PipelinePanelProps) {
  const { params, onParams, vis, onVis, stage, onStage } = props
  const arachne = params.wallStrategy === 'arachne'

  return (
    <div className="pipeline-panel">
      <Section title="1 · Slicing" open={stage === 'slicing'} onToggle={() => onStage('slicing')}>
        <MmField
          label="Layer height"
          valueUm={params.layerHeight}
          onChangeUm={(v) => onParams({ layerHeight: Math.max(50, v) })}
          minMm={0.05}
          maxMm={1}
          stepMm={0.05}
        />
        <div className="toggle-group">
          <Toggle
            label="Raw segments"
            checked={vis.rawSegments}
            onChange={(v) => onVis({ rawSegments: v })}
          />
          <Toggle
            label="Stitched outline"
            checked={vis.outline}
            onChange={(v) => onVis({ outline: v })}
          />
        </div>
      </Section>

      <Section title="2 · Areas" open={stage === 'areas'} onToggle={() => onStage('areas')}>
        <NumField
          label="Wall count"
          value={params.wallCount}
          onChange={(v) => onParams({ wallCount: Math.max(1, Math.round(v)) })}
          min={1}
          max={6}
        />
        <NumField
          label="Top layers"
          value={params.topLayers}
          onChange={(v) => onParams({ topLayers: Math.max(0, Math.round(v)) })}
          min={0}
          max={10}
        />
        <NumField
          label="Bottom layers"
          value={params.bottomLayers}
          onChange={(v) => onParams({ bottomLayers: Math.max(0, Math.round(v)) })}
          min={0}
          max={10}
        />
        <div className="toggle-group">
          <Toggle
            label="Walls region"
            checked={vis.wallsRegion}
            onChange={(v) => onVis({ wallsRegion: v })}
          />
          <Toggle label="Skin fill" checked={vis.skinFill} onChange={(v) => onVis({ skinFill: v })} />
          <Toggle
            label="Infill region"
            checked={vis.infillRegion}
            onChange={(v) => onVis({ infillRegion: v })}
          />
        </div>
      </Section>

      <Section title="3 · Walls" open={stage === 'walls'} onToggle={() => onStage('walls')}>
        <SelectField
          label="Strategy"
          value={params.wallStrategy}
          options={[
            { value: 'constant', label: 'Constant width' },
            { value: 'arachne', label: 'Arachne (variable)' },
          ]}
          onChange={(v) => onParams({ wallStrategy: v })}
        />
        <MmField
          label="Wall width"
          valueUm={params.wallWidth}
          onChangeUm={(v) => onParams({ wallWidth: Math.max(100, v) })}
          minMm={0.2}
          maxMm={1.2}
          stepMm={0.05}
        />
        {arachne && (
          <>
            <MmField
              label="Min bead width"
              valueUm={params.minBeadWidth}
              onChangeUm={(v) => onParams({ minBeadWidth: Math.max(50, v) })}
              minMm={0.1}
              maxMm={0.8}
              stepMm={0.05}
            />
            <SelectField
              label="Beading"
              value={params.beadingStrategy}
              options={[
                { value: 'constant', label: 'Constant' },
                { value: 'distributed', label: 'Distributed' },
              ]}
              onChange={(v) => onParams({ beadingStrategy: v })}
            />
          </>
        )}
        <div className="toggle-group">
          <Toggle
            label="Wall paths"
            checked={vis.wallPaths}
            onChange={(v) => onVis({ wallPaths: v })}
          />
          <Toggle label="Gap regions" checked={vis.gaps} onChange={(v) => onVis({ gaps: v })} />
          {arachne && (
            <Toggle
              label="Skeleton"
              checked={vis.skeleton}
              onChange={(v) => onVis({ skeleton: v })}
            />
          )}
        </div>
      </Section>

      <Section title="4 · Infill" open={stage === 'infill'} onToggle={() => onStage('infill')}>
        <SelectField
          label="Pattern"
          value={params.infillPattern}
          options={patterns}
          onChange={(v) => onParams({ infillPattern: v })}
        />
        <NumField
          label="Density"
          value={Math.round(params.infillDensity * 100)}
          onChange={(v) => onParams({ infillDensity: Math.min(100, Math.max(0, v)) / 100 })}
          min={0}
          max={100}
          step={5}
          unit="%"
        />
        <NumField
          label="Angle"
          value={params.infillAngle}
          onChange={(v) => onParams({ infillAngle: v })}
          min={0}
          max={180}
          step={15}
          unit="°"
        />
        <div className="toggle-group">
          <Toggle
            label="Infill lines"
            checked={vis.infillLines}
            onChange={(v) => onVis({ infillLines: v })}
          />
          <Toggle
            label="Skin lines"
            checked={vis.skinLines}
            onChange={(v) => onVis({ skinLines: v })}
          />
          <Toggle
            label="Raw pattern lines"
            checked={vis.rawInfill}
            onChange={(v) => onVis({ rawInfill: v })}
          />
        </div>
      </Section>

      <Section title="5 · Path order" open={stage === 'order'} onToggle={() => onStage('order')}>
        <div className="toggle-group">
          <Toggle
            label="Order numbers"
            checked={vis.orderNumbers}
            onChange={(v) => onVis({ orderNumbers: v })}
          />
        </div>
        <label className="field">
          <span className="field-label">
            Step through ({props.step}/{props.stepMax})
          </span>
          <span className="slider-with-arrows">
            <button
              type="button"
              className="btn btn-xs layer-step-btn"
              disabled={props.step <= 0}
              onClick={() => props.onStep(Math.max(0, props.step - 1))}
              title="Previous extrusion move"
              aria-label="Previous extrusion move"
            >
              ◀
            </button>
            <input
              type="range"
              min={0}
              max={props.stepMax}
              value={props.step}
              onChange={(e) => props.onStep(Number(e.target.value))}
            />
            <button
              type="button"
              className="btn btn-xs layer-step-btn"
              disabled={props.step >= props.stepMax}
              onClick={() => props.onStep(Math.min(props.stepMax, props.step + 1))}
              title="Next extrusion move"
              aria-label="Next extrusion move"
            >
              ▶
            </button>
          </span>
        </label>
      </Section>

      <Section
        title="6 · Travel & metrics"
        open={stage === 'travel'}
        onToggle={() => onStage('travel')}
      >
        <Toggle
          label="Combing"
          checked={params.combing}
          onChange={(v) => onParams({ combing: v })}
        />
        <MmField
          label="Combing inset"
          valueUm={params.combingInset}
          onChangeUm={(v) => onParams({ combingInset: Math.max(0, v) })}
          minMm={0}
          maxMm={2}
        />
        <MmField
          label="Avoid distance"
          valueUm={params.avoidDistance}
          onChangeUm={(v) => onParams({ avoidDistance: Math.max(0, v) })}
          minMm={0}
          maxMm={2}
        />
        <MmField
          label="Retract min dist"
          valueUm={params.retractionMinDistance}
          onChangeUm={(v) => onParams({ retractionMinDistance: Math.max(0, v) })}
          minMm={0}
          maxMm={20}
          stepMm={0.5}
        />
        <Toggle label="Z-hop" checked={params.zHop} onChange={(v) => onParams({ zHop: v })} />
        <SpeedField
          label="Print speed"
          valueUmS={params.printSpeed}
          onChangeUmS={(v) => onParams({ printSpeed: Math.max(1000, v) })}
        />
        <SpeedField
          label="Travel speed"
          valueUmS={params.travelSpeed}
          onChangeUmS={(v) => onParams({ travelSpeed: Math.max(1000, v) })}
        />
        <div className="toggle-group">
          <Toggle
            label="Travel paths"
            checked={vis.travel}
            onChange={(v) => onVis({ travel: v })}
          />
        </div>
      </Section>
    </div>
  )
}
