import { describe, expect, it } from "vitest";
import { COMPOSITION_TYPES, validateCompositionInput } from "../../../src/twin/standardsValidation.js";
import { verifyEvents } from "../../../src/thread/verifier.js";

describe("ISO 23247-6 composition evidence", () => {
  it("DT-23247-6-001 accepts INTEGRATED, UNIFIED, and FEDERATED and rejects invalid composition", () => {
    for (const compositionType of Object.values(COMPOSITION_TYPES)) expect(validateCompositionInput({ compositionType })).toBeTruthy();
    expect(() => validateCompositionInput({ compositionType: 0 })).toThrowError(/compositionType/);
  });

  it("DT-23247-6-002 preserves member addition and removal in the Digital Thread", () => {
    const common = { twinId: "0xtwin", actorDid: "did:a", payloadRef: "0xmember", payloadHash: "", createdAt: 1 };
    const result = verifyEvents("0xtwin", [
      { ...common, eventId: "add", eventType: 153, revisionBefore: 0, revisionAfter: 1 },
      { ...common, eventId: "remove", eventType: 154, revisionBefore: 1, revisionAfter: 2, createdAt: 2 },
    ]);
    expect(result.valid).toBe(true);
  });
});
