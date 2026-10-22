import { useMemo, useState } from 'react'
import type { SlicedLayer } from '../algorithms/types'
import { runPipeline, type PipelineParams } from '../state/pipeline'
import { LayerView } from './LayerView'
import { MetricsTable } from './MetricsTable'
import type { ViewTransform, VisState } from './vis'

interface CompareViewProps {
  layers: SlicedLayer[]
  layerIndex: number
  params: PipelineParams
  vis: VisState
  fitKey: number
}

/**
 * Side-by-side constant-width vs Arachne planning of the same layer with
 * shared pan/zoom — the quickest way to see what variable-width beads buy.
 */
export function CompareView(props: CompareViewProps) {
  const { layers, layerIndex, params, vis, fitKey } = props
  const [view, setView] = useState<ViewTransform | null>(null)

  const constant = useMemo(
    () => runPipeline(layers, layerIndex, { ...params, wallStrategy: 'constant' }),
    [layers, layerIndex, params],
  )
  const arachne = useMemo(
    () => runPipeline(layers, layerIndex, { ...params, wallStrategy: 'arachne' }),
    [layers, layerIndex, params],
  )
  const layer = layers[layerIndex] ?? null

  const side = (
    title: string,
    result: typeof constant,
    key: string,
  ) => (
    <div className="compare-side">
      <div className="compare-title">{title}</div>
      <LayerView
        key={key}
        result={result}
        layer={layer}
        vis={vis}
        fitKey={fitKey}
        view={view}
        onView={setView}
      />
      <MetricsTable metrics={result.metrics} />
    </div>
  )

  return (
    <div className="compare-view">
      {side('Constant width', constant, 'c')}
      {side('Arachne (variable width)', arachne, 'a')}
    </div>
  )
}
