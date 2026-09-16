"""The single path every reading takes, whatever produced it.

    simulator ─┐
               ├─> validate ─> calibrate ─> integrate (raw) ─> persist
    MQTT/ESP32 ┘                  │
                                  ├─> edge detect + attribute (raw)
                                  ├─> moving average ─> charts, alerts
                                  └─> WebSocket broadcast

Keeping the simulator and the hardware on one path is what makes the dashboard
identical in both modes: nothing downstream knows which source it is reading.
"""
from __future__ import annotations

import logging
import math
import re
import threading
import time
from collections import deque
from datetime import datetime

from .. import alerts, control, db
from ..analytics.anomaly import AnomalyDetector
from ..analytics.disaggregation import OTHER_ID, Disaggregator, Signature
from ..analytics.events import EdgeDetector
from ..config import SIM_DEVICE_ID, settings
from ..hub import hub
from .simulator import HOUSE, HouseSimulator

log = logging.getLogger("smartwatt.pipeline")

# Rolling window kept in memory for charts and the forecaster (~2 h at 1 Hz).
LIVE_WINDOW = 7200
# Persist a reading (and appliance split) at most this often, to keep the DB small.
PERSIST_EVERY_S = 5.0
# Anything below this is not an epoch timestamp but ESP32 millis() since boot.
EPOCH_MS_FLOOR = 1_000_000_000_000
# New devices self-register on first reading; cap that so a misbehaving
# publisher cannot fill the database with device ids.
MAX_DEVICES = 50
DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
# Accuracy for a single instant swings wildly around a merged switching step, so
# a rolling mean over this window is reported alongside the instant value.
ACCURACY_WINDOW_MS = 30 * 60 * 1000


class ReadingError(ValueError):
    """A reading that is malformed or physically impossible."""


def _number(raw: dict, key: str, lo: float, hi: float, default: float | None,
            noise_floor: float = 0.0) -> float | None:
    value = raw.get(key, default)
    if value is None:
        return None
    if isinstance(value, bool):
        raise ReadingError(f"{key} must be a number")
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise ReadingError(f"{key} must be a number") from None
    if not math.isfinite(value):
        raise ReadingError(f"{key} must be finite")
    # Sensors report tiny negatives around zero; that is noise, not data.
    if -noise_floor <= value < 0:
        value = 0.0
    if not lo <= value <= hi:
        raise ReadingError(f"{key}={value:g} is outside {lo:g}..{hi:g}")
    return value


def validate_reading(raw: dict) -> dict:
    device_id = raw.get("device_id")
    if not isinstance(device_id, str) or not DEVICE_ID_RE.match(device_id):
        raise ReadingError("device_id must be 1-64 letters, digits or _ - . :")
    ts = raw.get("ts_ms")
    if ts is not None:
        if isinstance(ts, bool) or not isinstance(ts, (int, float)) or ts < 0:
            raise ReadingError("ts_ms must be a non-negative integer")
        ts = int(ts)
    return {
        "device_id": device_id,
        "ts_ms": ts,
        "voltage_V": _number(raw, "voltage_V", 0, 500, 0.0, noise_floor=1.0),
        "current_A": _number(raw, "current_A", 0, 200, 0.0, noise_floor=0.5),
        "power_W": _number(raw, "power_W", 0, 100_000, None, noise_floor=5.0),
        "pf": _number(raw, "pf", 0, 1, 1.0),
        "energyWh_total": _number(raw, "energyWh_total", 0, 1e12, 0.0),
    }


