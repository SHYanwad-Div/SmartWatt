"""Synthetic household energy simulator.

Produces a realistic aggregate load curve from individual appliance state
machines, so the dashboard runs end-to-end with no hardware attached. The
per-appliance truth is kept alongside the aggregate: the disaggregation engine
only ever sees the aggregate signal, and the truth is used to score it.

Behaviour models
----------------
cycling    compressor-style duty cycle (fridge, AC) gated by active hours
scheduled  runs inside fixed windows (water heater)
occupancy  probabilistic on/off driven by an hourly presence profile (TV, fan)
burst      short random runs a few times a day (microwave, washing machine)
always_on  constant parasitic draw (router, ONT)
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class ApplianceSpec:
    id: str
    name: str
    icon: str
    category: str
    rated_w: float
    standby_w: float = 0.0
    controllable: bool = True
    behaviour: str = "occupancy"
    # hours of day the appliance may run (inclusive ranges)
    active_hours: list[tuple[int, int]] = field(default_factory=lambda: [(0, 23)])
    # cycling: minutes on / minutes off
    on_minutes: float = 15.0
    off_minutes: float = 25.0
    # occupancy: probability of being on during active hours
    on_probability: float = 0.5
    # burst: expected runs per day and run length in minutes
    runs_per_day: float = 2.0
    run_minutes: float = 10.0
    # fraction of rated power that varies run to run
    variability: float = 0.06
    power_factor: float = 0.98


HOUSE: list[ApplianceSpec] = [
    ApplianceSpec(
        id="ac", name="AC", icon="❄️", category="cooling", rated_w=1500,
        standby_w=3, behaviour="cycling", active_hours=[(12, 16), (21, 23), (0, 2)],
        on_minutes=10, off_minutes=20, power_factor=0.92,
    ),
    ApplianceSpec(
        id="refrigerator", name="Refrigerator", icon="🧊", category="cooling",
        rated_w=160, standby_w=2, controllable=False, behaviour="cycling",
        active_hours=[(0, 23)], on_minutes=16, off_minutes=24, power_factor=0.85,
    ),
    ApplianceSpec(
        id="geyser", name="Water Heater", icon="🚿", category="heating",
        rated_w=2000, behaviour="scheduled", active_hours=[(6, 8), (18, 20)],
        on_minutes=12, off_minutes=120, power_factor=1.0,
    ),
    ApplianceSpec(
        id="tv", name="TV", icon="📺", category="entertainment", rated_w=110,
        standby_w=6, behaviour="occupancy", active_hours=[(7, 9), (19, 23)],
        on_probability=0.7, power_factor=0.95,
    ),
    ApplianceSpec(
        id="fan", name="Fan", icon="🌀", category="cooling", rated_w=75,
        behaviour="occupancy", active_hours=[(10, 23)], on_probability=0.6,
        power_factor=0.9,
    ),
    ApplianceSpec(
        id="lights", name="Lights", icon="💡", category="lighting", rated_w=140,
        behaviour="occupancy", active_hours=[(6, 8), (18, 23)],
        on_probability=0.85, variability=0.15, power_factor=0.98,
    ),
    ApplianceSpec(
        id="washing_machine", name="Washing Machine", icon="🧺", category="laundry",
        rated_w=500, standby_w=2, behaviour="burst", active_hours=[(8, 11), (16, 18)],
        runs_per_day=1.2, run_minutes=40, power_factor=0.88,
    ),
    ApplianceSpec(
        id="microwave", name="Microwave", icon="🍲", category="kitchen", rated_w=1200,
        standby_w=3, behaviour="burst", active_hours=[(7, 9), (12, 14), (19, 21)],
        runs_per_day=4, run_minutes=4, power_factor=0.95,
    ),
    ApplianceSpec(
        id="router", name="Router & ONT", icon="📶", category="network", rated_w=18,
        controllable=False, behaviour="always_on", power_factor=0.7,
    ),
]


class _ApplianceState:
    def __init__(self, spec: ApplianceSpec, rng: random.Random) -> None:
        self.spec = spec
        self.rng = rng
        self.on = False
        self.enabled = True          # user override; False = forced off
        self.timer_s = 0.0           # seconds remaining in current phase
        self.run_noise = 1.0
        self.energy_wh = 0.0         # accumulated today
        self._last_burst_hour = -1

    # -- helpers ---------------------------------------------------------
    def in_active_hours(self, hour: int) -> bool:
        for lo, hi in self.spec.active_hours:
            if lo <= hi:
                if lo <= hour <= hi:
                    return True
            else:  # wraps midnight, e.g. (22, 2)
                if hour >= lo or hour <= hi:
                    return True
        return False

    def _switch(self, on: bool, minutes: float) -> None:
        self.on = on
        self.timer_s = max(1.0, minutes * 60.0 * self.rng.uniform(0.7, 1.3))
        if on:
            self.run_noise = 1.0 + self.rng.uniform(-1, 1) * self.spec.variability

    # -- state machine ---------------------------------------------------
    def tick(self, dt_s: float, now: datetime) -> None:
        spec = self.spec
        if not self.enabled:
            self.on = False
            return

        active = self.in_active_hours(now.hour)
        self.timer_s -= dt_s

        if spec.behaviour == "always_on":
            self.on = True
            return

        if spec.behaviour in ("cycling", "scheduled"):
            if not active:
                self.on = False
                self.timer_s = 0.0
                return
            if self.timer_s <= 0:
                self._switch(not self.on, spec.off_minutes if self.on else spec.on_minutes)
            return

        if spec.behaviour == "occupancy":
            if not active:
                self.on = False
                self.timer_s = 0.0
                return
            if self.timer_s <= 0:
                want_on = self.rng.random() < spec.on_probability
                # dwell for a few minutes so the trace is not jittery
                self._switch(want_on, self.rng.uniform(8, 35))
            return

        if spec.behaviour == "burst":
            if self.on:
                if self.timer_s <= 0:
                    self.on = False
                    self.timer_s = 0.0
                return
            if not active:
                return
            # probability of starting a run within this tick
            active_span_h = sum(
                (hi - lo + 1) if lo <= hi else (24 - lo + hi + 1)
                for lo, hi in spec.active_hours
            )
            p = spec.runs_per_day / max(1.0, active_span_h * 3600.0 / dt_s)
            if self.rng.random() < p:
                self._switch(True, spec.run_minutes)
            return

    def power_w(self) -> float:
        spec = self.spec
        if not self.enabled:
            return 0.0
        if not self.on:
            return spec.standby_w
        base = spec.rated_w * self.run_noise
        # Sample-to-sample ripple. Kept small because the firmware reports an
        # RMS average over 300 ADC samples, which suppresses most noise.
        return max(0.0, base * (1.0 + self.rng.uniform(-0.005, 0.005)))


class HouseSimulator:
    """Ticks every `interval_s` and emits an aggregate reading + truth split."""

    def __init__(self, device_id: str, interval_s: float = 1.0, seed: int | None = None) -> None:
        self.device_id = device_id
        self.interval_s = interval_s
        self.rng = random.Random(seed)
        self.states: dict[str, _ApplianceState] = {
            spec.id: _ApplianceState(spec, self.rng) for spec in HOUSE
        }
        self.energy_wh_total = 0.0
        self.nominal_v = 230.0
        self._sag_ticks = 0
        self._day = datetime.now().date()

    # -- control ---------------------------------------------------------
    def set_enabled(self, appliance_id: str, enabled: bool) -> bool:
        st = self.states.get(appliance_id)
        if st is None:
            return False
        st.enabled = enabled
        if not enabled:
            st.on = False
            st.timer_s = 0.0
        return True

    def is_enabled(self, appliance_id: str) -> bool:
        st = self.states.get(appliance_id)
        return bool(st and st.enabled)

    # -- simulation ------------------------------------------------------
    def _voltage(self) -> float:
        """230 V nominal with slow drift, ripple and the occasional sag."""
        if self._sag_ticks > 0:
            self._sag_ticks -= 1
            return self.nominal_v * self.rng.uniform(0.80, 0.87)
        if self.rng.random() < 0.0015:          # ~1 sag every 11 min at 1 Hz
            self._sag_ticks = self.rng.randint(3, 10)
        drift = 4.0 * math.sin(datetime.now().timestamp() / 600.0)
        return self.nominal_v + drift + self.rng.gauss(0, 1.2)

    def tick(self, now: datetime | None = None) -> dict:
        now = now or datetime.now()
        if now.date() != self._day:
            self._day = now.date()
            for st in self.states.values():
                st.energy_wh = 0.0

        dt_s = self.interval_s
        truth: dict[str, float] = {}
        total_w = 0.0
        weighted_pf = 0.0

        for aid, st in self.states.items():
            st.tick(dt_s, now)
            p = st.power_w()
            st.energy_wh += p * dt_s / 3600.0
            truth[aid] = p
            total_w += p
            weighted_pf += p * st.spec.power_factor

        pf = (weighted_pf / total_w) if total_w > 0 else 1.0
        voltage = self._voltage()
        current = total_w / (voltage * pf) if voltage > 0 and pf > 0 else 0.0
        self.energy_wh_total += total_w * dt_s / 3600.0

        return {
            "device_id": self.device_id,
            "ts_ms": int(now.timestamp() * 1000),
            "voltage_V": round(voltage, 2),
            "current_A": round(current, 4),
            "power_W": round(total_w, 2),
            "pf": round(pf, 3),
            "energyWh_total": round(self.energy_wh_total, 4),
            "_truth": {k: round(v, 2) for k, v in truth.items()},
            "_truth_energy_wh": {k: round(st.energy_wh, 4) for k, st in self.states.items()},
        }

    def specs(self) -> list[ApplianceSpec]:
        return [st.spec for st in self.states.values()]
