import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { applyCommand, createControlServer, isHostedDeviceProvisioning } from "../src/control-server.js";

const hostedTwinId = `0x${"a".repeat(64)}`;
const hostedDeviceFile = {
  specVersion: "objectid.device-provisioning.v1",
  objectid: { network: "mainnet", tenantId: "tenant-a", subscriptionId: `0x${"b".repeat(64)}` },
  twin: { id: hostedTwinId, name: "Machine A", type: "machine" },
  mqtt: {
    endpoint: "wss://dtis.objectid.io/mqtt-mainnet", clientId: "device-a", username: "device-a", password: "secret-a",
    topics: {
      state: `objectid/mainnet/tenants/tenant-a/twins/${hostedTwinId}/telemetry/state`,
      dataset: `objectid/mainnet/tenants/tenant-a/twins/${hostedTwinId}/telemetry/dataset`,
      commandRequests: `objectid/mainnet/twins/${hostedTwinId}/commands/request`,
      commandResults: `objectid/mainnet/twins/${hostedTwinId}/commands/+/result`,
    },
  },
};

test("applies simulator control commands", () => {
  const control = { scenario: "normal", paused: false, mobileEnabled: false };
  const transition = applyCommand({ action: "scenario", scenario: "overheat" }, control);
  assert.equal(control.scenario, "overheat");
  assert.deepEqual(transition, { previousScenario: "normal", scenarioChanged: true });
  assert.equal(applyCommand({ action: "scenario", scenario: "overheat" }, control).scenarioChanged, false);
  applyCommand({ action: "enable-mobility" }, control);
  assert.equal(control.mobileEnabled, true);
  applyCommand({ action: "toggle-mobility" }, control);
  assert.equal(control.mobileEnabled, false);
  applyCommand({ action: "pause" }, control);
  assert.equal(control.paused, true);
  const cleared = applyCommand({ action: "reset" }, control);
  assert.deepEqual({ scenario: control.scenario, paused: control.paused }, { scenario: "normal", paused: false });
  assert.deepEqual(cleared, { previousScenario: "overheat", scenarioChanged: true });
});

test("rejects unknown scenarios", () => {
  assert.throws(() => applyCommand({ action: "scenario", scenario: "meltdown" }, { scenario: "normal", paused: false }), /Unsupported/);
});

test("exposes the demo control API and applies commands", async (context) => {
  const status = { connected: true, published: 3 };
  const control = { scenario: "normal", paused: false };
  const transitions = [];
  const server = createControlServer({
    status, control, port: 0,
    publishNow: async () => undefined,
    recordTransition: async (transition) => transitions.push(transition),
  });
  context.after(() => server.close());
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${baseUrl}/api/status`)).status, 200);
  const response = await fetch(`${baseUrl}/api/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "scenario", scenario: "pressure-loss" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).scenario, "pressure-loss");
  assert.deepEqual(transitions, [{ from: "normal", to: "pressure-loss" }]);
});

test("protects and installs an uploaded integration configuration", async (context) => {
  let installed;
  const server = createControlServer({
    status: { connected: false }, control: { scenario: "normal", paused: true }, port: 0,
    publishNow: async () => undefined, adminPassword: "admin-secret",
    installIntegrationConfig: async (value) => { installed = value; return { installed: 1, twins: [{ twinId: "0xtwin" }] }; },
  });
  context.after(() => server.close());
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/integration`;
  const denied = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-simulator-admin-password": "wrong" }, body: "{}" });
  assert.equal(denied.status, 401);
  const accepted = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-simulator-admin-password": "admin-secret" }, body: JSON.stringify({ mqtt: { endpoint: "wss://dtis.objectid.io/mqtt" } }) });
  assert.equal(accepted.status, 201);
  assert.deepEqual(installed, { mqtt: { endpoint: "wss://dtis.objectid.io/mqtt" } });
  assert.equal((await accepted.json()).restarting, false);
});

test("self-provisions a hosted Twin device file without the simulator administrator password", async (context) => {
  let installed;
  let options;
  const server = createControlServer({
    status: { connected: true }, control: { scenario: "normal", paused: false }, port: 0,
    publishNow: async () => undefined, adminPassword: "admin-secret",
    installIntegrationConfig: async (value, installOptions) => { installed = value; options = installOptions; return { installed: 1, twins: [{ twinId: hostedTwinId }] }; },
  });
  context.after(() => server.close());
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/integration`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(hostedDeviceFile) });
  assert.equal(response.status, 201);
  assert.deepEqual(installed, hostedDeviceFile);
  assert.deepEqual(options, { verifyCredential: true });
});

test("rejects self-provisioning files that do not bind a hosted endpoint and exact Twin topics", () => {
  assert.equal(isHostedDeviceProvisioning(hostedDeviceFile), true);
  assert.equal(isHostedDeviceProvisioning({ ...hostedDeviceFile, mqtt: { ...hostedDeviceFile.mqtt, endpoint: "wss://private.example/mqtt-mainnet" } }), false);
  assert.equal(isHostedDeviceProvisioning({ ...hostedDeviceFile, mqtt: { ...hostedDeviceFile.mqtt, topics: { ...hostedDeviceFile.mqtt.topics, dataset: "objectid/mainnet/tenants/tenant-a/twins/0xdead/telemetry/dataset" } } }), false);
});

test("routes controls and removal to a selected Twin in a simulator fleet", async (context) => {
  const calls = [];
  const server = createControlServer({
    port: 0,
    getStatus: () => ({ connected: true, configured: 2, twins: [{ twinId: "0xa", connected: true }, { twinId: "0xb", connected: true }] }),
    controlTwin: async (command) => { calls.push(["control", command.twinId]); return { twinId: command.twinId, scenario: command.scenario }; },
    adminPassword: "admin-secret",
    removeIntegrationConfig: async (twinId) => { calls.push(["remove", twinId]); return { twinId }; },
  });
  context.after(() => server.close());
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const controlled = await fetch(`${baseUrl}/api/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ twinId: "0xb", action: "scenario", scenario: "overheat" }) });
  assert.equal(controlled.status, 200);
  assert.equal((await controlled.json()).twinId, "0xb");
  const removed = await fetch(`${baseUrl}/api/integration`, { method: "DELETE", headers: { "content-type": "application/json", "x-simulator-admin-password": "admin-secret" }, body: JSON.stringify({ twinId: "0xa" }) });
  assert.equal(removed.status, 200);
  assert.deepEqual(calls, [["control", "0xb"], ["remove", "0xa"]]);
});
