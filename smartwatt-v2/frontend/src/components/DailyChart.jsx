import { useEffect, useRef } from 'react'
import { baseOptions, Chart, token } from '../lib/charts.js'
import { money, num2 } from '../lib/format.js'

const dayLabel = (d) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })

/** Daily energy as columns: one series, one colour, capped width, rounded cap. */
export default function DailyChart({ days, theme, symbol }) {
  const canvas = useRef(null)

  useEffect(() => {
    if (!canvas.current) return undefined
    const c1 = token('--series-1')
    const options = baseOptions()
    options.interaction = { mode: 'index', intersect: false }
    options.scales.x = {
      type: 'category',
      grid: { display: false },
      border: { color: token('--axis') },
      ticks: { color: token('--text-muted'), maxRotation: 0, autoSkipPadding: 12, font: { size: 11 } },
    }
    options.scales.y.ticks.callback = (v) => `${v} kWh`
    options.plugins.tooltip.callbacks = {
      title: (items) => dayLabel(days[items[0].dataIndex].day),
      label: (item) => {
        const d = days[item.dataIndex]
        return ` ${num2(d.kwh)} kWh · ${money(d.cost, symbol)}`
      },
    }
    options.plugins.tooltip.usePointStyle = false
    options.plugins.tooltip.boxWidth = 10
    options.plugins.tooltip.boxHeight = 10
    const chart = new Chart(canvas.current, {
      type: 'bar',
      data: {
        labels: days.map((d) => dayLabel(d.day)),
        datasets: [{
          data: days.map((d) => d.kwh),
          backgroundColor: c1,
          hoverBackgroundColor: token('--series-1'),
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: 'start',
          maxBarThickness: 24,
          categoryPercentage: 0.8,
          barPercentage: 0.9,
        }],
      },
      options,
    })
    return () => chart.destroy()
  }, [days, theme, symbol])

  if (!days.length) return <div className="empty">No completed days recorded yet.</div>
  return (
    <div className="chart-box">
      <canvas ref={canvas} role="img" aria-label="Column chart of energy used per day" />
    </div>
  )
}
