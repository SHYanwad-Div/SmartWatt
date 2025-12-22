// ingest/index.js
// Full ingest server with:
// - MQTT subscriber -> InfluxDB
// - SQLite events & labels
// - /mock_reading for PowerShell-friendly simulation
// - /weather proxy to OpenWeatherMap
// - Alerting (Telegram + email) with cooldown
// - simple step-detection -> events insertion

const mqtt = require('mqtt');
const Influx = require('influx');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch'); // v2
const nodemailer = require('nodemailer');

// ---- Config (via env) ----
const MQTT_URL = process.env.MQTT_URL || 'mqtt://mosquitto:1883';
const INFLUX_HOST = process.env.INFLUX_HOST || 'influxdb';
const INFLUX_DB = process.env.INFLUX_DB || 'smartwatt';

// Alerting / notification envs
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ALERT_THRESHOLD_W = parseFloat(process.env.ALERT_THRESHOLD_W || '2000'); // watts
const ALERT_COOLDOWN_SEC = parseInt(process.env.ALERT_COOLDOWN_SEC || '900', 10); // seconds

// SMTP for email alerts (optional)
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || '';

// OpenWeather key (for /weather)
const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY || '';

// ---- Influx client ----
const influx = new Influx.InfluxDB({
  host: INFLUX_HOST,
  database: INFLUX_DB,
  schema: [
    {
      measurement: 'readings',
      fields: {
        power_total: Influx.FieldType.FLOAT,
        energy_wh: Influx.FieldType.FLOAT,
        voltage: Influx.FieldType.FLOAT,
        current: Influx.FieldType.FLOAT
      },
      tags: ['device']
    }
  ]
});

// ensure DB exists
influx.getDatabaseNames()
  .then(names => {
    if (!names.includes(INFLUX_DB)) return influx.createDatabase(INFLUX_DB);
  })
  .catch(err => console.error('Influx init error', err));

// ---- MQTT setup ----
const mqttClient = mqtt.connect(MQTT_URL);
mqttClient.on('connect', () => {
  console.log('MQTT connected to', MQTT_URL);
  mqttClient.subscribe('smartwatt/readings/#', (err) => {
    if (err) console.error('subscribe readings err', err);
  });
  mqttClient.subscribe('smartwatt/events/#', (err) => {
    if (err) console.error('subscribe events err', err);
  });
  mqttClient.subscribe('smartwatt/alerts', (err) => {
    if (err) console.error('subscribe alerts err', err);
  });
});

