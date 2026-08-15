import test from "node:test";
import assert from "node:assert/strict";
import { isTwinId, twinIdFromLocation, twinShareUrl } from "./twin-share.js";

const twinId = `0x${"a".repeat(64)}`;

test("builds and reads a canonical public Twin URL", () => {
  const url = twinShareUrl("https://dt-demo.objectid.io/", twinId);
  assert.equal(url, `https://dt-demo.objectid.io/twin/${twinId}`);
  assert.equal(twinIdFromLocation(new URL(url)), twinId);
});

test("supports the legacy twinId query parameter", () => {
  assert.equal(twinIdFromLocation(new URL(`https://dt-demo.objectid.io/?twinId=${twinId}`)), twinId);
});

test("rejects malformed Twin identifiers", () => {
  assert.equal(isTwinId("0x1234"), false);
  assert.equal(twinIdFromLocation(new URL("https://dt-demo.objectid.io/twin/0x1234")), "");
  assert.equal(twinShareUrl("https://dt-demo.objectid.io", "0x1234"), "");
});
