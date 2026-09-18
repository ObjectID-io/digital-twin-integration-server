import { describe, it, expect } from "vitest";
import { planCleanup, type CleanupChild } from "../../src/objectid/twinCleanup.js";
const pkg = "0x" + "a".repeat(64);
const child = (id: string, type: string, fields = {}): CleanupChild => ({ id, type: `${pkg}::oid_twin::${type}`, fields });
describe("registered Twin cleanup planner", () => {
  it("removes events without creating replacement events", () => {
    expect(planCleanup([child("e", "OIDTwinEvent")], pkg)).toEqual([{ name: "remove_event", ids: ["e"] }]);
  });
  it("handles all 17 types and removes members before parents", () => {
    const all = [child("c", "OIDTwinComposition"), child("m", "OIDTwinCompositionMember", { composition_id: "c" }), child("a", "OIDTwinMaturityAssessment"), child("i", "OIDTwinMaturityIndicator", { assessment_id: "a" }), child("f", "OIDTwinInterface"), child("n", "OIDTwinInterfaceNetwork", { interface_id: "f" }),
      ...["Aspect", "Relation", "Identifier", "ModelRef", "Dataset", "Command", "IdentifierMapping", "RoleGrant", "State", "FidelityProfile", "Event"].map(t => child(t, "OIDTwin" + t))];
    expect(planCleanup(all, pkg)).toEqual([{ name: "cleanup_composition_member", ids: ["c", "m"] }]);
    expect(planCleanup(all.filter(c => c.id !== "m"), pkg)).toEqual([{ name: "cleanup_maturity_indicator", ids: ["a", "i"] }]);
    const remaining = planCleanup(all.filter(c => !["m", "i"].includes(c.id)), pkg);
    expect(remaining.find(c => c.name === "cleanup_interface_v2")?.ids).toEqual(["f", "n"]);
    expect(remaining.flatMap(c => c.ids).sort()).toEqual(all.filter(c => !["m", "i"].includes(c.id)).map(c => c.id).sort());
  });
  it("rejects foreign types and missing parents before cleanup", () => {
    expect(() => planCleanup([child("x", "Foreign")], pkg)).toThrow();
    expect(() => planCleanup([child("m", "OIDTwinCompositionMember", { composition_id: "missing" })], pkg)).toThrow();
    expect(() => planCleanup([child("n", "OIDTwinInterfaceNetwork", { interface_id: "missing" })], pkg)).toThrow();
  });
  it("bounds independent batches and uses v1 for unpaired interface", () => {
    expect(planCleanup(Array.from({length: 50}, (_, i) => child(String(i), "OIDTwinEvent")), pkg)).toHaveLength(16);
    expect(planCleanup([child("f", "OIDTwinInterface")], pkg)[0]?.name).toBe("cleanup_interface");
  });
});
