import {
  BarController, BarElement, CategoryScale, Chart, Filler, LinearScale,
  LineController, LineElement, PointElement, Tooltip,
} from 'chart.js'

Chart.register(
  LineController, LineElement, PointElement, LinearScale, CategoryScale,
  BarController, BarElement, Filler, Tooltip,
)
Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

export { Chart }

/** Read a CSS custom property so charts follow the active theme. */
export function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function alpha(hex, a) {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

/** Vertical hairline that snaps to the hovered x position. */
export const crosshairPlugin = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() || []
    if (!active.length) return
    const x = active[0].element.x
    const { top, bottom } = chart.chartArea
    const { ctx } = chart
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(x, top)
    ctx.lineTo(x, bottom)
    ctx.lineWidth = 1
    ctx.strokeStyle = token('--axis')
    ctx.stroke()
    ctx.restore()
  },
}

/** Horizontal reference line (e.g. the overload limit) with a text label. */
export const referenceLinePlugin = {
  id: 'referenceLine',
  afterDatasetsDraw(chart) {
    const ref = chart.$reference
    if (!ref || !Number.isFinite(ref.value)) return
    const y = chart.scales.y.getPixelForValue(ref.value)
    const { left, right, top, bottom } = chart.chartArea
    if (y < top || y > bottom) return
    const { ctx } = chart
    ctx.save()
    ctx.strokeStyle = token('--status-critical')
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(right, y)
    ctx.stroke()
    ctx.fillStyle = token('--text-secondary')
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    ctx.fillText(ref.label, right - 4, y - 3)
    ctx.restore()
  },
}

/** Shared recessive chrome: hairline grid, muted ticks, no legend box. */
export function baseOptions() {
  const muted = token('--text-muted')
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    layout: { padding: { top: 6, right: 6 } },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: token('--surface-raised'),
        titleColor: token('--text-secondary'),
        bodyColor: token('--text-primary'),
        borderColor: token('--border-strong'),
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
        usePointStyle: true,
        boxWidth: 14,
        boxHeight: 2,
        titleFont: { weight: '400', size: 12 },
        bodyFont: { weight: '600', size: 13 },
      },
    },
    scales: {
      x: {
        type: 'linear',
        grid: { display: false },
        border: { color: token('--axis') },
        ticks: { color: muted, maxTicksLimit: 6, maxRotation: 0, font: { size: 11 } },
      },
      y: {
        beginAtZero: true,
        grid: { color: token('--grid'), lineWidth: 1 },
        border: { display: false },
        ticks: { color: muted, maxTicksLimit: 5, font: { size: 11 }, padding: 6 },
      },
    },
  }
}
