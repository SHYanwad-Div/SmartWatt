// In-browser stand-in for the Smart Watt backend, used by the static demo build.
//
// It runs the same pipeline as backend/app/ingest/pipeline.py (simulate, detect
// appliance switching, attribute, alert, automate) and answers the dashboard's
// REST paths with the same JSON shapes, so the React app is unchanged. Each
// visitor gets a private house; nothing leaves the browser.
import { ApiError, getToken } from '../lib/api.js'
import { AnomalyDetector } from './anomaly.js'
import { makeAssistant, TIPS } from './assistant.js'
import { computeBill, marginalCostOf, nextSlabInfo } from './billing.js'
import { forecastMonthKwh, forecastPower } from './forecast.js'
import { Disaggregator, EdgeDetector, OTHER_ID, scoreEstimate } from './nilm.js'
import { loadSettings, saveSettings, validateSettings } from './settings.js'
import { HouseSimulator, specsFor } from './simulator.js'
import { clamp, dayKey, r1, r2, r3, r4, startOfDay, store, sum } from './util.js'

const METERS = [
  { id: 'home-bengaluru', scale: 1, omit: [], seed: 11 },
  { id: 'apartment-2b', scale: 0.8, omit: ['washing_machine'], seed: 23 },
  { id: 'villa-7', scale: 1.35, omit: [], seed: 42 },
]

const PAST_DAYS = 35            // completed days of daily totals for bills and reports
const PAST_STEP_S = 120         // coarse step for those days (aggregate only)
const REPLAY_STEP_S = 10        // today is replayed through the full pipeline at this step
const HISTORY_MS = 2 * 3600e3   // live chart window, like the backend's 2 h buffer
const SAMPLE_EVERY_MS = 10000   // "persisted" readings used for reports, CSV and forecasts
const SAMPLES_MS = 48 * 3600e3
const OPEN_ALERT_MS = 30 * 60e3 // replayed alerts older than this count as handled
// Accuracy for a single instant swings wildly around a merged switching step, so the
// dashboard reports a rolling mean over this window alongside the instant value.
const ACCURACY_WINDOW_MS = 30 * 60e3

const PERMISSIONS = {
  homeowner: ['automate', 'control', 'ingest', 'read', 'settings'],
  utility: ['billing', 'read'],
}
const USERS = {
  home: { id: 2, username: 'home', role: 'homeowner', display_name: 'Home Owner' },
  utility: { id: 3, username: 'utility', role: 'utility', display_name: 'Utility Analyst' },
}
const TRIGGERS = new Set(['appliance_on_for', 'daily_budget', 'power_above', 'time_of_day'])
const ACTIONS = new Set(['notify', 'turn_off', 'turn_on'])
const RANGE_MS = {
  '5m': 5 * 60e3, '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3,
  '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3,
}

let started = false
let settings = null
let automations = []
let nextAutomationId = 1
let nextAlertId = 1
let nextEventId = 1
const runtimes = new Map()
const subscribers = new Map()

// ------------------------------------------------------------------ runtime

function makeRuntime(meter, now) {
  const specs = specsFor(meter.scale, meter.omit)
  const dayOfYear = Math.floor((startOfDay(now) - new Date(new Date(now).getFullYear(), 0, 0).getTime()) / 86400e3)
  return {
    id: meter.id,
    meter,
    specs,
    sim: new HouseSimulator(meter.id, specs, meter.seed * 1000 + dayOfYear),
    catalog: specs.map((s) => ({
      id: s.id, name: s.name, icon: s.icon, category: s.category, behaviour: s.behaviour,
      rated_w: s.rated_w, standby_w: s.standby_w, controllable: s.controllable, enabled: true, state: false,
    })),
    edge: new EdgeDetector(),
    anomaly: new AnomalyDetector(),
    disagg: new Disaggregator(specs),
    filter: [],
    history: [],
    samples: [],
    daily: new Map(),
    events: [],
    alerts: [],
    lastAlertAt: new Map(),
    last: null,
    lastTs: 0,
    lastSampleTs: 0,
    energyWhToday: 0,
    energyWhSession: 0,
    peak: 0,
    day: null,
    score: {},
    accuracyWindow: [],
    ticks: 0,
  }
}

