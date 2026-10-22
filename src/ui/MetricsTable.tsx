import type { LayerMetrics } from '../algorithms/types'

const mm = (um: number) => (um / 1000).toFixed(1)
const mm2 = (um2: number) => (um2 / 1e6).toFixed(2)

export function MetricsTable(props: { metrics: LayerMetrics }) {
  const m = props.metrics
  const rows: [string, string][] = [
    ['Extrusion length', `${mm(m.extrusionLength)} mm`],
    ['Travel total', `${mm(m.travelLength)} mm`],
    ['Travel outside', `${mm(m.travelOutsideLength)} mm`],
    ['Gap area', `${mm2(m.gapArea)} mm²`],
    ['Estimated time', `${m.estimatedTimeS.toFixed(1)} s`],
  ]
  return (
    <table className="metrics-table">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td>{k}</td>
            <td className="num">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
