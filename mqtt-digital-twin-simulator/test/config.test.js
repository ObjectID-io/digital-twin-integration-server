import test from "node:test";
import assert from "node:assert/strict";
import { loadSimulatorConfig } from "../src/config.js";

const twinId = `0x${"a".repeat(64)}`;
const integration = {
  objectid: { tenantId: "free-customer", subscriptionId: `0x${"b".repeat(64)}`, twinIds: [twinId] },
  mqtt: {
    endpoint: "wss://dtis.objectid.io/mqtt",
    username: "oid_free-customer",
    password: "dedicated-secret",
    topics: [{
      twinId,
      state: `objectid/tenants/free-customer/twins/${twinId}/telemetry/state`,
      dataset: `objectid/tenants/free-customer/twins/${twinId}/telemetry/dataset`,
      commandRequests: `objectid/twins/${twinId}/commands/request`,
      commandResults: `objectid/twins/${twinId}/commands/+/result`,
    }],
  },
};

const deviceIntegration = {
  specVersion: "objectid.device-provisioning.v1",
  generatedAt: "2026-08-23T10:00:00.000Z",
  objectid: { network: "mainnet", tenantId: "free-customer", subscriptionId: `0x${"b".repeat(64)}` },
  twin: { id: twinId, name: "Packaging line", type: "machine" },
  mqtt: {
    endpoint: "wss://dtis.objectid.io/mqtt-mainnet",
    clientId: "oid_device_mainnet_free-customer_aaaaaaaa",
    username: "oid_device_mainnet_free-customer_aaaaaaaa",
    password: "twin-only-secret",
    topics: {
      state: `objectid/mainnet/tenants/free-customer/twins/${twinId}/telemetry/state`,
      dataset: `objectid/mainnet/tenants/free-customer/twins/${twinId}/telemetry/dataset`,
      commandRequests: `objectid/mainnet/twins/${twinId}/commands/request`,
      commandResults: `objectid/mainnet/twins/${twinId}/commands/+/result`,
    },
  },
};

test("loads dedicated tenant credentials and topics from the downloaded configuration", async () => {
  const config = await loadSimulatorConfig(
    { OBJECTID_INTEGRATION_CONFIG_FILE: "/credentials.json" },
    async (path) => { assert.equal(path, "/credentials.json"); return JSON.stringify(integration); },
  );
  assert.equal(config.mqttUrl, "wss://dtis.objectid.io/mqtt");
  assert.equal(config.username, "oid_free-customer");
  assert.equal(config.password, "dedicated-secret");
  assert.equal(config.assetId, twinId);
  assert.equal(config.topic, integration.mqtt.topics[0].dataset);
  assert.equal(config.stateTopic, integration.mqtt.topics[0].state);
  assert.equal(config.commandTopic, integration.mqtt.topics[0].commandRequests);
  assert.equal(config.credentialSource, "integration-file");
  assert.equal(config.intervalMs, 15000);
});

test("loads a Twin-scoped device configuration", async () => {
  const config = await loadSimulatorConfig(
    { OBJECTID_INTEGRATION_CONFIG_FILE: "/twin.json" },
    async () => JSON.stringify(deviceIntegration),
  );
  assert.equal(config.network, "mainnet");
  assert.equal(config.assetId, twinId);
  assert.equal(config.username, deviceIntegration.mqtt.username);
  assert.equal(config.password, deviceIntegration.mqtt.password);
  assert.equal(config.topic, deviceIntegration.mqtt.topics.dataset);
  assert.equal(config.stateTopic, deviceIntegration.mqtt.topics.state);
  assert.equal(config.commandTopic, deviceIntegration.mqtt.topics.commandRequests);
  assert.equal(config.commandResultsTopic, deviceIntegration.mqtt.topics.commandResults);
  assert.equal(config.clientId, deviceIntegration.mqtt.clientId);
  assert.equal(config.machineName, "Packaging line");
});

test("keeps uploaded credentials authoritative while allowing simulator settings and explicit overrides", async () => {
  const config = await loadSimulatorConfig(
    { OBJECTID_INTEGRATION_CONFIG_FILE: "/credentials.json", MQTT_URL: "mqtt://legacy:1883", MQTT_TOPIC: "legacy/topic", SIM_MQTT_TOPIC_OVERRIDE: "custom/topic", SIM_INTERVAL_MS: "10000" },
    async () => JSON.stringify(integration),
  );
  assert.equal(config.mqttUrl, "wss://dtis.objectid.io/mqtt");
  assert.equal(config.topic, "custom/topic");
  assert.equal(config.intervalMs, 10000);
});

test("rejects a malformed downloaded credentials file", async () => {
  await assert.rejects(() => loadSimulatorConfig({ OBJECTID_INTEGRATION_CONFIG_FILE: "/bad.json" }, async () => "{}"), /objectid and mqtt sections/);
});

test("starts in fallback mode before the first web upload", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const config = await loadSimulatorConfig(
    { OBJECTID_INTEGRATION_CONFIG_FILE: "/data/integration.json", SIM_ASSET_ID: "unknown" },
    async (path) => { if (path === "/data/integration.json") throw missing; return "bootstrap-secret"; },
  );
  assert.equal(config.assetId, "unknown");
  assert.equal(config.credentialSource, "environment");
});
