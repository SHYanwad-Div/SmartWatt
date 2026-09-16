/*
 * Smart Watt v2 - ESP32 energy meter firmware
 *
 * Hardware (report table 4.1):
 *   ZMPT101B voltage sensor  -> GPIO 35 (ADC1)
 *   ACS712 current sensor    -> GPIO 34 (ADC1)
 *   16x2 LCD, I2C backpack   -> SDA 21, SCL 22
 *   Relay board (optional)   -> GPIO 26, 27, 25, 33 (see RELAYS below)
 *
 * What changed from the Phase-I sketch:
 *   - True RMS. Phase-I averaged the raw ADC value, which on an AC waveform
 *     returns the mid-rail DC offset, not the RMS magnitude. Here each sample has
 *     the running DC offset removed and Vrms / Irms / real power are computed
 *     over whole mains cycles, giving an actual power factor as well.
 *   - Epoch timestamps via NTP (falls back to millis() until time syncs; the
 *     server handles both).
 *   - Relay control: the dashboard's Turn off / Turn on and automations arrive
 *     on smartwatt/cmd/<device> as {"cmd":"setAppliance","appliance_id":..,"state":..}.
 *   - Non-blocking reconnects and an MQTT last-will so the broker marks the
 *     meter offline if it drops.
 *
 * Libraries: PubSubClient (Nick O'Leary), ArduinoJson 7.x, LiquidCrystal_I2C.
 * Credentials live in secrets.h (copy secrets.example.h).
 */

#include <WiFi.h>
#include <Wire.h>
#include <time.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <LiquidCrystal_I2C.h>
#include "secrets.h"

// ---------------------------------------------------------------- pins
const int PIN_VOLTAGE = 35;
const int PIN_CURRENT = 34;
const int I2C_SDA = 21;
const int I2C_SCL = 22;

struct Relay { const char* applianceId; int pin; };
// Map dashboard appliance ids to relay channels. Unlisted ids are ignored.
const Relay RELAYS[] = {
  {"ac", 26},
  {"geyser", 27},
  {"fan", 25},
  {"lights", 33},
};
const size_t RELAY_COUNT = sizeof(RELAYS) / sizeof(RELAYS[0]);
const bool RELAY_ACTIVE_LOW = true;   // most opto relay boards switch on LOW

// --------------------------------------------------------- calibration
// Calibrate against a multimeter with a known resistive load (e.g. a 100 W bulb):
//   VOLTAGE_CAL = measured_mains_V / reported_Vrms_with_cal_1
//   CURRENT_CAL = measured_load_A  / reported_Irms_with_cal_1
float VOLTAGE_CAL = 0.4700;   // volts of mains per ADC count (ZMPT101B trimmer dependent)
float CURRENT_CAL = 0.0122;   // amps per ADC count (ACS712-20A at 3.3 V divider)
const float NOISE_FLOOR_A = 0.05;     // below this the load is treated as zero
const float NOISE_FLOOR_V = 20.0;

// ------------------------------------------------------------- timing
const unsigned long PUBLISH_MS = 2000;
const int SAMPLES = 2000;             // ~10 mains cycles at ESP32 analogRead speed
const unsigned long LCD_PAGE_MS = 3000;

// ------------------------------------------------------------- topics
String topicReadings, topicCmd, topicStatus;

WiFiClient net;
PubSubClient mqtt(net);
LiquidCrystal_I2C lcd(0x27, 16, 2);   // try 0x3F if the screen stays blank

double energyWh = 0.0;
float thresholdW = 2000.0;
float vrms = 0, irms = 0, realPower = 0, pf = 1;
unsigned long lastPublish = 0, lastSample = 0, lastLcd = 0, lastWifiTry = 0, lastMqttTry = 0;
int lcdPage = 0;
double offsetV = 2048, offsetI = 2048;  // running DC offsets (ADC counts)

