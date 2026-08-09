import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../../src/policy/engine.js";

describe("local role policy", () => {
  const policy = new PolicyEngine();
  it("allows a data provider to publish state", () => expect(policy.assertAllowed({ callerDid: "did:a", grants: [{ subjectDid: "did:a", roleType: "DATA_PROVIDER" }] }, "publish_state")).toBe(true));
  it("denies a data provider maturity assessment", () => expect(() => policy.assertAllowed({ callerDid: "did:a", grants: [{ subjectDid: "did:a", roleType: "DATA_PROVIDER" }] }, "maturity_assessment")).toThrowError(/denies/));
  it("allows native owner and steward authority", () => {
    expect(policy.assertAllowed({ callerDid: "did:owner", ownerDid: "did:owner", grants: [] }, "modify_composition")).toBe(true);
    expect(policy.assertAllowed({ callerDid: "did:steward", stewardDid: "did:steward", grants: [] }, "add_model")).toBe(true);
  });
  it("denies unrelated, expired, and auditor callers", () => {
    expect(() => policy.assertAllowed({ callerDid: "did:x", ownerDid: "did:owner", grants: [] }, "publish_state")).toThrow();
    expect(() => policy.assertAllowed({ callerDid: "did:x", grants: [{ subjectDid: "did:x", roleType: "DATA_PROVIDER", validTo: 99 }] }, "publish_state", 100)).toThrow();
    expect(() => policy.assertAllowed({ callerDid: "did:audit", grants: [{ subjectDid: "did:audit", roleType: "AUDITOR" }] }, "publish_state")).toThrow();
  });
});