class DeviceRuntime:
    """Per-device live state: filters, detectors and the recent history."""

    def __init__(self, device_id: str, source: str) -> None:
        self.device_id = device_id
        self.source = source
        self.lock = threading.RLock()

        self.history: deque[tuple[int, float]] = deque(maxlen=LIVE_WINDOW)
        self.last: dict | None = None
        self.last_ts: int = 0
        self.last_device_ms: int | None = None
        self.filter_buf: deque[float] = deque(maxlen=5)

        self.energy_wh_today = 0.0
        self.energy_wh_session = 0.0
        self.peak_w_today = 0.0
        self.day = datetime.now().strftime("%Y-%m-%d")
        self._resume_today()

        self.edge = EdgeDetector(threshold_w=30.0, sustain_samples=3)
        self.anomaly = AnomalyDetector()
        self.disagg = Disaggregator(self._signatures())
        for row in db.query(
            "SELECT id FROM appliances WHERE device_id=? AND enabled=0", (device_id,)
        ):
            self.disagg.set_enabled(row["id"], False)
        self._resume_appliance_energy()
        self.appliance_state: dict[str, dict] = {}
        self.disagg_score: dict = {}
        self.accuracy_window: deque[tuple[int, float]] = deque()

        self._last_persist = 0.0
        self._sim: HouseSimulator | None = None

    def _resume_today(self) -> None:
        """Carry today's energy across a restart instead of resetting to zero."""
        row = db.query_one(
            "SELECT kwh, peak_w FROM daily_energy WHERE device_id=? AND day=?",
            (self.device_id, self.day),
        )
        if row:
            self.energy_wh_today = row["kwh"] * 1000.0
            self.peak_w_today = row["peak_w"]

    def _resume_appliance_energy(self) -> None:
        """Restore each appliance's energy so far today.

        The house total is restored from daily_energy; without this the
        per-appliance figures restarted at zero, so after a restart the breakdown
        showed a few Wh against a house total of hundreds and every share was
        computed over the wrong base.
        """
        start = int(datetime.strptime(self.day, "%Y-%m-%d").timestamp() * 1000)
        rows = db.query(
            "SELECT s.appliance_id, s.energy_wh FROM appliance_samples s "
            "JOIN (SELECT appliance_id, MAX(ts) AS ts FROM appliance_samples "
            "      WHERE device_id=? AND ts>=? GROUP BY appliance_id) latest "
            "  ON s.appliance_id = latest.appliance_id AND s.ts = latest.ts "
            "WHERE s.device_id=?",
            (self.device_id, start, self.device_id),
        )
        for row in rows:
            self.disagg.restore_energy(row["appliance_id"], row["energy_wh"])

    def _signatures(self) -> list[Signature]:
        rows = db.query("SELECT * FROM appliances WHERE device_id=?", (self.device_id,))
        return [
            Signature(
                id=r["id"], name=r["name"], icon=r["icon"], rated_w=r["rated_w"],
                standby_w=r["standby_w"], behaviour=r["behaviour"],
            )
            for r in rows
        ]

    def refresh_signatures(self) -> None:
        with self.lock:
            self.disagg.set_signatures(self._signatures())

    def _roll_day_if_needed(self, now: datetime) -> None:
        today = now.strftime("%Y-%m-%d")
        if today == self.day:
            return
        db.execute(
            "INSERT INTO daily_energy(device_id, day, kwh, cost, peak_w) VALUES(?,?,?,?,?) "
            "ON CONFLICT(device_id, day) DO UPDATE SET kwh=excluded.kwh, peak_w=excluded.peak_w",
            (self.device_id, self.day, self.energy_wh_today / 1000.0, 0.0, self.peak_w_today),
        )
        self.day = today
        self.energy_wh_today = 0.0
        self.peak_w_today = 0.0
        self.disagg.reset_daily_energy()


def _seed_appliances(device_id: str) -> None:
    """Populate the appliance library for a device if it has none."""
    existing = db.query_one(
        "SELECT COUNT(*) AS n FROM appliances WHERE device_id=?", (device_id,)
    )
    if existing and existing["n"] > 0:
        return
    now = db.now_ms()
    db.execute_many(
        "INSERT INTO appliances(id, device_id, name, icon, category, behaviour, rated_w, "
        "standby_w, controllable, state, enabled, created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,0,1,?)",
        [
            (s.id, device_id, s.name, s.icon, s.category, s.behaviour, s.rated_w,
             s.standby_w, 1 if s.controllable else 0, now)
            for s in HOUSE
        ],
    )
    log.info("seeded %d appliances for %s", len(HOUSE), device_id)


