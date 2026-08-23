import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { applyCommand, createControlServer } from "../src/control-server.js";

test("applies simulator control commands", () => {
  const control = { scenario: "normal", paused: false };
  const transition = applyCommand({ action: "scenario", scenario: "overheat" }, control);
  assert.equal(control.scenario, "overheat");
  assert.deepEqual(transition, { previousScenario: "normal", scenarioChanged: true });
  assert.equal(applyCommand({ action: "scenario", scenario: "overheat" }, control).scenarioChanged, false);
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
