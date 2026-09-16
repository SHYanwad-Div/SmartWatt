// Port of the settings defaults and validation in backend/app/db.py. In the
// demo, a visitor's settings live in their own browser storage.
import { store } from './util.js'

const KEY = 'sw_demo_settings'

export const WIDGET_IDS = new Set([
  'status', 'tiles', 'house3d', 'live_chart', 'today_energy', 'top_consumer', 'tip',
  'breakdown', 'donut', 'forecast', 'billing', 'events', 'alerts',
])

export const DEFAULT_SETTINGS = {
  threshold_power_w: 2000,
  threshold_voltage_low: 200,
  threshold_voltage_high: 250,
  threshold_daily_kwh: 12,
  anomaly_z: 3,
  standby_waste_w: 60,
  alert_cooldown_s: 300,
  tariff_currency: 'INR',
  tariff_slabs: [
    { upto: 50, rate: 4.1 },
    { upto: 100, rate: 5.65 },
    { upto: 200, rate: 7.35 },
    { upto: null, rate: 8.25 },
  ],
  tariff_fixed_charge: 110,
  tariff_tax_pct: 9,
  notify_dashboard: true,
  notify_email: false,
  notify_webhook: false,
  notify_telegram: false,
  widget_layout: [
    'status', 'tiles', 'house3d', 'live_chart', 'today_energy', 'top_consumer',
    'tip', 'breakdown', 'donut', 'forecast', 'billing', 'events', 'alerts',
  ],
  currency_symbol: '₹',
  cal_voltage_gain: 1,
  cal_current_gain: 1,
  cal_power_gain: 1,
}

const NUMERIC_RANGES = {
  threshold_power_w: [50, 100000],
  threshold_voltage_low: [50, 300],
  threshold_voltage_high: [100, 400],
  threshold_daily_kwh: [0.1, 1000],
  anomaly_z: [1, 20],
  standby_waste_w: [0, 5000],
  alert_cooldown_s: [0, 86400],
  tariff_fixed_charge: [0, 100000],
  tariff_tax_pct: [0, 100],
  cal_voltage_gain: [0.1, 10],
  cal_current_gain: [0.1, 10],
  cal_power_gain: [0.1, 10],
}
const BOOL_KEYS = new Set(['notify_dashboard', 'notify_email', 'notify_webhook', 'notify_telegram'])
const STR_KEYS = { tariff_currency: 8, currency_symbol: 4 }

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...store.get(KEY, {}) }
}

export function saveSettings(current) {
  const changed = {}
  for (const [k, v] of Object.entries(current)) {
    if (JSON.stringify(v) !== JSON.stringify(DEFAULT_SETTINGS[k])) changed[k] = v
  }
  store.set(KEY, changed)
}

/** Returns cleaned values or throws Error with a user-facing message. */
export function validateSettings(values, current) {
  if (!values || typeof values !== 'object' || !Object.keys(values).length) {
    throw new Error('values must be a non-empty object')
  }
  const clean = {}
  for (const [key, v] of Object.entries(values)) {
    if (key in NUMERIC_RANGES) {
      const [lo, hi] = NUMERIC_RANGES[key]
      if (!isNumber(v)) throw new Error(`${key} must be a number`)
      if (v < lo || v > hi) throw new Error(`${key} must be between ${lo} and ${hi}`)
      clean[key] = v
    } else if (BOOL_KEYS.has(key)) {
      if (typeof v !== 'boolean') throw new Error(`${key} must be true or false`)
      clean[key] = v
    } else if (key in STR_KEYS) {
      if (typeof v !== 'string' || !v.trim() || v.length > STR_KEYS[key]) {
        throw new Error(`${key} must be text of 1-${STR_KEYS[key]} characters`)
      }
      clean[key] = v.trim()
    } else if (key === 'tariff_slabs') {
      if (!Array.isArray(v) || v.length < 1 || v.length > 10) throw new Error('tariff_slabs must be a list of 1-10 slabs')
      let prev = 0
      clean[key] = v.map((slab, i) => {
        if (!slab || typeof slab !== 'object') throw new Error(`slab ${i + 1} must be an object`)
        const { rate, upto } = slab
        if (!isNumber(rate) || rate < 0 || rate > 1000) throw new Error(`slab ${i + 1}: rate must be a number between 0 and 1000`)
        if (i === v.length - 1) {
          if (upto != null) throw new Error('the last slab must have no upper limit (upto: null)')
        } else {
          if (!isNumber(upto) || upto <= prev) throw new Error(`slab ${i + 1}: upto must be a number greater than ${prev}`)
          prev = upto
        }
        return { upto: upto == null ? null : upto, rate }
      })
    } else if (key === 'widget_layout') {
      if (!Array.isArray(v) || !v.every((w) => typeof w === 'string')) throw new Error('widget_layout must be a list of widget ids')
      const unknown = v.filter((w) => !WIDGET_IDS.has(w))
      if (unknown.length) throw new Error(`unknown widget(s): ${unknown.join(', ')}`)
      if (new Set(v).size !== v.length) throw new Error('widget_layout contains duplicates')
      clean[key] = [...v]
    } else {
      throw new Error(`unknown setting '${key}'`)
    }
  }
  const merged = { ...current, ...clean }
  if (merged.threshold_voltage_low >= merged.threshold_voltage_high) {
    throw new Error('threshold_voltage_low must be below threshold_voltage_high')
  }
  return clean
}
