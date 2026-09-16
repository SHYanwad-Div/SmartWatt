"""Alert lifecycle and multi-channel notification delivery.

An anomaly becomes an alert row, is pushed to every connected dashboard over
WebSocket, and is optionally fanned out to email / webhook / Telegram. A
per-(device, type) cooldown stops a sustained condition from producing hundreds
of duplicate notifications.
"""
from __future__ import annotations

import json
import logging
import smtplib
import threading
import urllib.request
from email.message import EmailMessage

from . import db
from .analytics.anomaly import Anomaly
from .config import settings
from .hub import hub

log = logging.getLogger("smartwatt.alerts")

_last_sent: dict[tuple[str, str], int] = {}


# --------------------------------------------------------------- channels

def _send_email(subject: str, body: str) -> bool:
    if not (settings.smtp_host and settings.alert_email_to):
        return False
    try:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = settings.smtp_user or "smartwatt@localhost"
        msg["To"] = settings.alert_email_to
        msg.set_content(body)
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as s:
            s.starttls()
            if settings.smtp_user:
                s.login(settings.smtp_user, settings.smtp_pass)
            s.send_message(msg)
        return True
    except Exception as exc:
        log.warning("email alert failed: %s", exc)
        return False


def _post_json(url: str, payload: dict) -> bool:
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10).read()
        return True
    except Exception as exc:
        log.warning("webhook failed: %s", exc)
        return False


def _send_webhook(alert: dict) -> bool:
    if not settings.webhook_url:
        return False
    return _post_json(settings.webhook_url, alert)


def _send_telegram(text: str) -> bool:
    if not (settings.telegram_bot_token and settings.telegram_chat_id):
        return False
    url = f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage"
    return _post_json(url, {"chat_id": settings.telegram_chat_id, "text": text})


def _deliver_async(alert: dict, cfg: dict) -> None:
    """Network I/O off the ingest thread so a slow SMTP server cannot stall it."""
    def run() -> None:
        sent: list[str] = []
        subject = f"SmartWatt: {alert['title']} ({alert['device_id']})"
        body = f"{alert['message']}\n\nValue: {alert['value']}  Threshold: {alert['threshold']}"
        if cfg.get("notify_email") and _send_email(subject, body):
            sent.append("email")
        if cfg.get("notify_webhook") and _send_webhook(alert):
            sent.append("webhook")
        if cfg.get("notify_telegram") and _send_telegram(f"{subject}\n{body}"):
            sent.append("telegram")
        if sent:
            db.execute(
                "UPDATE alerts SET channels=? WHERE id=?",
                (",".join(["dashboard", *sent]), alert["id"]),
            )

    threading.Thread(target=run, daemon=True, name="alert-deliver").start()


# ------------------------------------------------------------------ raise

def raise_alert(device_id: str, anomaly: Anomaly, cfg: dict) -> dict | None:
    """Persist + broadcast an anomaly, honouring the per-type cooldown."""
    now = db.now_ms()
    cooldown_ms = int(float(cfg.get("alert_cooldown_s", 300)) * 1000)
    key = (device_id, anomaly.type)
    if now - _last_sent.get(key, 0) < cooldown_ms:
        return None
    _last_sent[key] = now

    alert_id = db.execute(
        "INSERT INTO alerts(device_id, ts, type, severity, title, message, value, "
        "threshold, status, channels) VALUES(?,?,?,?,?,?,?,?,'active','dashboard')",
        (device_id, now, anomaly.type, anomaly.severity, anomaly.title,
         anomaly.message, anomaly.value, anomaly.threshold),
    )
    alert = {
        "id": alert_id,
        "device_id": device_id,
        "ts": now,
        "type": anomaly.type,
        "severity": anomaly.severity,
        "title": anomaly.title,
        "message": anomaly.message,
        "value": anomaly.value,
        "threshold": anomaly.threshold,
        "status": "active",
    }
    hub.broadcast_threadsafe(device_id, {"type": "alert", "alert": alert})
    _deliver_async(alert, cfg)
    log.info("ALERT [%s] %s: %s", anomaly.severity, anomaly.title, anomaly.message)
    return alert


def acknowledge(alert_id: int) -> bool:
    return db.execute(
        "UPDATE alerts SET status='acknowledged', acked_at=? WHERE id=? AND status='active'",
        (db.now_ms(), alert_id),
    ) > 0


def resolve(alert_id: int) -> bool:
    return db.execute(
        "UPDATE alerts SET status='resolved', resolved_at=? WHERE id=?",
        (db.now_ms(), alert_id),
    ) > 0


def recent(device_id: str, limit: int = 100, status: str | None = None) -> list[dict]:
    sql = "SELECT * FROM alerts WHERE device_id=?"
    params: list = [device_id]
    if status:
        sql += " AND status=?"
        params.append(status)
    sql += " ORDER BY ts DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in db.query(sql, params)]
