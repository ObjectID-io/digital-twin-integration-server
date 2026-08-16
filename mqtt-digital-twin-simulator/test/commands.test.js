import test from "node:test";
import assert from "node:assert/strict";
import { executeSimulatorCommand } from "../src/commands.js";

test("executes the operational simulator command catalog", () => {
  const control = { scenario: "normal", paused: false };
  assert.deepEqual(executeSimulatorCommand(control, { command: { name: "pauseSimulation", parameters: {} } }), { scenario: "normal", paused: true });
  assert.deepEqual(executeSimulatorCommand(control, { command: { name: "setSimulationScenario", parameters: { scenario: "overheat" } } }), { scenario: "overheat", paused: true });
});

test("rejects emergency-stop through the general command channel", () => {
  assert.throws(() => executeSimulatorCommand({ scenario: "normal", paused: false }, { command: { name: "setSimulationScenario", parameters: { scenario: "emergency-stop" } } }), /not allowed/);
});