// ------------------------------------------------------------ helpers
void setRelay(int pin, bool on) {
  digitalWrite(pin, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

uint64_t nowMs() {
  time_t t = time(nullptr);
  if (t > 1700000000) {                       // NTP has synced
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    return (uint64_t)tv.tv_sec * 1000ULL + tv.tv_usec / 1000ULL;
  }
  return millis();                            // server re-stamps boot-relative time
}

/* Sample both channels, remove DC with a slow IIR, integrate RMS and v*i. */
void measure() {
  double sumV2 = 0, sumI2 = 0, sumP = 0;
  for (int n = 0; n < SAMPLES; n++) {
    int rawV = analogRead(PIN_VOLTAGE);
    int rawI = analogRead(PIN_CURRENT);
    offsetV += (rawV - offsetV) / 1024.0;
    offsetI += (rawI - offsetI) / 1024.0;
    double v = (rawV - offsetV) * VOLTAGE_CAL;
    double i = (rawI - offsetI) * CURRENT_CAL;
    sumV2 += v * v;
    sumI2 += i * i;
    sumP += v * i;
  }
  vrms = sqrt(sumV2 / SAMPLES);
  irms = sqrt(sumI2 / SAMPLES);
  realPower = fabs(sumP / SAMPLES);
  if (vrms < NOISE_FLOOR_V) vrms = 0;
  if (irms < NOISE_FLOOR_A) { irms = 0; realPower = 0; }
  float apparent = vrms * irms;
  pf = apparent > 1 ? constrain(realPower / apparent, 0.0f, 1.0f) : 1.0f;
}

void onMessage(char* topic, byte* payload, unsigned int length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) {
    Serial.println("cmd: bad JSON");
    return;
  }
  const char* cmd = doc["cmd"] | "";
  if (strcmp(cmd, "setAppliance") == 0) {
    const char* id = doc["appliance_id"] | "";
    bool on = strcmp(doc["state"] | "off", "on") == 0;
    for (size_t k = 0; k < RELAY_COUNT; k++) {
      if (strcmp(RELAYS[k].applianceId, id) == 0) {
        setRelay(RELAYS[k].pin, on);
        Serial.printf("relay %s -> %s\n", id, on ? "ON" : "OFF");
        lcd.clear();
        lcd.setCursor(0, 0); lcd.print("Cmd: "); lcd.print(id);
        lcd.setCursor(0, 1); lcd.print(on ? "Turned ON" : "Turned OFF");
        lastLcd = millis();
        return;
      }
    }
    Serial.printf("cmd for unmapped appliance '%s' ignored\n", id);
  } else if (strcmp(cmd, "setThreshold") == 0) {
    thresholdW = doc["threshold"] | thresholdW;
    Serial.printf("threshold -> %.0f W\n", thresholdW);
  }
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED || millis() - lastWifiTry < 10000) return;
  lastWifiTry = millis();
  Serial.println("WiFi: connecting");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void ensureMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected() || millis() - lastMqttTry < 5000) return;
  lastMqttTry = millis();
  bool ok = strlen(MQTT_USER)
    ? mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASS, topicStatus.c_str(), 1, true, "offline")
    : mqtt.connect(DEVICE_ID, topicStatus.c_str(), 1, true, "offline");
  if (ok) {
    mqtt.publish(topicStatus.c_str(), "online", true);
    mqtt.subscribe(topicCmd.c_str(), 1);
    Serial.println("MQTT: connected");
  } else {
    Serial.printf("MQTT: failed rc=%d\n", mqtt.state());
  }
}

void publishReading() {
  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  doc["ts_ms"] = nowMs();
  doc["voltage_V"] = round(vrms * 100) / 100.0;
  doc["current_A"] = round(irms * 1000) / 1000.0;
  doc["power_W"] = round(realPower * 10) / 10.0;
  doc["pf"] = round(pf * 1000) / 1000.0;
  doc["energyWh_total"] = energyWh;
  char buf[256];
  size_t n = serializeJson(doc, buf);
  if (mqtt.connected()) mqtt.publish(topicReadings.c_str(), (const uint8_t*)buf, n, false);
  Serial.println(buf);
}

void drawLcd() {
  if (millis() - lastLcd < LCD_PAGE_MS) return;
  lastLcd = millis();
  lcd.clear();
  if (lcdPage == 0) {
    lcd.setCursor(0, 0); lcd.printf("%3.0fV  %5.2fA", vrms, irms);
    lcd.setCursor(0, 1); lcd.printf("%5.0fW pf%.2f", realPower, pf);
  } else {
    lcd.setCursor(0, 0); lcd.printf("E %8.3f kWh", energyWh / 1000.0);
    lcd.setCursor(0, 1);
    lcd.print(realPower > thresholdW ? "OVERLOAD!" : (mqtt.connected() ? "Cloud: online" : "Cloud: offline"));
  }
  lcdPage = 1 - lcdPage;
}

// -------------------------------------------------------------- setup
void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  for (size_t k = 0; k < RELAY_COUNT; k++) {
    pinMode(RELAYS[k].pin, OUTPUT);
    setRelay(RELAYS[k].pin, true);            // appliances powered by default
  }

  Wire.begin(I2C_SDA, I2C_SCL);
  lcd.init();
  lcd.backlight();
  lcd.print("Smart Watt v2");
  lcd.setCursor(0, 1);
  lcd.print("Starting...");

  topicReadings = String("smartwatt/readings/") + DEVICE_ID;
  topicCmd = String("smartwatt/cmd/") + DEVICE_ID;
  topicStatus = String("smartwatt/status/") + DEVICE_ID;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lastWifiTry = millis();
  configTime(19800, 0, "pool.ntp.org", "time.google.com");   // IST, UTC+5:30

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMessage);
  mqtt.setBufferSize(512);

  lastSample = millis();
}

// --------------------------------------------------------------- loop
void loop() {
  ensureWifi();
  ensureMqtt();
  mqtt.loop();

  unsigned long now = millis();
  if (now - lastPublish >= PUBLISH_MS) {
    measure();
    unsigned long t = millis();
    energyWh += realPower * (t - lastSample) / 3600000.0;   // Wh over the elapsed interval
    lastSample = t;
    lastPublish = now;
    publishReading();
  }
  drawLcd();
}
