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

test("protects the control API and applies authenticated commands", async (context) => {
  const status = { connected: true, published: 3 };
  const control = { scenario: "normal", paused: false };
  const transitions = [];
  const server = createControlServer({
    status, control, username: "operator", password: "secret", port: 0,
    publishNow: async () => undefined,
    recordTransition: async (transition) => transitions.push(transition),
  });
  context.after(() => server.close());
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${baseUrl}/api/status`)).status, 401);
  const response = await fetch(`${baseUrl}/api/control`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from("operator:secret").toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "scenario", scenario: "pressure-loss" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).scenario, "pressure-loss");
  assert.deepEqual(transitions, [{ from: "normal", to: "pressure-loss" }]);
});
