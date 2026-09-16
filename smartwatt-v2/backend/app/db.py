"""SQLite storage layer for Smart Watt v2.

One connection per process, guarded by a lock. WAL mode keeps the ingest writer
and the API readers from blocking each other.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any, Iterable

from .config import settings

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    location     TEXT DEFAULT '',
    source       TEXT DEFAULT 'sim',
    created_at   INTEGER NOT NULL,
    last_seen    INTEGER,
    voltage_nominal REAL DEFAULT 230.0
);

CREATE TABLE IF NOT EXISTS readings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    voltage_v    REAL NOT NULL,
    current_a    REAL NOT NULL,
    power_w      REAL NOT NULL,
    pf           REAL DEFAULT 1.0,
    energy_wh_total REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_readings_dev_ts ON readings(device_id, ts);

CREATE TABLE IF NOT EXISTS appliances (
    id           TEXT NOT NULL,
    device_id    TEXT NOT NULL,
    name         TEXT NOT NULL,
    icon         TEXT DEFAULT '',
    category     TEXT DEFAULT 'general',
    behaviour    TEXT DEFAULT 'occupancy',
    rated_w      REAL NOT NULL,
    standby_w    REAL DEFAULT 0,
    controllable INTEGER DEFAULT 1,
    state        INTEGER DEFAULT 0,
    enabled      INTEGER DEFAULT 1,
    created_at   INTEGER NOT NULL,
    -- appliance ids ("ac", "fan") repeat across devices, so the key is composite
    PRIMARY KEY (device_id, id)
);
CREATE INDEX IF NOT EXISTS idx_appl_dev ON appliances(device_id);

CREATE TABLE IF NOT EXISTS appliance_samples (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    appliance_id TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    power_w      REAL NOT NULL,
    energy_wh    REAL NOT NULL DEFAULT 0,
    estimated    INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_asamp_dev_ts ON appliance_samples(device_id, ts);
CREATE INDEX IF NOT EXISTS idx_asamp_appl_ts ON appliance_samples(appliance_id, ts);

CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    delta_w      REAL NOT NULL,
    direction    TEXT NOT NULL,
    power_now    REAL DEFAULT 0,
    appliance_id TEXT,
    label        TEXT,
    confidence   REAL DEFAULT 0,
    confirmed    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_dev_ts ON events(device_id, ts);

CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    type         TEXT NOT NULL,
    severity     TEXT NOT NULL,
    title        TEXT NOT NULL,
    message      TEXT NOT NULL,
    value        REAL,
    threshold    REAL,
    status       TEXT DEFAULT 'active',
    acked_at     INTEGER,
    resolved_at  INTEGER,
    channels     TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_alerts_dev_ts ON alerts(device_id, ts);

CREATE TABLE IF NOT EXISTS daily_energy (
    device_id    TEXT NOT NULL,
    day          TEXT NOT NULL,
    kwh          REAL NOT NULL DEFAULT 0,
    cost         REAL NOT NULL DEFAULT 0,
    peak_w       REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, day)
);

CREATE TABLE IF NOT EXISTS settings (
    key          TEXT PRIMARY KEY,
    value        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt         TEXT NOT NULL,
    role         TEXT NOT NULL,
    display_name TEXT DEFAULT '',
    created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS automations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    name         TEXT NOT NULL,
    enabled      INTEGER DEFAULT 1,
    trigger_type TEXT NOT NULL,
    trigger_config TEXT NOT NULL,
    action_type  TEXT NOT NULL,
    action_config TEXT NOT NULL,
    last_fired   INTEGER,
    fire_count   INTEGER DEFAULT 0,
    created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    appliance_id TEXT,
    action       TEXT NOT NULL,
    source       TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    status       TEXT DEFAULT 'sent'
);
"""


def connect() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            settings.db_path.parent.mkdir(parents=True, exist_ok=True)
            _conn = sqlite3.connect(
                settings.db_path, check_same_thread=False, isolation_level=None
            )
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA journal_mode=WAL")
            _conn.execute("PRAGMA synchronous=NORMAL")
            _conn.execute("PRAGMA busy_timeout=5000")
            _conn.executescript(SCHEMA)
        return _conn