class Pipeline:
    def __init__(self) -> None:
        self.runtimes: dict[str, DeviceRuntime] = {}
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    # ------------------------------------------------------------- devices
    def runtime(self, device_id: str, source: str = "mqtt") -> DeviceRuntime:
        with self._lock:
            rt = self.runtimes.get(device_id)
            if rt is not None:
                return rt
            known = db.query_one("SELECT 1 FROM devices WHERE id=?", (device_id,))
            if known is None:
                count = db.query_one("SELECT COUNT(*) AS n FROM devices")["n"]
                if count >= MAX_DEVICES:
                    raise ReadingError(
                        f"device limit of {MAX_DEVICES} reached; '{device_id}' not registered")
            db.execute(
                "INSERT INTO devices(id, name, location, source, created_at, last_seen) "
                "VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen",
                (device_id, device_id, "", source, db.now_ms(), db.now_ms()),
            )
            _seed_appliances(device_id)
            rt = DeviceRuntime(device_id, source)
            self.runtimes[device_id] = rt
            log.info("registered device %s (source=%s)", device_id, source)
            return rt

    # ------------------------------------------------------------- ingest
    def ingest(self, raw: dict) -> dict:
        """Validate, analyse, store and broadcast one reading.

        Raises ReadingError for malformed or impossible input.
        """
        reading = validate_reading(raw)
        device_id = reading["device_id"]
        rt = self.runtime(device_id, raw.get("_source", "mqtt"))

        with rt.lock:
            now_dt = datetime.now()
            rt._roll_day_if_needed(now_dt)

            # --- timestamps ------------------------------------------------
            # Epoch timestamps are used as-is. ESP32 millis() is re-stamped to
            # arrival time for display, but the elapsed time used for energy
            # comes from the device's own clock: readings delivered in a burst
            # (broker backlog after a reconnect) arrive milliseconds apart yet
            # each still represents its full sampling interval.
            raw_ts = reading["ts_ms"] or 0
            if raw_ts >= EPOCH_MS_FLOOR:
                ts = raw_ts
                dt_s = (ts - rt.last_ts) / 1000.0 if rt.last_ts else 0.0
            else:
                ts = db.now_ms()
                if raw_ts > 0:
                    if rt.last_device_ms is not None and raw_ts >= rt.last_device_ms:
                        dt_s = (raw_ts - rt.last_device_ms) / 1000.0
                    else:
                        dt_s = 0.0          # first sample, or millis() reset by a reboot
                    rt.last_device_ms = raw_ts
                else:
                    dt_s = (ts - rt.last_ts) / 1000.0 if rt.last_ts else 0.0
            dt_s = min(max(dt_s, 0.0), 60.0)   # offline gaps are not billed as load
            rt.last_ts = max(ts, rt.last_ts)

            # --- calibration -----------------------------------------------
            voltage = reading["voltage_V"] * float(db.get_setting("cal_voltage_gain", 1.0))
            current = reading["current_A"] * float(db.get_setting("cal_current_gain", 1.0))
            power = reading["power_W"] if reading["power_W"] is not None else voltage * current
            power *= float(db.get_setting("cal_power_gain", 1.0))
            pf = reading["pf"]

            # --- smoothing for display and alerting only -------------------
            # Detection and energy use the raw signal: a moving average smears a
            # clean step across several samples, which the edge detector then
            # reported as two smaller events matched to the wrong appliances.
            rt.filter_buf.append(power)
            power_display = sum(rt.filter_buf) / len(rt.filter_buf)

            wh = power * dt_s / 3600.0
            rt.energy_wh_today += wh
            rt.energy_wh_session += wh
            rt.peak_w_today = max(rt.peak_w_today, power_display)
            today_kwh = rt.energy_wh_today / 1000.0
            rt.history.append((ts, power_display))

            # --- NILM: edge detection then attribution ---------------------
            event_row = None
            edge = rt.edge.push(ts, power)
            if edge:
                aid, confidence = rt.disagg.match_edge(edge.delta_w, edge.ts)
                # a merged step credits several appliances: label it with all of them
                names = [rt.disagg.name_of(x) for x in rt.disagg.last_match_ids]
                label = " + ".join(n for n in names if n) or None
                event_id = db.execute(
                    "INSERT INTO events(device_id, ts, delta_w, direction, power_now, "
                    "appliance_id, label, confidence) VALUES(?,?,?,?,?,?,?,?)",
                    (device_id, edge.ts, edge.delta_w, edge.direction, edge.power_now,
                     aid, label, confidence),
                )
                event_row = {
                    "id": event_id, "ts": edge.ts, "delta_w": edge.delta_w,
                    "direction": edge.direction, "power_now": edge.power_now,
                    "appliance_id": aid, "label": label, "confidence": confidence,
                }

            appliances = rt.disagg.attribute(power, dt_s)
            rt.appliance_state = appliances
            if "_truth" in raw:
                score = Disaggregator.score(appliances, raw["_truth"])
                rt.accuracy_window.append((ts, score["accuracy"]))
                while rt.accuracy_window and ts - rt.accuracy_window[0][0] > ACCURACY_WINDOW_MS:
                    rt.accuracy_window.popleft()
                score["accuracy_30m"] = round(
                    sum(a for _, a in rt.accuracy_window) / len(rt.accuracy_window), 4)
                rt.disagg_score = score

            # --- alerts and automations ------------------------------------
            # A failure here must never stop the reading itself from flowing.
            try:
                cfg = db.all_settings()
                all_off = all(
                    not a["state"] for aid, a in appliances.items() if aid != OTHER_ID
                )
                for anomaly in rt.anomaly.check(
                    power_display, voltage, today_kwh, cfg, all_appliances_off=all_off
                ):
                    alerts.raise_alert(device_id, anomaly, cfg)
            except Exception:
                log.exception("anomaly/alert stage failed for %s", device_id)
            try:
                control.evaluate_automations(device_id, power_display, today_kwh,
                                             appliances, now_dt)
            except Exception:
                log.exception("automation stage failed for %s", device_id)

            snapshot = {
                "device_id": device_id,
                "ts": ts,
                "voltage_v": round(voltage, 2),
                "current_a": round(current, 4),
                "power_w": round(power_display, 2),
                "power_raw_w": round(power, 2),
                "pf": round(pf, 3),
                "today_kwh": round(today_kwh, 4),
                "peak_w_today": round(rt.peak_w_today, 1),
                "energy_wh_session": round(rt.energy_wh_session, 3),
                "appliances": appliances,
                "disagg_score": rt.disagg_score,
                "source": rt.source,
            }
            rt.last = snapshot

            # --- persistence (throttled) -----------------------------------
            wall = time.time()
            if wall - rt._last_persist >= PERSIST_EVERY_S:
                rt._last_persist = wall
                db.execute(
                    "INSERT INTO readings(device_id, ts, voltage_v, current_a, power_w, pf, "
                    "energy_wh_total) VALUES(?,?,?,?,?,?,?)",
                    (device_id, ts, voltage, current, power_display, pf,
                     reading["energyWh_total"] or rt.energy_wh_session),
                )
                db.execute_many(
                    "INSERT INTO appliance_samples(device_id, appliance_id, ts, power_w, "
                    "energy_wh, estimated) VALUES(?,?,?,?,?,1)",
                    [(device_id, aid, ts, a["power_w"], a["energy_wh"])
                     for aid, a in appliances.items()],
                )
                db.execute_many(
                    "UPDATE appliances SET state=? WHERE device_id=? AND id=?",
                    [(1 if a["state"] else 0, device_id, aid)
                     for aid, a in appliances.items() if aid != OTHER_ID],
                )
                db.execute(
                    "INSERT INTO daily_energy(device_id, day, kwh, cost, peak_w) "
                    "VALUES(?,?,?,0,?) ON CONFLICT(device_id, day) DO UPDATE SET "
                    "kwh=excluded.kwh, peak_w=excluded.peak_w",
                    (device_id, rt.day, today_kwh, rt.peak_w_today),
                )
                db.execute("UPDATE devices SET last_seen=? WHERE id=?", (db.now_ms(), device_id))

            payload = {"type": "reading", "reading": snapshot}
            if event_row:
                payload["event"] = event_row
            hub.broadcast_threadsafe(device_id, payload)
            return snapshot

    # ----------------------------------------------------------- simulator
    def _sim_loop(self) -> None:
        rt = self.runtime(SIM_DEVICE_ID, source="sim")
        sim = HouseSimulator(SIM_DEVICE_ID, interval_s=settings.sim_interval_s, seed=None)
        rt._sim = sim
        # honour control state persisted from a previous run
        for row in db.query(
            "SELECT id, enabled FROM appliances WHERE device_id=?", (SIM_DEVICE_ID,)
        ):
            sim.set_enabled(row["id"], bool(row["enabled"]))
        log.info("simulator started (%.2fs interval)", settings.sim_interval_s)

        while not self._stop.is_set():
            started = time.time()
            try:
                reading = sim.tick()
                reading["_source"] = "sim"
                self.ingest(reading)
            except Exception:
                log.exception("simulator tick failed")
            elapsed = time.time() - started
            self._stop.wait(max(0.0, settings.sim_interval_s - elapsed))

    def _actuate(self, device_id: str, appliance_id: str, on: bool) -> bool:
        """Apply a control command to whichever backend owns the device."""
        rt = self.runtimes.get(device_id)
        if rt is not None:
            with rt.lock:
                rt.disagg.set_enabled(appliance_id, on)
            if rt._sim is not None:
                return rt._sim.set_enabled(appliance_id, on)
        from .mqtt_client import publish_command   # local import: optional dep
        return publish_command(device_id, appliance_id, on)

    # ------------------------------------------------------------ lifecycle
    def start(self) -> None:
        control.register_actuator(self._actuate)
        if settings.sim_enabled:
            t = threading.Thread(target=self._sim_loop, daemon=True, name="simulator")
            t.start()
            self._threads.append(t)
        if settings.mqtt_enabled:
            from .mqtt_client import start_mqtt
            start_mqtt(self)

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=3)


pipeline = Pipeline()
