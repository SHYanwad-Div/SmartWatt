import { useEffect, useRef, useState } from 'react'
import { alpha, baseOptions, Chart, crosshairPlugin, token } from '../lib/charts.js'
import { clock, kwh, money, num0, watts } from '../lib/format.js'
import { Card, Segmented } from '../lib/ui.jsx'

const shortClock = (ts) =>
  new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })

const METHOD = {
  ewma: 'Smoothed level (history under 2 h)',
  insufficient_history: 'Collecting history',
}

export default function ForecastChart({ history, forecast, billing, theme, symbol, span = 7 }) {
  const canvas = useRef(null)
  const chartRef = useRef(null)
  const [view, setView] = useState('chart')
  const points = forecast?.power?.points || []
  const method = forecast?.power?.method || ''
  const month = forecast?.month

  useEffect(() => {
    if (view !== 'chart' || !canvas.current) return undefined
    const c1 = token('--series-1')
    const c2 = token('--series-2')
    const options = baseOptions()
    options.scales.x.ticks.callback = (v) => shortClock(v)
    options.scales.y.ticks.callback = (v) => num0(v)
    options.plugins.tooltip.filter = (item) => item.datasetIndex === 0 || item.datasetIndex === 3
    options.plugins.tooltip.callbacks = {
      title: (items) => clock(items[0].parsed.x),
      label: (item) => ` ${num0(item.parsed.y)} W  ${item.datasetIndex === 0 ? 'Measured' : 'Forecast'}`,
      labelPointStyle: () => ({ pointStyle: 'line', rotation: 0 }),
    }
    const line = (color) => ({
      parsing: false, borderColor: color, borderWidth: 2, tension: 0.2,
      pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: color,
      pointHoverBorderColor: token('--surface-1'), pointHoverBorderWidth: 2, pointHitRadius: 12,
    })
    const chart = new Chart(canvas.current, {
      type: 'line',
      data: {
        datasets: [
          { ...line(c1), data: [], fill: 'origin', backgroundColor: alpha(c1, 0.1) },
          { parsing: false, data: [], borderWidth: 0, pointRadius: 0, fill: false },
          { parsing: false, data: [], borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: alpha(c2, 0.14) },
          { ...line(c2), data: [], fill: false },
        ],
      },
      options,
      plugins: [crosshairPlugin],
    })
    chartRef.current = chart
    return () => {
      chart.destroy()
      chartRef.current = null
    }
  }, [theme, view])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const measured = (history || []).map((p) => ({ x: p.ts, y: p.power_w }))
    const last = measured[measured.length - 1]
    const join = last ? [last] : []
    chart.data.datasets[0].data = measured
    chart.data.datasets[1].data = [...join, ...points.map((p) => ({ x: p.ts_ms, y: p.hi_w ?? p.power_w }))]
    chart.data.datasets[2].data = [...join, ...points.map((p) => ({ x: p.ts_ms, y: p.lo_w ?? p.power_w }))]
    chart.data.datasets[3].data = [...join, ...points.map((p) => ({ x: p.ts_ms, y: p.power_w }))]
    chart.update('none')
  }, [history, points, theme, view])

  const projected = billing?.projected_month

  return (
    <Card
      span={span}
      title="Load forecast"
      sub={`Last hour measured, next 2 hours predicted · ${METHOD[method] || 'Ridge regression on daily harmonics'}`}
      actions={(
        <Segmented
          label="Chart or table"
          value={view}
          onChange={setView}
          options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]}
        />
      )}
    >
      <div className="legend">
        <span><i className="key-line" style={{ background: 'var(--series-1)' }} />Measured</span>
        <span><i className="key-line" style={{ background: 'var(--series-2)' }} />Forecast</span>
        <span><i className="key-band" style={{ background: 'var(--series-2)', opacity: 0.25 }} />±1σ range</span>
      </div>
      {view === 'chart' ? (
        <div className="chart-box short">
          <canvas ref={canvas} role="img" aria-label="Measured load for the last hour and forecast load for the next two hours" />
        </div>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 200 }}>
          <table className="data">
            <thead><tr><th>Time</th><th className="r">Forecast</th><th className="r">Low</th><th className="r">High</th></tr></thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.ts_ms}>
                  <td className="num">{shortClock(p.ts_ms)}</td>
                  <td className="r">{watts(p.power_w)}</td>
                  <td className="r">{watts(p.lo_w ?? p.power_w)}</td>
                  <td className="r">{watts(p.hi_w ?? p.power_w)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {month && (
        <div className="kv" style={{ marginTop: 10 }}>
          <span>Month-end projection ({month.confidence} confidence)</span>
          <span className="num">
            {kwh(month.projected_month_kwh, 1)}{projected ? ` · ${money(projected.total, symbol)}` : ''}
          </span>
        </div>
      )}
    </Card>
  )
}
