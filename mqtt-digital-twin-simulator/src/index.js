import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import mqtt from "mqtt";
import { createTelemetry } from "./telemetry.js";
import { applyCommand, createControlServer } from "./control-server.js";
import { executeSimulatorCommand, verifySimulatorCommand } from "./commands.js";
import { loadSimulatorConfig, loadSimulatorConfigFromValue, validateIntegrationConfig } from "./config.js";

const configDirectory = process.env.OBJECTID_SIMULATOR_CONFIG_DIR ?? "/data/twins";
const legacyConfigFile = process.env.OBJECTID_INTEGRATION_CONFIG_FILE ?? "/data/integration.json";
const controlPasswordFile = process.env.SIM_CONTROL_PASSWORD_FILE ?? "/run/secrets/sim_control_password";
const controlPassword = (await readFile(controlPasswordFile, "utf8")).trimEnd();
if (!controlPassword) throw new Error("Simulator control password file is empty");
const signingKeyFile = process.env.SIM_COMMAND_SIGNING_KEY_FILE ?? "/run/secrets/command_signing_key";
const commandSigningKey = Buffer.from((await readFile(signingKeyFile, "utf8")).trim(), "base64");
if (commandSigningKey.length < 32) throw new Error("Simulator command signing key must contain at least 32 random bytes encoded as base64");

const runtimes = new Map();
await loadConfiguredTwins();

const controlServer = createControlServer({
  port: Number(process.env.HEALTH_PORT ?? 8081),
  getStatus: fleetStatus,
  controlTwin,
  adminPassword: controlPassword,
  installIntegrationConfig,
  removeIntegrationConfig,
});

