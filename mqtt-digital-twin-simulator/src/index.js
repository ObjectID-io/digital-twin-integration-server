import { readFile } from "node:fs/promises";
import mqtt from "mqtt";
import { createTelemetry } from "./telemetry.js";
import { createControlServer } from "./control-server.js";
import { executeSimulatorCommand } from "./commands.js";

const config = {
  mqttUrl: process.env.MQTT_URL ?? "mqtt://mosquitto:1883",
  username: process.env.MQTT_USERNAME ?? "objectid",
  passwordFile: process.env.MQTT_PASSWORD_FILE ?? "/run/secrets/mqtt_password",
  topic: process.env.MQTT_TOPIC ?? "objectid/twins/telemetry/dataset",
  stateTopic: process.env.SIM_STATE_TOPIC ?? "objectid/twins/telemetry/state",
  qos: integer("MQTT_QOS", 1, 0, 2),
  intervalMs: integer("SIM_INTERVAL_MS", 5000, 1000, 86_400_000),
  assetId: process.env.SIM_ASSET_ID ?? "unknown",
  machineName: process.env.SIM_MACHINE_NAME ?? "mqtt-digital-twin",
  healthPort: integer("HEALTH_PORT", 8081, 1, 65535)
};
config.commandTopic = process.env.SIM_COMMAND_TOPIC ?? `objectid/twins/${config.assetId}/commands/request`;

const status = {
  connected: false,
  published: 0,
  lastPublishedAt: null,
  lastError: null
};

const password = (await readFile(config.passwordFile, "utf8")).trimEnd();
if (!password) throw new Error("MQTT password file is empty");
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
const processedCommands = new Set();

client.on("connect", () => {
  status.connected = true;
  status.lastError = null;
  log("mqtt_connected", { url: config.mqttUrl, topic: config.topic });
  void publishSample();
  timer ??= setInterval(() => void publishSample(), config.intervalMs);
  void client.subscribeAsync(config.commandTopic, { qos: 1 });
});

client.on("message", (_topic, payload) => void handleCommand(payload));

client.on("offline", () => { status.connected = false; });
client.on("close", () => { status.connected = false; });
client.on("error", (error) => {
  status.lastError = error.message;
  log("mqtt_error", { error: error.message });
});

Object.assign(status, { machineName: config.machineName, topic: config.topic });
const healthServer = createControlServer({
  status, control, port: config.healthPort, publishNow: publishSample,
  recordTransition: publishStateTransition,
});

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

async function publishStateTransition({ from, to }) {
  if (!client.connected) throw new Error("MQTT broker is unavailable");
  sequence += 1;
  const sample = createTelemetry({ sequence, machineName: config.machineName, assetId: config.assetId, scenario: to });
  const transition = {
    ...sample,
    transition: {
      kind: to === "normal" ? "fault-cleared" : "fault-opened",
      fromScenario: from,
      toScenario: to,
      source: "dt-simulator-control",
      occurredAt: sample.observedAt,
    },
  };
  await client.publishAsync(config.stateTopic, JSON.stringify(transition), { qos: config.qos, retain: false });
  status.lastTransitionAt = sample.observedAt;
  log("fault_transition_published", { from, to, topic: config.stateTopic, sequence });
}

async function handleCommand(payload) {
  let request;
  try { request = JSON.parse(payload.toString()); } catch { return; }
  const commandId = String(request?.commandId ?? "");
  if (!commandId || processedCommands.has(commandId) || request?.twinId !== config.assetId) return;
  processedCommands.add(commandId);
  if (processedCommands.size > 1000) processedCommands.delete(processedCommands.values().next().value);
  const uuid = commandId.replace(/^urn:uuid:/, "");
  const resultTopic = `objectid/twins/${config.assetId}/commands/${uuid}/result`;
  try {
    await client.publishAsync(resultTopic, JSON.stringify({ specVersion: "objectid.command-result.v1", commandId, twinId: config.assetId, status: "accepted", acceptedAt: new Date().toISOString() }), { qos: 1, retain: false });
    const result = executeSimulatorCommand(control, request);
    await client.publishAsync(resultTopic, JSON.stringify({ specVersion: "objectid.command-result.v1", commandId, twinId: config.assetId, status: "succeeded", completedAt: new Date().toISOString(), result }), { qos: 1, retain: false });
    log("command_succeeded", { commandId, command: request.command?.name, result });
  } catch (error) {
    await client.publishAsync(resultTopic, JSON.stringify({ specVersion: "objectid.command-result.v1", commandId, twinId: config.assetId, status: "failed", completedAt: new Date().toISOString(), error: { code: "SIMULATOR_COMMAND_FAILED", message: error.message } }), { qos: 1, retain: false });
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
