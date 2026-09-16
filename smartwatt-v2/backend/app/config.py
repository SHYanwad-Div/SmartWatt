"""Central configuration, loaded from environment / .env file."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv() -> None:
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


def _env_float(key: str, default: float) -> float:
    try:
        return float(_env(key) or default)
    except ValueError:
        return default


def _env_int(key: str, default: int) -> int:
    try:
        return int(float(_env(key) or default))
    except ValueError:
        return default


@dataclass
class Settings:
    host: str = field(default_factory=lambda: _env("SW_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: _env_int("SW_PORT", 8000))
    db_path: Path = field(
        default_factory=lambda: (ROOT / _env("SW_DB_PATH", "data/smartwatt.db")).resolve()
    )

    # "sim" | "mqtt" | "both"
    source: str = field(default_factory=lambda: _env("SW_SOURCE", "sim").lower())
    sim_interval_s: float = field(default_factory=lambda: _env_float("SW_SIM_INTERVAL_S", 1.0))

    mqtt_host: str = field(default_factory=lambda: _env("SW_MQTT_HOST", "localhost"))
    mqtt_port: int = field(default_factory=lambda: _env_int("SW_MQTT_PORT", 1883))
    mqtt_user: str = field(default_factory=lambda: _env("SW_MQTT_USER"))
    mqtt_pass: str = field(default_factory=lambda: _env("SW_MQTT_PASS"))
    mqtt_readings_topic: str = field(
        default_factory=lambda: _env("SW_MQTT_READINGS_TOPIC", "smartwatt/readings/#")
    )
    mqtt_events_topic: str = field(
        default_factory=lambda: _env("SW_MQTT_EVENTS_TOPIC", "smartwatt/events/#")
    )
    mqtt_cmd_topic_fmt: str = field(
        default_factory=lambda: _env("SW_MQTT_CMD_TOPIC_FMT", "smartwatt/cmd/{device_id}")
    )

    # Empty (or a known placeholder) means: generate a random secret on first run
    # and keep it in the data directory. See auth._jwt_secret().
    jwt_secret: str = field(default_factory=lambda: _env("SW_JWT_SECRET"))
    # Shared key a test script or gateway sends as X-Device-Key to POST readings
    # over HTTP. Empty disables key-based ingest (a logged-in user still can).
    ingest_key: str = field(default_factory=lambda: _env("SW_INGEST_KEY"))
    jwt_ttl_hours: int = field(default_factory=lambda: _env_int("SW_JWT_TTL_HOURS", 12))
    admin_password: str = field(default_factory=lambda: _env("SW_ADMIN_PASSWORD", "admin123"))

    smtp_host: str = field(default_factory=lambda: _env("SW_SMTP_HOST"))
    smtp_port: int = field(default_factory=lambda: _env_int("SW_SMTP_PORT", 587))
    smtp_user: str = field(default_factory=lambda: _env("SW_SMTP_USER"))
    smtp_pass: str = field(default_factory=lambda: _env("SW_SMTP_PASS"))
    alert_email_to: str = field(default_factory=lambda: _env("SW_ALERT_EMAIL_TO"))
    webhook_url: str = field(default_factory=lambda: _env("SW_WEBHOOK_URL"))
    telegram_bot_token: str = field(default_factory=lambda: _env("SW_TELEGRAM_BOT_TOKEN"))
    telegram_chat_id: str = field(default_factory=lambda: _env("SW_TELEGRAM_CHAT_ID"))

    @property
    def sim_enabled(self) -> bool:
        return self.source in ("sim", "both")

    @property
    def mqtt_enabled(self) -> bool:
        return self.source in ("mqtt", "both")


settings = Settings()

# Simulated device used when no hardware is attached. Keeps the same id shape as
# the ESP32 firmware so the dashboard is identical in both modes.
SIM_DEVICE_ID = "sim-smartwatt-001"
HW_DEVICE_ID = "esp32-smartwatt-001"