function emit(deviceId, payload) {
  const subs = subscribers.get(deviceId)
  if (!subs) return
  for (const fn of subs) fn(payload)
}

function saveRelays() {
  const relays = {}
  for (const rt of runtimes.values()) {
    const off = rt.catalog.filter((a) => !a.enabled).map((a) => a.id)
    if (off.length) relays[rt.id] = off
  }
  store.set('sw_demo_relays', relays)
}

function raiseAlert(rt, anomaly, ts, live) {
  const cooldownMs = Number(settings.alert_cooldown_s ?? 300) * 1000
  if (ts - (rt.lastAlertAt.get(anomaly.type) ?? -Infinity) < cooldownMs) return
  rt.lastAlertAt.set(anomaly.type, ts)
  const alert = { id: nextAlertId++, device_id: rt.id, ts, ...anomaly, status: 'active', channels: 'dashboard' }
  rt.alerts.unshift(alert)
  if (rt.alerts.length > 200) rt.alerts.pop()
  if (live) emit(rt.id, { type: 'alert', alert })
}

function ingest(rt, reading, live) {
  const cfg = settings
  const ts = reading.ts_ms
  const day = dayKey(ts)
  if (rt.day === null) rt.day = day
  if (day !== rt.day) {
    rt.daily.set(rt.day, { kwh: rt.energyWhToday / 1000, peak_w: rt.peak })
    rt.day = day
    rt.energyWhToday = 0
    rt.peak = 0
    rt.disagg.resetDailyEnergy()
  }
  const dt = rt.lastTs ? clamp((ts - rt.lastTs) / 1000, 0, 60) : 0
  rt.lastTs = ts

  const voltage = reading.voltage_V * Number(cfg.cal_voltage_gain ?? 1)
  const current = reading.current_A * Number(cfg.cal_current_gain ?? 1)
  const power = reading.power_W * Number(cfg.cal_power_gain ?? 1)
  rt.filter.push(power)
  if (rt.filter.length > 5) rt.filter.shift()
  const display = sum(rt.filter) / rt.filter.length

  const wh = (power * dt) / 3600
  rt.energyWhToday += wh
  rt.energyWhSession += wh
  rt.peak = Math.max(rt.peak, display)
  const todayKwh = rt.energyWhToday / 1000
  rt.history.push({ ts, power_w: r1(display) })
  while (rt.history.length && ts - rt.history[0].ts > HISTORY_MS) rt.history.shift()

  let eventRow = null
  const edge = rt.edge.push(ts, power)
  if (edge) {
    const [aid, confidence] = rt.disagg.matchEdge(edge.delta_w, edge.ts)
    const label = rt.disagg.lastMatchIds.map((id) => rt.disagg.nameOf(id)).filter(Boolean).join(' + ') || null
    eventRow = { id: nextEventId++, device_id: rt.id, ...edge, appliance_id: aid, label, confidence }
    rt.events.unshift(eventRow)
    if (rt.events.length > 500) rt.events.pop()
  }

  const appliances = rt.disagg.attribute(power, dt)
  rt.score = scoreEstimate(appliances, reading.truth)
  rt.accuracyWindow.push([ts, rt.score.accuracy])
  while (rt.accuracyWindow.length && ts - rt.accuracyWindow[0][0] > ACCURACY_WINDOW_MS) rt.accuracyWindow.shift()
  rt.score.accuracy_30m = r4(sum(rt.accuracyWindow.map(([, a]) => a)) / rt.accuracyWindow.length)
  rt.ticks += 1
  for (const c of rt.catalog) c.state = Boolean(appliances[c.id]?.state)

  const allOff = Object.entries(appliances).every(([id, a]) => id === OTHER_ID || !a.state)
  for (const anomaly of rt.anomaly.check(display, voltage, todayKwh, cfg, allOff, live || rt.ticks % 30 === 0)) {
    raiseAlert(rt, anomaly, ts, live)
  }
  if (live) evaluateAutomations(rt, display, todayKwh, appliances, ts)

  rt.last = {
    device_id: rt.id,
    ts,
    voltage_v: r2(voltage),
    current_a: r4(current),
    power_w: r2(display),
    power_raw_w: r2(power),
    pf: r3(reading.pf),
    today_kwh: r4(todayKwh),
    peak_w_today: r1(rt.peak),
    energy_wh_session: r3(rt.energyWhSession),
    appliances,
    disagg_score: rt.score,
    source: 'sim',
  }

  if (ts - rt.lastSampleTs >= SAMPLE_EVERY_MS) {
    rt.lastSampleTs = ts
    rt.samples.push({ ts, voltage_v: voltage, current_a: current, power_w: display, pf: reading.pf, energy_wh_total: reading.energyWh_total })
    while (rt.samples.length && ts - rt.samples[0].ts > SAMPLES_MS) rt.samples.shift()
    rt.daily.set(rt.day, { kwh: todayKwh, peak_w: rt.peak })
  }

  if (live) emit(rt.id, eventRow ? { type: 'reading', reading: rt.last, event: eventRow } : { type: 'reading', reading: rt.last })
}

