import test from "node:test";
import assert from "node:assert/strict";
import { validateCreateTwinInput } from "./gas-station.js";

const OBJECT_ID = `0x${"1".repeat(64)}`;
const valid = {
  name: "Five-axis CNC", description: "Production machine", namespace: "objectid", twinType: "machine",
  targetKind: "physical-asset", targetObjectId: "", targetDid: "", lifecycleState: "6", fidelityLevel: "1",
  maturityLevel: "1", immutableMetadata: "{}", mutableMetadata: "{}", creditTokenId: OBJECT_ID,
};

test("normalizes a sponsored create intent", () => {
  const result = validateCreateTwinInput(valid);
  assert.equal(result.name, valid.name);
  assert.equal(result.lifecycleState, 6);
  assert.equal(result.creditTokenId, OBJECT_ID);
});

test("rejects malformed metadata before reserving gas", () => {
  assert.throws(() => validateCreateTwinInput({ ...valid, mutableMetadata: "{x" }), /valid JSON/);
});

test("rejects an invalid credit object before reserving gas", () => {
  assert.throws(() => validateCreateTwinInput({ ...valid, creditTokenId: "0x1" }), /OID Credit token is invalid/);
});
