import assert from "node:assert/strict";
import test from "node:test";
import { buildCreateTwinTransaction, buildDeleteTwinTransaction, usableCreditTokens } from "./twin-mutations.js";

const id = (digit) => `0x${digit.repeat(64)}`;
const context = { packageId: id("1"), creditPolicyId: id("2"), controllerCapId: id("3"), clockId: "0x6" };

test("builds create_twin with the published Move signature", () => {
  const tx = buildCreateTwinTransaction(context, {
    creditTokenId: id("4"), twinType: "machine", targetKind: "physical-asset", targetObjectId: "", targetDid: "",
    lifecycleState: 1, fidelityLevel: 1, maturityLevel: 1, name: "CNC", description: "", namespace: "objectid",
    immutableMetadata: "{}", mutableMetadata: "{}",
  });
  const call = tx.getData().commands[0].MoveCall;
  assert.equal(call.module, "oid_twin");
  assert.equal(call.function, "create_twin");
  assert.equal(call.arguments.length, 16);
});

test("builds delete_twin with credit, policy, controller, Twin and Clock", () => {
  const tx = buildDeleteTwinTransaction(context, id("5"), id("4"));
  const call = tx.getData().commands[0].MoveCall;
  assert.equal(call.function, "delete_twin");
  assert.equal(call.arguments.length, 5);
});

test("selects only OID Credit tokens with positive readable balances", () => {
  assert.deepEqual(usableCreditTokens({ creditTokens: [
    { objectId: "positive", balance: "2" }, { objectId: "empty", balance: "0" }, { objectId: "invalid", balance: "?" },
  ] }), [{ objectId: "positive", balance: "2" }]);
});