/** Fill the house's past so charts, bills and forecasts are meaningful on first view. */
function replayHistory(rt, now) {
  const today = startOfDay(now)
  const past = new HouseSimulator(rt.id, rt.specs, rt.meter.seed * 7919)
  for (let t = today - PAST_DAYS * 86400e3; t < today; t += PAST_STEP_S * 1000) {
    const r = past.tick(t, PAST_STEP_S)
    const d = dayKey(t)
    const entry = rt.daily.get(d) || { kwh: 0, peak_w: 0 }
    entry.kwh += (r.power_W * PAST_STEP_S) / 3600e3
    entry.peak_w = Math.max(entry.peak_w, r.power_W)
    rt.daily.set(d, entry)
  }
  for (let t = today; t <= now; t += REPLAY_STEP_S * 1000) ingest(rt, rt.sim.tick(t, REPLAY_STEP_S), false)
  for (const a of rt.alerts) {
    if (a.ts < now - OPEN_ALERT_MS) {
      a.status = 'resolved'
      a.resolved_at = a.ts + 10 * 60e3
    }
  }
}

function liveTick() {
  const now = Date.now()
  for (const rt of runtimes.values()) {
    // a background tab is throttled: catch up in coarse steps, at most an hour
    if (now - rt.lastTs > 15000) {
      const from = rt.lastTs
      for (let t = from + REPLAY_STEP_S * 1000; t < now - 1000 && t < from + 3600e3; t += REPLAY_STEP_S * 1000) {
        ingest(rt, rt.sim.tick(t, REPLAY_STEP_S), false)
      }
    }
    const dt = clamp((now - rt.lastTs) / 1000, 0.05, 60)
    ingest(rt, rt.sim.tick(now, dt), true)
  }
}

function ensureStarted() {
  if (started) return
  started = true
  settings = loadSettings()
  automations = store.get('sw_demo_automations', [])
  nextAutomationId = automations.reduce((m, a) => Math.max(m, a.id), 0) + 1
  const relays = store.get('sw_demo_relays', {})
  const now = Date.now()
  for (const meter of METERS) {
    const rt = makeRuntime(meter, now)
    runtimes.set(meter.id, rt)
    // Replay the day first, then apply the visitor's saved switch-offs as of now.
    // Applying them before the replay made an appliance switched off this
    // afternoon look off since midnight, erasing the energy it had already used.
    replayHistory(rt, now)
    for (const id of relays[meter.id] || []) {
      const c = rt.catalog.find((a) => a.id === id)
      if (!c || !c.controllable) continue
      c.enabled = false
      rt.sim.setEnabled(id, false)
      rt.disagg.setEnabled(id, false, rt.lastTs)
    }
  }
  if (typeof setInterval === 'function' && typeof window !== 'undefined') setInterval(liveTick, 1000)
}