async function loadConfiguredTwins() {
  let files = [];
  try { files = (await readdir(configDirectory)).filter((name) => name.endsWith(".json")).sort(); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  for (const file of files) {
    try { await activateIntegrationConfig(JSON.parse(await readFile(join(configDirectory, file), "utf8"))); }
    catch (error) { log("stored_twin_config_rejected", { file, error: message(error) }); }
  }
  if (runtimes.size) return;
  try {
    await installIntegrationConfig(JSON.parse(await readFile(legacyConfigFile, "utf8")));
    log("legacy_config_migrated", { directory: configDirectory });
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") log("legacy_config_rejected", { error: message(error) });
  }
  const fallback = await loadSimulatorConfig();
  runtimes.set(fallback.assetId, createTwinRuntime(fallback));
}

async function activateIntegrationConfig(value) {
  const validated = validateIntegrationConfig(value);
  const activated = [];
  for (const twinIdValue of validated.objectid.twinIds) {
    const twinId = String(twinIdValue).toLowerCase();
    const config = await loadSimulatorConfigFromValue(value, process.env, readFile, twinId);
    const previous = runtimes.get(twinId);
    if (previous) await previous.stop();
    runtimes.set(twinId, createTwinRuntime(config));
    activated.push({ twinId, machineName: config.machineName, network: config.network });
  }
  if (runtimes.has("unknown") && activated.length) {
    await runtimes.get("unknown").stop();
    runtimes.delete("unknown");
  }
  return activated;
}

async function installIntegrationConfig(value) {
  const validated = validateIntegrationConfig(value);
  await mkdir(configDirectory, { recursive: true });
  const storedValues = [];
  for (const twinIdValue of validated.objectid.twinIds) {
    const twinId = String(twinIdValue).toLowerCase();
    const stored = scopedConfiguration(validated, twinId);
    const target = join(configDirectory, `${twinId}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    storedValues.push(stored);
  }
  const twins = [];
  for (const stored of storedValues) twins.push(...await activateIntegrationConfig(stored));
  return { installed: twins.length, twins };
}

async function removeIntegrationConfig(twinIdValue) {
  const twinId = String(twinIdValue ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(twinId)) throw new Error("A valid Twin ID is required");
  const runtime = runtimes.get(twinId);
  if (!runtime) throw new Error("Simulated Twin is not configured");
  await runtime.stop();
  runtimes.delete(twinId);
  await unlink(join(configDirectory, `${twinId}.json`)).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  return { twinId };
}

function scopedConfiguration(validated, twinId) {
  const topics = validated.mqtt.topics.find((item) => String(item.twinId).toLowerCase() === twinId);
  const sourceTwin = String(validated.twin?.id ?? "").toLowerCase() === twinId ? validated.twin : null;
  return {
    specVersion: "objectid.device-provisioning.v1",
    generatedAt: validated.generatedAt,
    objectid: { network: validated.objectid.network ?? "testnet", tenantId: validated.objectid.tenantId, subscriptionId: validated.objectid.subscriptionId },
    twin: { id: twinId, name: sourceTwin?.name ?? `Simulated Twin ${twinId.slice(2, 10)}`, type: sourceTwin?.type ?? "machine" },
    mqtt: {
      endpoint: validated.mqtt.endpoint,
      clientId: validated.mqtt.clientId,
      username: validated.mqtt.username,
      password: validated.mqtt.password,
      topics: { state: topics.state, dataset: topics.dataset, commandRequests: topics.commandRequests, commandResults: topics.commandResults },
    },
  };
}

async function controlTwin(command) {
  const twinId = String(command?.twinId ?? "").toLowerCase();
  const runtime = runtimes.get(twinId) ?? (runtimes.size === 1 ? runtimes.values().next().value : null);
  if (!runtime) throw new Error("Select a configured simulated Twin");
  const result = applyCommand(command, runtime.control);
  await runtime.publishSample();
  if (result.scenarioChanged) await runtime.publishStateTransition({ from: result.previousScenario, to: runtime.control.scenario });
  return runtime.publicStatus();
}

function fleetStatus() {
  const twins = [...runtimes.values()].map((runtime) => runtime.publicStatus());
  return {
    connected: twins.some((twin) => twin.connected),
    allConnected: twins.length > 0 && twins.every((twin) => twin.connected),
    configured: twins.filter((twin) => twin.twinId !== "unknown").length,
    totalPublished: twins.reduce((sum, twin) => sum + twin.published, 0),
    twins,
  };
}

function createTwinRuntime(config) {
  const status = { connected: false, published: 0, lastPublishedAt: null, lastError: null };
  const control = { scenario: "normal", paused: config.assetId === "unknown", changedAt: new Date().toISOString() };
  const processedCommands = new Map();
  let sequence = 0;
  let timer;
  let publishing = false;
  const suffix = config.assetId === "unknown" ? "bootstrap" : config.assetId.slice(-12);
  const client = mqtt.connect(config.mqttUrl, {
    username: config.username,
    password: config.password,
    clientId: config.clientId || `oid-simulator-${suffix}`,
    clean: true,
    connectTimeout: 10_000,
    reconnectPeriod: 5_000,
  });

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
  client.on("error", (error) => { status.lastError = error.message; log("mqtt_error", { twinId: config.assetId, error: error.message }); });

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
      log("telemetry_published", { twinId: config.assetId, sequence, topic: config.topic, scenario: control.scenario });
    } catch (error) {
      status.lastError = message(error);
      log("publish_error", { twinId: config.assetId, error: status.lastError });
    } finally { publishing = false; }
  }

  async function publishStateTransition({ from, to }) {
    if (!client.connected) throw new Error("MQTT broker is unavailable");
    sequence += 1;
    const sample = createTelemetry({ sequence, machineName: config.machineName, assetId: config.assetId, scenario: to });
    const transition = { ...sample, transition: { kind: to === "normal" ? "fault-cleared" : "fault-opened", fromScenario: from, toScenario: to, source: "dt-simulator-control", occurredAt: sample.observedAt } };
    await client.publishAsync(config.stateTopic, JSON.stringify(transition), { qos: config.qos, retain: false });
    status.lastTransitionAt = sample.observedAt;
    log("fault_transition_published", { twinId: config.assetId, from, to, topic: config.stateTopic, sequence });
  }

  async function handleCommand(topic, payload) {
    let request;
    try { request = JSON.parse(payload.toString()); }
    catch { log("command_rejected", { twinId: config.assetId, code: "COMMAND_JSON_INVALID" }); return; }
    const commandId = String(request?.commandId ?? "");
    const validId = /^urn:uuid:[0-9a-f-]{36}$/i.test(commandId);
    if (topic !== config.commandTopic || request?.twinId !== config.assetId || !validId) { log("command_rejected", { twinId: config.assetId, commandId, code: "COMMAND_ROUTE_INVALID" }); return; }
    const uuid = commandId.replace(/^urn:uuid:/, "");
    const resultTopic = config.commandResultsTopic.replace("+", uuid);
    const prior = processedCommands.get(commandId);
    if (prior) { await publishCommandResult(resultTopic, prior); return; }
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
    } catch (error) {
      const final = resultEnvelope(commandId, error?.code ? "rejected" : "failed", { completedAt: new Date().toISOString(), error: { code: error?.code ?? "SIMULATOR_COMMAND_FAILED", message: message(error) } });
      rememberResult(commandId, final);
      await publishCommandResult(resultTopic, final);
      log("command_rejected", { twinId: config.assetId, commandId, code: final.error.code });
    }
  }

  function resultEnvelope(commandId, commandStatus, fields) { return { specVersion: "objectid.command-result.v1", commandId, twinId: config.assetId, status: commandStatus, ...fields }; }
  async function publishCommandResult(topic, value) { await client.publishAsync(topic, JSON.stringify(value), { qos: 1, retain: false }); }
  function rememberResult(commandId, result) {
    processedCommands.set(commandId, result);
    if (processedCommands.size > 1000) processedCommands.delete(processedCommands.keys().next().value);
  }
  function publicStatus() {
    return { ...status, scenario: control.scenario, paused: control.paused, changedAt: control.changedAt, machineName: config.machineName, topic: config.topic, twinId: config.assetId, tenantId: config.tenantId, network: config.network, credentialSource: config.credentialSource };
  }
  async function stop() {
    if (timer) clearInterval(timer);
    await client.endAsync().catch(() => undefined);
  }
  return { control, publishSample, publishStateTransition, publicStatus, stop };
}

async function shutdown(signal) {
  log("shutdown", { signal });
  await Promise.all([...runtimes.values()].map((runtime) => runtime.stop()));
  controlServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

function message(error) { return error instanceof Error ? error.message : String(error); }
function log(event, fields = {}) { console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })); }
