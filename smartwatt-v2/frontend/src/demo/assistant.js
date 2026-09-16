// Port of backend/app/assistant.py: rule-based Energy Assistant over the live
// state of one home. Every number it quotes comes from the same engine the
// dashboard renders.
import { computeBill, marginalCostOf, nextSlabInfo } from './billing.js'
import { forecastMonthKwh, forecastPower } from './forecast.js'
import { OTHER_ID } from './nilm.js'
import { dayKey, sum } from './util.js'

export const TIPS = {
  ac: 'Raise the AC to 26-27 C and clean the filters monthly. Every 1 C lower costs roughly 6% more energy.',
  refrigerator: 'Keep the fridge away from the wall and the stove, and check the door gasket. A worn gasket can add 20% to its running cost.',
  geyser: 'Heat water only for as long as you need it. A 15-minute timer on a 2 kW geyser saves more than almost any other single change.',
  tv: 'Switch the TV off at the socket. Standby draw is small but runs 24x7.',
  fan: 'Fans cost a fraction of an AC. Running a fan at 26 C feels like 23 C.',
  lights: 'Swap any remaining CFL or halogen fittings for LED; same light for about a fifth of the power.',
  washing_machine: "Wash full loads on a cold cycle. Heating the water is most of the machine's energy use.",
  microwave: 'A microwave is far more efficient than an oven for small portions.',
  router: 'The router is a small constant load; leave it on, it is not worth switching.',
}

const GENERIC_TIPS = [
  'Shift heavy loads such as the washing machine to off-peak hours.',
  'Switching off at the socket avoids standby draw across the whole house.',
  'Track your daily budget - small daily savings compound across the billing cycle.',
]

const ALIASES = {
  ac: ['ac', 'air conditioner', 'aircon', 'a/c', 'cooler'],
  refrigerator: ['fridge', 'refrigerator', 'freezer'],
  geyser: ['geyser', 'water heater', 'heater', 'boiler'],
  tv: ['tv', 'television', 'telly'],
  fan: ['fan', 'ceiling fan'],
  lights: ['light', 'lights', 'lamp', 'bulb'],
  washing_machine: ['washing machine', 'washer', 'laundry'],
  microwave: ['microwave', 'oven'],
  router: ['router', 'wifi', 'modem', 'ont'],
}

const SUGGESTIONS = [
  'Which device uses most?', 'How much did AC use today?', 'Projected bill?',
  'How close am I to the next slab?', 'Turn off AC', 'Turn off everything except Refrigerator',
]

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const CONTROL_INTENTS = new Set(['control_all', 'control_one'])

/**
 * ctx: { state(dev), catalog(dev), settings(), monthDaily(dev), alerts(dev),
 *        setAppliance(dev, id, on, source), setAll(dev, on, except, source), history(dev) }
 */
