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
