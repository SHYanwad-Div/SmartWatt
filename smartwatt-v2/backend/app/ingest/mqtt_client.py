"""MQTT subscriber for real ESP32 hardware.

Wire-compatible with the Phase-I firmware already in this repository:

    smartwatt/readings/<device_id>
      {"device_id":..,"ts_ms":..,"voltage_V":..,"current_A":..,
       "power_W":..,"energyWh_total":..}

    smartwatt/events/<device_id>
      {"device_id":..,"ts_ms":..,"deltaW":..,"direction":"ON","power_now":..}

    smartwatt/cmd/<device_id>        (published by us)
      {"cmd":"setAppliance","appliance_id":"ac","state":"off"}
"""
from __future__ import annotations

import json
import logging

from .. import db
from ..config import settings

log = logging.getLogger("smartwatt.mqtt")

_client = None
_pipeline = None


def start_mqtt(pipeline) -> bool:
    """Connect and subscribe. Returns False if MQTT is unavailable."""
    global _client, _pipeline
    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        log.warning("paho-mqtt not installed; MQTT ingest disabled")
        return False

    _pipeline = pipeline

    def on_connect(client, userdata, flags, reason_code, properties=None):
        log.info("MQTT connected to %s:%s (rc=%s)",
                 settings.mqtt_host, settings.mqtt_port, reason_code)
        client.subscribe(settings.mqtt_readings_topic)
        client.subscribe(settings.mqtt_events_topic)

    def on_message(client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode())
        except (ValueError, UnicodeDecodeError):
            log.warning("non-JSON payload on %s", msg.topic)
            return
        try:
            if msg.topic.startswith("smartwatt/readings"):
                from .pipeline import ReadingError
                payload["_source"] = "mqtt"
                try:
                    _pipeline.ingest(payload)
                except ReadingError as exc:
                    log.warning("rejected reading on %s: %s", msg.topic, exc)
            elif msg.topic.startswith("smartwatt/events"):
                # The firmware also does its own step detection. Store those
                # events, tagged so they are distinguishable from ours.
                device_id = payload.get("device_id", "unknown")
                db.execute(
                    "INSERT INTO events(device_id, ts, delta_w, direction, power_now, "
                    "label, confidence) VALUES(?,?,?,?,?,'device',0)",
                    (device_id, db.now_ms(), float(payload.get("deltaW") or 0),
                     payload.get("direction") or "ON", float(payload.get("power_now") or 0)),
                )
        except Exception:
            log.exception("failed handling MQTT message on %s", msg.topic)

    try:
        try:                      # paho-mqtt 2.x
            client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        except AttributeError:    # paho-mqtt 1.x
            client = mqtt.Client()
        if settings.mqtt_user:
            client.username_pw_set(settings.mqtt_user, settings.mqtt_pass)
        client.on_connect = on_connect
        client.on_message = on_message
        client.connect_async(settings.mqtt_host, settings.mqtt_port, keepalive=60)
        client.loop_start()
        _client = client
        log.info("MQTT client started (broker %s:%s)", settings.mqtt_host, settings.mqtt_port)
        return True
    except Exception as exc:
        log.warning("MQTT unavailable (%s); continuing without hardware ingest", exc)
        return False


def publish_command(device_id: str, appliance_id: str, on: bool) -> bool:
    if _client is None:
        return False
    topic = settings.mqtt_cmd_topic_fmt.format(device_id=device_id)
    payload = json.dumps({
        "cmd": "setAppliance",
        "appliance_id": appliance_id,
        "state": "on" if on else "off",
    })
    try:
        _client.publish(topic, payload, qos=1)
        log.info("published command to %s: %s", topic, payload)
        return True
    except Exception:
        log.exception("failed publishing command")
        return False


def publish_threshold(device_id: str, watts: float) -> bool:
    if _client is None:
        return False
    topic = settings.mqtt_cmd_topic_fmt.format(device_id=device_id)
    try:
        _client.publish(topic, json.dumps({"cmd": "setThreshold", "threshold": watts}), qos=1)
        return True
    except Exception:
        return False


def stop_mqtt() -> None:
    if _client is not None:
        _client.loop_stop()
        _client.disconnect()
