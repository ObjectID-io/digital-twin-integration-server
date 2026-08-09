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
