import { describe, expect, it } from "vitest";
import { verifyEvents } from "../../src/thread/verifier.js";
import type { TwinEvent } from "../../src/objectid/types.js";

const types = [1, 60, 104, 70, 120, 121];
function event(index: number, before = index): TwinEvent {
  return { eventId: `e${index}`, twinId: "0xtwin", eventType: types[index]!, revisionBefore: before, revisionAfter: before + 1, actorDid: "did:iota:actor", payloadRef: "ipfs://ref", payloadHash: `sha256:${"a".repeat(64)}`, createdAt: index };
}

describe("Digital Thread verifier", () => {
  it("accepts a continuous lifecycle thread", () => {
    const result = verifyEvents("0xtwin", types.map((_, index) => event(index)));
    expect(result.valid).toBe(true); expect(result.toRevision).toBe(6);
  });
  it("detects an artificial gap", () => {
    const events = types.map((_, index) => event(index)); events[3] = event(3, 4);
    const result = verifyEvents("0xtwin", events);
    expect(result.valid).toBe(false); expect(result.gaps.length).toBeGreaterThan(0);
  });
  it("keeps a pruned state publication verifiable and detects a present-state hash mismatch", () => {
    const anchored = { ...event(0), eventType: 30, payloadRef: "0xstate" };
    expect(verifyEvents("0xtwin", [anchored]).valid).toBe(true);

    const mismatched = {
      ...anchored,
      referencedState: {
        objectId: "0xstate", aspectCode: "telemetry", sampleType: "observed", sourceUri: "",
        payloadHash: "b".repeat(64), payloadUri: "", payloadInline: "", observedAt: 0,
        validFrom: 0, validTo: 0, qualityScore: 100, creatorDid: "did:iota:actor", superseded: false,
      },
    };
    expect(verifyEvents("0xtwin", [mismatched]).valid).toBe(false);
  });
});
