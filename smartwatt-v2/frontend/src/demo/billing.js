// Port of backend/app/billing.py: telescopic slab tariff.
import { r2, r3 } from './util.js'

export function computeBill(kwh, cfg) {
  const slabs = cfg.tariff_slabs || []
  const fixed = Number(cfg.tariff_fixed_charge || 0)
  const taxPct = Number(cfg.tariff_tax_pct || 0)
  let remaining = Math.max(0, kwh)
  let lower = 0
  let energy = 0
  const breakdown = []
  for (const slab of slabs) {
    const upto = slab.upto
    const rate = Number(slab.rate || 0)
    const capacity = upto == null ? Infinity : Math.max(0, Number(upto) - lower)
    const units = Math.min(remaining, capacity)
    if (units > 0) {
      const cost = units * rate
      energy += cost
      breakdown.push({ from: r2(lower), to: upto == null ? null : Number(upto), rate, units: r3(units), cost: r2(cost) })
      remaining -= units
    }
    if (upto != null) lower = Number(upto)
    if (remaining <= 0) break
  }
  const tax = ((energy + fixed) * taxPct) / 100
  const total = energy + fixed + tax
  return {
    kwh: r3(kwh),
    energy_charge: r2(energy),
    fixed_charge: r2(fixed),
    tax: r2(tax),
    total: r2(total),
    currency: cfg.tariff_currency || 'INR',
    symbol: cfg.currency_symbol || '₹',
    breakdown,
    effective_rate: kwh > 0 ? r3(total / kwh) : 0,
  }
}

export function nextSlabInfo(kwh, cfg) {
  const slabs = cfg.tariff_slabs || []
  let lower = 0
  for (let i = 0; i < slabs.length; i += 1) {
    const slab = slabs[i]
    if (slab.upto == null) {
      return { in_top_slab: true, current_rate: Number(slab.rate || 0), units_to_next: null, next_rate: null, boundary: null, pct_through_slab: 100 }
    }
    const upto = Number(slab.upto)
    if (kwh < upto) {
      const next = slabs[i + 1]
      const span = upto - lower
      return {
        in_top_slab: false,
        current_rate: Number(slab.rate || 0),
        units_to_next: r2(upto - kwh),
        next_rate: next ? Number(next.rate || 0) : null,
        boundary: upto,
        pct_through_slab: span > 0 ? Math.round(((kwh - lower) / span) * 1000) / 10 : 0,
      }
    }
    lower = upto
  }
  return {
    in_top_slab: true,
    current_rate: slabs.length ? Number(slabs[slabs.length - 1].rate || 0) : 0,
    units_to_next: null, next_rate: null, boundary: null, pct_through_slab: 100,
  }
}

export function marginalCostOf(extraKwh, currentKwh, cfg) {
  return r2(computeBill(currentKwh + extraKwh, cfg).total - computeBill(currentKwh, cfg).total)
}
