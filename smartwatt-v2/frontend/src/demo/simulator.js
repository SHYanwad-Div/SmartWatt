// Port of backend/app/ingest/simulator.py: a synthetic house built from
// per-appliance state machines. The aggregate is what the "meter" reports; the
// per-appliance truth is kept only to score the disaggregation.

export function makeRng(seed = Math.floor(Math.random() * 2 ** 31)) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    random: next,
    uniform: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    gauss: (mu, sigma) => mu + sigma * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
  }
}

const DEFAULTS = {
  standby_w: 0, controllable: true, behaviour: 'occupancy', active_hours: [[0, 23]],
  on_minutes: 15, off_minutes: 25, on_probability: 0.5, runs_per_day: 2, run_minutes: 10,
  variability: 0.06, power_factor: 0.98,
}

export const HOUSE = [
  { id: 'ac', name: 'AC', icon: '❄️', category: 'cooling', rated_w: 1500, standby_w: 3, behaviour: 'cycling', active_hours: [[12, 16], [21, 23], [0, 2]], on_minutes: 10, off_minutes: 20, power_factor: 0.92 },
  { id: 'refrigerator', name: 'Refrigerator', icon: '🧊', category: 'cooling', rated_w: 160, standby_w: 2, controllable: false, behaviour: 'cycling', active_hours: [[0, 23]], on_minutes: 16, off_minutes: 24, power_factor: 0.85 },
  { id: 'geyser', name: 'Water Heater', icon: '🚿', category: 'heating', rated_w: 2000, behaviour: 'scheduled', active_hours: [[6, 8], [18, 20]], on_minutes: 12, off_minutes: 120, power_factor: 1.0 },
  { id: 'tv', name: 'TV', icon: '📺', category: 'entertainment', rated_w: 110, standby_w: 6, behaviour: 'occupancy', active_hours: [[7, 9], [19, 23]], on_probability: 0.7, power_factor: 0.95 },
  { id: 'fan', name: 'Fan', icon: '🌀', category: 'cooling', rated_w: 75, behaviour: 'occupancy', active_hours: [[10, 23]], on_probability: 0.6, power_factor: 0.9 },
  { id: 'lights', name: 'Lights', icon: '💡', category: 'lighting', rated_w: 140, behaviour: 'occupancy', active_hours: [[6, 8], [18, 23]], on_probability: 0.85, variability: 0.15, power_factor: 0.98 },
  { id: 'washing_machine', name: 'Washing Machine', icon: '🧺', category: 'laundry', rated_w: 500, standby_w: 2, behaviour: 'burst', active_hours: [[8, 11], [16, 18]], runs_per_day: 1.2, run_minutes: 40, power_factor: 0.88 },
  { id: 'microwave', name: 'Microwave', icon: '🍲', category: 'kitchen', rated_w: 1200, standby_w: 3, behaviour: 'burst', active_hours: [[7, 9], [12, 14], [19, 21]], runs_per_day: 4, run_minutes: 4, power_factor: 0.95 },
  { id: 'router', name: 'Router & ONT', icon: '📶', category: 'network', rated_w: 18, controllable: false, behaviour: 'always_on', power_factor: 0.7 },
]

/** Appliance specs for one home: `scale` resizes loads, `omit` drops appliances. */
export function specsFor(scale = 1, omit = []) {
  return HOUSE
    .filter((s) => !omit.includes(s.id))
    .map((s) => {
      const spec = { ...DEFAULTS, ...s }
      if (spec.behaviour !== 'always_on') spec.rated_w = Math.round(spec.rated_w * scale)
      return spec
    })
}

class ApplianceState {
  constructor(spec, rng) {
    this.spec = spec
    this.rng = rng
    this.on = false
    this.enabled = true
    this.timer = 0
    this.noise = 1
    this.energyWh = 0
  }

  inActiveHours(hour) {
    return this.spec.active_hours.some(([lo, hi]) => (lo <= hi ? hour >= lo && hour <= hi : hour >= lo || hour <= hi))
  }

