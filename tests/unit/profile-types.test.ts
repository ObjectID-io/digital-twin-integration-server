import { describe, expect, it } from "vitest";
import { ProfileRegistry } from "../../src/schemas/registry.js";

describe("typed profile registry", () => {
  const registry = new ProfileRegistry("./profiles");
  it("validates OME only as a validation profile", async () => {
    const result = await registry.validateAgainstProfile("iso23247-ome-v1", { profile: "objectid-profile://iso23247/ome/v1", twinType: "equipment", name: "Motor" });
    expect(result.valid).toBe(true);
  });
  it("loads maturity definitions without AJV", async () => {
    expect(await registry.getMaturityDefinition("objectid-maturity-example-v1")).toMatchObject({ scoringRule: "weighted-average" });
  });
  it("rejects validation against a maturity definition explicitly", async () => {
    await expect(registry.validateAgainstProfile("objectid-maturity-example-v1", {})).rejects.toMatchObject({ code: "PROFILE_NOT_VALIDATABLE" });
  });
});