// ------------------------------------------------------------------ control

function setAppliance(rt, applianceId, on, source) {
  const c = rt.catalog.find((a) => a.id === applianceId)
  if (!c) return { ok: false, code: 404, error: `unknown appliance '${applianceId}'` }
  if (!c.controllable) return { ok: false, code: 400, error: `${c.name} is not remotely controllable` }
  rt.sim.setEnabled(applianceId, on)
  rt.disagg.setEnabled(applianceId, on, rt.lastTs || Date.now())
  c.enabled = on
  saveRelays()
  const payload = { ok: true, device_id: rt.id, appliance_id: applianceId, name: c.name, enabled: on, source, delivered: true }
  emit(rt.id, { type: 'control', control: payload })
  return payload
}

function setAll(rt, on, exceptIds = [], source = 'dashboard') {
  const except = exceptIds.map((e) => String(e).toLowerCase())
  const changed = []
  const skipped = []
  for (const c of rt.catalog.filter((a) => a.controllable)) {
    if (except.includes(c.id.toLowerCase()) || except.includes(c.name.toLowerCase())) {
      skipped.push(c.name)
      continue
    }
    if (setAppliance(rt, c.id, on, source).ok) changed.push(c.name)
  }
  return { ok: true, changed, skipped, state: on }
}

