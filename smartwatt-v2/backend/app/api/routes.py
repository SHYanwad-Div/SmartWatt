"""REST + WebSocket API."""
from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import alerts as alerts_mod
from .. import auth, billing, control, db
from ..analytics.disaggregation import OTHER_ID
from ..analytics.forecast import forecast_month_kwh, forecast_power
from ..assistant import TIPS, Assistant
from ..hub import hub
from ..ingest.pipeline import ReadingError, pipeline

router = APIRouter()
# Only the Phase-I compatible paths are also served without the /api prefix, so
# the SPA keeps ownership of every other top-level path (/settings, /reports...).
compat = APIRouter()
assistant = Assistant(pipeline)

RANGE_MS = {
    "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 3_600_000, "6h": 6 * 3_600_000,
    "24h": 24 * 3_600_000, "7d": 7 * 24 * 3_600_000, "30d": 30 * 24 * 3_600_000,
}


# ------------------------------------------------------------------ models

class LoginRequest(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


class ControlRequest(BaseModel):
    state: bool
    appliance_id: str | None = None
    all: bool = False
    except_ids: list[str] = Field(default_factory=list)


class AskRequest(BaseModel):
    query: str = Field(max_length=500)


class SettingsPatch(BaseModel):
    values: dict[str, Any]


class AutomationRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    trigger_type: str
    trigger_config: dict
    action_type: str
    action_config: dict
    enabled: bool = True


class ReadingIn(BaseModel):
    device_id: str
    ts_ms: int | None = None
    voltage_V: float = 230.0
    current_A: float = 0.0
    power_W: float | None = None
    pf: float = 1.0
    energyWh_total: float = 0.0
    deltaW: float | None = None


def _live_today_kwh(device_id: str) -> float:
    rt = pipeline.runtimes.get(device_id)
    return rt.last["today_kwh"] if rt and rt.last else 0.0


# -------------------------------------------------------------------- auth

@router.post("/auth/login")
def login(body: LoginRequest) -> dict:
    user = auth.verify_user(body.username, body.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    return {
        "token": auth.issue_token(user),
        "user": {**user, "permissions": auth.permissions_for(user["role"])},
    }


@router.get("/auth/me")
def me(user: dict = Depends(auth.current_user)) -> dict:
    return {
        "username": user["sub"], "role": user["role"], "name": user.get("name"),
        "permissions": auth.permissions_for(user["role"]),
    }


# ----------------------------------------------------------------- devices

@router.get("/devices")
def devices(user: dict = Depends(auth.require("read"))) -> list[dict]:
    out = []
    for r in db.query("SELECT * FROM devices ORDER BY id"):
        d = dict(r)
        rt = pipeline.runtimes.get(d["id"])
        d["online"] = bool(rt and rt.last and (db.now_ms() - rt.last_ts) < 30_000)
        d["power_w"] = rt.last["power_w"] if rt and rt.last else 0.0
        out.append(d)
    return out


@router.get("/portfolio")
def portfolio(user: dict = Depends(auth.require("billing"))) -> dict:
    """Utility / admin view: every meter with its load, energy and bill."""
    cfg = db.all_settings()
    rows = []
    for d in db.query("SELECT * FROM devices ORDER BY id"):
        rt = pipeline.runtimes.get(d["id"])
        today = rt.last["today_kwh"] if rt and rt.last else 0.0
        month_kwh, daily = _month_kwh(d["id"], today)
        proj = forecast_month_kwh(daily, today)
        active = db.query_one(
            "SELECT COUNT(*) AS n FROM alerts WHERE device_id=? AND status='active'", (d["id"],)
        )["n"]
        rows.append({
            "id": d["id"], "source": d["source"],
            "online": bool(rt and rt.last and (db.now_ms() - rt.last_ts) < 30_000),
            "power_w": rt.last["power_w"] if rt and rt.last else 0.0,
            "peak_w_today": rt.last["peak_w_today"] if rt and rt.last else 0.0,
            "today_kwh": round(today, 4),
            "month_kwh": round(month_kwh, 3),
            "month_bill": billing.compute_bill(month_kwh, cfg)["total"],
            "projected_bill": billing.compute_bill(proj["projected_month_kwh"], cfg)["total"],
            "active_alerts": active,
        })
    return {
        "devices": rows,
        "total_power_w": round(sum(r["power_w"] for r in rows), 1),
        "total_today_kwh": round(sum(r["today_kwh"] for r in rows), 3),
        "total_month_bill": round(sum(r["month_bill"] for r in rows), 2),
    }


@router.get("/live/{device_id}")
def live(device_id: str, user: dict = Depends(auth.require("read"))) -> dict:
    rt = pipeline.runtimes.get(device_id)
    if not rt or not rt.last:
        raise HTTPException(status_code=404, detail="No live data for this device yet")
    return rt.last


@router.get("/readings/{device_id}")
def readings(
    device_id: str,
    range_: str = Query("1h", alias="range"),
    limit: int = Query(1500, ge=10, le=10000),
    user: dict = Depends(auth.require("read")),
) -> dict:
    """Recent power series. Served from memory for short ranges, DB for long."""
    window = RANGE_MS.get(range_, RANGE_MS["1h"])
    since = db.now_ms() - window
    rt = pipeline.runtimes.get(device_id)

    if rt and window <= RANGE_MS["1h"]:
        pts = [{"ts": t, "power_w": round(p, 1)} for t, p in rt.history if t >= since]
    else:
        rows = db.query(
            "SELECT ts, power_w, voltage_v, current_a FROM readings "
            "WHERE device_id=? AND ts>=? ORDER BY ts", (device_id, since),
        )
        pts = [{"ts": r["ts"], "power_w": round(r["power_w"], 1),
                "voltage_v": round(r["voltage_v"], 1),
                "current_a": round(r["current_a"], 3)} for r in rows]

    if len(pts) > limit:     # decimate evenly so the chart stays responsive
        step = len(pts) / limit
        pts = [pts[int(i * step)] for i in range(limit)]
    return {"device_id": device_id, "range": range_, "count": len(pts), "points": pts}


@router.get("/summary/{device_id}")
def summary(
    device_id: str,
    range_: str = Query("24h", alias="range"),
    user: dict = Depends(auth.require("read")),
) -> list[dict]:
    """Hourly mean/max power. Same shape as the Phase-I Node API."""
    since = db.now_ms() - RANGE_MS.get(range_, RANGE_MS["24h"])
    rows = db.query(
        "SELECT (ts/3600000)*3600000 AS bucket, AVG(power_w) AS mean_power, "
        "MAX(power_w) AS max_power, COUNT(*) AS n FROM readings "
        "WHERE device_id=? AND ts>=? GROUP BY bucket ORDER BY bucket",
        (device_id, since),
    )
    return [
        {"time": datetime.fromtimestamp(r["bucket"] / 1000).isoformat(),
         "ts": r["bucket"], "mean_power": round(r["mean_power"], 2),
         "max_power": round(r["max_power"], 2), "samples": r["n"]}
        for r in rows
    ]


# -------------------------------------------------------------- appliances

@router.get("/appliances/{device_id}")
def appliances(device_id: str, user: dict = Depends(auth.require("read"))) -> dict:
    rt = pipeline.runtimes.get(device_id)
    live_state = rt.last["appliances"] if rt and rt.last else {}
    rows = db.query("SELECT * FROM appliances WHERE device_id=? ORDER BY rated_w DESC",
                    (device_id,))

    # Shares are of the whole house, so the column (unattributed row included)
    # adds up to 100%.
    total_wh = sum(a["energy_wh"] for a in live_state.values()) or 1.0
    items = []
    for r in rows:
        st = live_state.get(r["id"], {})
        wh = st.get("energy_wh", 0.0)
        items.append({
            "id": r["id"], "name": r["name"], "icon": r["icon"],
            "category": r["category"], "rated_w": r["rated_w"],
            "controllable": bool(r["controllable"]), "enabled": bool(r["enabled"]),
            "power_w": st.get("power_w", 0.0), "state": bool(st.get("state")),
            "today_kwh": round(wh / 1000.0, 4),
            "share_pct": round(wh / total_wh * 100, 2),
            "confidence": st.get("confidence", 0.0),
        })
    other = live_state.get(OTHER_ID)
    if other:
        items.append({
            "id": OTHER_ID, "name": other["name"], "icon": other["icon"],
            "category": "unknown", "rated_w": 0, "controllable": False, "enabled": True,
            "power_w": other["power_w"], "state": other["state"],
            "today_kwh": round(other["energy_wh"] / 1000.0, 4),
            "share_pct": round(other["energy_wh"] / total_wh * 100, 2),
            "confidence": 1.0,
        })
    return {
        "device_id": device_id,
        "appliances": items,
        "disagg_score": rt.disagg_score if rt else {},
    }


@router.post("/appliances/{device_id}/control")
def control_appliance(
    device_id: str,
    body: ControlRequest,
    user: dict = Depends(auth.require("control")),
) -> dict:
    if body.all:
        if db.query_one("SELECT 1 FROM devices WHERE id=?", (device_id,)) is None:
            raise HTTPException(status_code=404, detail=f"unknown device '{device_id}'")
        return control.set_all(device_id, body.state, body.except_ids, source="dashboard")
    if not body.appliance_id:
        raise HTTPException(status_code=400, detail="appliance_id or all=true required")
    res = control.set_appliance(device_id, body.appliance_id, body.state)
    if not res.get("ok"):
        raise HTTPException(status_code=res.get("code", 400), detail=res.get("error"))
    return res


# ------------------------------------------------------------------ events

@router.get("/events/{device_id}")
def events(
    device_id: str,
    limit: int = Query(100, ge=1, le=1000),
    user: dict = Depends(auth.require("read")),
) -> list[dict]:
    return [
        dict(r) for r in db.query(
            "SELECT * FROM events WHERE device_id=? ORDER BY ts DESC LIMIT ?",
            (device_id, limit),
        )
    ]


# ------------------------------------------------------------------ alerts

@router.get("/alerts/{device_id}")
def get_alerts(
    device_id: str,
    status: str | None = None,
    limit: int = Query(100, ge=1, le=1000),
    user: dict = Depends(auth.require("read")),
) -> list[dict]:
    return alerts_mod.recent(device_id, limit=limit, status=status)


@router.post("/alerts/{alert_id}/ack")
def ack_alert(alert_id: int, user: dict = Depends(auth.require("read"))) -> dict:
    return {"ok": alerts_mod.acknowledge(alert_id)}


@router.post("/alerts/{alert_id}/resolve")
def resolve_alert(alert_id: int, user: dict = Depends(auth.require("read"))) -> dict:
    return {"ok": alerts_mod.resolve(alert_id)}


# ----------------------------------------------------------------- billing

def _month_kwh(device_id: str, today_kwh: float) -> tuple[float, list[tuple[str, float]]]:
    month = datetime.now().strftime("%Y-%m")
    today = datetime.now().strftime("%Y-%m-%d")
    daily = [
        (r["day"], r["kwh"]) for r in db.query(
            "SELECT day, kwh FROM daily_energy WHERE device_id=? AND day LIKE ? ORDER BY day",
            (device_id, f"{month}-%"),
        )
    ]
    completed = sum(k for d, k in daily if d != today)
    return completed + today_kwh, daily


@router.get("/billing/{device_id}")
def get_billing(device_id: str, user: dict = Depends(auth.require("read"))) -> dict:
    cfg = db.all_settings()
    today_kwh = _live_today_kwh(device_id)
    month_kwh, daily = _month_kwh(device_id, today_kwh)
    proj = forecast_month_kwh(daily, today_kwh)
    return {
        "device_id": device_id,
        "today": {
            "kwh": round(today_kwh, 4),
            "cost": billing.marginal_cost_of(today_kwh, max(0.0, month_kwh - today_kwh), cfg),
        },
        "month_to_date": billing.compute_bill(month_kwh, cfg),
        "projected_month": billing.compute_bill(proj["projected_month_kwh"], cfg),
        "next_slab": billing.next_slab_info(month_kwh, cfg),
        "forecast": proj,
        "daily": [{"day": d, "kwh": round(k, 3)} for d, k in daily],
    }


@router.get("/forecast/{device_id}")
def get_forecast(
    device_id: str,
    horizon_minutes: int = Query(120, ge=10, le=1440),
    user: dict = Depends(auth.require("read")),
) -> dict:
    rt = pipeline.runtimes.get(device_id)
    if not rt:
        raise HTTPException(status_code=404, detail="Unknown device")
    power = forecast_power(list(rt.history), horizon_minutes=horizon_minutes,
                           step_minutes=max(5, horizon_minutes // 24))
    today_kwh = _live_today_kwh(device_id)
    _, daily = _month_kwh(device_id, today_kwh)
    return {"power": power, "month": forecast_month_kwh(daily, today_kwh)}


# ---------------------------------------------------------------- insights

@router.get("/insights/{device_id}")
def insights(device_id: str, user: dict = Depends(auth.require("read"))) -> dict:
    """Top consumer + contextual saving tip, for the dashboard's tip cards."""
    rt = pipeline.runtimes.get(device_id)
    empty = {"top_now": None, "top_today": None, "tip": None,
             "unattributed_w": 0.0, "unattributed_share": 0.0}
    if not rt or not rt.last:
        return empty
    live_apps = rt.last["appliances"]
    items = [a for aid, a in live_apps.items() if aid != OTHER_ID]
    if not items:
        return empty
    top_now = max(items, key=lambda a: a["power_w"])
    top_today = max(items, key=lambda a: a["energy_wh"])
    total_wh = sum(a["energy_wh"] for a in live_apps.values()) or 1.0
    unattributed_w = live_apps.get(OTHER_ID, {}).get("power_w", 0.0)
    # Attribution splits the raw signal, so compare against raw power, not the
    # lagging moving average. And the question the card answers is "what is the
    # biggest load", so unattributed load that exceeds the largest known
    # appliance must win -- otherwise an 18 W router gets named top consumer
    # next to 300 W nobody has identified.
    raw_w = max(rt.last.get("power_raw_w", rt.last["power_w"]), 1.0)
    return {
        "unattributed_w": round(unattributed_w, 1),
        "unattributed_share": round(unattributed_w / raw_w, 3),
        "unattributed_is_largest": unattributed_w > max(top_now["power_w"], 30.0),
        "top_now": {**top_now, "tip": TIPS.get(top_now["id"])},
        "top_today": {
            **top_today,
            "share_pct": round(top_today["energy_wh"] / total_wh * 100, 2),
            "tip": TIPS.get(top_today["id"]),
        },
        "tip": TIPS.get(top_today["id"]),
    }


# --------------------------------------------------------------- assistant

@router.post("/assistant/{device_id}")
def ask(device_id: str, body: AskRequest, user: dict = Depends(auth.require("read"))) -> dict:
    can_control = "control" in auth.permissions_for(user["role"])
    reply = assistant.ask(device_id, body.query, can_control=can_control)
    if reply.get("forbidden"):
        raise HTTPException(status_code=403, detail=reply["text"])
    return reply


# ---------------------------------------------------------------- settings

@router.get("/settings")
def get_settings(user: dict = Depends(auth.require("read"))) -> dict:
    return db.all_settings()


@router.put("/settings")
def put_settings(body: SettingsPatch, user: dict = Depends(auth.require("settings"))) -> dict:
    try:
        clean = db.validate_settings(body.values)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    for key, value in clean.items():
        db.set_setting(key, value)
    if "threshold_power_w" in clean:      # push the new limit to real hardware
        try:
            from ..ingest.mqtt_client import publish_threshold
            for d in db.query("SELECT id FROM devices WHERE source='mqtt'"):
                publish_threshold(d["id"], clean["threshold_power_w"])
        except Exception:
            pass
    return db.all_settings()


# ------------------------------------------------------------- automations

TRIGGERS = {"power_above", "daily_budget", "time_of_day", "appliance_on_for"}
ACTIONS = {"turn_off", "turn_on", "notify"}


@router.get("/automations/{device_id}")
def get_automations(device_id: str, user: dict = Depends(auth.require("read"))) -> list[dict]:
    return control.list_automations(device_id)


@router.post("/automations/{device_id}")
def post_automation(
    device_id: str,
    body: AutomationRequest,
    user: dict = Depends(auth.require("automate")),
) -> dict:
    if body.trigger_type not in TRIGGERS:
        raise HTTPException(status_code=422, detail=f"trigger_type must be one of {sorted(TRIGGERS)}")
    if body.action_type not in ACTIONS:
        raise HTTPException(status_code=422, detail=f"action_type must be one of {sorted(ACTIONS)}")
    if db.query_one("SELECT 1 FROM devices WHERE id=?", (device_id,)) is None:
        raise HTTPException(status_code=404, detail=f"unknown device '{device_id}'")
    rule_id = control.create_automation(
        device_id, body.name, body.trigger_type, body.trigger_config,
        body.action_type, body.action_config, body.enabled,
    )
    return {"id": rule_id}


@router.patch("/automations/{automation_id}")
def patch_automation(
    automation_id: int,
    enabled: bool,
    user: dict = Depends(auth.require("automate")),
) -> dict:
    return {"ok": control.set_automation_enabled(automation_id, enabled)}


@router.delete("/automations/{automation_id}")
def delete_automation(
    automation_id: int, user: dict = Depends(auth.require("automate"))
) -> dict:
    return {"ok": control.delete_automation(automation_id)}


# ----------------------------------------------------------------- reports

@router.get("/reports/{device_id}/daily")
def daily_report(
    device_id: str,
    days: int = Query(30, ge=1, le=365),
    user: dict = Depends(auth.require("read")),
) -> dict:
    cfg = db.all_settings()
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    rows = db.query(
        "SELECT day, kwh, peak_w FROM daily_energy WHERE device_id=? AND day>=? ORDER BY day",
        (device_id, since),
    )
    out = []
    running = 0.0
    for r in rows:
        cost = billing.marginal_cost_of(r["kwh"], running, cfg)
        running += r["kwh"]
        out.append({"day": r["day"], "kwh": round(r["kwh"], 3),
                    "peak_w": round(r["peak_w"], 1), "cost": cost})
    return {"device_id": device_id, "days": out,
            "total_kwh": round(sum(d["kwh"] for d in out), 3),
            "total_cost": round(sum(d["cost"] for d in out), 2)}


@router.get("/reports/{device_id}/export.csv")
def export_csv(
    device_id: str,
    range_: str = Query("24h", alias="range"),
    user: dict = Depends(auth.require("read")),
) -> StreamingResponse:
    since = db.now_ms() - RANGE_MS.get(range_, RANGE_MS["24h"])
    rows = db.query(
        "SELECT ts, voltage_v, current_a, power_w, pf, energy_wh_total FROM readings "
        "WHERE device_id=? AND ts>=? ORDER BY ts", (device_id, since),
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["timestamp", "iso_time", "voltage_V", "current_A", "power_W",
                "power_factor", "energy_Wh_total"])
    for r in rows:
        w.writerow([
            r["ts"], datetime.fromtimestamp(r["ts"] / 1000).isoformat(),
            round(r["voltage_v"], 2), round(r["current_a"], 4),
            round(r["power_w"], 2), round(r["pf"], 3), round(r["energy_wh_total"], 3),
        ])
    buf.seek(0)
    filename = f"smartwatt_{device_id}_{range_}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ------------------------------------------------------- hardware compat

@router.post("/mock_reading")
def mock_reading(body: ReadingIn, user: dict = Depends(auth.require_ingest)) -> dict:
    """Ingest one reading over HTTP.

    Kept for parity with the Phase-I Node service. Unlike that service it needs
    either an X-Device-Key header or a logged-in user allowed to ingest, and it
    rejects physically impossible values.
    """
    payload = body.model_dump()
    payload["_source"] = "mqtt"
    try:
        snap = pipeline.ingest(payload)
    except ReadingError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    return {"status": "ok", "reading": snap}


@router.get("/health")
def health() -> dict:
    from ..config import settings as cfg
    return {
        "ok": True,
        "source": cfg.source,
        "devices": list(pipeline.runtimes),
        "ws_clients": hub.client_count(),
    }


compat.add_api_route("/mock_reading", mock_reading, methods=["POST"], include_in_schema=False)
compat.add_api_route("/health", health, methods=["GET"], include_in_schema=False)


# --------------------------------------------------------------- websocket

@router.websocket("/ws/{device_id}")
async def ws_endpoint(websocket: WebSocket, device_id: str) -> None:
    # Browsers cannot set headers on a WebSocket, so the token rides in ?token=.
    # Rejections accept first and then close: closing before the handshake turns
    # into a bare HTTP 403 and the browser only sees code 1006, so the dashboard
    # could not tell "session expired" (sign out) from "network blip" (retry).
    claims = auth.decode_token(websocket.query_params.get("token", ""))
    if not claims:
        await websocket.accept()
        await websocket.close(code=4401, reason="Not authenticated")
        return
    if db.query_one("SELECT 1 FROM devices WHERE id=?", (device_id,)) is None:
        await websocket.accept()
        await websocket.close(code=4404, reason="Unknown device")
        return
    await hub.connect(device_id, websocket)
    try:
        rt = pipeline.runtimes.get(device_id)
        if rt and rt.last:
            await websocket.send_json({"type": "reading", "reading": rt.last})
        while True:
            await websocket.receive_text()     # keeps the socket open; allows ping
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(device_id, websocket)
