import { readFile } from "node:fs/promises";
import mqtt from "mqtt";
import { createTelemetry } from "./telemetry.js";
import { createControlServer } from "./control-server.js";

const config = {
  mqttUrl: process.env.MQTT_URL ?? "mqtt://mosquitto:1883",
  username: process.env.MQTT_USERNAME ?? "objectid",
  passwordFile: process.env.MQTT_PASSWORD_FILE ?? "/run/secrets/mqtt_password",
  topic: process.env.MQTT_TOPIC ?? "objectid/twins/telemetry/dataset",
  qos: integer("MQTT_QOS", 1, 0, 2),
  intervalMs: integer("SIM_INTERVAL_MS", 5000, 1000, 86_400_000),
  assetId: process.env.SIM_ASSET_ID ?? "unknown",
  machineName: process.env.SIM_MACHINE_NAME ?? "mqtt-digital-twin",
  healthPort: integer("HEALTH_PORT", 8081, 1, 65535),
  controlUsername: process.env.SIM_CONTROL_USERNAME ?? "objectid-admin",
  controlPasswordFile: process.env.SIM_CONTROL_PASSWORD_FILE ?? "/run/secrets/sim_control_password"
};

const status = {
  connected: false,
  published: 0,
  lastPublishedAt: null,
  lastError: null
};

const password = (await readFile(config.passwordFile, "utf8")).trimEnd();
if (!password) throw new Error("MQTT password file is empty");
const controlPassword = (await readFile(config.controlPasswordFile, "utf8")).trimEnd();
if (!controlPassword) throw new Error("Simulator control password file is empty");

const client = mqtt.connect(config.mqttUrl, {
  username: config.username,
  password,
  clientId: `oid-simulator-${config.machineName.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
  clean: true,
  connectTimeout: 10_000,
  reconnectPeriod: 5_000
});

let sequence = 0;
let timer;
let publishing = false;
const control = { scenario: "normal", paused: false, changedAt: new Date().toISOString() };

client.on("connect", () => {
  status.connected = true;
  status.lastError = null;
  log("mqtt_connected", { url: config.mqttUrl, topic: config.topic });
  void publishSample();
  timer ??= setInterval(() => void publishSample(), config.intervalMs);
});

client.on("offline", () => { status.connected = false; });
client.on("close", () => { status.connected = false; });
client.on("error", (error) => {
  status.lastError = error.message;
  log("mqtt_error", { error: error.message });
});

Object.assign(status, { machineName: config.machineName, topic: config.topic });
const healthServer = createControlServer({ status, control, username: config.controlUsername, password: controlPassword, port: config.healthPort, publishNow: publishSample });

async function publishSample() {
  if (!client.connected || publishing || control.paused) return;
  publishing = true;
  try {
    sequence += 1;
    const sample = createTelemetry({ sequence, machineName: config.machineName, assetId: config.assetId, scenario: control.scenario });
    await client.publishAsync(config.topic, JSON.stringify(sample), { qos: config.qos, retain: false });
    status.published += 1;
    status.lastPublishedAt = sample.observedAt;
    status.lastError = null;
    log("telemetry_published", { sequence, topic: config.topic, scenario: control.scenario });
  } catch (error) {
    status.lastError = error instanceof Error ? error.message : String(error);
    log("publish_error", { error: status.lastError });
  } finally {
    publishing = false;
  }
}

async function shutdown(signal) {
  log("shutdown", { signal });
  if (timer) clearInterval(timer);
  await client.endAsync().catch(() => undefined);
  healthServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

function integer(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
}
