import { useState } from 'react'
import { areasDoc } from '../algorithms/areas'
import { infillDoc } from '../algorithms/infill'
import { metricsDoc } from '../algorithms/metrics'
import { pathOrderDoc } from '../algorithms/pathOrder'
import type { PseudocodeKey, PseudocodeRunResult } from '../algorithms/pseudocode'
import { slicingDoc } from '../algorithms/slicing'
import { travelDoc } from '../algorithms/travel'
import type { StageDoc } from '../algorithms/types'
import { arachneDoc } from '../algorithms/wallsArachne'
import { constantWallsDoc } from '../algorithms/wallsConstant'
import type { PipelineResult } from '../state/pipeline'
import { Markdown } from './markdown'
import { MetricsTable } from './MetricsTable'
import { PseudocodePanel } from './PseudocodePanel'
import type { StageId } from './vis'

export type RightTab = 'pseudocode' | 'guide'

interface ExplainerPanelProps {
  stage: StageId
  wallStrategy: 'constant' | 'arachne'
  result: PipelineResult | null
  compareHint: boolean
  onCompare: () => void
  // Pseudocode runner state
  stageKey: PseudocodeKey
  code: string
  isCustomCode: boolean
  driveLayer: boolean
  pseudoRun: PseudocodeRunResult
  selectedStep: number | null
  onChangeCode: (code: string) => void
  onResetCode: () => void
  onToggleDriveLayer: (drive: boolean) => void
  onSelectStep: (stepIndex: number | null) => void
}

function DocView({ doc }: { doc: StageDoc }) {
  return (
    <div className="doc">
      <h3 className="doc-title">{doc.title}</h3>
      <Markdown text={doc.explanation} />
      <div className="cura-ref">
        <code>{doc.curaRef}</code>
      </div>
      {doc.refs && doc.refs.length > 0 && (
        <ul className="refs">
          {doc.refs.map((r) => (
            <li key={r.url}>
              <a href={r.url} target="_blank" rel="noreferrer">
                {r.label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ExplainerPanel(props: ExplainerPanelProps) {
  const [tab, setTab] = useState<RightTab>('pseudocode')

  const docs: Record<StageId, StageDoc> = {
    slicing: slicingDoc,
    areas: areasDoc,
    walls: props.wallStrategy === 'arachne' ? arachneDoc : constantWallsDoc,
    infill: infillDoc,
    order: pathOrderDoc,
    travel: travelDoc,
  }

  return (
    <div className="explainer">
      <div className="explainer-tabs">
        <button
          type="button"
          className={`explainer-tab${tab === 'pseudocode' ? ' active' : ''}`}
          onClick={() => setTab('pseudocode')}
        >
          Pseudocode & Runner
        </button>
        <button
          type="button"
          className={`explainer-tab${tab === 'guide' ? ' active' : ''}`}
          onClick={() => setTab('guide')}
        >
          Algorithm Guide
        </button>
      </div>

      {tab === 'pseudocode' ? (
        <PseudocodePanel
          stageKey={props.stageKey}
          code={props.code}
          isCustom={props.isCustomCode}
          driveLayer={props.driveLayer}
          runResult={props.pseudoRun}
          selectedStep={props.selectedStep}
          onChangeCode={props.onChangeCode}
          onResetCode={props.onResetCode}
          onToggleDriveLayer={props.onToggleDriveLayer}
          onSelectStep={props.onSelectStep}
        />
      ) : (
        <>
          <DocView doc={docs[props.stage]} />
          {props.stage === 'travel' && <DocView doc={metricsDoc} />}
        </>
      )}

      <div className="explainer-footer">
        <h3>Layer metrics {props.driveLayer && <span className="metrics-badge">from pseudocode</span>}</h3>
        {props.result ? <MetricsTable metrics={props.result.metrics} /> : <p>No layer loaded.</p>}
        {props.compareHint && (
          <button type="button" className="compare-hint" onClick={props.onCompare}>
            Compare constant vs Arachne on this wedge →
          </button>
        )}
      </div>
    </div>
  )
}