// ---- SQLite for events/labels ----
const db = new sqlite3.Database('./events.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device TEXT,
    ts INTEGER,
    deltaW REAL,
    direction TEXT,
    cluster_id INTEGER,
    label_id INTEGER,
    confirmed INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device TEXT,
    name TEXT,
    power_estimate REAL
  )`);
});

// ---- In-memory helpers ----
const lastPower = {}; // for simple step-detection
const lastAlertAt = {}; // deviceId -> timestamp_ms to enforce cooldown

function shouldSendAlert(deviceId) {
  const now = Date.now();
  const last = lastAlertAt[deviceId] || 0;
  if (now - last > ALERT_COOLDOWN_SEC * 1000) {
    lastAlertAt[deviceId] = now;
    return true;
  }
  return false;
}

// ---- Notification helpers ----
async function sendTelegramAlert(deviceId, powerW) {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    const text = `⚠️ SmartWatt Alert\nDevice: ${deviceId}\nPower: ${Math.round(powerW)} W (threshold ${ALERT_THRESHOLD_W} W)\nTime: ${new Date().toLocaleString()}`;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
    });
    console.log('Telegram alert sent for', deviceId);
  } catch (err) {
    console.error('sendTelegramAlert error', err);
  }
}

async function sendEmailAlert(deviceId, powerW) {
  try {
    if (!SMTP_HOST || !ALERT_EMAIL_TO) return;
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
    });

    const mail = {
      from: SMTP_USER || 'smartwatt@localhost',
      to: ALERT_EMAIL_TO,
      subject: `SmartWatt alert: ${deviceId} high power ${Math.round(powerW)}W`,
      text: `Device ${deviceId} reported ${powerW} W which is above threshold ${ALERT_THRESHOLD_W} W at ${new Date().toLocaleString()}.`
    };

    await transporter.sendMail(mail);
    console.log('Email alert sent for', deviceId);
  } catch (err) {
    console.error('sendEmailAlert error', err);
  }
}

async function checkAndAlert(deviceId, powerW) {
  try {
    if (!deviceId) return;
    if (isNaN(powerW)) return;
    if (powerW < ALERT_THRESHOLD_W) return;

    if (!shouldSendAlert(deviceId)) {
      console.log(`Alert for ${deviceId} suppressed (cooldown)`);
      return;
    }

    // send notifications (fire-and-forget)
    sendTelegramAlert(deviceId, powerW).catch(console.error);
    sendEmailAlert(deviceId, powerW).catch(console.error);
    console.log(`Alert triggered for ${deviceId} at ${powerW} W`);
  } catch (err) {
    console.error('checkAndAlert error', err);
  }
}

// ---- MQTT message handler ----
mqttClient.on('message', (topic, message) => {
  try {
    const msg = JSON.parse(message.toString());
    if (topic.startsWith('smartwatt/readings')) {
      const device = msg.device_id || 'unknown';
      const power = parseFloat(msg.power_W || msg.powerW_total || 0) || 0;
      const energy = parseFloat(msg.energyWh_total || 0) || 0;
      const volt = parseFloat(msg.voltage_V || 0) || 0;

      // write to influx
      influx.writePoints([{
        measurement: 'readings',
        tags: { device },
        fields: { power_total: power, energy_wh: energy, voltage: volt, current: msg.current_A || 0 },
        timestamp: new Date(msg.ts_ms || Date.now())
      }]).catch(err => console.error('Influx write error', err));

      // step detector (very simple)
      const prev = lastPower[device] !== undefined ? lastPower[device] : power;
      const diff = power - prev;
      const STEP_TH = 30.0; // watts
      if (Math.abs(diff) >= STEP_TH) {
        db.run(`INSERT INTO events (device, ts, deltaW, direction) VALUES (?, ?, ?, ?)`,
          [device, Date.now(), diff, diff > 0 ? 'ON' : 'OFF'], function (err) {
            if (err) console.error('DB insert event', err);
            else console.log('Event stored id=', this.lastID, 'dev', device, 'dW', diff);
          });
      }
      lastPower[device] = power;

      // check alerts
      checkAndAlert(device, power).catch(console.error);
    } else if (topic.startsWith('smartwatt/events')) {
      // if devices publish events directly, mirror into DB
      const device = msg.device_id || 'unknown';
      const dW = parseFloat(msg.deltaW || 0) || 0;
      const dir = msg.direction || null;
      db.run(`INSERT INTO events (device, ts, deltaW, direction) VALUES (?, ?, ?, ?)`,
        [device, msg.ts_ms || Date.now(), dW, dir], function (err) {
          if (err) console.error('DB event insert', err);
          else console.log('Inserted event from device');
        });
    } else if (topic === 'smartwatt/alerts') {
      console.log('ALERT topic:', message.toString());
    }
  } catch (e) {
    console.error('Bad JSON (MQTT)', e && e.message ? e.message : e);
  }
});

// ---- Express API ----
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

// recent raw points
app.get('/api/recent/:device', async (req, res) => {
  const device = req.params.device;
  try {
    const results = await influx.query(`SELECT * FROM readings WHERE device='${device}' ORDER BY time DESC LIMIT 500`);
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// hourly summary for range (default 24h)
app.get('/api/summary/:device', async (req, res) => {
  const device = req.params.device;
  const range = req.query.range || '24h';
  const q = `SELECT mean("power_total") as mean_power, max("power_total") as max_power FROM readings WHERE device='${device}' AND time > now() - ${range} GROUP BY time(1h)`;
  try {
    const out = await influx.query(q);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// events
app.get('/api/events/:device', (req, res) => {
  const device = req.params.device;
  db.all(`SELECT * FROM events WHERE device=? ORDER BY ts DESC LIMIT 500`, [device], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// labels CRUD
app.get('/api/labels/:device', (req, res) => {
  db.all(`SELECT * FROM labels WHERE device=?`, [req.params.device], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});
app.post('/api/labels', (req, res) => {
  const { device, name, power_estimate } = req.body;
  db.run(`INSERT INTO labels (device, name, power_estimate) VALUES (?,?,?)`, [device, name, power_estimate], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID });
  });
});
app.put('/api/events/:id/label', (req, res) => {
  const id = req.params.id;
  const { label_id } = req.body;
  db.run(`UPDATE events SET label_id=? WHERE id=?`, [label_id, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ changed: this.changes });
  });
});

// estimates - naive, returns labels with estimated state
app.get('/api/estimates/:device', async (req, res) => {
  try {
    db.all(`SELECT * FROM labels WHERE device=?`, [req.params.device], (err, labels) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all(`SELECT * FROM events WHERE device=? ORDER BY ts DESC LIMIT 500`, [req.params.device], (err2, events) => {
        if (err2) return res.status(500).json({ error: err2.message });
        const labelMap = {};
        labels.forEach(l => labelMap[l.id] = { id: l.id, name: l.name, power_estimate: l.power_estimate || 0, today_kWh: 0, month_kWh: 0, state: false });
        events.forEach(ev => {
          if (ev.label_id && labelMap[ev.label_id]) {
            if (ev.direction === 'ON') labelMap[ev.label_id].state = true;
            else if (ev.direction === 'OFF') labelMap[ev.label_id].state = false;
          }
        });
        res.json(Object.values(labelMap));
      });
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Temporary demo route to POST a mock reading from PowerShell (avoids mosquitto_pub quoting)
app.post('/mock_reading', async (req, res) => {
  try {
    const msg = req.body;
    console.log('MOCK READING RECEIVED', JSON.stringify(msg));

    const device = msg.device_id || 'unknown';
    const power = parseFloat(msg.power_W || msg.power_total || msg.power || 0) || 0;
    const energy = parseFloat(msg.energyWh_total || msg.energy_wh || 0) || 0;
    const volt = parseFloat(msg.voltage_V || msg.voltage || 0) || 0;

    // write to influx
    await influx.writePoints([{
      measurement: 'readings',
      tags: { device },
      fields: { power_total: power, energy_wh: energy, voltage: volt, current: msg.current_A || 0 },
      timestamp: new Date(msg.ts_ms || Date.now())
    }]);

    // optional: insert an event if deltaW provided and big
    const delta = parseFloat(msg.deltaW || 0) || 0;
    if (!isNaN(delta) && Math.abs(delta) >= 30) {
      db.run(`INSERT INTO events (device, ts, deltaW, direction) VALUES (?, ?, ?, ?)`,
        [device, Date.now(), delta, delta > 0 ? 'ON' : 'OFF'], function (err) {
          if (err) console.error('DB insert event', err);
        });
    }

    // check alerts for mock reading as well
    checkAndAlert(device, power).catch(console.error);

    return res.json({ status: 'ok', device, power, energy });
  } catch (err) {
    console.error('mock_reading error', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /weather?lat=<lat>&lon=<lon>  -> proxied call to OpenWeatherMap (API key stored in env OPENWEATHER_KEY)
app.get('/weather', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    const key = OPENWEATHER_KEY;
    if (!key) return res.status(500).json({ error: 'OPENWEATHER_KEY not set' });

    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&units=metric&appid=${key}`;
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).json({ error: 'weather fetch failed' });
    const body = await r.json();
    res.json(body);
  } catch (err) {
    console.error('weather proxy error', err);
    res.status(500).json({ error: err.message });
  }
});

// Health / simple info
app.get('/health', (req, res) => res.json({ ok: true, influx: INFLUX_DB, mqtt: !!mqttClient.connected }));

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ingest API listening on ${PORT}`));