function triggerFires(rule, powerW, todayKwh, appliances, ts) {
  const cfg = rule.trigger_config || {}
  switch (rule.trigger_type) {
    case 'power_above':
      return powerW > Number(cfg.watts ?? 1e9)
    case 'daily_budget':
      return todayKwh > Number(cfg.kwh ?? 1e9)
    case 'time_of_day': {
      const d = new Date(ts)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` === cfg.at
    }
    case 'appliance_on_for': {
      const st = appliances[cfg.appliance_id]
      if (!st || !st.state || !st.since_ts) return false
      return ts - st.since_ts >= Number(cfg.minutes ?? 60) * 60e3
    }
    default:
      return false
  }
}

function evaluateAutomations(rt, powerW, todayKwh, appliances, ts) {
  const fired = []
  for (const rule of automations) {
    if (rule.device_id !== rt.id || !rule.enabled) continue
    if (rule.last_fired && ts - rule.last_fired < 60000) continue
    if (!triggerFires(rule, powerW, todayKwh, appliances, ts)) continue
    const acfg = rule.action_config || {}
    let result = null
    if (rule.action_type === 'turn_off' || rule.action_type === 'turn_on') {
      const on = rule.action_type === 'turn_on'
      if (acfg.all) result = setAll(rt, on, acfg.except || [], 'automation')
      else if (acfg.appliance_id) result = setAppliance(rt, acfg.appliance_id, on, 'automation')
    } else if (rule.action_type === 'notify') {
      result = { message: acfg.message || rule.name }
    }
    rule.last_fired = ts
    rule.fire_count += 1
    fired.push({ rule: rule.name, action: rule.action_type, result })
  }
  if (fired.length) {
    store.set('sw_demo_automations', automations)
    emit(rt.id, { type: 'automation', fired })
  }
}

// -------------------------------------------------------------- read models

function runtimeOr404(id, detail = 'Unknown device') {
  const rt = runtimes.get(id)
  if (!rt) throw new ApiError(404, detail)
  return rt
}

function monthDaily(rt) {
  const prefix = dayKey(Date.now()).slice(0, 7)
  return [...rt.daily.entries()].filter(([d]) => d.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, e]) => [d, e.kwh])
}

function monthKwh(rt, todayKwh) {
  const today = dayKey(Date.now())
  return sum(monthDaily(rt).filter(([d]) => d !== today).map(([, k]) => k)) + todayKwh
}

function applianceRows(rt) {
  const live = rt.last?.appliances || {}
  const totalWh = sum(Object.values(live).map((a) => a.energy_wh)) || 1
  const rows = [...rt.catalog]
    .sort((a, b) => b.rated_w - a.rated_w)
    .map((c) => {
      const st = live[c.id] || {}
      const wh = st.energy_wh || 0
      return {
        id: c.id, name: c.name, icon: c.icon, category: c.category, rated_w: c.rated_w,
        controllable: c.controllable, enabled: c.enabled, power_w: st.power_w || 0, state: Boolean(st.state),
        today_kwh: r4(wh / 1000), share_pct: r2((wh / totalWh) * 100), confidence: st.confidence || 0,
      }
    })
  const other = live[OTHER_ID]
  if (other) {
    rows.push({
      id: OTHER_ID, name: other.name, icon: other.icon, category: 'unknown', rated_w: 0, controllable: false,
      enabled: true, power_w: other.power_w, state: other.state, today_kwh: r4(other.energy_wh / 1000),
      share_pct: r2((other.energy_wh / totalWh) * 100), confidence: 1,
    })
  }
  return rows
}

function billing(rt) {
  const todayKwh = rt.last?.today_kwh || 0
  const month = monthKwh(rt, todayKwh)
  const proj = forecastMonthKwh(monthDaily(rt), todayKwh)
  return {
    device_id: rt.id,
    today: { kwh: r4(todayKwh), cost: marginalCostOf(todayKwh, Math.max(0, month - todayKwh), settings) },
    month_to_date: computeBill(month, settings),
    projected_month: computeBill(proj.projected_month_kwh, settings),
    next_slab: nextSlabInfo(month, settings),
    forecast: proj,
    daily: monthDaily(rt).map(([day, kwh]) => ({ day, kwh: r3(kwh) })),
  }
}

function forecastHistory(rt) {
  return rt.samples.slice(-8640).map((s) => ({ ts: s.ts, power_w: s.power_w }))
}

function insights(rt) {
  const empty = { top_now: null, top_today: null, tip: null, unattributed_w: 0, unattributed_share: 0, unattributed_is_largest: false }
  if (!rt.last) return empty
  const apps = rt.last.appliances
  const items = Object.values(apps).filter((a) => a.id !== OTHER_ID)
  if (!items.length) return empty
  const topNow = items.reduce((m, a) => (a.power_w > m.power_w ? a : m))
  const topToday = items.reduce((m, a) => (a.energy_wh > m.energy_wh ? a : m))
  const totalWh = sum(Object.values(apps).map((a) => a.energy_wh)) || 1
  const unattributed = apps[OTHER_ID]?.power_w || 0
  return {
    unattributed_w: r1(unattributed),
    unattributed_share: r3(unattributed / Math.max(rt.last.power_raw_w, 1)),
    unattributed_is_largest: unattributed > Math.max(topNow.power_w, 30),
    top_now: { ...topNow, tip: TIPS[topNow.id] || null },
    top_today: { ...topToday, share_pct: r2((topToday.energy_wh / totalWh) * 100), tip: TIPS[topToday.id] || null },
    tip: TIPS[topToday.id] || null,
  }
}

function dailyReport(rt, days) {
  const since = dayKey(Date.now() - days * 86400e3)
  let running = 0
  const out = [...rt.daily.entries()]
    .filter(([d]) => d >= since)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, e]) => {
      const cost = marginalCostOf(e.kwh, running, settings)
      running += e.kwh
      return { day, kwh: r3(e.kwh), peak_w: r1(e.peak_w), cost }
    })
  return { device_id: rt.id, days: out, total_kwh: r3(sum(out.map((d) => d.kwh))), total_cost: r2(sum(out.map((d) => d.cost))) }
}

function exportCsv(rt, range) {
  const since = Date.now() - (RANGE_MS[range] || RANGE_MS['24h'])
  const lines = ['timestamp,iso_time,voltage_V,current_A,power_W,power_factor,energy_Wh_total']
  for (const s of rt.samples) {
    if (s.ts < since) continue
    lines.push([s.ts, new Date(s.ts).toISOString(), r2(s.voltage_v), r4(s.current_a), r2(s.power_w), r3(s.pf), r3(s.energy_wh_total)].join(','))
  }
  return new Response(`${lines.join('\r\n')}\r\n`, {
    headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="smartwatt_${rt.id}_${range}.csv"` },
  })
}

