import { readFile } from "node:fs/promises";

export async function loadSimulatorConfig(env = process.env, read = readFile) {
  const integrationFile = pick(env.OBJECTID_INTEGRATION_CONFIG_FILE);
  const integration = integrationFile ? parseIntegrationConfig(await read(integrationFile, "utf8")) : null;
  const requestedTwinId = pick(env.SIM_ASSET_ID, env.SIM_TWIN_ID, integration?.objectid?.twinIds?.[0], "unknown").toLowerCase();
  const topicSet = integration?.mqtt?.topics?.find((item) => String(item?.twinId).toLowerCase() === requestedTwinId);
  const tenantId = String(integration?.objectid?.tenantId ?? "").trim();
  const tenantRoot = validTwinId(requestedTwinId) && tenantId ? `objectid/tenants/${tenantId}/twins/${requestedTwinId}` : "";
  const passwordFile = pick(env.MQTT_PASSWORD_FILE, !integration ? "/run/secrets/mqtt_password" : "");
  const password = passwordFile
    ? String(await read(passwordFile, "utf8")).trimEnd()
    : pick(env.MQTT_PASSWORD, integration?.mqtt?.password);
  const config = {
    mqttUrl: pick(env.MQTT_URL, integration?.mqtt?.endpoint, "mqtt://mosquitto:1883"),
    username: pick(env.MQTT_USERNAME, integration?.mqtt?.username, "objectid"),
    password,
    passwordFile: passwordFile || null,
    topic: pick(env.MQTT_TOPIC, topicSet?.dataset, tenantRoot ? `${tenantRoot}/telemetry/dataset` : "objectid/twins/telemetry/dataset"),
    stateTopic: pick(env.SIM_STATE_TOPIC, topicSet?.state, tenantRoot ? `${tenantRoot}/telemetry/state` : "objectid/twins/telemetry/state"),
    qos: integer(env, "MQTT_QOS", 1, 0, 2),
    intervalMs: integer(env, "SIM_INTERVAL_MS", 5000, 1000, 86_400_000),
    assetId: requestedTwinId,
    tenantId: tenantId || null,
    machineName: pick(env.SIM_MACHINE_NAME, "mqtt-digital-twin"),
    commandInterfaceId: pick(env.SIM_COMMAND_INTERFACE_ID, "urn:objectid:interface:simulator-control:v1"),
    commandSigningKeyFile: pick(env.SIM_COMMAND_SIGNING_KEY_FILE, "/run/secrets/command_signing_key"),
    commandSigningKeyId: pick(env.SIM_COMMAND_SIGNING_KEY_ID, "dtis-command-v1"),
    healthPort: integer(env, "HEALTH_PORT", 8081, 1, 65535),
    credentialSource: integration ? "integration-file" : "environment",
  };
  config.commandTopic = pick(env.SIM_COMMAND_TOPIC, topicSet?.commandRequests, `objectid/twins/${config.assetId}/commands/request`);
  validate(config, integrationFile);
  return config;
}

function parseIntegrationConfig(raw) {
  let value;
  try { value = JSON.parse(String(raw)); }
  catch { throw new Error("ObjectID integration configuration file is not valid JSON"); }
  if (!value || typeof value !== "object" || !value.mqtt || !value.objectid) throw new Error("ObjectID integration configuration must contain objectid and mqtt sections");
  if (!Array.isArray(value.objectid.twinIds) || !Array.isArray(value.mqtt.topics)) throw new Error("ObjectID integration configuration does not contain Twin topic assignments");
  return value;
}

function validate(config, integrationFile) {
  if (!/^(mqtt|mqtts|ws|wss):\/\//i.test(config.mqttUrl)) throw new Error("MQTT_URL must use mqtt, mqtts, ws or wss");
  if (!config.username || !config.password) throw new Error(`MQTT credentials are missing${integrationFile ? " from the integration configuration" : ""}`);
  if (!validTwinId(config.assetId) && config.assetId !== "unknown") throw new Error("SIM_ASSET_ID must be a valid ObjectID Twin ID");
  if (integrationFile && !validTwinId(config.assetId)) throw new Error("The integration configuration does not contain a usable Twin ID");
}

function validTwinId(value) { return /^0x[0-9a-f]{64}$/i.test(String(value)); }

function pick(...values) {
  for (const value of values) { if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim(); }
  return "";
}

function integer(env, name, fallback, minimum, maximum) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}
