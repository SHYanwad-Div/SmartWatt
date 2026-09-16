// Port of backend/app/analytics/events.py and disaggregation.py: step
// detection on the total signal, then attribution of each step to an appliance.
// Tuning constants and their measured rationale are documented in the Python.
import { median, r2, r4 } from './util.js'

export const OTHER_ID = 'other'
const RECONCILE_EVERY_S = 20
const RECONCILE_TOLERANCE = 0.15
const COLD_START_SHARE = 0.25
const PARKED_EDGE_WINDOW_MS = 20000

export class EdgeDetector {
  constructor({ thresholdW = 30, sustain = 3, window = 5 } = {}) {
    this.thresholdW = thresholdW
    this.sustain = sustain
    this.window = window
    this.baseline = []
    this.pending = null
    this.count = 0
    this.pendingTs = 0
  }

  push(ts, powerW) {
    if (!this.baseline.length) {
      this.baseline.push(powerW)
      return null
    }
    const base = this.baseline.reduce((a, b) => a + b, 0) / this.baseline.length
    if (Math.abs(powerW - base) >= this.thresholdW) {
      if (this.pending === null) {
        this.pending = base
        this.count = 1
        this.pendingTs = ts
      } else {
        this.count += 1
      }
      if (this.count >= this.sustain) {
        const edge = {
          ts: this.pendingTs,
          delta_w: r2(powerW - this.pending),
          direction: powerW > this.pending ? 'ON' : 'OFF',
          power_now: r2(powerW),
        }
        this.baseline = [powerW]
        this.pending = null
        this.count = 0
        return edge
      }
      return null
    }
    this.pending = null
    this.count = 0
    this.baseline.push(powerW)
    if (this.baseline.length > this.window) this.baseline.shift()
    return null
  }
}

function freshState(sig) {
  const st = { on: false, power_w: 0, since_ts: 0, energy_wh: 0, confidence: 0, parked_at_ms: 0, parked_power_w: 0 }
  if (sig.behaviour === 'always_on') {
    st.on = true
    st.power_w = sig.rated_w
    st.confidence = 1
  } else {
    st.power_w = sig.standby_w
  }
  return st
}

export class Disaggregator {
  constructor(signatures) {
    this.signatures = new Map(signatures.map((s) => [s.id, { tolerance: 0.25, ...s }]))
    this.states = new Map(signatures.map((s) => [s.id, freshState(s)]))
    this.other = { on: true, power_w: 0, energy_wh: 0, confidence: 1 }
    this.disabled = new Map()
    this.residuals = []
    this.sinceReconcile = 0
    this.pendingFix = null
    this.lastMatchIds = []
  }

  nameOf(id) {
    const sig = this.signatures.get(id) || this.disabled.get(id)?.sig
    return sig ? sig.name : null
  }

  /** Relay control: a switched-off appliance draws nothing and cannot be matched. */
  setEnabled(id, enabled, nowMs) {
    if (!enabled) {
      if (!this.signatures.has(id)) return
      const sig = this.signatures.get(id)
      const st = this.states.get(id)
      this.signatures.delete(id)
      this.states.delete(id)
      if (st.on && st.power_w > sig.standby_w) {
        st.parked_power_w = st.power_w
        st.parked_at_ms = nowMs
      }
      st.on = false
      st.power_w = 0
      st.confidence = 1
      this.disabled.set(id, { sig, st })
    } else if (this.disabled.has(id)) {
      const { sig, st } = this.disabled.get(id)
      this.disabled.delete(id)
      const fresh = freshState(sig)
      Object.assign(st, { on: fresh.on, power_w: fresh.power_w, confidence: fresh.confidence, parked_at_ms: 0, parked_power_w: 0 })
      this.signatures.set(id, sig)
      this.states.set(id, st)
    }
  }