function portfolio() {
  const rows = [...runtimes.values()].map((rt) => {
    const today = rt.last?.today_kwh || 0
    const month = monthKwh(rt, today)
    const proj = forecastMonthKwh(monthDaily(rt), today)
    return {
      id: rt.id, source: 'sim', online: true,
      power_w: rt.last?.power_w || 0, peak_w_today: rt.last?.peak_w_today || 0,
      today_kwh: r4(today), month_kwh: r3(month),
      month_bill: computeBill(month, settings).total,
      projected_bill: computeBill(proj.projected_month_kwh, settings).total,
      active_alerts: rt.alerts.filter((a) => a.status === 'active').length,
    }
  })
  return {
    devices: rows,
    total_power_w: r1(sum(rows.map((r) => r.power_w))),
    total_today_kwh: r3(sum(rows.map((r) => r.today_kwh))),
    total_month_bill: r2(sum(rows.map((r) => r.month_bill))),
  }
}

const assistantAsk = makeAssistant({
  state: (dev) => runtimes.get(dev)?.last || null,
  catalog: (dev) => runtimes.get(dev)?.catalog || [],
  settings: () => settings,
  monthDaily: (dev) => (runtimes.get(dev) ? monthDaily(runtimes.get(dev)) : []),
  alerts: (dev) => runtimes.get(dev)?.alerts || [],
  history: (dev) => (runtimes.get(dev) ? forecastHistory(runtimes.get(dev)) : []),
  setAppliance: (dev, id, on, source) => setAppliance(runtimeOr404(dev), id, on, source),
  setAll: (dev, on, except, source) => setAll(runtimeOr404(dev), on, except, source),
})

// ------------------------------------------------------------------- routes

function findAlert(id) {
  for (const rt of runtimes.values()) {
    const a = rt.alerts.find((x) => x.id === id)
    if (a) return a
  }
  return null
}

