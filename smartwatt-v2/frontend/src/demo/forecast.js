// Port of backend/app/analytics/forecast.py: ridge regression on daily
// Fourier terms for the short-term load, and a month-end energy projection.
import { dayKey, r1, r3, sum } from './util.js'

const HARMONICS = 3
const RIDGE_LAMBDA = 1e-2

function designRow(hours, t0) {
  const tod = ((((hours % 24) + 24) % 24) / 24) * 2 * Math.PI
  const row = [1, (hours - t0) / 24]
  for (let k = 1; k <= HARMONICS; k += 1) row.push(Math.sin(k * tod), Math.cos(k * tod))
  return row
}

/** Solve A x = b by Gaussian elimination with partial pivoting. */
function solve(A, b) {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c += 1) {
    let p = c
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    ;[M[c], M[p]] = [M[p], M[c]]
    const pivot = M[c][c] || 1e-12
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue
      const f = M[r][c] / pivot
      if (f === 0) continue
      for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k]
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12))
}

const std = (values) => {
  if (!values.length) return 0
  const mean = sum(values) / values.length
  return Math.sqrt(sum(values.map((v) => (v - mean) ** 2)) / values.length)
}

/** `history` is [{ ts, power_w }] oldest first. */
export function forecastPower(history, horizonMinutes = 120, stepMinutes = 10) {
  if (history.length < 20) return { points: [], method: 'insufficient_history', sigma_w: 0 }
  const ts = history.map((h) => h.ts)
  const watts = history.map((h) => h.power_w)
  const hours = ts.map((t) => t / 3600000)
  const t0 = hours[0]
  const lastMs = ts[ts.length - 1]
  const steps = []
  for (let m = stepMinutes; m <= horizonMinutes; m += stepMinutes) steps.push(lastMs + m * 60000)

  if (hours[hours.length - 1] - t0 < 2) {
    let level = watts[0]
    for (const w of watts.slice(1)) level = 0.1 * w + 0.9 * level
    const sigma = watts.length >= 10 ? std(watts.slice(-60)) : 0
    return { points: steps.map((t) => ({ ts_ms: t, power_w: r1(level) })), method: 'ewma', sigma_w: r1(sigma) }
  }

  const X = hours.map((h) => designRow(h, t0))
  const n = X[0].length
  const XtX = Array.from({ length: n }, () => new Array(n).fill(0))
  const Xty = new Array(n).fill(0)
  X.forEach((row, i) => {
    for (let a = 0; a < n; a += 1) {
      Xty[a] += row[a] * watts[i]
      for (let b = 0; b < n; b += 1) XtX[a][b] += row[a] * row[b]
    }
  })
  for (let a = 0; a < n; a += 1) XtX[a][a] += RIDGE_LAMBDA
  const beta = solve(XtX, Xty)
  const predict = (row) => row.reduce((acc, v, i) => acc + v * beta[i], 0)
  const sigma = std(X.map((row, i) => watts[i] - predict(row)))

  return {
    points: steps.map((t) => {
      const p = Math.max(0, predict(designRow(t / 3600000, t0)))
      return { ts_ms: t, power_w: r1(p), lo_w: r1(Math.max(0, p - sigma)), hi_w: r1(p + sigma) }
    }),
    method: `ridge_fourier_h${HARMONICS}`,
    sigma_w: r1(sigma),
  }
}

/** `daily` is [[YYYY-MM-DD, kwh]] for this month. */
export function forecastMonthKwh(daily, todayKwh, now = new Date()) {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const today = dayKey(now)
  const completed = daily.filter(([d]) => d !== today).map(([, k]) => k)
  const soFar = sum(completed)
  const elapsed = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400
  const todayProjected = todayKwh / Math.max(elapsed, 0.08)
  const recent = completed.slice(-7)
  const avgDay = recent.length ? sum(recent) / recent.length : todayProjected
  const remaining = Math.max(0, daysInMonth - now.getDate())
  return {
    month_so_far_kwh: r3(soFar + todayKwh),
    today_projected_kwh: r3(todayProjected),
    avg_daily_kwh: r3(avgDay),
    days_elapsed: now.getDate(),
    days_in_month: daysInMonth,
    projected_month_kwh: Math.round((soFar + todayProjected + remaining * avgDay) * 100) / 100,
    confidence: completed.length >= 5 ? 'high' : completed.length ? 'medium' : 'low',
  }
}
