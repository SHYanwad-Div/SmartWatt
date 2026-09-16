const nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 })
const nf2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const num0 = (v) => nf0.format(Number(v) || 0)
export const num1 = (v) => nf1.format(Number(v) || 0)
export const num2 = (v) => nf2.format(Number(v) || 0)

/** Watts, switching to kW past 10 kW. */
export function watts(v) {
  const w = Number(v) || 0
  return Math.abs(w) >= 10_000 ? `${nf1.format(w / 1000)} kW` : `${nf0.format(w)} W`
}

export function kwh(v, digits = 2) {
  const n = Number(v) || 0
  return `${n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })} kWh`
}

export const money = (v, symbol = '₹') => `${symbol}${nf2.format(Number(v) || 0)}`

export function clock(ts) {
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function dateTime(ts) {
  return new Date(ts).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
