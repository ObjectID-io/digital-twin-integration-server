import { readFile } from "node:fs/promises";

export async function loadSimulatorConfig(env = process.env, read = readFile) {
  const integrationFile = pick(env.OBJECTID_INTEGRATION_CONFIG_FILE);
  let integration = null;
  if (integrationFile) {
    try { integration = parseIntegrationConfig(await read(integrationFile, "utf8")); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const requestedTwinId = pick(env.SIM_TWIN_ID, integration?.objectid?.twinIds?.[0], env.SIM_ASSET_ID, "unknown").toLowerCase();
  const topicSet = integration?.mqtt?.topics?.find((item) => String(item?.twinId).toLowerCase() === requestedTwinId);
  const tenantId = String(integration?.objectid?.tenantId ?? "").trim();
  const tenantRoot = validTwinId(requestedTwinId) && tenantId ? `objectid/tenants/${tenantId}/twins/${requestedTwinId}` : "";
  const passwordFile = integration ? pick(env.SIM_MQTT_PASSWORD_FILE) : pick(env.MQTT_PASSWORD_FILE, "/run/secrets/mqtt_password");
  const password = passwordFile
    ? String(await read(passwordFile, "utf8")).trimEnd()
    : pick(env.SIM_MQTT_PASSWORD, integration?.mqtt?.password, env.MQTT_PASSWORD);
  const config = {
    mqttUrl: pick(env.SIM_MQTT_URL, integration?.mqtt?.endpoint, env.MQTT_URL, "mqtt://mosquitto:1883"),
    username: pick(env.SIM_MQTT_USERNAME, integration?.mqtt?.username, env.MQTT_USERNAME, "objectid"),
    password,
    passwordFile: passwordFile || null,
    topic: pick(env.SIM_MQTT_TOPIC_OVERRIDE, topicSet?.dataset, env.MQTT_TOPIC, tenantRoot ? `${tenantRoot}/telemetry/dataset` : "objectid/twins/telemetry/dataset"),
    stateTopic: pick(env.SIM_STATE_TOPIC_OVERRIDE, topicSet?.state, env.SIM_STATE_TOPIC, tenantRoot ? `${tenantRoot}/telemetry/state` : "objectid/twins/telemetry/state"),
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
  config.commandTopic = pick(env.SIM_COMMAND_TOPIC_OVERRIDE, topicSet?.commandRequests, env.SIM_COMMAND_TOPIC, `objectid/twins/${config.assetId}/commands/request`);
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

export function validateIntegrationConfig(value) {
  const parsed = parseIntegrationConfig(JSON.stringify(value));
  if (!/^[a-z0-9_-]{1,96}$/i.test(String(parsed.objectid.tenantId ?? ""))) throw new Error("Integration configuration contains an invalid tenant ID");
  if (!/^(wss|mqtts):\/\//i.test(String(parsed.mqtt.endpoint ?? ""))) throw new Error("Uploaded MQTT endpoint must use WSS or MQTTS");
  if (!String(parsed.mqtt.username ?? "") || !String(parsed.mqtt.password ?? "")) throw new Error("Integration configuration is missing MQTT credentials");
  for (const twinId of parsed.objectid.twinIds) if (!validTwinId(twinId)) throw new Error("Integration configuration contains an invalid Twin ID");
  for (const topics of parsed.mqtt.topics) {
    if (!validTwinId(topics?.twinId) || !parsed.objectid.twinIds.some((id) => String(id).toLowerCase() === String(topics.twinId).toLowerCase())) throw new Error("MQTT topic assignment references an unknown Twin");
    for (const name of ["state", "dataset", "commandRequests", "commandResults"]) if (!String(topics?.[name] ?? "").startsWith("objectid/")) throw new Error(`MQTT ${name} topic is invalid`);
  }
  return parsed;
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
