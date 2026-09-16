// Port of backend/app/analytics/anomaly.py: threshold rules plus a robust
// (median / MAD) z-score for spikes that are unusual for this house.
import { g, median, r1, r2, r3 } from './util.js'

export class AnomalyDetector {
  constructor(size = 300) {
    this.size = size
    this.window = []
    this.standbyRun = 0
  }

  static robustZ(value, samples) {
    if (samples.length < 30) return 0
    const med = median(samples)
    const mad = median(samples.map((s) => Math.abs(s - med)))
    if (mad < 1e-6) return 0
    return (value - med) / (1.4826 * mad)
  }

  /** `withSpike` lets the history replay skip the costly statistical check. */
  check(powerW, voltageV, todayKwh, cfg, allOff, withSpike = true) {
    const out = []
    const pMax = Number(cfg.threshold_power_w ?? 2000)
    const vLo = Number(cfg.threshold_voltage_low ?? 200)
    const vHi = Number(cfg.threshold_voltage_high ?? 250)
    const kwhMax = Number(cfg.threshold_daily_kwh ?? 12)
    const zMax = Number(cfg.anomaly_z ?? 3)
    const standby = Number(cfg.standby_waste_w ?? 60)

    if (powerW > pMax) {
      out.push({
        type: 'overload', severity: 'critical', title: 'Overload detected',
        message: `Load is ${powerW.toFixed(0)} W, above the ${pMax.toFixed(0)} W limit. Switch off a high-draw appliance.`,
        value: r1(powerW), threshold: pMax,
      })
    }
    if (voltageV < vLo) {
      out.push({
        type: 'undervoltage', severity: 'warning', title: 'Low supply voltage',
        message: `Supply dropped to ${voltageV.toFixed(1)} V (limit ${g(vLo)} V). Motors and compressors can overheat at low voltage.`,
        value: r1(voltageV), threshold: vLo,
      })
    } else if (voltageV > vHi) {
      out.push({
        type: 'overvoltage', severity: 'warning', title: 'High supply voltage',
        message: `Supply rose to ${voltageV.toFixed(1)} V (limit ${g(vHi)} V).`,
        value: r1(voltageV), threshold: vHi,
      })
    }
    if (todayKwh > kwhMax) {
      out.push({
        type: 'daily_budget', severity: 'warning', title: 'Daily budget exceeded',
        message: `${todayKwh.toFixed(2)} kWh used today, over your ${kwhMax.toFixed(1)} kWh budget.`,
        value: r3(todayKwh), threshold: kwhMax,
      })
    }
    if (withSpike) {
      const z = AnomalyDetector.robustZ(powerW, this.window)
      if (z > zMax) {
        out.push({
          type: 'spike', severity: 'warning', title: 'Unusual consumption spike',
          message: `${powerW.toFixed(0)} W is well outside the normal range for this period (z=${z.toFixed(1)}). Check for an appliance left running.`,
          value: r1(powerW), threshold: r2(zMax),
        })
      }
    }
    if (allOff && powerW > standby) {
      this.standbyRun += 1
      if (this.standbyRun === 60) {
        out.push({
          type: 'standby_waste', severity: 'info', title: 'Phantom load',
          message: `${powerW.toFixed(0)} W is still being drawn with everything switched off. Unplug idle chargers and set-top boxes.`,
          value: r1(powerW), threshold: standby,
        })
      }
    } else {
      this.standbyRun = 0
    }

    this.window.push(powerW)
    if (this.window.length > this.size) this.window.shift()
    return out
  }
}
