import { areasDoc } from '../algorithms/areas'
import { infillDoc } from '../algorithms/infill'
import { metricsDoc } from '../algorithms/metrics'
import { pathOrderDoc } from '../algorithms/pathOrder'
import { slicingDoc } from '../algorithms/slicing'
import { travelDoc } from '../algorithms/travel'
import type { StageDoc } from '../algorithms/types'
import { arachneDoc } from '../algorithms/wallsArachne'
import { constantWallsDoc } from '../algorithms/wallsConstant'
import type { PipelineResult } from '../state/pipeline'
import { Markdown } from './markdown'
import { MetricsTable } from './MetricsTable'
import type { StageId } from './vis'

interface ExplainerPanelProps {
  stage: StageId
  wallStrategy: 'constant' | 'arachne'
  result: PipelineResult | null
  compareHint: boolean
  onCompare: () => void
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
      <DocView doc={docs[props.stage]} />
      {props.stage === 'travel' && <DocView doc={metricsDoc} />}
      <h3>Layer metrics</h3>
      {props.result ? <MetricsTable metrics={props.result.metrics} /> : <p>No layer loaded.</p>}
      {props.compareHint && (
        <button type="button" className="compare-hint" onClick={props.onCompare}>
          Compare constant vs Arachne on this wedge →
        </button>
      )}
    </div>
  )
}