export function makeAssistant(ctx) {
  const findAppliance = (dev, text) => {
    const low = text.toLowerCase()
    const catalog = ctx.catalog(dev)
    const byId = new Map(catalog.map((a) => [a.id, a]))
    const candidates = []
    for (const [id, names] of Object.entries(ALIASES)) {
      if (!byId.has(id)) continue
      for (const n of names) if (new RegExp(`\\b${escape(n)}\\b`).test(low)) candidates.push([n.length, id])
    }
    for (const a of catalog) {
      if (new RegExp(`\\b${escape(a.name.toLowerCase())}\\b`).test(low)) candidates.push([a.name.length, a.id])
    }
    if (!candidates.length) return null
    candidates.sort((x, y) => y[0] - x[0] || (y[1] > x[1] ? 1 : -1))
    return byId.get(candidates[0][1])
  }

  const monthKwh = (dev, todayKwh) => {
    const today = dayKey(Date.now())
    return sum(ctx.monthDaily(dev).filter(([d]) => d !== today).map(([, k]) => k)) + todayKwh
  }

  const handlers = {
    help: () => ({
      text: 'I can answer questions about live usage, energy, bills and alerts, and I can switch appliances on or off.',
      suggestions: SUGGESTIONS,
    }),

    status: (dev) => {
      const s = ctx.state(dev)
      if (!s) return { text: 'No live data yet for this device.' }
      const on = Object.values(s.appliances).filter((a) => a.state && a.id !== OTHER_ID).map((a) => a.name)
      return {
        text: `Drawing ${s.power_w.toFixed(0)} W right now at ${s.voltage_v.toFixed(0)} V. Today's use is ${s.today_kwh.toFixed(3)} kWh. `
          + (on.length ? `Running: ${on.join(', ')}.` : 'Nothing significant is on.'),
        data: { power_w: s.power_w, today_kwh: s.today_kwh },
      }
    },

    electrical: (dev) => {
      const s = ctx.state(dev)
      if (!s) return { text: 'No live data yet.' }
      return {
        text: `Voltage ${s.voltage_v.toFixed(1)} V, current ${s.current_a.toFixed(2)} A, power factor ${s.pf.toFixed(2)}, load ${s.power_w.toFixed(0)} W.`,
      }
    },

    top: (dev) => {
      const s = ctx.state(dev)
      if (!s) return { text: 'No live data yet.' }
      const items = Object.values(s.appliances).filter((a) => a.id !== OTHER_ID)
      if (!items.length) return { text: 'No appliance breakdown available yet.' }
      const other = s.appliances[OTHER_ID] || { power_w: 0 }
      const biggestKnown = Math.max(0, ...items.map((a) => a.power_w))
      if (other.power_w > Math.max(biggestKnown, 30)) {
        return {
          text: `${other.power_w.toFixed(0)} W of the current ${s.power_raw_w.toFixed(0)} W is not yet attributed to a known appliance - the meter has not seen those appliances switch on yet. Give it a few minutes of switching activity and the breakdown will fill in.`,
        }
      }
      const byPower = items.reduce((m, a) => (a.power_w > m.power_w ? a : m))
      const byEnergy = items.reduce((m, a) => (a.energy_wh > m.energy_wh ? a : m))
      const totalWh = sum(Object.values(s.appliances).map((a) => a.energy_wh)) || 1
      const share = (byEnergy.energy_wh / totalWh) * 100
      return {
        text: `${byPower.name} is the biggest load right now at ${byPower.power_w.toFixed(0)} W. Over today, ${byEnergy.name} has used the most: ${(byEnergy.energy_wh / 1000).toFixed(3)} kWh (${share.toFixed(1)}% of the total).`,
      }
    },

    energy: (dev, text) => {
      const s = ctx.state(dev)
      if (!s) return { text: 'No live data yet.' }
      const appliance = findAppliance(dev, text)
      if (appliance) {
        const a = s.appliances[appliance.id]
        if (!a) return { text: `No data for ${appliance.name} yet.` }
        const totalWh = sum(Object.values(s.appliances).map((x) => x.energy_wh)) || 1
        const share = (a.energy_wh / totalWh) * 100
        const cfg = ctx.settings()
        const cost = marginalCostOf(a.energy_wh / 1000, s.today_kwh, cfg)
        return {
          text: `${a.name} has used ${(a.energy_wh / 1000).toFixed(4)} kWh today (${share.toFixed(1)}% of the house), about ${cfg.currency_symbol}${cost.toFixed(2)}. It is drawing ${a.power_w.toFixed(0)} W and is currently ${a.state ? 'ON' : 'OFF'}.`,
        }
      }
      return { text: `The house has used ${s.today_kwh.toFixed(3)} kWh today, peaking at ${s.peak_w_today.toFixed(0)} W.` }
    },

    bill: (dev) => {
      const cfg = ctx.settings()
      const s = ctx.state(dev)
      const todayKwh = s ? s.today_kwh : 0
      const proj = forecastMonthKwh(ctx.monthDaily(dev), todayKwh)
      const now = computeBill(proj.month_so_far_kwh, cfg)
      const projected = computeBill(proj.projected_month_kwh, cfg)
      const sym = cfg.currency_symbol
      return {
        text: `This month you have used ${proj.month_so_far_kwh.toFixed(2)} kWh, costing ${sym}${now.total.toFixed(2)} so far. At your recent average of ${proj.avg_daily_kwh.toFixed(2)} kWh/day, the month should end near ${proj.projected_month_kwh.toFixed(1)} kWh, about ${sym}${projected.total.toFixed(2)} (${proj.confidence} confidence).`,
      }
    },

    slab: (dev) => {
      const cfg = ctx.settings()
      const s = ctx.state(dev)
      const kwh = monthKwh(dev, s ? s.today_kwh : 0)
      const info = nextSlabInfo(kwh, cfg)
      const sym = cfg.currency_symbol
      if (info.in_top_slab) {
        return { text: `At ${kwh.toFixed(1)} kWh you are in the highest slab, paying ${sym}${info.current_rate}/unit. Every unit saved now saves the most it possibly can.` }
      }
      return {
        text: `You have used ${kwh.toFixed(1)} kWh this month, paying ${sym}${info.current_rate}/unit. You are ${info.units_to_next.toFixed(1)} kWh below the ${info.boundary.toFixed(0)} kWh boundary, after which units cost ${sym}${info.next_rate}/unit. You are ${info.pct_through_slab.toFixed(0)}% through the current slab.`,
      }
    },

    alerts: (dev) => {
      const active = ctx.alerts(dev).filter((a) => a.status === 'active').slice(0, 5)
      if (!active.length) return { text: 'No active alerts. Everything looks normal.' }
      return {
        text: `${active.length} active alert(s).\n${active.map((a) => `${a.severity.toUpperCase()}: ${a.title} - ${a.message}`).join('\n')}`,
      }
    },

    tip: (dev, text) => {
      const appliance = findAppliance(dev, text)
      if (appliance && TIPS[appliance.id]) return { text: TIPS[appliance.id] }
      const s = ctx.state(dev)
      if (s) {
        const items = Object.values(s.appliances).filter((a) => a.id !== OTHER_ID)
        if (items.length) {
          const top = items.reduce((m, a) => (a.energy_wh > m.energy_wh ? a : m))
          return { text: `${top.name} is your largest consumer today. ${TIPS[top.id] || GENERIC_TIPS[0]}` }
        }
      }
      return { text: GENERIC_TIPS[0] }
    },

    forecast: (dev) => {
      const history = ctx.history(dev)
      if (history.length < 20) return { text: 'Not enough history yet to forecast. Give it a few minutes.' }
      const f = forecastPower(history, 120, 30)
      if (!f.points.length) return { text: 'Not enough history yet to forecast.' }
      const next = f.points[0].power_w
      const end = f.points[f.points.length - 1].power_w
      return {
        text: `Over the next two hours I expect load around ${next.toFixed(0)} W rising or falling toward ${end.toFixed(0)} W (model: ${f.method}, +/-${f.sigma_w.toFixed(0)} W).`,
      }
    },

    control_all: (dev, text) => {
      const on = /turn\s+on|switch\s+on/i.test(text)
      const exceptIds = []
      const exc = text.match(/except\s+(?:the\s+)?(.+)$/i)
      if (exc) {
        for (const part of exc[1].split(/,|\band\b/)) {
          const found = findAppliance(dev, part)
          if (found) exceptIds.push(found.id)
        }
      }
      const res = ctx.setAll(dev, on, exceptIds, 'assistant')
      const word = on ? 'on' : 'off'
      const kept = res.skipped.length ? ` Left running: ${res.skipped.join(', ')}.` : ''
      if (!res.changed.length) return { text: `Nothing to switch ${word}.${kept}` }
      return { text: `Switched ${word}: ${res.changed.join(', ')}.${kept}` }
    },

    control_one: (dev, text) => {
      const on = /(turn|switch)\s+on/i.test(text)
      const appliance = findAppliance(dev, text)
      if (!appliance) return { text: 'Which appliance? Try "turn off AC" or "turn off the fan".' }
      const res = ctx.setAppliance(dev, appliance.id, on, 'assistant')
      if (!res.ok) return { text: res.error || 'That could not be switched.' }
      return { text: `${appliance.name} switched ${on ? 'on' : 'off'}.` }
    },
  }

  const PATTERNS = [
    [/\b(help|what can you do|commands)\b/i, 'help'],
    [/turn\s+(off|on)\s+every(thing|\s*one)|turn\s+(off|on)\s+all/i, 'control_all'],
    [/\b(turn|switch)\s+(off|on)\b/i, 'control_one'],
    [/\b(next\s+slab|slab|tariff\s+band)\b/i, 'slab'],
    [/\b(bill|cost|projected|how much.*(pay|cost)|rupees)\b/i, 'bill'],
    [/\b(which|what).*(most|highest|biggest|top)\b/i, 'top'],
    [/\b(how many|how much)\b.*\b(kwh|unit|energy|consum|use|used|using|draw|drawn|run|spent)/i, 'energy'],
    [/\b(alert|warning|problem|anomal)/i, 'alerts'],
    [/\b(voltage|current|volt|amp)\b/i, 'electrical'],
    [/\b(tip|save|saving|advice|reduce|suggest)\b/i, 'tip'],
    [/\b(status|now|live|right now|current power|power)\b/i, 'status'],
    [/\b(forecast|predict|tomorrow|expect)\b/i, 'forecast'],
  ]

  return function ask(dev, rawText, canControl) {
    const text = (rawText || '').trim()
    if (!text) return { text: 'Ask me something about your energy use.' }
    for (const [pattern, intent] of PATTERNS) {
      if (!pattern.test(text)) continue
      if (CONTROL_INTENTS.has(intent) && !canControl) {
        return { text: 'Your account can view energy data but cannot switch appliances.', intent, forbidden: true }
      }
      try {
        return { ...handlers[intent](dev, text), intent }
      } catch (e) {
        return { text: `I could not work that out (${e.message}).`, intent }
      }
    }
    return {
      text: 'I did not follow that. Try "which device uses most?", "projected bill?", or "turn off AC".',
      intent: 'unknown',
      suggestions: ['Which device uses most?', 'How many kWh today?', 'Projected bill?', 'Turn off AC'],
    }
  }
}
