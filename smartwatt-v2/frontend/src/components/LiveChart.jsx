import { useEffect, useRef, useState } from 'react'
import { alpha, baseOptions, Chart, crosshairPlugin, referenceLinePlugin, token } from '../lib/charts.js'
import { clock, num0, watts } from '../lib/format.js'
import { Card, Segmented } from '../lib/ui.jsx'

const shortClock = (ts) =>
  new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })

export default function LiveChart({ series, threshold, theme, status, span = 8 }) {
  const canvas = useRef(null)
  const chartRef = useRef(null)
  const [view, setView] = useState('chart')

  useEffect(() => {
    if (view !== 'chart' || !canvas.current) return undefined
    const c1 = token('--series-1')
    const options = baseOptions()
    options.scales.x.ticks.callback = (v) => shortClock(v)
    options.scales.y.ticks.callback = (v) => num0(v)
    options.plugins.tooltip.callbacks = {
      title: (items) => clock(items[0].parsed.x),
      label: (item) => ` ${num0(item.parsed.y)} W  Power`,
      labelPointStyle: () => ({ pointStyle: 'line', rotation: 0 }),
    }
    const chart = new Chart(canvas.current, {
      type: 'line',
      data: {
        datasets: [{
          data: [],
          parsing: false,
          borderColor: c1,
          backgroundColor: alpha(c1, 0.1),
          borderWidth: 2,
          borderJoinStyle: 'round',
          borderCapStyle: 'round',
          fill: 'origin',
          tension: 0.15,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: c1,
          pointHoverBorderColor: token('--surface-1'),
          pointHoverBorderWidth: 2,
          pointHitRadius: 12,
        }],
      },
      options,
      plugins: [crosshairPlugin, referenceLinePlugin],
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
    const pts = series.map((p) => ({ x: p.ts, y: p.power_w }))
    chart.data.datasets[0].data = pts
    const peak = pts.reduce((m, p) => Math.max(m, p.y), 0)
    // keep the limit on screen when load is close to it, without squashing a quiet trace
    const showLimit = threshold && peak > threshold * 0.5
    chart.$reference = showLimit ? { value: threshold, label: `Limit ${num0(threshold)} W` } : null
    chart.options.scales.y.suggestedMax = Math.max(showLimit ? threshold * 1.08 : 0, peak * 1.12, 100)
    if (pts.length) {
      chart.options.scales.x.min = pts[0].x
      chart.options.scales.x.max = pts[pts.length - 1].x
    }
    chart.update('none')
  }, [series, threshold, theme, view])

  const recent = series.slice(-15).reverse()
  const pill = {
    live: ['on', 'Live'], connecting: ['warn', 'Connecting'],
    reconnecting: ['warn', 'Reconnecting'], offline: ['off', 'Offline'],
  }[status] || ['warn', status]

  return (
    <Card
      span={span}
      title="Live power"
      sub="Total load, last 15 minutes, 5-sample moving average"
      actions={(
        <>
          <span className="pill"><span className={`dot ${pill[0]}`} />{pill[1]}</span>
          <Segmented
            label="Chart or table"
            value={view}
            onChange={setView}
            options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]}
          />
        </>
      )}
    >
      {view === 'chart' ? (
        <div className="chart-box">
          <canvas ref={canvas} role="img" aria-label="Line chart of total power over the last 15 minutes" />
          {!series.length && <div className="empty" style={{ position: 'absolute', inset: 0 }}>Waiting for readings…</div>}
        </div>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 260 }}>
          <table className="data">
            <thead><tr><th>Time</th><th className="r">Power</th></tr></thead>
            <tbody>
              {recent.map((p) => (
                <tr key={p.ts}><td className="num">{clock(p.ts)}</td><td className="r">{watts(p.power_w)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
