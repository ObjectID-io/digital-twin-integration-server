import assert from "node:assert/strict";
import test from "node:test";
import { createTelemetry } from "../src/telemetry.js";

test("creates a bounded machine telemetry sample", () => {
  const sample = createTelemetry({
    sequence: 12,
    machineName: "machine-1",
    assetId: "0xtwin",
    now: Date.parse("2026-08-09T12:00:00.000Z"),
    random: () => 0.5
  });

  assert.equal(sample.assetId, "0xtwin");
  assert.equal(sample.machineName, "machine-1");
  assert.equal(sample.sequence, 12);
  assert.equal(sample.observedAt, "2026-08-09T12:00:00.000Z");
  assert.equal(sample.operatingState, "running");
  assert.ok(sample.measurements.temperature.value >= 45);
  assert.ok(sample.measurements.temperature.value <= 85);
  assert.equal(sample.measurements.temperature.unit, "Cel");
});

test("injects deterministic CNC fault scenarios", () => {
  const base = { sequence: 12, machineName: "machine-1", assetId: "0xtwin", random: () => 0.5 };
  assert.ok(createTelemetry({ ...base, scenario: "overheat" }).measurements.temperature.value >= 95);
  assert.ok(createTelemetry({ ...base, scenario: "high-vibration" }).measurements.vibration.value >= 8);
  assert.ok(createTelemetry({ ...base, scenario: "pressure-loss" }).measurements.pressure.value < 3);
  const stopped = createTelemetry({ ...base, scenario: "emergency-stop" });
  assert.equal(stopped.operatingState, "emergency-stop");
  assert.equal(stopped.measurements.rotationalSpeed.value, 0);
  assert.equal(stopped.measurements.activePower.value, 0);
});
