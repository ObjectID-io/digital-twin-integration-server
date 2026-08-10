import assert from "node:assert/strict";
import test from "node:test";
import { eventLabel, isIotaObjectId, objectExplorerUrl, transactionExplorerUrl } from "../src/thread-ui.js";

test("maps Move event constants to readable labels", () => {
  assert.equal(eventLabel(1), "Twin created");
  assert.equal(eventLabel(162), "Maturity assessment finalized");
  assert.equal(eventLabel(999), "Event type 999");
});

test("builds safe IOTA Explorer links", () => {
  const objectId = `0x${"a".repeat(64)}`;
  assert.equal(isIotaObjectId(objectId), true);
  assert.equal(isIotaObjectId("target"), false);
  assert.equal(objectExplorerUrl(objectId, "testnet"), `https://explorer.iota.org/object/${objectId}?network=testnet`);
  assert.equal(transactionExplorerUrl("digest/unsafe", "testnet"), "https://explorer.iota.org/txblock/digest%2Funsafe?network=testnet");
});
