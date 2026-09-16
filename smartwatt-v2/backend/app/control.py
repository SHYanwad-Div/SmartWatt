"""Appliance control and the automation rule engine.

Control targets both worlds: in simulator mode the command flips the appliance's
state machine directly; in hardware mode it is published to the device's MQTT
command topic, where the ESP32 firmware drives a relay. The dashboard cannot
tell the difference.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Callable

from . import db
from .hub import hub

log = logging.getLogger("smartwatt.control")

# Set by the pipeline at start-up: (device_id, appliance_id, on) -> handled?
_actuator: Callable[[str, str, bool], bool] | None = None


def register_actuator(fn: Callable[[str, str, bool], bool]) -> None:
    global _actuator
    _actuator = fn


def set_appliance(
    device_id: str,
    appliance_id: str,
    on: bool,
    source: str = "dashboard",
) -> dict:
    """Turn an appliance on/off. Returns the resulting state."""
    if db.query_one("SELECT 1 FROM devices WHERE id=?", (device_id,)) is None:
        return {"ok": False, "code": 404, "error": f"unknown device '{device_id}'"}
    row = db.query_one(
        "SELECT * FROM appliances WHERE device_id=? AND id=?", (device_id, appliance_id)
    )
    if row is None:
        return {"ok": False, "code": 404, "error": f"unknown appliance '{appliance_id}'"}
    if not row["controllable"]:
        return {"ok": False, "error": f"{row['name']} is not remotely controllable"}

    delivered = _actuator(device_id, appliance_id, on) if _actuator else False

    db.execute(
        "UPDATE appliances SET enabled=?, state=? WHERE device_id=? AND id=?",
        (1 if on else 0, 1 if on else 0, device_id, appliance_id),
    )
    db.execute(
        "INSERT INTO commands(device_id, appliance_id, action, source, ts, status) "
        "VALUES(?,?,?,?,?,?)",
        (device_id, appliance_id, "on" if on else "off", source, db.now_ms(),
         "delivered" if delivered else "queued"),
    )

    payload = {
        "ok": True,
        "device_id": device_id,
        "appliance_id": appliance_id,
        "name": row["name"],
        "enabled": on,
        "source": source,
        "delivered": delivered,
    }
    hub.broadcast_threadsafe(device_id, {"type": "control", "control": payload})
    log.info("control: %s %s -> %s (%s)", device_id, appliance_id,
             "ON" if on else "OFF", source)
    return payload


def set_all(
    device_id: str,
    on: bool,
    except_ids: list[str] | None = None,
    source: str = "dashboard",
) -> dict:
    """Bulk control, e.g. "turn off everything except the refrigerator"."""
    except_ids = [e.lower() for e in (except_ids or [])]
    rows = db.query(
        "SELECT id, name FROM appliances WHERE device_id=? AND controllable=1", (device_id,)
    )
    changed, skipped = [], []
    for r in rows:
        if r["id"].lower() in except_ids or r["name"].lower() in except_ids:
            skipped.append(r["name"])
            continue
        res = set_appliance(device_id, r["id"], on, source=source)
        if res.get("ok"):
            changed.append(r["name"])
    return {"ok": True, "changed": changed, "skipped": skipped, "state": on}


# ------------------------------------------------------------- automations

def list_automations(device_id: str) -> list[dict]:
    out = []
    for r in db.query(
        "SELECT * FROM automations WHERE device_id=? ORDER BY id", (device_id,)
    ):
        d = dict(r)
        d["trigger_config"] = json.loads(d["trigger_config"])
        d["action_config"] = json.loads(d["action_config"])
        d["enabled"] = bool(d["enabled"])
        out.append(d)
    return out


def create_automation(
    device_id: str,
    name: str,
    trigger_type: str,
    trigger_config: dict,
    action_type: str,
    action_config: dict,
    enabled: bool = True,
) -> int:
    return db.execute(
        "INSERT INTO automations(device_id, name, enabled, trigger_type, trigger_config, "
        "action_type, action_config, created_at) VALUES(?,?,?,?,?,?,?,?)",
        (device_id, name, 1 if enabled else 0, trigger_type, json.dumps(trigger_config),
         action_type, json.dumps(action_config), db.now_ms()),
    )


def set_automation_enabled(automation_id: int, enabled: bool) -> bool:
    return db.execute(
        "UPDATE automations SET enabled=? WHERE id=?", (1 if enabled else 0, automation_id)
    ) > 0


def delete_automation(automation_id: int) -> bool:
    return db.execute("DELETE FROM automations WHERE id=?", (automation_id,)) > 0


def _trigger_fires(
    rule: dict,
    power_w: float,
    today_kwh: float,
    appliances: dict[str, dict],
    now: datetime,
) -> bool:
    cfg = rule["trigger_config"]
    kind = rule["trigger_type"]

    if kind == "power_above":
        return power_w > float(cfg.get("watts", 1e9))
    if kind == "daily_budget":
        return today_kwh > float(cfg.get("kwh", 1e9))
    if kind == "time_of_day":
        return now.strftime("%H:%M") == cfg.get("at", "--:--")
    if kind == "appliance_on_for":
        aid = cfg.get("appliance_id")
        mins = float(cfg.get("minutes", 60))
        st = appliances.get(aid)
        if not st or not st.get("state"):
            return False
        since = st.get("since_ts") or 0
        return since > 0 and (now.timestamp() * 1000 - since) >= mins * 60_000
    return False


def evaluate_automations(
    device_id: str,
    power_w: float,
    today_kwh: float,
    appliances: dict[str, dict],
    now: datetime | None = None,
) -> list[dict]:
    """Run every enabled rule for a device. Returns the actions that fired."""
    now = now or datetime.now()
    fired: list[dict] = []

    for rule in list_automations(device_id):
        if not rule["enabled"]:
            continue
        # one firing per minute at most, so a sustained condition does not loop
        if rule["last_fired"] and (now.timestamp() * 1000 - rule["last_fired"]) < 60_000:
            continue
        if not _trigger_fires(rule, power_w, today_kwh, appliances, now):
            continue

        acfg = rule["action_config"]
        action = rule["action_type"]
        result: Any = None
        if action in ("turn_off", "turn_on"):
            on = action == "turn_on"
            if acfg.get("all"):
                result = set_all(device_id, on, acfg.get("except", []), source="automation")
            elif acfg.get("appliance_id"):
                result = set_appliance(device_id, acfg["appliance_id"], on, source="automation")
        elif action == "notify":
            result = {"message": acfg.get("message", rule["name"])}

        db.execute(
            "UPDATE automations SET last_fired=?, fire_count=fire_count+1 WHERE id=?",
            (int(now.timestamp() * 1000), rule["id"]),
        )
        fired.append({"rule": rule["name"], "action": action, "result": result})
        log.info("automation fired: %s -> %s", rule["name"], action)

    if fired:
        hub.broadcast_threadsafe(device_id, {"type": "automation", "fired": fired})
    return fired