const ROUTES = [
  ['POST', /^\/auth\/login$/, null, ({ body }) => {
    const user = USERS[String(body.username || '').trim().toLowerCase()]
    if (!user) throw new ApiError(401, 'Invalid username or password')
    return { token: `demo.${user.role}`, user: { ...user, permissions: PERMISSIONS[user.role] } }
  }],
  ['GET', /^\/auth\/me$/, 'auth', ({ user }) => ({
    username: user.username, role: user.role, name: user.display_name, permissions: PERMISSIONS[user.role],
  })],
  ['GET', /^\/devices$/, 'read', () => [...runtimes.values()].map((rt) => ({
    id: rt.id, name: rt.id, location: '', source: 'sim', online: true, power_w: rt.last?.power_w || 0,
  }))],
  ['GET', /^\/portfolio$/, 'billing', () => portfolio()],
  ['GET', /^\/live\/([^/]+)$/, 'read', ({ params }) => {
    const rt = runtimeOr404(params[0], 'No live data for this device yet')
    if (!rt.last) throw new ApiError(404, 'No live data for this device yet')
    return rt.last
  }],
  ['GET', /^\/readings\/([^/]+)$/, 'read', ({ params, query }) => {
    const rt = runtimeOr404(params[0])
    const range = query.get('range') || '1h'
    const limit = clamp(Number(query.get('limit') || 1500), 10, 10000)
    const windowMs = RANGE_MS[range] || RANGE_MS['1h']
    const since = Date.now() - windowMs
    let points = windowMs <= RANGE_MS['1h']
      ? rt.history.filter((p) => p.ts >= since).map((p) => ({ ts: p.ts, power_w: p.power_w }))
      : rt.samples.filter((s) => s.ts >= since).map((s) => ({ ts: s.ts, power_w: r1(s.power_w), voltage_v: r1(s.voltage_v), current_a: r3(s.current_a) }))
    if (points.length > limit) {
      const step = points.length / limit
      points = Array.from({ length: limit }, (_, i) => points[Math.floor(i * step)])
    }
    return { device_id: rt.id, range, count: points.length, points }
  }],
  ['GET', /^\/appliances\/([^/]+)$/, 'read', ({ params }) => {
    const rt = runtimeOr404(params[0])
    return { device_id: rt.id, appliances: applianceRows(rt), disagg_score: rt.score }
  }],
  ['POST', /^\/appliances\/([^/]+)\/control$/, 'control', ({ params, body }) => {
    const rt = runtimeOr404(params[0], `unknown device '${params[0]}'`)
    if (typeof body.state !== 'boolean') throw new ApiError(422, 'state: Field required')
    if (body.all) return setAll(rt, body.state, body.except_ids || [], 'dashboard')
    if (!body.appliance_id) throw new ApiError(400, 'appliance_id or all=true required')
    const res = setAppliance(rt, body.appliance_id, body.state, 'dashboard')
    if (!res.ok) throw new ApiError(res.code || 400, res.error)
    return res
  }],
  ['GET', /^\/events\/([^/]+)$/, 'read', ({ params, query }) => {
    const rt = runtimeOr404(params[0])
    return rt.events.slice(0, clamp(Number(query.get('limit') || 100), 1, 1000))
  }],
  ['GET', /^\/alerts\/([^/]+)$/, 'read', ({ params, query }) => {
    const rt = runtimeOr404(params[0])
    const status = query.get('status')
    return rt.alerts.filter((a) => !status || a.status === status).slice(0, clamp(Number(query.get('limit') || 100), 1, 1000))
  }],
  ['POST', /^\/alerts\/(\d+)\/(ack|resolve)$/, 'read', ({ params }) => {
    const alert = findAlert(Number(params[0]))
    if (!alert) return { ok: false }
    if (params[1] === 'ack') {
      if (alert.status !== 'active') return { ok: false }
      alert.status = 'acknowledged'
      alert.acked_at = Date.now()
    } else {
      alert.status = 'resolved'
      alert.resolved_at = Date.now()
    }
    return { ok: true }
  }],
  ['GET', /^\/billing\/([^/]+)$/, 'read', ({ params }) => billing(runtimeOr404(params[0]))],
  ['GET', /^\/forecast\/([^/]+)$/, 'read', ({ params, query }) => {
    const rt = runtimeOr404(params[0])
    const horizon = clamp(Number(query.get('horizon_minutes') || 120), 10, 1440)
    const today = rt.last?.today_kwh || 0
    return {
      power: forecastPower(forecastHistory(rt), horizon, Math.max(5, Math.floor(horizon / 24))),
      month: forecastMonthKwh(monthDaily(rt), today),
    }
  }],
  ['GET', /^\/insights\/([^/]+)$/, 'read', ({ params }) => insights(runtimeOr404(params[0]))],
  ['POST', /^\/assistant\/([^/]+)$/, 'read', ({ params, body, user }) => {
    runtimeOr404(params[0])
    const query = String(body.query ?? '')
    if (query.length > 500) throw new ApiError(422, 'query: String should have at most 500 characters')
    const reply = assistantAsk(params[0], query, PERMISSIONS[user.role].includes('control'))
    if (reply.forbidden) throw new ApiError(403, reply.text)
    return reply
  }],
  ['GET', /^\/settings$/, 'read', () => settings],
  ['PUT', /^\/settings$/, 'settings', ({ body }) => {
    let clean
    try {
      clean = validateSettings(body.values, settings)
    } catch (e) {
      throw new ApiError(422, e.message)
    }
    settings = { ...settings, ...clean }
    saveSettings(settings)
    return settings
  }],
  ['GET', /^\/automations\/([^/]+)$/, 'read', ({ params }) => {
    runtimeOr404(params[0])
    return automations.filter((a) => a.device_id === params[0])
  }],
  ['POST', /^\/automations\/([^/]+)$/, 'automate', ({ params, body }) => {
    runtimeOr404(params[0], `unknown device '${params[0]}'`)
    const name = String(body.name || '').trim()
    if (!name || name.length > 80) throw new ApiError(422, 'name: must be 1-80 characters')
    if (!TRIGGERS.has(body.trigger_type)) throw new ApiError(422, `trigger_type must be one of ${JSON.stringify([...TRIGGERS])}`)
    if (!ACTIONS.has(body.action_type)) throw new ApiError(422, `action_type must be one of ${JSON.stringify([...ACTIONS])}`)
    const rule = {
      id: nextAutomationId++, device_id: params[0], name, enabled: body.enabled !== false,
      trigger_type: body.trigger_type, trigger_config: body.trigger_config || {},
      action_type: body.action_type, action_config: body.action_config || {},
      last_fired: null, fire_count: 0, created_at: Date.now(),
    }
    automations.push(rule)
    store.set('sw_demo_automations', automations)
    return { id: rule.id }
  }],
  ['PATCH', /^\/automations\/(\d+)$/, 'automate', ({ params, query }) => {
    const rule = automations.find((a) => a.id === Number(params[0]))
    if (!rule) return { ok: false }
    rule.enabled = query.get('enabled') === 'true'
    store.set('sw_demo_automations', automations)
    return { ok: true }
  }],
  ['DELETE', /^\/automations\/(\d+)$/, 'automate', ({ params }) => {
    const before = automations.length
    automations = automations.filter((a) => a.id !== Number(params[0]))
    store.set('sw_demo_automations', automations)
    return { ok: automations.length < before }
  }],
  ['GET', /^\/reports\/([^/]+)\/daily$/, 'read', ({ params, query }) => dailyReport(runtimeOr404(params[0]), clamp(Number(query.get('days') || 30), 1, 365))],
  ['GET', /^\/reports\/([^/]+)\/export\.csv$/, 'read', ({ params, query }) => exportCsv(runtimeOr404(params[0]), query.get('range') || '24h')],
]

