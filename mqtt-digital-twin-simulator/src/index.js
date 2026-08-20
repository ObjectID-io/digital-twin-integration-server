import { readFile } from "node:fs/promises";
import mqtt from "mqtt";
import { createTelemetry } from "./telemetry.js";
import { createControlServer } from "./control-server.js";
import { executeSimulatorCommand, verifySimulatorCommand } from "./commands.js";
import { loadSimulatorConfig } from "./config.js";

const config = await loadSimulatorConfig();

const status = {
  connected: false,
  published: 0,
  lastPublishedAt: null,
  lastError: null
};

const commandSigningKey = Buffer.from((await readFile(config.commandSigningKeyFile, "utf8")).trim(), "base64");
if (commandSigningKey.length < 32) throw new Error("Simulator command signing key must contain at least 32 random bytes encoded as base64");
const client = mqtt.connect(config.mqttUrl, {
  username: config.username,
  password: config.password,
  clientId: `oid-simulator-${config.machineName.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
  clean: true,
  connectTimeout: 10_000,
  reconnectPeriod: 5_000
});

let sequence = 0;
let timer;
let publishing = false;
const control = { scenario: "normal", paused: false, changedAt: new Date().toISOString() };
const processedCommands = new Map();

client.on("connect", () => {
  status.connected = true;
  status.lastError = null;
  log("mqtt_connected", { url: config.mqttUrl, topic: config.topic, twinId: config.assetId, tenantId: config.tenantId, credentialSource: config.credentialSource });
  void publishSample();
  timer ??= setInterval(() => void publishSample(), config.intervalMs);
  void client.subscribeAsync(config.commandTopic, { qos: 1 });
});

client.on("message", (topic, payload) => void handleCommand(topic, payload));

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

async function handleCommand(topic, payload) {
  let request;
  try { request = JSON.parse(payload.toString()); }
  catch { log("command_rejected", { code: "COMMAND_JSON_INVALID" }); return; }
  const commandId = String(request?.commandId ?? "");
  const validId = /^urn:uuid:[0-9a-f-]{36}$/i.test(commandId);
  if (topic !== config.commandTopic || request?.twinId !== config.assetId || !validId) { log("command_rejected", { commandId, code: "COMMAND_ROUTE_INVALID" }); return; }
  const uuid = commandId.replace(/^urn:uuid:/, "");
  const resultTopic = `objectid/twins/${config.assetId}/commands/${uuid}/result`;
  const prior = processedCommands.get(commandId);
  if (prior) { await publishCommandResult(resultTopic, prior); log("command_result_replayed", { commandId }); return; }
  try {
    verifySimulatorCommand(request, { assetId: config.assetId, interfaceId: config.commandInterfaceId, signingKey: commandSigningKey, signingKeyId: config.commandSigningKeyId });
    await publishCommandResult(resultTopic, resultEnvelope(commandId, "accepted", { acceptedAt: new Date().toISOString() }));
    await publishCommandResult(resultTopic, resultEnvelope(commandId, "executing", { startedAt: new Date().toISOString() }));
    const previousScenario = control.scenario;
    const result = executeSimulatorCommand(control, request);
    if (previousScenario !== control.scenario) await publishStateTransition({ from: previousScenario, to: control.scenario });
    const final = resultEnvelope(commandId, "succeeded", { completedAt: new Date().toISOString(), result });
    rememberResult(commandId, final);
    await publishCommandResult(resultTopic, final);
    log("command_succeeded", { commandId, command: request.command?.name, result });
  } catch (error) {
    const status = error?.code ? "rejected" : "failed";
    const final = resultEnvelope(commandId, status, { completedAt: new Date().toISOString(), error: { code: error?.code ?? "SIMULATOR_COMMAND_FAILED", message: error instanceof Error ? error.message : String(error) } });
    rememberResult(commandId, final);
    await publishCommandResult(resultTopic, final);
    log("command_rejected", { commandId, code: final.error.code });
  }
}

function resultEnvelope(commandId, status, fields) { return { specVersion: "objectid.command-result.v1", commandId, twinId: config.assetId, status, ...fields }; }
async function publishCommandResult(topic, value) { await client.publishAsync(topic, JSON.stringify(value), { qos: 1, retain: false }); }
function rememberResult(commandId, result) {
  processedCommands.set(commandId, result);
  if (processedCommands.size > 1000) processedCommands.delete(processedCommands.keys().next().value);
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

function log(event, fields = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
}
