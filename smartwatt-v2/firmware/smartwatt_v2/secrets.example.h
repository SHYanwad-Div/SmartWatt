// Copy this file to secrets.h (git-ignored) and fill in your values.
#pragma once

#define WIFI_SSID     "your-wifi-name"
#define WIFI_PASS     "your-wifi-password"

// IP of the machine running mosquitto (usually the laptop running Smart Watt).
#define MQTT_HOST     "192.168.1.10"
#define MQTT_PORT     1883
#define MQTT_USER     ""
#define MQTT_PASS     ""

// Must be unique per meter; appears as the device id on the dashboard.
#define DEVICE_ID     "esp32-smartwatt-001"