  matchParked(magnitude, nowMs) {
    let bestId = null
    let bestScore = Infinity
    for (const [id, { st }] of this.disabled) {
      if (st.parked_power_w <= 0 || nowMs - st.parked_at_ms > PARKED_EDGE_WINDOW_MS) continue
      const score = Math.abs(magnitude - st.parked_power_w) / st.parked_power_w
      if (score < bestScore) {
        bestScore = score
        bestId = id
      }
    }
    if (bestId === null) return [null, 0]
    const { sig, st } = this.disabled.get(bestId)
    if (bestScore > sig.tolerance) return [null, 0]
    st.parked_power_w = 0
    return [bestId, Math.round(Math.max(0, 1 - bestScore / sig.tolerance) * 1000) / 1000]
  }

  matchEdge(deltaW, ts) {
    const magnitude = Math.abs(deltaW)
    const turningOn = deltaW > 0
    this.lastMatchIds = []

    if (!turningOn) {
      const [parked, conf] = this.matchParked(magnitude, ts)
      if (parked) {
        this.lastMatchIds = [parked]
        return [parked, conf]
      }
    }

    let bestId = null
    let bestScore = Infinity
    for (const [id, sig] of this.signatures) {
      const st = this.states.get(id)
      if (sig.behaviour === 'always_on') continue
      if (turningOn && st.on) continue
      if (!turningOn && !st.on) continue
      const expected = turningOn ? sig.rated_w : Math.max(st.power_w, sig.rated_w * 0.5)
      if (expected <= 0) continue
      const score = Math.abs(magnitude - expected) / expected
      if (score < bestScore) {
        bestScore = score
        bestId = id
      }
    }

    let relaxed = false
    if (bestId === null || bestScore > this.signatures.get(bestId).tolerance) {
      // stale belief (a missed ON edge): retry ignoring the on/off constraint
      bestId = null
      bestScore = Infinity
      for (const [id, sig] of this.signatures) {
        if (sig.behaviour === 'always_on' || sig.rated_w <= 0) continue
        const score = Math.abs(magnitude - sig.rated_w) / sig.rated_w
        if (score < bestScore) {
          bestScore = score
          bestId = id
        }
      }
      if (bestId === null || bestScore > this.signatures.get(bestId).tolerance) return [null, 0]
      relaxed = true
    }

    const sig = this.signatures.get(bestId)
    const st = this.states.get(bestId)
    let confidence = Math.max(0, 1 - bestScore / sig.tolerance)
    if (relaxed) confidence *= 0.6
    confidence = Math.round(confidence * 1000) / 1000
    if (turningOn) {
      st.on = true
      st.power_w = magnitude
      st.since_ts = ts
    } else {
      st.on = false
      st.power_w = sig.standby_w
    }
    st.confidence = confidence
    this.lastMatchIds = [bestId]
    return [bestId, confidence]
  }

  reconcile() {
    if (this.residuals.length < 8) return
    const med = median(this.residuals)
    let candidate = null
    let candidateScore = 1

    if (med > 25) {
      let bestId = null
      let best = Infinity
      for (const [id, sig] of this.signatures) {
        if (this.states.get(id).on || sig.behaviour === 'always_on') continue
        const score = Math.abs(med - sig.rated_w) / sig.rated_w
        if (score < best) {
          best = score
          bestId = id
        }
      }
      if (bestId !== null && best <= RECONCILE_TOLERANCE) {
        candidate = `on:${bestId}`
        candidateScore = best
      }
    } else if (med < -25) {
      const excess = -med
      let bestId = null
      let best = Infinity
      for (const [id, sig] of this.signatures) {
        const st = this.states.get(id)
        if (!st.on || sig.behaviour === 'always_on' || st.power_w <= 0) continue
        const score = Math.abs(excess - st.power_w) / st.power_w
        if (score < best) {
          best = score
          bestId = id
        }
      }
      if (bestId !== null && best <= RECONCILE_TOLERANCE) {
        candidate = `off:${bestId}`
        candidateScore = best
      }
    }

    if (candidate !== null && candidate === this.pendingFix) {
      const [action, id] = candidate.split(':')
      const st = this.states.get(id)
      const sig = this.signatures.get(id)
      if (action === 'on') {
        st.on = true
        st.power_w = Math.min(Math.abs(med), sig.rated_w * 1.2)
      } else {
        st.on = false
        st.power_w = sig.standby_w
      }
      st.confidence = Math.round(0.5 * Math.max(0, 1 - candidateScore) * 1000) / 1000
      this.residuals = []
      this.pendingFix = null
    } else {
      this.pendingFix = candidate
    }
  }