def query(sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
    with _lock:
        return connect().execute(sql, tuple(params)).fetchall()


def query_one(sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: Iterable[Any] = ()) -> int:
    with _lock:
        cur = connect().execute(sql, tuple(params))
        return cur.lastrowid or cur.rowcount


def execute_many(sql: str, seq: Iterable[Iterable[Any]]) -> None:
    with _lock:
        connect().executemany(sql, [tuple(p) for p in seq])


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------- settings kv

DEFAULT_SETTINGS: dict[str, Any] = {
    "threshold_power_w": 2000.0,
    "threshold_voltage_low": 200.0,
    "threshold_voltage_high": 250.0,
    "threshold_daily_kwh": 12.0,
    "anomaly_z": 3.0,
    "standby_waste_w": 60.0,
    "alert_cooldown_s": 300,
    # Karnataka-style domestic slabs (INR per kWh), applied monthly
    "tariff_currency": "INR",
    "tariff_slabs": [
        {"upto": 50, "rate": 4.10},
        {"upto": 100, "rate": 5.65},
        {"upto": 200, "rate": 7.35},
        {"upto": None, "rate": 8.25},
    ],
    "tariff_fixed_charge": 110.0,
    "tariff_tax_pct": 9.0,
    "notify_dashboard": True,
    "notify_email": False,
    "notify_webhook": False,
    "notify_telegram": False,
    "widget_layout": [
        "status", "tiles", "house3d", "live_chart", "today_energy", "top_consumer",
        "tip", "breakdown", "donut", "forecast", "billing", "events", "alerts",
    ],
    "currency_symbol": "₹",
}


def get_setting(key: str, default: Any = None) -> Any:
    row = query_one("SELECT value FROM settings WHERE key=?", (key,))
    if row is None:
        return DEFAULT_SETTINGS.get(key, default)
    try:
        return json.loads(row["value"])
    except json.JSONDecodeError:
        return row["value"]


def set_setting(key: str, value: Any) -> None:
    execute(
        "INSERT INTO settings(key, value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, json.dumps(value)),
    )


WIDGET_IDS = {
    "status", "tiles", "house3d", "live_chart", "today_energy", "top_consumer", "tip",
    "breakdown", "donut", "forecast", "billing", "events", "alerts",
}

# key -> (min, max). Every number the pipeline reads on each tick must be here:
# a non-numeric value used to stop ingest for every device.
_NUMERIC_RANGES: dict[str, tuple[float, float]] = {
    "threshold_power_w": (50, 100_000),
    "threshold_voltage_low": (50, 300),
    "threshold_voltage_high": (100, 400),
    "threshold_daily_kwh": (0.1, 1000),
    "anomaly_z": (1, 20),
    "standby_waste_w": (0, 5000),
    "alert_cooldown_s": (0, 86_400),
    "tariff_fixed_charge": (0, 100_000),
    "tariff_tax_pct": (0, 100),
    "cal_voltage_gain": (0.1, 10),
    "cal_current_gain": (0.1, 10),
    "cal_power_gain": (0.1, 10),
}
_BOOL_KEYS = {"notify_dashboard", "notify_email", "notify_webhook", "notify_telegram"}
_STR_KEYS = {"tariff_currency": 8, "currency_symbol": 4}


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v \
        and v not in (float("inf"), float("-inf"))


def validate_settings(values: dict[str, Any]) -> dict[str, Any]:
    """Check a settings patch. Returns the cleaned values or raises ValueError.

    Unknown keys are rejected rather than stored, so a typo cannot silently
    create a setting nobody reads.
    """
    if not isinstance(values, dict) or not values:
        raise ValueError("values must be a non-empty object")
    clean: dict[str, Any] = {}
    for key, v in values.items():
        if key in _NUMERIC_RANGES:
            lo, hi = _NUMERIC_RANGES[key]
            if not _is_number(v):
                raise ValueError(f"{key} must be a number")
            if not lo <= v <= hi:
                raise ValueError(f"{key} must be between {lo:g} and {hi:g}")
            clean[key] = float(v)
        elif key in _BOOL_KEYS:
            if not isinstance(v, bool):
                raise ValueError(f"{key} must be true or false")
            clean[key] = v
        elif key in _STR_KEYS:
            if not isinstance(v, str) or not v.strip() or len(v) > _STR_KEYS[key]:
                raise ValueError(f"{key} must be text of 1-{_STR_KEYS[key]} characters")
            clean[key] = v.strip()
        elif key == "tariff_slabs":
            if not isinstance(v, list) or not 1 <= len(v) <= 10:
                raise ValueError("tariff_slabs must be a list of 1-10 slabs")
            prev = 0.0
            slabs = []
            for i, slab in enumerate(v):
                if not isinstance(slab, dict):
                    raise ValueError(f"slab {i + 1} must be an object")
                rate, upto = slab.get("rate"), slab.get("upto")
                if not _is_number(rate) or not 0 <= rate <= 1000:
                    raise ValueError(f"slab {i + 1}: rate must be a number between 0 and 1000")
                last = i == len(v) - 1
                if last:
                    if upto is not None:
                        raise ValueError("the last slab must have no upper limit (upto: null)")
                else:
                    if not _is_number(upto) or upto <= prev:
                        raise ValueError(
                            f"slab {i + 1}: upto must be a number greater than {prev:g}")
                    prev = float(upto)
                slabs.append({"upto": None if upto is None else float(upto), "rate": float(rate)})
            clean[key] = slabs
        elif key == "widget_layout":
            if not isinstance(v, list) or not all(isinstance(w, str) for w in v):
                raise ValueError("widget_layout must be a list of widget ids")
            unknown = [w for w in v if w not in WIDGET_IDS]
            if unknown:
                raise ValueError(f"unknown widget(s): {', '.join(unknown)}")
            if len(set(v)) != len(v):
                raise ValueError("widget_layout contains duplicates")
            clean[key] = list(v)
        else:
            raise ValueError(f"unknown setting '{key}'")

    merged = {**all_settings(), **clean}
    if merged["threshold_voltage_low"] >= merged["threshold_voltage_high"]:
        raise ValueError("threshold_voltage_low must be below threshold_voltage_high")
    return clean


def all_settings() -> dict[str, Any]:
    merged = dict(DEFAULT_SETTINGS)
    for row in query("SELECT key, value FROM settings"):
        try:
            merged[row["key"]] = json.loads(row["value"])
        except json.JSONDecodeError:
            merged[row["key"]] = row["value"]
    return merged
