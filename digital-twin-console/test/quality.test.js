import assert from "node:assert/strict";
import test from "node:test";
import { qualityScore, runQualityChecks } from "../src/quality.js";

test("passes coherent live twin evidence", () => {
  const twinId = "0xabc";
  const checks = runQualityChecks({
    expectedTwinId: twinId,
    twin: { data: { objectId: twinId, content: { fields: { lifecycle_state: 6, revision: 3, created_at: 10, updated_at: 20, twin_did: "did:iota:testnet:abc" } } } },
    telemetry: { assetId: twinId, observedAt: new Date().toISOString(), measurements: { a: { value: 1 }, b: { value: 2 }, c: { value: 3 }, d: { value: 4 }, e: { value: 5 } } },
    verification: { valid: true, eventCount: 3 },
    readiness: { ready: true }
  });
  assert.equal(checks.filter((item) => item.status === "fail").length, 0);
  assert.equal(qualityScore(checks), 100);
});

test("detects mismatched telemetry and invalid lifecycle", () => {
  const checks = runQualityChecks({
    expectedTwinId: "0xabc",
    twin: { data: { objectId: "0xabc", content: { fields: { lifecycle_state: 99, revision: 0 } } } },
    telemetry: { assetId: "0xother", observedAt: "invalid", measurements: {} },
    readiness: { ready: false }
  });
  assert.ok(checks.some((item) => item.id === "OID-02" && item.status === "fail"));
  assert.ok(checks.some((item) => item.id === "TEL-01" && item.status === "fail"));
  assert.ok(qualityScore(checks) < 50);
});