  attribute(totalW, dt) {
    const unattributedShare = this.other.power_w / Math.max(totalW, 1)
    if (unattributedShare > COLD_START_SHARE) {
      let assignedNow = 0
      for (const st of this.states.values()) assignedNow += st.power_w
      this.residuals.push(totalW - assignedNow)
      if (this.residuals.length > 64) this.residuals.shift()
      this.sinceReconcile += dt
      if (this.sinceReconcile >= RECONCILE_EVERY_S) {
        this.sinceReconcile = 0
        this.reconcile()
      }
    }

    let assigned = 0
    for (const [id, st] of this.states) {
      const sig = this.signatures.get(id)
      if (st.on && sig.behaviour === 'always_on') st.power_w = sig.rated_w
      assigned += st.power_w
    }
    let residual = totalW - assigned
    if (residual < 0) {
      const switched = [...this.states].filter(([id, st]) => st.on && this.signatures.get(id).behaviour !== 'always_on')
      const switchedTotal = switched.reduce((n, [, st]) => n + st.power_w, 0)
      if (switchedTotal > 0) {
        const scale = Math.max(0, 1 + residual / switchedTotal)
        for (const [, st] of switched) st.power_w *= scale
      }
      let now = 0
      for (const st of this.states.values()) now += st.power_w
      residual = Math.max(0, totalW - now)
    }
    this.other.power_w = Math.max(0, residual)

    const out = {}
    for (const [id, st] of this.states) {
      st.energy_wh += (st.power_w * dt) / 3600
      const sig = this.signatures.get(id)
      out[id] = {
        id, name: sig.name, icon: sig.icon, power_w: r2(st.power_w), state: st.on,
        energy_wh: r4(st.energy_wh), confidence: st.confidence, since_ts: st.on ? st.since_ts : 0,
      }
    }
    for (const [id, { sig, st }] of this.disabled) {
      out[id] = { id, name: sig.name, icon: sig.icon, power_w: 0, state: false, energy_wh: r4(st.energy_wh), confidence: 1, since_ts: 0 }
    }
    this.other.energy_wh += (this.other.power_w * dt) / 3600
    out[OTHER_ID] = {
      id: OTHER_ID, name: 'Other / Unmetered', icon: '❓', power_w: r2(this.other.power_w),
      state: this.other.power_w > 1, energy_wh: r4(this.other.energy_wh), confidence: 1, since_ts: 0,
    }
    return out
  }

  resetDailyEnergy() {
    for (const st of this.states.values()) st.energy_wh = 0
    for (const { st } of this.disabled.values()) st.energy_wh = 0
    this.other.energy_wh = 0
  }
}

/** NILM accuracy 1 - sum|est - true| / (2 * sum true), against simulator truth. */
export function scoreEstimate(estimate, truth) {
  let totalTrue = 0
  let absErr = 0
  const per = {}
  for (const [id, t] of Object.entries(truth)) {
    const e = estimate[id]?.power_w ?? 0
    per[id] = r2(e - t)
    absErr += Math.abs(e - t)
    totalTrue += t
  }
  const accuracy = totalTrue > 0 ? 1 - absErr / (2 * totalTrue) : 1
  return { accuracy: r4(Math.max(0, Math.min(1, accuracy))), abs_error_w: r2(absErr), per_appliance_error_w: per }
}
