"""Abnormal-condition detection.

Two layers, as described in the report's alert mechanism:

1. Threshold rules   - overload, under/over voltage, daily budget. Deterministic,
                       instant, and what a user can reason about.
2. Statistical       - robust z-score (median / MAD) over a rolling window,
                       catching spikes that are unusual *for this house* even
                       when they sit under the absolute threshold.
"""
from __future__ import annotations

import statistics
from collections import deque
from dataclasses import dataclass


@dataclass
class Anomaly:
    type: str
    severity: str          # info | warning | critical
    title: str
    message: str
    value: float
    threshold: float


class AnomalyDetector:
    def __init__(self, window: int = 300) -> None:
        self.window: deque[float] = deque(maxlen=window)
        self._standby_run = 0

    # -------------------------------------------------------------- helpers
    @staticmethod
    def _robust_z(value: float, samples: list[float]) -> float:
        """Median/MAD z-score. Robust to the very spikes we are looking for."""
        if len(samples) < 30:
            return 0.0
        med = statistics.median(samples)
        mad = statistics.median([abs(s - med) for s in samples])
        if mad < 1e-6:
            return 0.0
        # 1.4826 makes MAD a consistent estimator of sigma for normal data
        return (value - med) / (1.4826 * mad)

    # ---------------------------------------------------------------- check
    def check(
        self,
        power_w: float,
        voltage_v: float,
        today_kwh: float,
        cfg: dict,
        all_appliances_off: bool = False,
    ) -> list[Anomaly]:
        out: list[Anomaly] = []

        p_max = float(cfg.get("threshold_power_w", 2000))
        v_lo = float(cfg.get("threshold_voltage_low", 200))
        v_hi = float(cfg.get("threshold_voltage_high", 250))
        kwh_max = float(cfg.get("threshold_daily_kwh", 12))
        z_max = float(cfg.get("anomaly_z", 3.0))
        standby_w = float(cfg.get("standby_waste_w", 60))

        # 1. overload
        if power_w > p_max:
            out.append(Anomaly(
                type="overload", severity="critical",
                title="Overload detected",
                message=f"Load is {power_w:.0f} W, above the {p_max:.0f} W limit. "
                        "Switch off a high-draw appliance.",
                value=round(power_w, 1), threshold=p_max,
            ))

        # 2. voltage excursions
        if voltage_v < v_lo:
            out.append(Anomaly(
                type="undervoltage", severity="warning",
                title="Low supply voltage",
                message=f"Supply dropped to {voltage_v:.1f} V (limit {v_lo:g} V). "
                        "Motors and compressors can overheat at low voltage.",
                value=round(voltage_v, 1), threshold=v_lo,
            ))
        elif voltage_v > v_hi:
            out.append(Anomaly(
                type="overvoltage", severity="warning",
                title="High supply voltage",
                message=f"Supply rose to {voltage_v:.1f} V (limit {v_hi:g} V).",
                value=round(voltage_v, 1), threshold=v_hi,
            ))

        # 3. daily budget
        if today_kwh > kwh_max:
            out.append(Anomaly(
                type="daily_budget", severity="warning",
                title="Daily budget exceeded",
                message=f"{today_kwh:.2f} kWh used today, over your {kwh_max:.1f} kWh budget.",
                value=round(today_kwh, 3), threshold=kwh_max,
            ))

        # 4. statistical spike, relative to this house's own recent behaviour
        z = self._robust_z(power_w, list(self.window))
        if z > z_max:
            out.append(Anomaly(
                type="spike", severity="warning",
                title="Unusual consumption spike",
                message=f"{power_w:.0f} W is well outside the normal range for this "
                        f"period (z={z:.1f}). Check for an appliance left running.",
                value=round(power_w, 1), threshold=round(z_max, 2),
            ))

        # 5. standby / phantom load: everything "off" yet still drawing
        if all_appliances_off and power_w > standby_w:
            self._standby_run += 1
            if self._standby_run == 60:      # sustained, not a switching transient
                out.append(Anomaly(
                    type="standby_waste", severity="info",
                    title="Phantom load",
                    message=f"{power_w:.0f} W is still being drawn with everything "
                            "switched off. Unplug idle chargers and set-top boxes.",
                    value=round(power_w, 1), threshold=standby_w,
                ))
        else:
            self._standby_run = 0

        self.window.append(power_w)
        return out