  switchTo(on, minutes) {
    this.on = on
    this.timer = Math.max(1, minutes * 60 * this.rng.uniform(0.7, 1.3))
    if (on) this.noise = 1 + this.rng.uniform(-1, 1) * this.spec.variability
  }

  tick(dt, hour) {
    const s = this.spec
    if (!this.enabled) {
      this.on = false
      return
    }
    const active = this.inActiveHours(hour)
    this.timer -= dt
    switch (s.behaviour) {
      case 'always_on':
        this.on = true
        return
      case 'cycling':
      case 'scheduled':
        if (!active) {
          this.on = false
          this.timer = 0
          return
        }
        if (this.timer <= 0) this.switchTo(!this.on, this.on ? s.off_minutes : s.on_minutes)
        return
      case 'occupancy':
        if (!active) {
          this.on = false
          this.timer = 0
          return
        }
        if (this.timer <= 0) this.switchTo(this.rng.random() < s.on_probability, this.rng.uniform(8, 35))
        return
      case 'burst': {
        if (this.on) {
          if (this.timer <= 0) {
            this.on = false
            this.timer = 0
          }
          return
        }
        if (!active) return
        const span = s.active_hours.reduce((n, [lo, hi]) => n + (lo <= hi ? hi - lo + 1 : 24 - lo + hi + 1), 0)
        const p = s.runs_per_day / Math.max(1, (span * 3600) / dt)
        if (this.rng.random() < p) this.switchTo(true, s.run_minutes)
        return
      }
      default:
    }
  }

  power() {
    const s = this.spec
    if (!this.enabled) return 0
    if (!this.on) return s.standby_w
    // small ripple: the firmware reports an RMS average, which suppresses noise
    return Math.max(0, s.rated_w * this.noise * (1 + this.rng.uniform(-0.005, 0.005)))
  }
}

export class HouseSimulator {
  constructor(deviceId, specs, seed) {
    this.deviceId = deviceId
    this.rng = makeRng(seed)
    this.states = new Map(specs.map((s) => [s.id, new ApplianceState(s, this.rng)]))
    this.energyWhTotal = 0
    this.nominalV = 230
    this.sagSeconds = 0
    this.day = null
  }

  setEnabled(id, on) {
    const st = this.states.get(id)
    if (!st) return false
    st.enabled = on
    if (!on) {
      st.on = false
      st.timer = 0
    }
    return true
  }

  voltage(tsMs, dt) {
    if (this.sagSeconds > 0) {
      this.sagSeconds -= dt
      return this.nominalV * this.rng.uniform(0.8, 0.87)
    }
    if (this.rng.random() < 0.0015 * dt) this.sagSeconds = this.rng.int(3, 10)
    return this.nominalV + 4 * Math.sin(tsMs / 600000) + this.rng.gauss(0, 1.2)
  }

  tick(tsMs, dt) {
    const d = new Date(tsMs)
    const day = d.toDateString()
    if (day !== this.day) {
      this.day = day
      for (const st of this.states.values()) st.energyWh = 0
    }
    const truth = {}
    let total = 0
    let weightedPf = 0
    for (const [id, st] of this.states) {
      st.tick(dt, d.getHours())
      const p = st.power()
      st.energyWh += (p * dt) / 3600
      truth[id] = p
      total += p
      weightedPf += p * st.spec.power_factor
    }
    const pf = total > 0 ? weightedPf / total : 1
    const voltage = this.voltage(tsMs, dt)
    const current = voltage > 0 && pf > 0 ? total / (voltage * pf) : 0
    this.energyWhTotal += (total * dt) / 3600
    return {
      device_id: this.deviceId,
      ts_ms: tsMs,
      voltage_V: voltage,
      current_A: current,
      power_W: total,
      pf,
      energyWh_total: this.energyWhTotal,
      truth,
    }
  }
}
