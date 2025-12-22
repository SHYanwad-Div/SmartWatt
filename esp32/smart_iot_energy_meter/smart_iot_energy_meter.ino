/* SmartWatt_single_ACS_MQTT + LCD I2C Integrated
   ESP32 reads:
    - ACS712 analog => pin 34
    - ZMPT101B analog => pin 35
   Publishes JSON to MQTT
   Displays Voltage/Current/Power/Energy on 16x2 LCD (I2C)
*/

#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <LiquidCrystal_I2C.h>

const char* WIFI_SSID = "Shyanawad 5G";
const char* WIFI_PASS = "Stgoud@73";

// 🔹 UPDATED: use your laptop IP as MQTT broker
const char* MQTT_BROKER = "192.168.29.156";
const uint16_t MQTT_PORT = 1883;
const char* DEVICE_ID = "esp32-smartwatt-001";

const int PIN_CURRENT = 34;
const int PIN_VOLTAGE = 35;

// LCD I2C pins
#define I2C_SDA 21
#define I2C_SCL 22
LiquidCrystal_I2C lcd(0x27, 16, 2);  // change 0x27 to 0x3F if your LCD uses that

// sampling
const unsigned long PUBLISH_INTERVAL_MS = 2000;
const int SAMPLE_COUNT = 300;
const int SAMPLE_DELAY_US = 200;

float ACS_SENSITIVITY = 0.066;
float VOLTAGE_DIVIDER_SCALE = 230.0 / 0.1;
const float VREF_MID = 1.65;

const float STEP_THRESHOLD_W = 30.0;
const int STEP_SUSTAIN_MS = 1500;

String TOPIC_READINGS;
String TOPIC_EVENTS;
String TOPIC_CMD;

WiFiClient espClient;
PubSubClient mqtt(espClient);

unsigned long lastPublish = 0;
unsigned long lastEnergyMillis = 0;
double energyWh_total = 0.0;
float powerThreshold = 2000.0;

float lastPublishedPower = 0.0;
unsigned long stepCandidateStart = 0;
float stepCandidateDelta = 0;

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String s;
  for (unsigned int i = 0; i < length; i++) s += (char)payload[i];

  StaticJsonDocument<200> doc;
  DeserializationError err = deserializeJson(doc, s);
  if (!err) {
    if (doc["cmd"] == "setThreshold") {
      powerThreshold = doc["threshold"];
      Serial.printf("Threshold updated: %.1f W\n", powerThreshold);
    }
  } else {
    Serial.print("MQTT JSON parse error: ");
    Serial.println(err.c_str());
  }
}

void connectWiFi() {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("WiFi connecting...");
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected!");
  Serial.println(WiFi.localIP());
}

void connectMQTT() {
  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  while (!mqtt.connected()) {
    Serial.print("MQTT connecting...");
    if (mqtt.connect(DEVICE_ID)) {
      Serial.println("connected");
      TOPIC_READINGS = "smartwatt/readings/" + String(DEVICE_ID);
      TOPIC_EVENTS   = "smartwatt/events/" + String(DEVICE_ID);
      TOPIC_CMD      = "smartwatt/cmd/" + String(DEVICE_ID);
      mqtt.subscribe(TOPIC_CMD.c_str());
    } else {
      Serial.print(" failed, rc=");
      Serial.println(mqtt.state());
      delay(2000);
    }
  }
}

float readADCAvg(int pin, int n, int usDelay) {
  long sum = 0;
  for (int i = 0; i < n; i++) {
    sum += analogRead(pin);
    delayMicroseconds(usDelay);
  }
  return sum / (float)n;
}

void publishEvent(float deltaW, String direction) {
  StaticJsonDocument<256> doc;
  doc["device_id"] = DEVICE_ID;
  doc["ts_ms"] = millis();
  doc["deltaW"] = deltaW;
  doc["direction"] = direction;
  doc["power_now"] = lastPublishedPower;

  char buf[256];
  serializeJson(doc, buf);
  mqtt.publish(TOPIC_EVENTS.c_str(), buf);
  Serial.println(buf);
}

void setup() {
  Serial.begin(115200);
  delay(200);

  // LCD init
  Wire.begin(I2C_SDA, I2C_SCL);
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("SmartWatt");
  lcd.setCursor(0, 1);
  lcd.print("Booting...");

  analogReadResolution(12);
  connectWiFi();
  connectMQTT();

  lastEnergyMillis = millis();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!mqtt.connected()) connectMQTT();
  mqtt.loop();

  unsigned long now = millis();
  if (now - lastPublish >= PUBLISH_INTERVAL_MS) {
    lastPublish = now;

    float avgADC_I = readADCAvg(PIN_CURRENT, SAMPLE_COUNT, SAMPLE_DELAY_US);
    float avgADC_V = readADCAvg(PIN_VOLTAGE, SAMPLE_COUNT, SAMPLE_DELAY_US);

    float voltsPerCount = 3.3f / 4095.0f;
    float vI = avgADC_I * voltsPerCount;
    float vV = avgADC_V * voltsPerCount;

    float iSignalV = vI - VREF_MID;
    float vSignalV = vV - VREF_MID;

    float Irms = fabs(iSignalV) / ACS_SENSITIVITY;
    float Vrms = fabs(vSignalV) * VOLTAGE_DIVIDER_SCALE;
    float powerW = Irms * Vrms;

    unsigned long dt = now - lastEnergyMillis;
    energyWh_total += powerW * ((double)dt / 3600000.0);
    lastEnergyMillis = now;
    lastPublishedPower = powerW;

    // ===== LCD UPDATE =====
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("V:");
    lcd.print((int)Vrms);
    lcd.print(" I:");
    lcd.print(Irms, 2);

    lcd.setCursor(0, 1);
    lcd.print("P:");
    lcd.print(powerW, 0);
    lcd.print("W ");

    lcd.print(energyWh_total / 1000.0, 2);
    lcd.print("kWh");
    // ======================

    StaticJsonDocument<512> doc;
    doc["device_id"] = DEVICE_ID;
    doc["ts_ms"] = now;
    doc["voltage_V"] = Vrms;
    doc["current_A"] = Irms;
    doc["power_W"] = powerW;
    doc["energyWh_total"] = energyWh_total;
    doc["threshold_W"] = powerThreshold;

    char out[512];
    serializeJson(doc, out);
    mqtt.publish(TOPIC_READINGS.c_str(), out);
    Serial.println(out);

    static float prevPower = 0.0;
    float diff = powerW - prevPower;
    if (fabs(diff) >= STEP_THRESHOLD_W) {
      if (stepCandidateStart == 0) {
        stepCandidateStart = now;
        stepCandidateDelta = diff;
      } else if (now - stepCandidateStart >= STEP_SUSTAIN_MS) {
        publishEvent(stepCandidateDelta, stepCandidateDelta > 0 ? "ON" : "OFF");
        stepCandidateStart = 0;
      }
    } else {
      stepCandidateStart = 0;
    }
    prevPower = powerW;
  }

  delay(10);
}