function authorize(permission) {
  const token = getToken() || ''
  const role = token.startsWith('demo.') ? token.slice(5) : null
  const user = Object.values(USERS).find((u) => u.role === role)
  if (!user) throw new ApiError(401, 'Not authenticated')
  if (permission !== 'auth' && !PERMISSIONS[role].includes(permission)) {
    throw new ApiError(403, `Role '${role}' cannot ${permission}`)
  }
  return user
}

/** Drop-in for fetch('/api' + path): same paths, same JSON, same errors. */
export async function demoApi(path, { method = 'GET', body, raw = false } = {}) {
  ensureStarted()
  const [pathname, qs = ''] = path.split('?')
  const query = new URLSearchParams(qs)
  for (const [m, re, permission, handler] of ROUTES) {
    if (m !== method) continue
    const match = pathname.match(re)
    if (!match) continue
    const user = permission === null ? null : authorize(permission)
    const params = match.slice(1).map((p) => decodeURIComponent(p))
    const result = handler({ params, query, body: body ?? {}, user })
    if (raw) return result
    // copy, as a network response would, so callers never share engine state
    return JSON.parse(JSON.stringify(result))
  }
  throw new ApiError(404, 'Not Found')
}

/** Drop-in for the WebSocket feed. Returns an unsubscribe function. */
export function subscribe(deviceId, onMessage) {
  ensureStarted()
  if (!subscribers.has(deviceId)) subscribers.set(deviceId, new Set())
  const subs = subscribers.get(deviceId)
  subs.add(onMessage)
  const rt = runtimes.get(deviceId)
  if (rt?.last) {
    const first = rt.last
    Promise.resolve().then(() => onMessage({ type: 'reading', reading: first }))
  }
  return () => subs.delete(onMessage)
}

/** For measurement scripts: start without the live timer and expose state. */
export function _debugStart() {
  ensureStarted()
  return { runtimes, settings }
}
