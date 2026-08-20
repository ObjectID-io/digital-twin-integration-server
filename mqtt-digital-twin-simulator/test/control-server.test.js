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
  let restartRequested = false;
  const server = createControlServer({
    status: { connected: false }, control: { scenario: "normal", paused: true }, port: 0,
    publishNow: async () => undefined, adminPassword: "admin-secret",
    installIntegrationConfig: async (value) => { installed = value; return { tenantId: "free-a", twinIds: ["0xtwin"] }; },
    restartForConfiguration: () => { restartRequested = true; },
  });
  context.after(() => server.close());
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/integration`;
  const denied = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-simulator-admin-password": "wrong" }, body: "{}" });
  assert.equal(denied.status, 401);
  const accepted = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-simulator-admin-password": "admin-secret" }, body: JSON.stringify({ mqtt: { endpoint: "wss://dtis.objectid.io/mqtt" } }) });
  assert.equal(accepted.status, 202);
  assert.deepEqual(installed, { mqtt: { endpoint: "wss://dtis.objectid.io/mqtt" } });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(restartRequested, true);
});
