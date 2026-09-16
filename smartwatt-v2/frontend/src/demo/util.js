// Small helpers shared by the in-browser demo engine.

export const r1 = (v) => Math.round(v * 10) / 10
export const r2 = (v) => Math.round(v * 100) / 100
export const r3 = (v) => Math.round(v * 1000) / 1000
export const r4 = (v) => Math.round(v * 10000) / 10000
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
export const sum = (list) => list.reduce((a, b) => a + b, 0)

const pad = (n) => String(n).padStart(2, '0')

/** Local calendar day as YYYY-MM-DD. */
export function dayKey(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function startOfDay(t) {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Python's {:g}: no trailing zeros. */
export const g = (v) => String(Number(v))

/** localStorage that never throws (private mode, blocked storage, Node). */
export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key)
      return raw == null ? fallback : JSON.parse(raw)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* storage unavailable: keep working in memory */
    }
  },
}
